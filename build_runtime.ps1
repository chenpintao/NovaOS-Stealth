# ============================================================
#  build_runtime.ps1 -- build the embedded portable Python runtime
#  (runtime\python\) shipped with Tzy OS.
#
#  The runtime lets the target PC (including Windows 7) run Tzy OS
#  without installing Python. Everything is Python 3.8, which is the
#  last release supporting Windows 7 (Win7 SP1 also needs the UCRT
#  update KB2999226 - see BUILD.md).
#
#  Usage (build machine, needs internet):
#      powershell -NoProfile -ExecutionPolicy Bypass -File build_runtime.ps1
#      powershell ... -Force     force rebuild (default: skip if present)
#
#  Loshop & Cpt
# ============================================================
param([switch]$Force)

$ErrorActionPreference = "Stop"
$env:PYTHONDONTWRITEBYTECODE = "1"   # never write __pycache__ into the runtime
$ROOT = $PSScriptRoot
$PYVER = "3.8.10"
$RT = Join-Path $ROOT "runtime\python"
$CACHE = Join-Path $ROOT "build-cache"

if ((Test-Path (Join-Path $RT "python.exe")) -and (-not $Force)) {
    Write-Host "[*] runtime already exists (use -Force to rebuild): $RT"
    exit 0
}

New-Item -ItemType Directory -Path $CACHE -Force | Out-Null

# ---- 1) download + extract the official embed zip ----
$embedName = "python-$PYVER-embed-amd64.zip"
$embedZip = Join-Path $CACHE $embedName
if (-not (Test-Path $embedZip)) {
    Write-Host "[1/6] Downloading $embedName ..."
    Invoke-WebRequest "https://www.python.org/ftp/python/$PYVER/$embedName" -OutFile $embedZip
} else {
    Write-Host "[1/6] Using cached $embedName"
}

if (Test-Path $RT) { Remove-Item $RT -Recurse -Force }
New-Item -ItemType Directory -Path $RT -Force | Out-Null
Write-Host "[2/6] Extracting to runtime\python ..."
Expand-Archive -Path $embedZip -DestinationPath $RT -Force

# ---- 2) enable site + site-packages (embed is semi-isolated by default) ----
$pth = Join-Path $RT "python38._pth"
@("python38.zip", ".", "", "import site", "Lib\site-packages") |
    Set-Content -Path $pth -Encoding ASCII
Write-Host "[*] wrote $pth"

# ---- 3) install pip ----
$getPip = Join-Path $CACHE "get-pip.py"
if (-not (Test-Path $getPip)) {
    Write-Host "[3/6] Downloading get-pip.py ..."
    Invoke-WebRequest "https://bootstrap.pypa.io/pip/3.8/get-pip.py" -OutFile $getPip
}
Write-Host "[*] Installing pip into runtime ..."
& (Join-Path $RT "python.exe") $getPip --no-warn-script-location

# ---- 4) install pinned dependencies (--no-compile avoids __pycache__) ----
$pinned = @(
    "flask==3.0.3",
    "requests==2.32.4",
    "websocket-client==1.8.0",
    "beautifulsoup4==4.15.0",
    "lxml==5.4.0",
    "pycryptodome==3.24.0",
    "cryptography==47.0.0",
    "ebooklib==0.20",
    "charset-normalizer==3.5.2"
)
Write-Host "[4/6] Installing pinned dependencies ..."
& (Join-Path $RT "python.exe") -m pip install --no-compile --no-cache-dir `
    --disable-pip-version-check --no-warn-script-location @pinned

# ---- 5) trim: drop pip/setuptools, caches, headers, test data ----
Write-Host "[5/6] Trimming runtime ..."
$sp = Join-Path $RT "Lib\site-packages"
Remove-Item (Join-Path $sp "pip*"), (Join-Path $sp "setuptools*"),
    (Join-Path $sp "wheel*"), (Join-Path $sp "pkg_resources*") `
    -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $sp "distutils-precedence.pth") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $RT "Include"), (Join-Path $RT "Scripts") `
    -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $sp -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $sp -Recurse -Directory | Where-Object { $_.Name -eq "tests" } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $sp "Crypto\SelfTest"), (Join-Path $sp "lxml\includes") `
    -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $sp -Recurse -File -Include *.pyx, *.pxd, *.h |
    Remove-Item -Force -ErrorAction SilentlyContinue
# sqlite3 (unused) and python.cat (signature catalog) are safe to drop
Remove-Item (Join-Path $RT "_sqlite3.pyd"), (Join-Path $RT "sqlite3.dll"),
    (Join-Path $RT "python.cat") -Force -ErrorAction SilentlyContinue

# ---- 6) verify ----
Write-Host "[6/6] Verifying ..."
& (Join-Path $RT "python.exe") -c "import flask,requests,websocket,bs4,lxml.etree,Crypto,cryptography,ebooklib,charset_normalizer;print('runtime ok')"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] runtime verification FAILED"
    exit 1
}
$sum = (Get-ChildItem (Join-Path $ROOT "runtime") -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[*] runtime ready: {0:N1} MB" -f ($sum / 1MB))