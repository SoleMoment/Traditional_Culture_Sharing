const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const nodeAbi = require('node-abi');
const {
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
} = require('./portable-package-lib');

const projectRoot = path.resolve(__dirname, '..');
const paths = getPackagePaths(projectRoot);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanTarget(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function ensureSupportedArch(arch) {
  if (arch === 'x64' || arch === 'arm64' || arch === 'ia32') {
    return arch;
  }
  throw new Error(`Unsupported Windows arch for portable runtime: ${arch}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(targetPath, buffer);
}

async function findLatestNodeVersionForAbi(abi, arch) {
  const targetVersion = nodeAbi.getTarget(String(abi), 'node');
  const major = String(targetVersion).split('.')[0];
  const normalizedArch = arch === 'ia32' ? 'x86' : arch;
  const requiredFile = `win-${normalizedArch}-zip`;
  const releases = await fetchJson('https://nodejs.org/dist/index.json');
  const release = releases.find((item) => {
    return String(item.version || '').startsWith(`v${major}.`)
      && Array.isArray(item.files)
      && item.files.includes(requiredFile);
  });

  if (!release) {
    throw new Error(`No Node.js ${major}.x Windows runtime found for ABI ${abi}.`);
  }

  return String(release.version).replace(/^v/, '');
}

async function ensureCompatibleRuntime(arch) {
  const betterSqlite3Path = path.join(projectRoot, 'node_modules', 'better-sqlite3');
  try {
    const Database = require(betterSqlite3Path);
    const probeDb = new Database(':memory:');
    probeDb.close();
    return {
      nodePath: process.execPath,
      version: process.versions.node,
      source: 'local',
    };
  } catch (error) {
    const abi = extractNodeModuleVersion(error && error.stack ? error.stack : error && error.message);
    if (!abi) {
      throw error;
    }

    const version = await findLatestNodeVersionForAbi(abi, arch);
    const normalizedArch = arch === 'ia32' ? 'x86' : arch;
    const cacheRoot = path.join(paths.distDir, '.runtime-cache');
    const archiveName = buildNodeRuntimeArchiveName(version, normalizedArch);
    const archivePath = path.join(cacheRoot, archiveName);
    const runtimeDir = path.join(cacheRoot, buildNodeRuntimeDirectoryName(version, normalizedArch));
    const nodePath = path.join(runtimeDir, 'node.exe');

    ensureDir(cacheRoot);

    if (!fs.existsSync(nodePath)) {
      if (!fs.existsSync(archivePath)) {
        const downloadUrl = buildNodeRuntimeDownloadUrl(version, normalizedArch);
        console.log(`Downloading compatible Node.js runtime: ${downloadUrl}`);
        await downloadFile(downloadUrl, archivePath);
      }

      execFileSync('tar.exe', ['-xf', archivePath, '-C', cacheRoot], {
        stdio: 'inherit',
      });
    }

    if (!fs.existsSync(nodePath)) {
      throw new Error(`Downloaded runtime is incomplete: ${nodePath}`);
    }

    return {
      nodePath,
      version,
      source: 'download',
    };
  }
}

function copyRuntime(runtimeNodePath, outputDir) {
  const runtimeDir = path.join(outputDir, 'runtime');
  ensureDir(runtimeDir);
  fs.copyFileSync(runtimeNodePath, path.join(runtimeDir, 'node.exe'));
}

function writeControlFiles(outputDir) {
  const controlDir = path.join(outputDir, 'app-control');
  ensureDir(controlDir);

  fs.writeFileSync(path.join(outputDir, '一键启动.bat'), renderStartBat(), 'utf8');
  fs.writeFileSync(path.join(outputDir, '一键停止.bat'), renderStopBat(), 'utf8');
  fs.writeFileSync(path.join(controlDir, 'launcher.js'), renderLauncherJs(), 'utf8');
  fs.writeFileSync(path.join(controlDir, 'start-server.js'), renderBootstrapJs(), 'utf8');
}

function copyProjectFiles(outputDir) {
  const entries = getCopyEntries(projectRoot);
  for (const entry of entries) {
    if (!fs.existsSync(entry.source)) {
      throw new Error(`缺少打包输入：${entry.source}`);
    }
    fs.cpSync(entry.source, path.join(outputDir, entry.target), {
      recursive: true,
      force: true,
    });
  }
}

function createZip(outputDir, zipPath) {
  execFileSync(
    'tar.exe',
    [
      '-a',
      '-c',
      '-f',
      zipPath,
      '-C',
      path.dirname(outputDir),
      path.basename(outputDir),
    ],
    {
      stdio: 'inherit',
    }
  );
}

async function main() {
  const arch = ensureSupportedArch(process.arch);
  const runtime = await ensureCompatibleRuntime(arch);

  ensureDir(paths.distDir);
  cleanTarget(paths.outputDir);
  cleanTarget(paths.zipPath);
  ensureDir(paths.outputDir);
  ensureDir(path.join(paths.outputDir, 'app-state'));
  ensureDir(path.join(paths.outputDir, 'logs'));

  copyProjectFiles(paths.outputDir);
  copyRuntime(runtime.nodePath, paths.outputDir);
  writeControlFiles(paths.outputDir);
  createZip(paths.outputDir, paths.zipPath);

  console.log(`Portable package created: ${paths.outputDir}`);
  console.log(`Portable zip created: ${paths.zipPath}`);
  console.log(`Portable runtime source: ${runtime.source} Node ${runtime.version}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
