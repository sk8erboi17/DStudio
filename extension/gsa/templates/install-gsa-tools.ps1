$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bin = Join-Path $Root 'bin'
$NucleiTemplatesDir = Join-Path $Root 'nuclei-templates'
$TrivyCacheDir = Join-Path $Root 'trivy-cache'
$GrypeDbCacheDir = Join-Path $Root 'grype\db'
$Warnings = New-Object System.Collections.Generic.List[string]
$Failures = New-Object System.Collections.Generic.List[string]
function Add-Warn([string]$Message) { $Warnings.Add($Message); Write-Warning $Message }
function Add-Fail([string]$Message) { $Failures.Add($Message); Write-Error $Message }
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
New-Item -ItemType Directory -Force -Path $NucleiTemplatesDir | Out-Null
New-Item -ItemType Directory -Force -Path $TrivyCacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $GrypeDbCacheDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'go') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'cargo\home') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'cargo\target') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'pipx') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'python') | Out-Null
$env:Path = "$Bin;$env:ProgramFiles\Go\bin;$env:ProgramFiles\nodejs;$env:USERPROFILE\.cargo\bin;$env:Path"
$env:GOBIN = $Bin
$env:GOPATH = Join-Path $Root 'go'
$env:GOMODCACHE = Join-Path $env:GOPATH 'pkg\mod'
$env:GOCACHE = Join-Path $env:GOPATH 'cache'
$env:CARGO_HOME = Join-Path $Root 'cargo\home'
$env:CARGO_TARGET_DIR = Join-Path $Root 'cargo\target'
$env:PIPX_HOME = Join-Path $Root 'pipx\home'
$env:PIPX_BIN_DIR = $Bin
$env:NUCLEI_TEMPLATES_DIR = $NucleiTemplatesDir
$env:TRIVY_CACHE_DIR = $TrivyCacheDir
$env:GRYPE_DB_CACHE_DIR = $GrypeDbCacheDir
Write-Host "Installing Go-based GSA tools into $Bin"
if (Get-Command go -ErrorAction SilentlyContinue) {
{{GO_INSTALL_LINES}}} else { Add-Fail 'Go is not installed; cannot install Go-based GSA tools. Install Go, then rerun this script.' }
function Test-AnyCommand([string[]]$Commands) { foreach ($Cmd in $Commands) { if (Get-Command $Cmd -ErrorAction SilentlyContinue) { return $true } }; return $false }
function Ensure-SystemTool([string]$Label, [string[]]$Commands, [string]$ChocoPackage) {
  if (Test-AnyCommand $Commands) { Write-Host "  - $Label present"; return }
  Write-Host "  - $Label missing; installing system package"
  if (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install -y $ChocoPackage
    if ($LASTEXITCODE -ne 0) { Add-Fail "$Label install failed via Chocolatey package $ChocoPackage" }
  } else {
    Add-Fail "$Label is missing and Chocolatey is not available for automatic install"
  }
  if (-not (Test-AnyCommand $Commands)) { Add-Fail "$Label command still unavailable after system package install" }
}
Write-Host 'Installing/validating system GSA tools'
Ensure-SystemTool 'trivy' @('trivy') 'trivy'
Ensure-SystemTool 'syft' @('syft') 'syft'
Ensure-SystemTool 'grype' @('grype') 'grype'
Ensure-SystemTool 'yara' @('yara') 'yara'
Ensure-SystemTool 'tshark' @('tshark') 'wireshark'
Ensure-SystemTool 'zeek' @('zeek') 'zeek'
Ensure-SystemTool 'nmap' @('nmap') 'nmap'
Ensure-SystemTool 'rizin' @('rizin','rz-bin','rz-find') 'rizin'
Ensure-SystemTool 'radare2' @('radare2','r2') 'radare2'
Ensure-SystemTool 'gdb' @('gdb') 'mingw'
Ensure-SystemTool 'exiftool' @('exiftool') 'exiftool'
Ensure-SystemTool 'jq' @('jq') 'jq'
Write-Host 'Installing/updating managed GSA tool data'
$NucleiExe = Join-Path $Bin 'nuclei.exe'
if (-not (Test-Path $NucleiExe)) { $NucleiExe = Join-Path $Bin 'nuclei' }
if (Test-Path $NucleiExe) {
  & $NucleiExe -update-templates -update-template-dir $NucleiTemplatesDir
  if ($LASTEXITCODE -ne 0) { Add-Warn 'nuclei update command failed; trying explicit template materialization' }
  $HasNucleiTemplates = (Test-Path (Join-Path $NucleiTemplatesDir 'http')) -or (Test-Path (Join-Path $NucleiTemplatesDir 'nuclei-templates\http'))
  if (-not $HasNucleiTemplates) {
    Write-Host "nuclei update did not materialize templates in $NucleiTemplatesDir; using explicit git/copy materialization"
    $HomeTemplates = Join-Path $HOME 'nuclei-templates'
    if (Test-Path (Join-Path $HomeTemplates 'http')) { Copy-Item (Join-Path $HomeTemplates '*') $NucleiTemplatesDir -Recurse -Force -ErrorAction SilentlyContinue; if (-not $?) { Add-Fail 'could not copy existing ~/nuclei-templates checkout' } }
    $HasNucleiTemplates = (Test-Path (Join-Path $NucleiTemplatesDir 'http')) -or (Test-Path (Join-Path $NucleiTemplatesDir 'nuclei-templates\http'))
    if (-not $HasNucleiTemplates -and (Get-Command git -ErrorAction SilentlyContinue)) {
      if (Test-Path (Join-Path $NucleiTemplatesDir '.git')) {
        git -C $NucleiTemplatesDir pull --ff-only
        if ($LASTEXITCODE -ne 0) { Add-Fail 'nuclei templates git pull failed' }
      } else {
        Remove-Item $NucleiTemplatesDir -Recurse -Force -ErrorAction SilentlyContinue
        git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates $NucleiTemplatesDir
        if ($LASTEXITCODE -ne 0) { Add-Fail 'nuclei templates git clone failed' }
      }
    }
    $HasNucleiTemplates = (Test-Path (Join-Path $NucleiTemplatesDir 'http')) -or (Test-Path (Join-Path $NucleiTemplatesDir 'nuclei-templates\http'))
    if (-not $HasNucleiTemplates) { Add-Fail 'nuclei templates were not found after update; rerun this script with git/network access' }
  }
} else { Add-Fail 'nuclei binary is not available; cannot install nuclei templates. Fix nuclei install, then rerun this script.' }
$Trivy = Get-Command trivy -ErrorAction SilentlyContinue
if ($Trivy) {
  & $Trivy.Source image --download-db-only --cache-dir $TrivyCacheDir
  if ($LASTEXITCODE -ne 0) { Add-Fail 'trivy vulnerability DB update failed' }
  & $Trivy.Source image --download-java-db-only --cache-dir $TrivyCacheDir
  if ($LASTEXITCODE -ne 0) { Add-Fail 'trivy Java DB update failed' }
} else { Add-Fail 'trivy is not installed after system tool installation; cannot prefetch vulnerability databases' }
$Grype = Get-Command grype -ErrorAction SilentlyContinue
if ($Grype) {
  & $Grype.Source db update
  if ($LASTEXITCODE -ne 0) { Add-Fail 'grype DB update failed' }
} else { Add-Fail 'grype is not installed after system tool installation; cannot prefetch vulnerability database' }
if (Get-Command cargo -ErrorAction SilentlyContinue) {
  cargo install binwalk --root $Root --locked --force
  if ($LASTEXITCODE -ne 0) { Add-Fail 'binwalk install failed via cargo' }
} else { Add-Fail 'Cargo is not installed; cannot install binwalk. Install Rust/Cargo, then rerun this script.' }
Write-Host 'Installing Node-based optional tools'
if (Get-Command npm -ErrorAction SilentlyContinue) {
  $NodeRoot = Join-Path $Root 'node'
  New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null
  npm install --prefix $NodeRoot playwright
  if ($LASTEXITCODE -ne 0) { Add-Fail 'playwright npm install failed' }
  $Pw = Join-Path $NodeRoot 'node_modules\.bin\playwright.cmd'
  if (Test-Path $Pw) {
    Copy-Item $Pw (Join-Path $Bin 'playwright.cmd') -Force
    & (Join-Path $Bin 'playwright.cmd') install chromium
    if ($LASTEXITCODE -ne 0) { Add-Fail 'playwright browser install failed' }
  } else { Add-Fail 'playwright binary was not produced by npm install' }
} else { Add-Fail 'Node.js/npm is not installed; cannot install Playwright. Install Node.js, then rerun this script.' }
$PyPkgs = @('plaso','volatility3','semgrep','sqlmap','arjun','uro','pwntools')
$PyConstraints = Join-Path $Root 'python\constraints.txt'
Set-Content -Path $PyConstraints -Value 'setuptools<81'
$env:PIP_CONSTRAINT = $PyConstraints
if (Get-Command pipx -ErrorAction SilentlyContinue) {
  function Install-ManagedPipxPackage([string]$Pkg) {
    Write-Host "  - $Pkg"
    $Venv = Join-Path $env:PIPX_HOME "venvs\$Pkg"
    if (Test-Path $Venv) {
      Write-Host "    refreshing managed pipx venv $Venv"
      try { Remove-Item $Venv -Recurse -Force -ErrorAction Stop } catch { Add-Fail "could not remove existing managed pipx venv for $Pkg"; return }
    }
    pipx install --force --pip-args "--constraint $PyConstraints" $Pkg
    if ($LASTEXITCODE -ne 0) { Add-Fail "$Pkg install failed via pipx" }
  }
  foreach ($Pkg in $PyPkgs) { Install-ManagedPipxPackage $Pkg }
} elseif ((Get-Command python3 -ErrorAction SilentlyContinue) -or (Get-Command python -ErrorAction SilentlyContinue)) {
  $Python = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } else { 'python' }
  $Venv = Join-Path $Root 'python\venv'
  if (Test-Path $Venv) { try { Remove-Item $Venv -Recurse -Force -ErrorAction Stop } catch { Add-Fail 'could not remove existing managed Python venv' } }
  & $Python -m venv $Venv
  if ($LASTEXITCODE -eq 0) {
    & (Join-Path $Venv 'Scripts\python.exe') -m pip install --upgrade pip 'setuptools<81' wheel; if ($LASTEXITCODE -ne 0) { Add-Fail 'pip/setuptools/wheel bootstrap failed in managed Python venv' }
    & (Join-Path $Venv 'Scripts\python.exe') -m pip install $PyPkgs; if ($LASTEXITCODE -ne 0) { Add-Fail 'one or more Python tools failed to install in managed venv' }
    Get-ChildItem (Join-Path $Venv 'Scripts') -File | Where-Object { $_.Extension -in '.exe','.cmd','.bat' } | ForEach-Object { Copy-Item $_.FullName (Join-Path $Bin $_.Name) -Force }
  } else { Add-Fail 'Python exists, but venv creation failed. Install venv support or use pipx, then rerun this script.' }
} else { Add-Fail 'Python 3 or pipx is not installed; cannot install Python-based GSA tools.' }
if ($Warnings.Count -gt 0) { Write-Host ''; Write-Host 'Completed with non-fatal warnings:'; foreach ($Warning in $Warnings) { Write-Host " - $Warning" } }
if ($Failures.Count -gt 0) { Write-Host ''; Write-Host 'Installer failed. Missing required managed tools/data:'; foreach ($Failure in $Failures) { Write-Host " - $Failure" }; exit 1 }
Write-Host 'All managed installer steps completed with required data present.'
