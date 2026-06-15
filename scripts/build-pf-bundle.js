// Build script: wraps perfect-freehand CJS into a browser-friendly IIFE bundle.
// Run: node scripts/build-pf-bundle.js
const fs = require('fs');
const path = require('path');

const cjsPath = path.join(__dirname, '..', 'node_modules', 'perfect-freehand', 'dist', 'cjs', 'index.js');
const outPath = path.join(__dirname, '..', 'src', 'js', 'perfect-freehand-bundle.js');

const src = fs.readFileSync(cjsPath, 'utf8');

const bundle = `/* Perfect Freehand v1.2.3 bundled for CDpaint — DO NOT EDIT */
(function(){
  var exports = {}, module = { exports: exports };
  ${src}
  window.getStroke = exports.getStroke || exports.default;
  window.getStrokePoints = exports.getStrokePoints;
  window.getStrokeOutlinePoints = exports.getStrokeOutlinePoints;
})();
`;

fs.writeFileSync(outPath, bundle, 'utf8');
console.log('Wrote ' + outPath);
