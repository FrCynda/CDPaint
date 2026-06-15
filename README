# CDPaint - GBA Asset Suite

[![Tauri](https://img.shields.io/badge/Tauri-Build-blue.svg)](https://tauri.app/)
[![Node.js](https://img.shields.io/badge/Node.js-LTS-green.svg)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-Ready-orange.svg)](https://www.rust-lang.org/)

A high-performance, WebGL-accelerated painting application designed for pixel artists and retro game developers. While it maintains a modern Windows aesthetic, it introduces useful image processing, active bit-depth enforcement, and specialized export tools for hardware-constrained environments like the Game Boy Advance (GBA).

**Try the live browser demo:** https://frcynda.github.io/CDPaint/

**Performance note:** This demo runs best in **Chromium-based** browsers. **Gecko-based** browsers (Firefox, LibreWolf, Waterfox, etc.) are noticeably slower.

<img width="1920" height="1039" alt="CDPaint Interface" src="https://github.com/user-attachments/assets/849695fe-28fa-4d8f-a389-c7d16cdcda47" />

# Table of Contents

- [Key Features](#-key-features)
- [Technical Stack](#-technical-stack)
- [Architecture](#-architecture)
- [Build & Run Guide](#-build--run-guide)
- [Windows Build + Installer](#1-windows-build--installer)
- [macOS Build + Installer](#2-macos-build--installer)
- [Linux Build + Installer (Ubuntu/Debian)](#3-linux-build--installer-ubuntudebian)
- [Troubleshooting](#-troubleshooting)
- [Legal & Licensing](#legal--licensing)

---

# 🚀 Key Features

## 1. Active Canvas-Wide Color Modes
Unlike standard editors that operate in a 24-bit space, this app allows you to lock the entire drawing experience to specific hardware limits:
* **Active Quantization**: Every stroke you draw is automatically converted to the nearest valid color in your selected mode.
* **15bpp (RGB555)**: Constrains R, G, and B to 32 levels each (GBA native).
* **16bpp (RGB565)**: Constrains R and B to 32 levels and G to 64 levels.
* **8bpp (Indexed)**: Restricts the entire canvas to a 256-color palette.
* **Live Mode Switching**: Instantly convert existing artwork between bit-depths using GPU-accelerated quantization shaders.

## 2. GBA & Retro Export Studio
A specialized workflow for generating game-ready assets:
* **Palette Index Reordering**: Drag-and-drop palette swatches to ensure specific colors (like transparency) are assigned to the correct indices (e.g., Slot 0).
* **Automated Sprite Splitting**: Automatically detects and splits 64x128 or 128x64 canvases into separate 64x64 files for "Front/Back" game sprites.
* **JASC-PAL Support**: Full import/export support for `.pal` files used in game decompilation projects and map editors like Porymap.
* **Hardware Preview**: Preview exactly how your image will look on 15-bit hardware before exporting.

## 3. Image Adjustments
* **Precision Hue/Saturation**: A channel-based HSL adjustment tool (Master, R, Y, G, C, B, M) with a Split View slider to compare changes in real-time.
* **Decrease Color Depth**: Advanced quantization menu featuring Floyd-Steinberg dithering, OKLab color space accuracy, and seeded RNG for repeatable noise patterns.
* **Smart Edge Cleaner**: A GPU-accelerated filter designed to remove "stray" pixels from edges while protecting user-defined primary colors.

## 4. Advanced Selection Engine
* **Magic Wand Tool**: Features a distance-based tolerance slider. Drag away from your click point to live-expand the selection.
* **Boolean Operations**: Shift (Add), Ctrl (Subtract), and Alt (Intersect) modifiers for all selection tools.
* **Lasso & Polyline Select**: Free-form and point-to-point selection paths for non-rectangular objects.
* **Transparent Selection**: Keyed transparency for floating selections and pasted content.

## 5. Power-User Workflow
* **Custom Hotkeys**: Fully rebindable keyboard shortcuts for every tool and action.
* **Tiled Mode**: Live tiling for seamless pattern design. Draw in the center tile and see your strokes replicated across a 3×3 grid.
* **Free Canvas Mode**: Toggle between an "Anchored" view and a "Free" floating canvas that can be moved and manipulated within the viewport.
* **Hover Preview**: A dedicated 20x magnification window showing the exact pixel grid under your cursor.

---

# 🛠 Technical Stack

* **Rendering**: Dual-layer HTML5 Canvas API with WebGL Fragment Shaders for strokes, transforms, and quantization.
* **Processing**: Web Workers for heavy lifting (K-means color clustering and HSL adjustments) to keep the UI thread responsive.
* **Architecture**: Vanilla JavaScript with a custom "modern Windows" UI component library.
* **Platform**: Optimized for standalone use or as a Tauri desktop application.

---

# 🏗 Architecture

**Frontend:**
* Source files live in `src/`
* Dev server is a small Node HTTP server at `http://localhost:1420` (`scripts/dev.js`)
* Build step copies `src/` to `dist/` (`scripts/build.js`)

**Tauri:**
* Config is in `src-tauri/tauri.conf.json`
* Tauri uses the dev server in development (`beforeDevCommand`: `npm run dev`)
* Tauri uses `dist/` for production builds (`beforeBuildCommand`: `npm run build`)

---

# 💻 Build & Run Guide

Use the section for your OS. Each one includes everything needed to build and run an installer.

## 1. Windows Build + Installer

1. Install Node.js (LTS): [nodejs.org](https://nodejs.org/en/download)
2. Install Rust: [rust-lang.org/tools/install](https://www.rust-lang.org/tools/install)
3. Install Visual Studio Build Tools: [visualstudio.microsoft.com](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
4. In the Build Tools installer, enable **Desktop development with C++**
5. Restart Windows once after installs
6. Open the CDPaint folder in File Explorer, click the address bar, type `powershell`, press Enter
7. Run:
   ```bash
   npm install
   npm run tauri:build
   ```
8. Open the installer output folder:
   - `src-tauri/target/release/bundle/nsis/` for `.exe`
   - `src-tauri/target/release/bundle/msi/` for `.msi`
9. Double-click the installer you want and complete install

## 2. macOS Build + Installer

1. Install Node.js (LTS): [nodejs.org](https://nodejs.org/en/download)
2. Install Rust: [rust-lang.org/tools/install](https://www.rust-lang.org/tools/install)
3. Install Xcode Command Line Tools: `xcode-select --install`
4. Open Terminal and `cd` into your CDPaint folder
5. Run:
   ```bash
   npm install
   npm run tauri:build
   ```
6. Open the installer output folder:
   - `src-tauri/target/release/bundle/dmg/` for `.dmg`
7. Open the `.dmg` and install CDPaint

## 3. Linux Build + Installer (Ubuntu/Debian)

1. Install Node.js (LTS): [nodejs.org](https://nodejs.org/en/download)
2. Install Rust: [rust-lang.org/tools/install](https://www.rust-lang.org/tools/install)
3. Install system libraries:
   ```bash
   sudo apt-get update
   sudo apt-get install -y \
     pkg-config \
     libssl-dev \
     libglib2.0-dev \
     libwebkit2gtk-4.1-dev \
     libsoup-3.0-dev \
     libgtk-3-dev \
     libayatana-appindicator3-dev \
     librsvg2-dev \
     patchelf
   ```
4. Open Terminal and `cd` into your CDPaint folder
5. Run:
   ```bash
   npm install
   npm run tauri:build
   ```
6. Open the installer output folder:
   - `src-tauri/target/release/bundle/appimage/` for `.AppImage`
   - `src-tauri/target/release/bundle/deb/` for `.deb`
   - `src-tauri/target/release/bundle/rpm/` for `.rpm`
7. Install using your preferred package type (`.AppImage`, `.deb`, or `.rpm`)

---

# 🔧 Troubleshooting

* **"Command not found" error:** Your computer hasn't recognized the OS install prerequisites yet. Re-check the install guide for your OS, then restart your computer.
* **Installer folder is empty:** Build likely failed earlier. Scroll up in terminal output, fix the first error shown, then run `npm run tauri:build` again.
* **Can't find output files:** Check both `src-tauri/target/release/bundle/` and `target/release/bundle/`.
* **Windows says app is unrecognized (SmartScreen):** Click `More info` then `Run anyway` for unsigned builds.
* **macOS says app is damaged or blocked:** Open `System Settings -> Privacy & Security`, find the blocked app message, click `Open Anyway`, then launch again.
* **Linux AppImage won't open:** In terminal, run `chmod +x path/to/CDPaint.AppImage`, then run it again.
* **Build fails with toolchain/version errors:** Check versions with `node -v`, `npm -v`, `rustc -V`, and `cargo -V`. Update Node (LTS) and Rust if needed.

---

# Legal & Licensing

* The project logic is MIT licensed.
* The embedded Microsoft Paint-style icons and baked-in Base64/SVG asset strings are property of Microsoft Corporation and are excluded from the MIT license for this repository.
* This repository is a non-commercial Fair Use educational tribute/reconstruction.
* Warning to forkers: anyone forking or redistributing this repository assumes all risk and responsibility for redistributing embedded Microsoft-owned assets.
