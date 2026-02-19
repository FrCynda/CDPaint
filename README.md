# CDPaint - GBA Asset Suite

A high-performance, WebGL-accelerated painting application designed for pixel artists and retro game developers. While it maintains the classic "Win32" aesthetic, it introduces professional image processing, active bit-depth enforcement, and specialized export tools for hardware-constrained environments like the Game Boy Advance (GBA).

<img width="1920" height="1039" alt="image" src="https://github.com/user-attachments/assets/849695fe-28fa-4d8f-a389-c7d16cdcda47" />


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

# CDPaint - Build & Run Guide

Welcome! This guide is written specifically for complete beginners. You do not need to be a programmer or have any special coding software installed to build this desktop app. Just follow these steps one by one.

## 1. Install Prerequisites (One-Time Setup)

You only need to install three standard tools to make this work. Download them using the official links below:

* **Node.js** (Runs the visual interface)
    * **Download:** Get the **LTS** version from [nodejs.org](https://nodejs.org/en/download)
    * **Setup:** Click through the standard installation, accepting all the defaults.
* **Rust** (Runs the app's background engine)
    * **Download:** Get the installer from [rust-lang.org](https://www.rust-lang.org/tools/install)
    * **Setup:** When the black window pops up during installation, simply press `1` and hit **Enter** to accept the default installation.
* **Visual Studio Build Tools** (Helps Windows read the code)
    * **Download:** Get it from [microsoft.com](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
    * **Setup:** During installation, you will see a screen with checkboxes. You **must** check the box that says **Desktop development with C++**. 

> **IMPORTANT:** Once all three are installed, **restart your computer** so Windows registers the new tools.

---

## 2. Open the Command Prompt in Your Folder

Instead of using complex coding software, use this standard Windows shortcut to open your command prompt exactly where it needs to be:

1. Open your **CDPaint** folder (e.g., `C:\Users\frenc\Desktop\CDPaint`) normally using Windows File Explorer.
2. Click directly on the long address bar at the very top of the folder window.
3. Delete the text in the bar, type `cmd`, and press **Enter**.
4. A black Command Prompt window will pop up, already locked onto your project folder. Keep it open!

---

## 3. Install the App Files (One-Time Setup)

We need to download the specific files your app needs to run. 

In the black Command Prompt window you just opened, type the following command exactly as written and press **Enter**:

`npm install`

*Note: Wait for the progress bars to finish. When the text stops moving and you see a blinking cursor again, it is done.*

---

## 4. Run the App (Test Mode)

To launch your app so you can see it and test it, type this command and press **Enter**:

`npm run tauri dev`

* **What happens:** The black window will process some text, and after a few moments, your CDPaint desktop application will automatically open! 
* **To stop it:** When you are done testing, close the CDPaint window normally. Then, click on your black Command Prompt window and press `Ctrl` + `C` to safely shut down the background process.

---

## 5. Build the Final App (To Share or Install)

When you are completely finished and want to create the final, clickable application file (like an `.exe` installer) that you can share with others, use this command and press **Enter**:

`npm run tauri:build`

* **What happens:** This process takes a few minutes. Once it finishes, open your CDPaint folder in File Explorer. You will find your final, ready-to-use application hidden inside this specific folder path: `src-tauri/target/release/bundle/`

---

## Common Fixes

* **"Command not found" error:** Your computer hasn't recognized the installations from Step 1. Make sure you fully restarted your computer after installing them.
* **White or Blank app window:** You likely skipped Step 3. Close the app, run `npm install` in your command prompt, and try again.
### White/blank window in dev
Check the dev server is running:
- Open `http://localhost:1420` in your browser
- If it fails, run `npm run dev` and check for errors 
