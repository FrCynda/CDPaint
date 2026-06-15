    class CompressionCompat {
        static toBytes(input) {
            if (input instanceof Uint8Array) return input;
            if (input instanceof ArrayBuffer) return new Uint8Array(input);
            if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
            return new Uint8Array(0);
        }
        static async deflateWithCompressionStream(bytes, timeoutMs = 1200) {
            const stream = new CompressionStream('deflate');
            const writer = stream.writable.getWriter();
            const compress = (async () => {
                await writer.write(bytes);
                await writer.close();
                const compressed = await new Response(stream.readable).arrayBuffer();
                return new Uint8Array(compressed);
            })();
            if (!timeoutMs || timeoutMs <= 0) return compress;
            let timer = null;
            try {
                return await Promise.race([
                    compress,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('CompressionStream timed out')), timeoutMs);
                    })
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        static adler32(bytes) {
            let a = 1;
            let b = 0;
            const MOD = 65521;
            const input = this.toBytes(bytes);
            const len = input.length;
            for (let i = 0; i < len; i++) {
                a += input[i];
                if (a >= MOD) a -= MOD;
                b += a;
                if (b >= MOD) b -= MOD;
            }
            return ((b << 16) | a) >>> 0;
        }
        static deflateStored(bytes) {
            const input = this.toBytes(bytes);
            const chunks = [];
            chunks.push(new Uint8Array([0x78, 0x01])); // zlib CMF+FLG: deflate with 32 KB window, no dict, low compression level
            let offset = 0;
            while (offset < input.length) {
                const remaining = input.length - offset;
                const blockLen = Math.min(0xffff, remaining);
                const isFinal = offset + blockLen >= input.length;
                const header = new Uint8Array(5);
                header[0] = isFinal ? 0x01 : 0x00; // BFINAL=1 on last block; BTYPE=00 means stored (uncompressed)
                header[1] = blockLen & 0xff;
                header[2] = (blockLen >>> 8) & 0xff;
                const nlen = (~blockLen) & 0xffff;
                header[3] = nlen & 0xff;
                header[4] = (nlen >>> 8) & 0xff;
                chunks.push(header);
                chunks.push(input.subarray(offset, offset + blockLen));
                offset += blockLen;
            }
            const adler = this.adler32(input);
            const trailer = new Uint8Array([
                (adler >>> 24) & 0xff,
                (adler >>> 16) & 0xff,
                (adler >>> 8) & 0xff,
                adler & 0xff
            ]);
            chunks.push(trailer);
            let total = 0;
            for (const part of chunks) total += part.length;
            const out = new Uint8Array(total);
            let writeAt = 0;
            for (const part of chunks) {
                out.set(part, writeAt);
                writeAt += part.length;
            }
            return out;
        }
        static async deflate(bytes) {
            const input = this.toBytes(bytes);
            if (window.pako && typeof window.pako.deflate === 'function') {
                return window.pako.deflate(input);
            }
            if (typeof CompressionStream === 'function') {
                try {
                    return await this.deflateWithCompressionStream(input, 1200);
                } catch (err) {
                    console.warn('CompressionStream failed, falling back to stored deflate', err);
                }
            }
            return this.deflateStored(input);
        }
    }