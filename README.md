# Paint - Professional (GBA & Retro Asset Suite)

A high-performance, WebGL-accelerated painting application designed for pixel artists and retro game developers. While it maintains the classic "Win32" aesthetic, it introduces professional image processing, active bit-depth enforcement, and specialized export tools for hardware-constrained environments like the Game Boy Advance (GBA).

## 🚀 Key Features (Beyond Standard MS Paint)

### 1. Active Canvas-Wide Color Modes

Unlike standard editors that operate in a 24-bit space, this app allows you to lock the entire drawing experience to specific hardware limits:

- **Active Quantization**: Every stroke you draw is automatically converted to the nearest valid color in your selected mode.
- **15bpp (RGB555)**: Constrains R, G, and B to 32 levels each (GBA native).
- **16bpp (RGB565)**: Constrains R and B to 32 levels and G to 64 levels.
- **8bpp (Indexed)**: Restricts the entire canvas to a 256-color palette.
- **Live Mode Switching**: Instantly convert existing artwork between bit-depths using GPU-accelerated quantization shaders.

### 2. GBA & Retro Export Studio

A specialized workflow for generating game-ready assets:

- **Palette Index Reordering**: Drag-and-drop palette swatches to ensure specific colors (like transparency) are assigned to the correct indices (e.g., Slot 0).
- **Automated Sprite Splitting**: Automatically detects and splits 64x128 or 128x64 canvases into separate 64x64 files for "Front/Back" game sprites.
- **JASC-PAL Support**: Full import/export support for .pal files used in game decompilation projects and map editors like Porymap.
- **Hardware Preview**: Preview exactly how your image will look on 15-bit hardware before exporting.

### 3. Professional Image Adjustments

- **Precision Hue/Saturation**: A channel-based HSL adjustment tool (Master, R, Y, G, C, B, M) with a Split View slider to compare changes in real-time.
- **Decrease Color Depth**: Advanced quantization menu featuring Floyd-Steinberg dithering, OKLab color space accuracy, and seeded RNG for repeatable noise patterns.
- **Smart Edge Cleaner**: A GPU-accelerated filter designed to remove "stray" pixels from edges while protecting user-defined primary colors.

### 4. Advanced Selection Engine

- **Magic Wand Tool**: Features a distance-based tolerance slider. Drag away from your click point to live-expand the selection.
- **Boolean Operations**: Shift (Add), Ctrl (Subtract), and Alt (Intersect) modifiers for all selection tools.
- **Lasso & Polyline Select**: Free-form and point-to-point selection paths for non-rectangular objects.
- **Transparent Selection**: Professional-grade keyed transparency for floating selections and pasted content.

### 5. Power-User Workflow

- **Custom Hotkeys**: Fully rebindable keyboard shortcuts for every tool and action.
- **Tiled Mode**: Live tiling for seamless pattern design. Draw in the center tile and see your strokes replicated across a 3×3 grid.
- **Free Canvas Mode**: Toggle between an "Anchored" view and a "Free" floating canvas that can be moved and manipulated within the viewport.
- **Hover Preview**: A dedicated 20x magnification window showing the exact pixel grid under your cursor.

**Quick start (Windows)**
1. Install Node.js (LTS) and Rust.
2. From the project folder:
   1. `npm install`
   2. `npm run tauri dev`

If you get stuck, read the full tutorial below.

## 🛠 Technical Stack

- **Rendering**: Dual-layer HTML5 Canvas API with WebGL Fragment Shaders for strokes, transforms, and quantization.
- **Processing**: Web Workers for heavy lifting (K-means color clustering and HSL adjustments) to keep the UI thread responsive.
- **Architecture**: Vanilla JavaScript with a custom "Win32-style" UI component library.
- **Platform**: Optimized for standalone use or as a Tauri desktop application.

## How this project is wired
Frontend:
- Source files live in `src/`
- Dev server is a small Node HTTP server at `http://localhost:1420` (`scripts/dev.js`)
- Build step copies `src/` to `dist/` (`scripts/build.js`)

Tauri:
- Config is in `src-tauri/tauri.conf.json`
- Tauri uses the dev server in development (`beforeDevCommand`: `npm run dev`)
- Tauri uses `dist/` for production builds (`beforeBuildCommand`: `npm run build`)

## Full tutorial: build and run (novice-friendly)

This section intentionally over-explains the setup so you can follow it even if you have never built a desktop app before.

### 1. Install prerequisites (one-time setup)
You need three things:
- **Node.js (LTS)** for the frontend dev server and build.
- **Rust + Cargo** for the Tauri backend and bundling.
- **C++ build tools** on Windows for compiling native dependencies.

Official download links (copy/paste into your browser):
```text
Node.js (LTS): https://nodejs.org/en/download
Rust (rustup): https://www.rust-lang.org/tools/install
Visual Studio Build Tools (C++): https://visualstudio.microsoft.com/visual-cpp-build-tools/
Tauri prerequisites (Windows): https://tauri.app/v2/guides/prerequisites/
```

Notes:
- For Rust, install via `rustup` when prompted. It sets up `cargo` automatically.
- For Visual Studio Build Tools, choose the **Desktop development with C++** workload.
- After installing, **close and re-open your terminal** so new commands are available.

Verify installs (you should see version numbers, not errors):
```powershell
node -v
npm -v
rustc -V
cargo -V
```

If any command says “not found,” the install did not finish correctly or the terminal needs a restart.

### 2. Open a terminal in the project folder
You should be in:
`C:\Users\frenc\Desktop\CDPaint`

In WebStorm:
1. Open the built-in Terminal tab.
2. Check the prompt path is the project folder.

### 3. Install frontend dependencies (one-time per clone)
This downloads the Node packages listed in `package.json`:
```powershell
npm install
```

Expected result:
- It creates a `node_modules/` folder.
- No fatal errors.

### 4. Run the app in development
This starts a local web server and opens the desktop window:
```powershell
npm run tauri dev
```

What happens:
1. `npm run dev` starts a tiny server at `http://localhost:1420`.
2. Tauri launches a native window that loads that URL.

What you should see:
- A CDPaint window.
- The UI updates live when you edit files in `src/`.

To stop dev mode:
- Close the app window.
- Press `Ctrl+C` in the terminal.

### 5. Build a production desktop app
This creates release builds and installers:
```powershell
npm run tauri:build
```

What happens:
1. `npm run build` copies `src/` to `dist/`.
2. Tauri compiles Rust and bundles the desktop app.

Output locations (common on Windows):
- Release binaries: `src-tauri/target/release/`
- Installers/bundles: `src-tauri/target/release/bundle/`

If you don’t see output:
- Re-run the command and read the last 20 lines for errors.
- Most issues are missing C++ build tools or a failed Rust install.

## Common problems

### "command not found" for node, npm, rustc, or cargo
Install the missing tool and restart the terminal.

### "failed to run beforeDevCommand" or "beforeBuildCommand"
Make sure:
- You ran `npm install`
- `npm run dev` works on its own
- `npm run build` works on its own

### White/blank window in dev
Check the dev server is running:
- Open `http://localhost:1420` in your browser
- If it fails, run `npm run dev` and check for errors 
