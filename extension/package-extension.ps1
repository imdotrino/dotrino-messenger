# Build a zip of the extension ready for Web Store upload (PowerShell version).
# Excludes documentation, git, and the zip itself so the upload is minimal.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$manifest = Get-Content -Raw -Path manifest.json | ConvertFrom-Json
$out = "..\..\cc-messenger-extension-$($manifest.version).zip"

if (Test-Path $out) { Remove-Item $out -Force }

# Stage files (Compress-Archive doesn't support exclusion patterns well)
$staging = Join-Path $env:TEMP "cc-messenger-extension-stage"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

$include = @(
    'manifest.json',
    'background.js',
    'content.js',
    'offscreen.html',
    'offscreen.js',
    'overlay.css',
    'popup',
    'icons',
    'LICENSE'
)
foreach ($item in $include) {
    Copy-Item -Path $item -Destination (Join-Path $staging $item) -Recurse -Force
}

Compress-Archive -Path "$staging\*" -DestinationPath $out -Force
Remove-Item $staging -Recurse -Force

$size = (Get-Item $out).Length
Write-Host "OK Wrote $out ($size bytes)" -ForegroundColor Green
