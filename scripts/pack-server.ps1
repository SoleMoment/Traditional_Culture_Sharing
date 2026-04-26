$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $projectRoot 'dist'
if (-not (Test-Path $distDir)) {
  New-Item -Path $distDir -ItemType Directory | Out-Null
}

$outputDir = Join-Path $distDir 'NetCommLab-server'
$legacyZip = Join-Path $distDir 'NetCommLab-server.zip'

if (Test-Path $outputDir) {
  Remove-Item $outputDir -Recurse -Force
}

if (Test-Path $legacyZip) {
  Remove-Item $legacyZip -Force
}

$excludeNames = @(
  '.git',
  'node_modules',
  '.vscode',
  'chathistory',
  'data',
  'nul'
)

$items = Get-ChildItem -LiteralPath $projectRoot -Force |
  Where-Object { $excludeNames -notcontains $_.Name }

if (-not $items) {
  throw 'No files to package.'
}

New-Item -Path $outputDir -ItemType Directory | Out-Null

foreach ($item in $items) {
  $targetPath = Join-Path $outputDir $item.Name
  Copy-Item -Path $item.FullName -Destination $targetPath -Recurse -Force
}

Write-Output "Package directory created: $outputDir"
