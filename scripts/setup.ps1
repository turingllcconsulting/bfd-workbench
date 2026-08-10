# BFD Workbench setup — Windows 10/11 (PowerShell 5.1 or 7+).
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# Checks each prerequisite, installs what is missing via winget where it safely
# can, and leaves you with a build that runs. Safe to re-run.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Say  ($m) { Write-Host "`n$m" -ForegroundColor White }
function Ok   ($m) { Write-Host "  [ok] $m"   -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  [x]  $m"   -ForegroundColor Red; exit 1 }

function Have ($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

# winget installs land in a PATH the current session has not picked up yet.
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

Say 'BFD Workbench setup (Windows)'

if (-not (Have 'winget')) {
  Warn 'winget not found. Install "App Installer" from the Microsoft Store, or install the prerequisites below by hand.'
}

# --- 1. WebView2 ---------------------------------------------------------------
# Tauri renders in WebView2. Windows 11 ships it; Windows 10 may not.
Say '1/6  WebView2 runtime'
$webview2 = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
if ($webview2) {
  Ok "WebView2 $($webview2.pv)"
} elseif (Have 'winget') {
  Warn 'Installing WebView2 runtime...'
  winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
  Ok 'WebView2 installed'
} else {
  Warn 'Install WebView2 from https://developer.microsoft.com/microsoft-edge/webview2/'
}

# --- 2. Visual Studio C++ build tools ------------------------------------------
# Rust's MSVC toolchain links against these. Without them cargo fails at link time.
Say '2/6  MSVC build tools'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
  Ok 'Visual Studio build tools present'
} elseif (Have 'winget') {
  Warn 'Installing Visual Studio Build Tools (large download, several minutes)...'
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements `
    --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
  Ok 'Build tools installed'
} else {
  Warn 'Install "Desktop development with C++" from https://visualstudio.microsoft.com/downloads/'
}

# --- 3. Node.js ----------------------------------------------------------------
Say '3/6  Node.js 18+'
if (Have 'node') {
  Ok "node $(node --version)"
} elseif (Have 'winget') {
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  Ok "node $(node --version)"
} else {
  Die 'Node.js not found. Install Node 18+ from https://nodejs.org and re-run.'
}

# --- 4. Rust -------------------------------------------------------------------
Say '4/6  Rust toolchain'
if (-not (Have 'rustc')) {
  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if (Test-Path $cargoBin) { $env:Path = "$cargoBin;$env:Path" }
}
if (Have 'rustc') {
  Ok (rustc --version)
} elseif (Have 'winget') {
  Warn 'Installing Rust via rustup...'
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  $env:Path = "$(Join-Path $env:USERPROFILE '.cargo\bin');$env:Path"
  Ok (rustc --version)
} else {
  Die 'Rust not found. Install from https://rustup.rs and re-run.'
}

# --- 5. Claude CLI -------------------------------------------------------------
Say '5/6  Claude CLI'
if (Have 'claude') {
  Ok 'claude present'
} else {
  Warn 'Installing @anthropic-ai/claude-code globally...'
  npm install -g @anthropic-ai/claude-code
  Refresh-Path
  Ok 'Claude CLI installed'
}

Say '     Claude authentication'
try {
  'reply with the word ok' | claude --print | Out-Null
  Ok 'Authenticated'
} catch {
  Warn "Not authenticated. Run 'claude login' in a terminal, then re-run this script."
}

# --- 6. Build ------------------------------------------------------------------
Say '6/6  Dependencies and backend build'
Set-Location $Root
npm install --no-audit --no-fund
Ok 'node_modules ready'

Warn 'Building the Rust backend (first build takes several minutes)...'
Set-Location (Join-Path $Root 'src-tauri')
cargo build
Ok 'Backend built'
Set-Location $Root

Say 'Setup complete'
Write-Host @'
  Run it:        npm run start        (dev build, hot reload)
  Package it:    npm run package      (installer in src-tauri\target\release\bundle\)

  Optional: create %USERPROFILE%\.bfd\global.md with notes you want in every conversation.
'@
