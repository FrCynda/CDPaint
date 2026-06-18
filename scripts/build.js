const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const srcDir = path.resolve(__dirname, '..', 'src');
const distDir = path.resolve(__dirname, '..', 'dist');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function collectFiles(dir, pattern) {
  const results = [];
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, pattern));
    } else if (pattern.test(full)) {
      results.push(full);
    }
  }
  return results;
}

async function main() {
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  copyRecursive(srcDir, distDir);

  const jsFiles = collectFiles(distDir, /\.js$/);
  for (const file of jsFiles) {
    await esbuild.build({
      entryPoints: [file],
      outfile: file,
      allowOverwrite: true,
      minify: true,
      sourcemap: false,
    });
  }

  console.log(`Built frontend into ${distDir} (${jsFiles.length} JS files minified)`);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
