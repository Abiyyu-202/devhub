# DevHub setup for Windows (PowerShell 5.1+).
param(
  [switch]$Install,
  [switch]$Autostart,
  [switch]$Start,
  [switch]$WithYtDlp
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Have($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Install-Winget($id) {
  if (-not (Have 'winget')) {
    Write-Host "winget tidak tersedia. Install manual package: $id" -ForegroundColor Yellow
    return
  }
  winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
}

Write-Host "DevHub setup · Windows"

if (-not (Have 'node')) {
  if ($Install) {
    Install-Winget 'OpenJS.NodeJS.LTS'
  }
  Write-Host "Node.js belum terpasang. Install Node 20+ lalu buka terminal baru." -ForegroundColor Red
  exit 1
}

$major = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 20) {
  Write-Host "Node $(node -v) terlalu lama. Butuh Node 20+." -ForegroundColor Red
  exit 1
}
Write-Host "OK Node $(node -v)" -ForegroundColor Green

if ($Install) {
  if (-not (Have 'git')) { Install-Winget 'Git.Git' }
  if (-not (Have 'fzf')) { Install-Winget 'junegunn.fzf' }
  if (-not (Have 'ffmpeg')) { Install-Winget 'Gyan.FFmpeg' }
  if ($WithYtDlp -and -not (Have 'yt-dlp')) { Install-Winget 'yt-dlp.yt-dlp' }
}

if (-not (Have 'ffmpeg')) {
  Write-Host "Catatan: kompresi media di Windows butuh ffmpeg (winget install Gyan.FFmpeg)." -ForegroundColor Yellow
}
if (-not (Have 'tmux')) {
  Write-Host "Catatan: 'devhub agy' butuh tmux; di Windows pakai WSL." -ForegroundColor Yellow
}

# Shim supaya perintah 'devhub' bisa dipanggil dari cmd/PowerShell.
$BinDir = Join-Path $env:USERPROFILE 'bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cmdPath = Join-Path $BinDir 'devhub.cmd'
$cmdBody = "@echo off`r`nnode `"$Root\cli.mjs`" %*`r`n"
Set-Content -Path $cmdPath -Value $cmdBody -Encoding ASCII
Write-Host "OK devhub -> $cmdPath" -ForegroundColor Green

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$parts = $userPath -split ';' | Where-Object { $_ -ne '' }
if ($parts -notcontains $BinDir) {
  $newPath = (($parts + $BinDir) -join ';')
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$BinDir"
  Write-Host "OK $BinDir ditambahkan ke PATH user (buka terminal baru)." -ForegroundColor Green
}

if ($Autostart) {
  Write-Host "Mengaktifkan autostart..."
  & node "$Root\cli.mjs" autostart on
}

if ($Start) {
  Write-Host "Menjalankan DevHub..."
  & node "$Root\cli.mjs" start
}

Write-Host ""
Write-Host "Selesai."
Write-Host "  Dashboard : node `"$Root\cli.mjs`" dashboard"
Write-Host "  Autostart : devhub autostart on"
Write-Host "  Status    : devhub status"
Write-Host "  agy split : gunakan WSL + tmux"
