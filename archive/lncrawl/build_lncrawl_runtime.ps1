# build_lncrawl_runtime.ps1 - build a bundled portable Python runtime for the
# lightnovel-crawler (lncrawl) engine, so target machines need NO Python install.
#
# What it does:
#   1. download the official python-embed zip from python.org
#   2. extract it to runtime\python
#   3. enable "import site" + Lib\site-packages in the ._pth file
#   4. bootstrap pip (get-pip.py)
#   5. pip install lightnovel-crawler (bundles all 446 crawler sources)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build_lncrawl_runtime.ps1
#   build_lncrawl_runtime.bat              (double-click entry)
#   build_lncrawl_runtime.bat -Force       (rebuild from scratch)
#   $env:LNCRAWL_PYVER="3.12.10"           (override Python version, default 3.13.7)
#
# Build machine needs network. Target machine does not need Python at all.
# Loshop & Cpt
param(
    [string]$PyVer = $(if ($env:LNCRAWL_PYVER) { $env:LNCRAWL_PYVER } else { "3.13.7" }),
    [string]$OutDir = "runtime",
    [string]$LncrawlSpec = "lightnovel-crawler",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $root $OutDir
$pydir   = Join-Path $runtime "python"
$py      = Join-Path $pydir "python.exe"

# minor version, used to pick a pip bootstrap that still supports this Python
$pyMinor = 0
if ($PyVer -match '^3\.(\d+)\.') { $pyMinor = [int]$Matches[1] }

function Info($m) { Write-Host "[*] $m" }
function Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Die($m)  { Write-Host "[!] $m" -ForegroundColor Red; exit 1 }

function Test-Runtime() {
    if (-not (Test-Path $py)) { return $false }
    & $py -c "import lncrawl, sources, flask" 2>$null
    return ($LASTEXITCODE -eq 0)
}

if (-not $Force -and (Test-Runtime)) {
    Ok "Bundled runtime already ready: $py  (use -Force to rebuild)"
    exit 0
}

if (Test-Path $runtime) {
    Info "Removing old runtime ..."
    Remove-Item -Recurse -Force $runtime
}
New-Item -ItemType Directory -Force -Path $pydir | Out-Null

# --- 1) download and extract the embeddable Python ---
$zipName = "python-$PyVer-embed-amd64.zip"
$url     = "https://www.python.org/ftp/python/$PyVer/$zipName"
$zip     = Join-Path $env:TEMP $zipName
Info "Downloading portable Python $PyVer ..."
try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 180
} catch {
    Die "Download failed: $url`n    Check network, or set LNCRAWL_PYVER to another version (e.g. 3.12.10)."
}
Info "Extracting to runtime\python ..."
Expand-Archive -Path $zip -DestinationPath $pydir -Force
Remove-Item $zip -Force

# --- 2) enable site + site-packages (disabled by default in embed, pip needs it) ---
$pthFile = Get-ChildItem $pydir -Filter "python*._pth" | Select-Object -First 1
if (-not $pthFile) { Die "python*._pth not found; embed package looks broken." }
$lines = Get-Content $pthFile.FullName
$lines = $lines | ForEach-Object { if ($_ -eq "#import site") { "import site" } else { $_ } }
if ($lines -notcontains "Lib\site-packages") { $lines += "Lib\site-packages" }
Set-Content -Path $pthFile.FullName -Value $lines -Encoding ASCII
Info "Enabled site in $($pthFile.Name)"

# --- 3) bootstrap pip ---
# pip >= 25 dropped Python 3.8, so use the version-pinned bootstrap for old Pythons.
$pipUrl = "https://bootstrap.pypa.io/get-pip.py"
if ($pyMinor -gt 0 -and $pyMinor -le 8) { $pipUrl = "https://bootstrap.pypa.io/pip/3.$pyMinor/get-pip.py" }
$getpip = Join-Path $env:TEMP "get-pip-py$pyMinor.py"
Info "Downloading get-pip.py ($pipUrl) ..."
Invoke-WebRequest -Uri $pipUrl -OutFile $getpip -UseBasicParsing -TimeoutSec 180
Info "Installing pip ..."
& $py $getpip --no-warn-script-location
if ($LASTEXITCODE -ne 0) { Die "pip installation failed." }
Remove-Item $getpip -Force

# --- 4) install lightnovel-crawler (includes every crawler source) ---
# lncrawl depends on FastAPI, but lncrawl_server.py is a Flask app, so flask
# (and requests) must be installed into the runtime explicitly.
Info "Installing $LncrawlSpec + flask (many deps, first run is slow) ..."
# only touch pip itself when the running Python is new enough (>=3.9)
if ($pyMinor -ge 9) { & $py -m pip install --no-warn-script-location --upgrade pip }
& $py -m pip install --no-warn-script-location $LncrawlSpec flask requests
if ($LASTEXITCODE -ne 0) { Die "dependency installation failed." }

# --- 5) verify ---
Info "Verifying runtime ..."
if (-not (Test-Runtime)) { Die "Verification failed: cannot import lncrawl / sources / flask." }

$idx = Join-Path $pydir "Lib\site-packages\sources\_index.json"
$cnt = -1
if (Test-Path $idx) {
    $cnt = (Select-String -Path $idx -Pattern '"url"' -AllMatches).Matches.Count
}
$sizeMB = [math]::Round((Get-ChildItem -Recurse -Force -File $runtime | Measure-Object Length -Sum).Sum / 1MB, 1)
Ok "Build done: $py"
Ok "Source index entries: ~$cnt ; runtime size: $sizeMB MB"
Info "Deploy: put the whole runtime\ folder next to novaosd.exe. No Python needed on the target."
