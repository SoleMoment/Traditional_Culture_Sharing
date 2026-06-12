$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageScript = Join-Path $PSScriptRoot 'package-portable.js'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'node command not found. Install Node.js on the packaging machine first.'
}

Push-Location $projectRoot
try {
  & node $packageScript
} finally {
  Pop-Location
}
