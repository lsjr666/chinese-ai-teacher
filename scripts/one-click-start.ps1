$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $psExe)) {
  $psExe = 'powershell.exe'
}

function Test-ListeningPort([int]$port) {
  $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-ListeningPort 8080)) {
  Start-Process -FilePath $psExe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
    '-File', (Join-Path $root 'scripts\start-llama-server.ps1')
  ) -WorkingDirectory $root
}

if (-not (Test-ListeningPort 8090)) {
  Start-Process -FilePath $psExe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
    '-File', (Join-Path $root 'scripts\start-math-server.ps1')
  ) -WorkingDirectory $root
}

# The science service only starts once its weights are fully on disk; launching it
# against a half-downloaded checkpoint would produce a window that dies instantly.
$scienceGgufDir = Join-Path $root 'models\Intern-S1-mini-GGUF'
$scienceFullDir = Join-Path $root 'models\Intern-S1-mini'
$scienceReady = $false
if (Test-Path -LiteralPath $scienceGgufDir) {
  $ggufPending = @(
    @(Get-ChildItem -LiteralPath $scienceGgufDir -Filter '*.part' -File -ErrorAction SilentlyContinue) +
    @(Get-ChildItem -LiteralPath $scienceGgufDir -Filter '*.incomplete' -File -ErrorAction SilentlyContinue)
  )
  $ggufWeights = @(Get-ChildItem -LiteralPath $scienceGgufDir -Filter '*.gguf' -File -ErrorAction SilentlyContinue)
  if ($ggufPending.Count -eq 0 -and $ggufWeights.Count -gt 0) { $scienceReady = $true }
}
if (-not $scienceReady -and (Test-Path -LiteralPath $scienceFullDir)) {
  $fullPending = @(
    @(Get-ChildItem -LiteralPath $scienceFullDir -Filter '*.part' -File -ErrorAction SilentlyContinue) +
    @(Get-ChildItem -LiteralPath $scienceFullDir -Filter '*.incomplete' -File -ErrorAction SilentlyContinue)
  )
  $fullCore = Join-Path $scienceFullDir 'config.json'
  if ($fullPending.Count -eq 0 -and (Test-Path -LiteralPath $fullCore)) { $scienceReady = $true }
}

if ($scienceReady -and -not (Test-ListeningPort 8100)) {
  Start-Process -FilePath $psExe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
    '-File', (Join-Path $root 'scripts\start-science-server.ps1')
  ) -WorkingDirectory $root
}

if (-not (Test-ListeningPort 8787)) {
  Start-Process -FilePath $psExe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
    '-File', (Join-Path $root 'scripts\start-backend.ps1')
  ) -WorkingDirectory $root
}

if (-not (Test-ListeningPort 5173)) {
  Start-Process -FilePath $psExe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
    '-File', (Join-Path $root 'scripts\start-client.ps1')
  ) -WorkingDirectory $root
}

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:5173/' | Out-Null
    Start-Process 'http://localhost:5173/'
    exit 0
  } catch {}
}

Write-Host 'Frontend did not respond within 30 seconds.'
Write-Host 'Keep the service windows open and inspect their output.'
Read-Host 'Press Enter to close'
