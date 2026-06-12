const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPackagePaths,
  getCopyEntries,
  buildNodeRuntimeArchiveName,
  buildNodeRuntimeDownloadUrl,
  extractNodeModuleVersion,
  renderStartBat,
  renderStopBat,
  renderLauncherJs,
  renderBootstrapJs,
} = require('../scripts/portable-package-lib');

test('getPackagePaths returns portable package locations under dist', () => {
  const paths = getPackagePaths('D:/Project/Traditional_Culture_Sharing');

  assert.equal(paths.distDir, 'D:/Project/Traditional_Culture_Sharing/dist');
  assert.equal(paths.outputDir, 'D:/Project/Traditional_Culture_Sharing/dist/Traditional_Culture_Sharing-portable');
  assert.equal(paths.zipPath, 'D:/Project/Traditional_Culture_Sharing/dist/Traditional_Culture_Sharing-portable.zip');
});

test('getCopyEntries includes app runtime inputs and excludes packaging helpers', () => {
  const entries = getCopyEntries('D:/Project/Traditional_Culture_Sharing');
  const targets = entries.map((entry) => entry.target);

  assert.deepEqual(targets, [
    'server',
    'public',
    'data',
    'node_modules',
    'package.json',
  ]);
});

test('extractNodeModuleVersion reads the required native module ABI from an error message', () => {
  const abi = extractNodeModuleVersion('NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.');

  assert.equal(abi, 127);
});

test('buildNodeRuntimeArchiveName uses the Windows zip naming convention', () => {
  const archiveName = buildNodeRuntimeArchiveName('22.21.1', 'x64');

  assert.equal(archiveName, 'node-v22.21.1-win-x64.zip');
});

test('buildNodeRuntimeDownloadUrl points at the official Node.js distribution URL', () => {
  const url = buildNodeRuntimeDownloadUrl('22.21.1', 'x64');

  assert.equal(url, 'https://nodejs.org/dist/v22.21.1/node-v22.21.1-win-x64.zip');
});

test('renderStartBat invokes the packaged PowerShell starter', () => {
  const script = renderStartBat();

  assert.match(script, /@echo off/);
  assert.match(script, /"%ROOT%runtime\\node\.exe" "%ROOT%app-control\\launcher\.js" start/);
});

test('renderStopBat invokes the packaged Node stopper', () => {
  const script = renderStopBat();

  assert.match(script, /@echo off/);
  assert.match(script, /"%ROOT%runtime\\node\.exe" "%ROOT%app-control\\launcher\.js" stop/);
});

test('renderLauncherJs starts the packaged server and opens the browser', () => {
  const script = renderLauncherJs();

  assert.match(script, /const serverEntry = path\.join\(__dirname, 'start-server\.js'\);/);
  assert.match(script, /process\.kill\(pid, 0\)/);
  assert.match(script, /taskkill\.exe/);
  assert.match(script, /cmd\.exe/);
  assert.match(script, /http:\/\/127\.0\.0\.1:/);
});

test('renderBootstrapJs sets PORT before loading the server entry', () => {
  const script = renderBootstrapJs();

  assert.match(script, /process\.env\.PORT = port;/);
  assert.match(script, /require\('\.\.\/server\/index\.js'\);/);
});
