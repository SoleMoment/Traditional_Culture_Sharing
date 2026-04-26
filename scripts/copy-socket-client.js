const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');
const dir = path.join(__dirname, '..', 'public', 'vendor');
const dst = path.join(dir, 'socket.io.min.js');
if (!fs.existsSync(src)) {
  process.stderr.write('socket.io client not found; run npm install first\n');
  process.exit(0);
}
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, dst);
// eslint-disable-next-line no-console
console.log('copied socket.io.min.js to public/vendor/');
