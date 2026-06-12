const path = require('path');

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function getPackagePaths(projectRoot) {
  const projectName = path.basename(projectRoot);
  const distDir = normalizePath(path.join(projectRoot, 'dist'));
  const outputDir = normalizePath(path.join(distDir, `${projectName}-portable`));
  const zipPath = normalizePath(path.join(distDir, `${projectName}-portable.zip`));

  return {
    projectName,
    distDir,
    outputDir,
    zipPath,
  };
}

function getCopyEntries(projectRoot) {
  return [
    { source: path.join(projectRoot, 'server'), target: 'server' },
    { source: path.join(projectRoot, 'public'), target: 'public' },
    { source: path.join(projectRoot, 'data'), target: 'data' },
    { source: path.join(projectRoot, 'node_modules'), target: 'node_modules' },
    { source: path.join(projectRoot, 'package.json'), target: 'package.json' },
  ];
}

function extractNodeModuleVersion(text) {
  const match = /NODE_MODULE_VERSION\s+(\d+)/.exec(String(text || ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeNodeWindowsArch(arch) {
  if (arch === 'ia32') return 'x86';
  return arch;
}

function buildNodeRuntimeArchiveName(version, arch) {
  const normalizedArch = normalizeNodeWindowsArch(arch);
  return `node-v${version}-win-${normalizedArch}.zip`;
}

function buildNodeRuntimeDirectoryName(version, arch) {
  const normalizedArch = normalizeNodeWindowsArch(arch);
  return `node-v${version}-win-${normalizedArch}`;
}

function buildNodeRuntimeDownloadUrl(version, arch) {
  return `https://nodejs.org/dist/v${version}/${buildNodeRuntimeArchiveName(version, arch)}`;
}

function renderStartBat() {
  return [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'if not exist "%ROOT%runtime\\node.exe" (',
    '  echo Runtime not found: %ROOT%runtime\\node.exe',
    '  exit /b 1',
    ')',
    '"%ROOT%runtime\\node.exe" "%ROOT%app-control\\launcher.js" start',
    'set "EXIT_CODE=%ERRORLEVEL%"',
    'if not "%EXIT_CODE%"=="0" pause',
    'exit /b %EXIT_CODE%',
    '',
  ].join('\r\n');
}

function renderStopBat() {
  return [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'if not exist "%ROOT%runtime\\node.exe" (',
    '  echo Runtime not found: %ROOT%runtime\\node.exe',
    '  exit /b 1',
    ')',
    '"%ROOT%runtime\\node.exe" "%ROOT%app-control\\launcher.js" stop',
    'set "EXIT_CODE=%ERRORLEVEL%"',
    'if not "%EXIT_CODE%"=="0" pause',
    'exit /b %EXIT_CODE%',
    '',
  ].join('\r\n');
}

function renderLauncherJs() {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const http = require('http');",
    "const net = require('net');",
    "const { spawn, spawnSync } = require('child_process');",
    '',
    "const root = path.join(__dirname, '..');",
    "const stateDir = path.join(root, 'app-state');",
    "const logDir = path.join(root, 'logs');",
    "const pidFile = path.join(stateDir, 'server.pid');",
    "const portFile = path.join(stateDir, 'server.port');",
    "const nodeExe = path.join(root, 'runtime', 'node.exe');",
    "const serverEntry = path.join(__dirname, 'start-server.js');",
    "const stdoutLog = path.join(logDir, 'server.stdout.log');",
    "const stderrLog = path.join(logDir, 'server.stderr.log');",
    "const command = String(process.argv[2] || 'start').toLowerCase();",
    '',
    'function ensureDir(dirPath) {',
    '  fs.mkdirSync(dirPath, { recursive: true });',
    '}',
    '',
    'function readIntFile(filePath) {',
    '  if (!fs.existsSync(filePath)) {',
    '    return null;',
    '  }',
    '  const value = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);',
    '  return Number.isInteger(value) ? value : null;',
    '}',
    '',
    'function writeIntFile(filePath, value) {',
    '  fs.writeFileSync(filePath, `${value}\\n`, "ascii");',
    '}',
    '',
    'function cleanupState() {',
    '  if (fs.existsSync(pidFile)) {',
    '    fs.rmSync(pidFile, { force: true });',
    '  }',
    '  if (fs.existsSync(portFile)) {',
    '    fs.rmSync(portFile, { force: true });',
    '  }',
    '}',
    '',
    'function isProcessRunning(pid) {',
    '  if (!Number.isInteger(pid) || pid <= 0) {',
    '    return false;',
    '  }',
    '  try {',
    '    process.kill(pid, 0);',
    '    return true;',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    '',
    'function canListen(port) {',
    '  return new Promise((resolve) => {',
    "    const server = net.createServer();",
    '    server.unref();',
    "    server.once('error', () => resolve(false));",
    "    server.listen(port, '127.0.0.1', () => {",
    '      server.close(() => resolve(true));',
    '    });',
    '  });',
    '}',
    '',
    'async function getFreePort() {',
    '  for (let port = 3000; port <= 3020; port += 1) {',
    '    if (await canListen(port)) {',
    '      return port;',
    '    }',
    '  }',
    "  throw new Error('No free port found in 3000-3020.');",
    '}',
    '',
    'function wait(ms) {',
    '  return new Promise((resolve) => setTimeout(resolve, ms));',
    '}',
    '',
    'function openBrowser(url) {',
    `  const child = spawn('cmd.exe', ['/c', 'start', '', url], {`,
    '    detached: true,',
    "    stdio: 'ignore',",
    '    windowsHide: true,',
    '  });',
    '  child.unref();',
    '}',
    '',
    'function checkHttp(url) {',
    '  return new Promise((resolve) => {',
    '    const req = http.get(url, (res) => {',
    '      res.resume();',
    '      resolve(res.statusCode >= 200 && res.statusCode < 500);',
    '    });',
    "    req.on('error', () => resolve(false));",
    '    req.setTimeout(1500, () => {',
    '      req.destroy();',
    '      resolve(false);',
    '    });',
    '  });',
    '}',
    '',
    'async function start() {',
    '  ensureDir(stateDir);',
    '  ensureDir(logDir);',
    '',
    '  if (!fs.existsSync(nodeExe)) {',
    '    throw new Error(`Runtime not found: ${nodeExe}`);',
    '  }',
    '',
    '  const existingPid = readIntFile(pidFile);',
    '  const existingPort = readIntFile(portFile) || 3000;',
    '  const existingUrl = `http://127.0.0.1:${existingPort}/`;',
    '  if (isProcessRunning(existingPid)) {',
    '    openBrowser(existingUrl);',
    '    console.log(`Server already running: ${existingUrl}`);',
    '    return;',
    '  }',
    '',
    '  cleanupState();',
    '',
    '  const port = await getFreePort();',
    '  const url = `http://127.0.0.1:${port}/`;',
    '  const healthUrl = `http://127.0.0.1:${port}/api/config`;',
    '  const stdoutFd = fs.openSync(stdoutLog, "a");',
    '  const stderrFd = fs.openSync(stderrLog, "a");',
    '  const child = spawn(nodeExe, [serverEntry, String(port)], {',
    '    cwd: root,',
    '    detached: true,',
    '    windowsHide: true,',
    '    stdio: ["ignore", stdoutFd, stderrFd],',
    '  });',
    '  child.unref();',
    '  fs.closeSync(stdoutFd);',
    '  fs.closeSync(stderrFd);',
    '',
    '  writeIntFile(pidFile, child.pid);',
    '  writeIntFile(portFile, port);',
    '',
    '  const deadline = Date.now() + 25000;',
    '  while (Date.now() < deadline) {',
    '    if (await checkHttp(healthUrl)) {',
    '      openBrowser(url);',
    '      console.log(`Server started: ${url}`);',
    '      return;',
    '    }',
    '    if (!isProcessRunning(child.pid)) {',
    '      break;',
    '    }',
    '    await wait(500);',
    '  }',
    '',
    '  cleanupState();',
    '  throw new Error(`Server failed to start or timed out. Check log: ${stderrLog}`);',
    '}',
    '',
    'function stop() {',
    '  const pid = readIntFile(pidFile);',
    '  if (!pid) {',
    "    console.log('No running server found.');",
    '    return;',
    '  }',
    '',
    '  if (isProcessRunning(pid)) {',
    "    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {",
    "      stdio: 'ignore',",
    '      windowsHide: true,',
    '    });',
    '    if (result.status !== 0 && isProcessRunning(pid)) {',
    "      throw new Error(`Failed to stop server process: ${pid}`);",
    '    }',
    '  }',
    '',
    '  cleanupState();',
    "  console.log('Server stopped.');",
    '}',
    '',
    'async function main() {',
    "  if (command === 'stop') {",
    '    stop();',
    '    return;',
    '  }',
    '  await start();',
    '}',
    '',
    'main().catch((error) => {',
    "  console.error(error && error.message ? error.message : String(error));",
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
}

function renderBootstrapJs() {
  return [
    "const path = require('path');",
    '',
    "const port = String(process.argv[2] || process.env.PORT || '3000');",
    'process.env.PORT = port;',
    "process.chdir(path.join(__dirname, '..'));",
    "require('../server/index.js');",
    '',
  ].join('\n');
}

module.exports = {
  getPackagePaths,
  getCopyEntries,
  extractNodeModuleVersion,
  buildNodeRuntimeArchiveName,
  buildNodeRuntimeDirectoryName,
  buildNodeRuntimeDownloadUrl,
  renderStartBat,
  renderStopBat,
  renderLauncherJs,
  renderBootstrapJs,
};
