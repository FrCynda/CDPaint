import struct, zlib, os

def list_ztxt_chunks(filepath):
    chunks = []
    try:
        with open(filepath, 'rb') as f:
            sig = f.read(8)
            if sig[:4] != b'\x89PNG':
                return chunks
            while True:
                hdr = f.read(8)
                if len(hdr) < 8: break
                length = struct.unpack('>I', hdr[:4])[0]
                chunk_type = hdr[4:8]
                data = f.read(length)
                crc = f.read(4)
                if len(data) < length: break
                if chunk_type == b'zTXt':
                    null_pos = data.index(0)
                    keyword = data[:null_pos].decode('latin-1')
                    chunks.append(keyword)
    except Exception as e:
        pass
    return chunks

base = r'C:\Users\frenc\Desktop\CDPaint\src\Deevad_25.01\paintoppresets'
files = sorted(os.listdir(base))
no_chunk = []
for f in files:
    fpath = os.path.join(base, f)
    chunks = list_ztxt_chunks(fpath)
    if 'preset' not in chunks:
        no_chunk.append(f)

print(f'Files missing preset chunk ({len(no_chunk)}):')
for f in no_chunk:
    enc = repr(f)
    print(f'  {enc}')
