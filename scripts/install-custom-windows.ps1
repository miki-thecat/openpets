$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "This installer helper is for Windows only."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "[OpenPets Custom] Preparing daily-driver build..." -ForegroundColor Cyan

# Close the installed app so the NSIS installer can replace its files.
Get-Process openpets -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Close only Electron dev processes that were launched from this repository.
try {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($repoRoot) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {
  Write-Warning "Could not inspect Electron dev processes. Close the dev OpenPets window manually if packaging reports a locked file."
}

Start-Sleep -Milliseconds 700

# Back up the existing OpenPets user data. Installing this fork intentionally
# keeps the same app identity/user-data path so pets, plugins, and settings carry over.
$userData = Join-Path $env:APPDATA "@open-pets\desktop"
if (Test-Path $userData) {
  $backupRoot = Join-Path $repoRoot ".backups"
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupZip = Join-Path $backupRoot "openpets-userdata-$stamp.zip"
  Write-Host "[OpenPets Custom] Backing up user data -> $backupZip" -ForegroundColor DarkCyan
  Compress-Archive -Path (Join-Path $userData "*") -DestinationPath $backupZip -Force
}

Write-Host "[OpenPets Custom] Typechecking desktop..." -ForegroundColor Cyan
& pnpm --filter @open-pets/desktop typecheck
if ($LASTEXITCODE -ne 0) { throw "Desktop typecheck failed." }

Write-Host "[OpenPets Custom] Building Windows installer..." -ForegroundColor Cyan
& pnpm --filter @open-pets/desktop package
if ($LASTEXITCODE -ne 0) {
  throw "Packaging failed. On Windows, enable Developer Mode or run PowerShell as Administrator if the symlink preflight reports a privilege error."
}

$dist = Join-Path $repoRoot "apps\desktop\dist-electron"
$installer = Get-ChildItem -Path $dist -Filter "OpenPets-*-win-*-setup.exe" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw "Windows installer was not found in $dist"
}

Write-Host "[OpenPets Custom] Installer ready:" -ForegroundColor Green
Write-Host $installer.FullName -ForegroundColor Green
Write-Host "[OpenPets Custom] Opening installer. Install it over the existing OpenPets installation." -ForegroundColor Yellow

Start-Process -FilePath $installer.FullName
