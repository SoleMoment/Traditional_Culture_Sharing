const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const sourceDir = path.join(projectRoot, 'public');
const distDir = path.join(projectRoot, 'docs');

if (!fs.existsSync(sourceDir)) {
  throw new Error(`源目录不存在: ${sourceDir}`);
}

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

for (const entry of fs.readdirSync(sourceDir)) {
  const src = path.join(sourceDir, entry);
  const dest = path.join(distDir, entry);
  fs.cpSync(src, dest, { recursive: true, force: true });
}

console.log(`Build complete. Static files copied to: ${distDir}`);
