/**
 * convert_brushes_to_png.js
 * Parses .gih (GIMP Image Hose) and .gbr (GIMP Brush) files
 * and exports the first cell as a PNG.
 * 
 * Usage: node tools/convert_brushes_to_png.js
 */

const fs = require('fs');
const path = require('path');

// Try to use the 'canvas' npm package if available, otherwise install it
let createCanvas;
try {
    const canvas = require('canvas');
    createCanvas = canvas.createCanvas;
} catch (e) {
    console.log("Installing 'canvas' npm package...");
    require('child_process').execSync('npm install canvas', { stdio: 'inherit' });
    const canvas = require('canvas');
    createCanvas = canvas.createCanvas;
}

const TIPS_DIR = path.join(__dirname, '..', 'src', 'brush-packs', 'revoy-2025', 'tips');
const OUT_DIR = TIPS_DIR; // Output PNGs alongside the source files

/**
 * Parse a single GBR cell from an ArrayBuffer (big-endian header).
 * Returns { width, height, pixels: Uint8Array(RGBA) }
 */
function parseGbrCell(buf) {
    // Use Buffer for Node.js; works with ArrayBuffer too
    const b = Buffer.from(buf);
    
    // Big-endian uint32 reads
    function be32(offset) {
        return b.readUInt32BE(offset);
    }
    
    const headerSize = be32(0);
    const width = be32(8);
    const height = be32(12);
    const bpp = be32(16);
    
    const src = new Uint8Array(buf, headerSize);
    const rgba = new Uint8Array(width * height * 4);
    
    if (bpp === 1) {
        // Grayscale: 0 = opaque (black), 255 = transparent (white)
        // In GIMP brush format, white = transparent, black = opaque
        for (let i = 0, len = width * height; i < len; i++) {
            const v = 255 - src[i];  // invert: black tip → white pixel
            rgba[i * 4] = v;
            rgba[i * 4 + 1] = v;
            rgba[i * 4 + 2] = v;
            rgba[i * 4 + 3] = 255;
        }
    } else if (bpp === 4) {
        for (let i = 0, len = width * height; i < len; i++) {
            rgba[i * 4] = src[i * 4];
            rgba[i * 4 + 1] = src[i * 4 + 1];
            rgba[i * 4 + 2] = src[i * 4 + 2];
            rgba[i * 4 + 3] = src[i * 4 + 3];
        }
    } else {
        console.warn(`  Unknown bpp: ${bpp}, skipping`);
        return null;
    }
    
    return { width, height, pixels: rgba };
}

/**
 * Parse a GIH (GIMP Image Hose) or GBR file.
 * For GIH, finds the first GBR cell after the text header.
 * For GBR, parses the single cell directly.
 */
function parseGimpBrush(filePath) {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    
    // Check if GIH (first byte is non-zero ASCII text char) or GBR (first byte is 0x00)
    const dv = new DataView(arrayBuf);
    
    if (dv.getUint8(0) !== 0) {
        // GIH format: find null-terminated text header
        let textEnd = 0;
        for (let i = 0; i < arrayBuf.byteLength; i++) {
            if (dv.getUint8(i) === 0) {
                textEnd = i;
                break;
            }
        }
        
        if (textEnd === 0) {
            console.warn('  No null terminator found in GIH header');
            return null;
        }
        
        // The text header includes the null byte; first GBR cell starts at textEnd
        // (the null byte doubles as the first byte of header_size for GBR)
        const cellBuf = arrayBuf.slice(textEnd);
        return parseGbrCell(cellBuf);
    } else {
        // GBR format: single cell
        return parseGbrCell(arrayBuf);
    }
}

function main() {
    const files = fs.readdirSync(TIPS_DIR).filter(f => /\.(gih|gbr)$/i.test(f));
    
    console.log(`Found ${files.length} GIMP brush files to convert:\n`);
    
    let converted = 0;
    let failed = 0;
    
    for (const file of files) {
        const fullPath = path.join(TIPS_DIR, file);
        const pngName = file.replace(/\.(gih|gbr)$/i, '.png');
        const pngPath = path.join(OUT_DIR, pngName);
        
        console.log(`Converting: ${file}`);
        
        try {
            const result = parseGimpBrush(fullPath);
            if (!result) {
                console.log(`  SKIPPED`);
                failed++;
                continue;
            }
            
            const { width, height, pixels } = result;
            console.log(`  ${width}×${height} → ${pngName}`);
            
            // Create canvas and draw pixels
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(width, height);
            imageData.data.set(pixels);
            ctx.putImageData(imageData, 0, 0);
            
            // Write PNG
            const pngBuffer = canvas.toBuffer('image/png');
            fs.writeFileSync(pngPath, pngBuffer);
            
            converted++;
        } catch (e) {
            console.log(`  ERROR: ${e.message}`);
            failed++;
        }
    }
    
    console.log(`\nDone: ${converted} converted, ${failed} failed, ${files.length} total`);
}

main();
