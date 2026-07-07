// @ts-check
    // PNG chunk builder used during export. Manually constructs sRGB and pHYs ancillary chunks
    // so exported files carry correct colour-space and DPI metadata.
    class PngMetadata {
        static get CRC_TABLE() {
            if (this._crcTable) return this._crcTable;
            this._crcTable = [];
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                this._crcTable[n] = c;
            }
            return this._crcTable;
        }

        static calcCRC(buf) {
            const table = this.CRC_TABLE;
            let crc = 0xffffffff;
            const u8 = new Uint8Array(buf);
            for (let i = 0; i < u8.length; i++) crc = table[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
            return (crc ^ 0xffffffff) >>> 0;
        }

        static createChunk(type, data) {
            const len = data.length;
            const buf = new Uint8Array(4 + 4 + len + 4);
            const view = new DataView(buf.buffer);

            view.setUint32(0, len, false);
            for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
            buf.set(data, 8);
            const crc = this.calcCRC(buf.subarray(4, 8 + len));
            view.setUint32(8 + len, crc, false);

            return buf;
        }

        static async inject(blob) {
            const buffer = await blob.arrayBuffer();
            const u8 = new Uint8Array(buffer);

            const physData = new Uint8Array([
                0x00, 0x00, 0x0E, 0xC3,
                0x00, 0x00, 0x0E, 0xC3,
                0x01
            ]);
            const physChunk = this.createChunk("pHYs", physData);
            const srgbChunk = this.createChunk("sRGB", new Uint8Array([0]));

            const insertPos = 33;

            return new Blob([
                u8.slice(0, insertPos),
                physChunk,
                srgbChunk,
                u8.slice(insertPos)
            ], { type: "image/png" });
        }
    }