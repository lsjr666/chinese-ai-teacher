<#
.SYNOPSIS
  Pack this project into a self-contained folder that runs on another PC from a
  USB drive, without installing Node.js, Python, llama.cpp or any dependencies.

.DESCRIPTION
  What makes the copy self-contained (everything else already is):
    - runtime\node    : bundled Node.js (backend + vite run without installing Node)
    - runtime\python  : full CPython + torch/transformers/fastapi (math & science
                        Python services run without installing Python) - created by
                        this script if missing, copied from the machine running it
    - runtime\*.dll   : llama.cpp with the CUDA runtime DLLs (no CUDA toolkit needed)
    - models\         : all weights live inside the project already
  Excluded on purpose: .cache, .workbuddy, __pycache__, *.pyc, and (unless
  -IncludeFullScienceModel) models\Intern-S1-mini, the 16 GB bfloat16 fallback
  that is redundant while the 8.5 GB GGUF default is present.

  Target machine requirements: Windows 10/11 x64; ~28 GB free on the drive;
  16 GB RAM minimum / 32 GB to run all three models at once; an NVIDIA GPU with
  a reasonably current driver for GPU acceleration (CPU-only machines need a
  CPU build of llama-server.exe swapped into runtime\).

.PARAMETER Destination
  Target folder, e.g. -Destination E:\AITeacher. Created if missing.

.PARAMETER IncludeFullScienceModel
  Also copy models\Intern-S1-mini (16 GB). Only needed if you want the Python
  bfloat16 science fallback on the target machine.

.PARAMETER SkipModels
  Copy everything except model weights. For quickly verifying this script;
  a copy made this way cannot serve questions.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\make-portable.ps1 -Destination E:\AITeacher
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Destination,
  [switch]$IncludeFullScienceModel,
  [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dest = [System.IO.Path]::GetFullPath($Destination)

if ($dest -eq $root -or $root.StartsWith($dest, [System.StringComparison]::OrdinalIgnoreCase) -or $dest.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destination must be outside the project folder: $dest"
}

# --- destination drive sanity checks -----------------------------------------
$driveLetter = $dest.Substring(0, 1)
if ($driveLetter -notmatch '^[A-Za-z]$' -or $dest.Substring(1, 2) -ne ':\') {
  throw "Destination must be a local drive path like E:\AITeacher (UNC paths are not supported)."
}
$drive = Get-PSDrive -Name $driveLetter -ErrorAction SilentlyContinue
if ($null -eq $drive) { throw "Drive ${driveLetter}: not found." }
$volume = Get-Volume -DriveLetter $driveLetter -ErrorAction SilentlyContinue
$fs = if ($volume) { $volume.FileSystem } else { $drive.FileSystem }
if ($fs -match '^FAT') {
  throw "Drive ${driveLetter}: is $fs. Model weight files exceed the 4 GB FAT limit; reformat the drive as exFAT or NTFS."
}

# --- estimate required space ---------------------------------------------------
function Get-TreeSize([string]$Path) {
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object Length -Sum).Sum
  if ($null -eq $sum) { 0L } else { [long]$sum }
}

$needed = 0L
foreach ($item in 'runtime','node_modules','science_service','math_service','client','server','scripts','dist','docs') {
  $p = Join-Path $root $item
  if (Test-Path -LiteralPath $p) { $needed += Get-TreeSize $p }
}
Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | ForEach-Object { $needed += $_.Length }
if (-not $SkipModels) {
  $modelsSize = Get-TreeSize (Join-Path $root 'models')
  $excludedSize = 0L
  $excludeModelDirs = @()
  if (-not $IncludeFullScienceModel) { $excludeModelDirs += 'Intern-S1-mini' }
  foreach ($name in $excludeModelDirs) {
    $d = Join-Path $root "models\$name"
    if (Test-Path -LiteralPath $d) { $excludedSize += Get-TreeSize $d }
  }
  $needed += ($modelsSize - $excludedSize)
}

if ($drive.Free -lt ($needed * 1.1)) {
  throw ("Drive {0}: has {1:N1} GB free, need about {2:N1} GB." -f $driveLetter, ($drive.Free / 1GB), ($needed / 1GB))
}

# --- ensure the bundled python exists ------------------------------------------
$portablePython = Join-Path $root 'runtime\python\python.exe'
if (-not (Test-Path -LiteralPath $portablePython)) {
  Write-Host 'runtime\python is missing; packing the local Python installation...'
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311')
  ) | Where-Object { Test-Path -LiteralPath $_ }
  if (-not $candidates) { throw 'No local Python 3.11/3.12 installation found to pack. Install Python with torch/transformers first.' }
  robocopy $candidates[0] (Join-Path $root 'runtime\python') /E /MT:8 /R:0 /W:0 /NFL /NDL /NP /XD __pycache__ /XF *.pyc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE while packing Python." }
  & $portablePython -c "import torch, transformers, fastapi, uvicorn" 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'The packed Python cannot import torch/transformers/fastapi/uvicorn.' }
  Write-Host 'Python packed and verified.'
}

# --- copy ------------------------------------------------------------------------
New-Item -ItemType Directory -Path $dest -Force | Out-Null

function Copy-Tree([string]$Source, [string]$Target, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @()) {
  $rc = @($Source, $Target, '/E', '/MT:8', '/R:1', '/W:1', '/NFL', '/NDL', '/NP')
  if ($ExcludeDirs.Count -gt 0) { $rc += '/XD'; $rc += $ExcludeDirs }
  if ($ExcludeFiles.Count -gt 0) { $rc += '/XF'; $rc += $ExcludeFiles }
  robocopy @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE) copying $Source" }
}

$dirs = @('client','server','scripts','math_service','science_service','runtime','node_modules','dist','docs') |
  Where-Object { Test-Path -LiteralPath (Join-Path $root $_) }
$rootFiles = @('package.json','package-lock.json','vite.config.js','start-ai-teacher.bat','README.md') |
  Where-Object { Test-Path -LiteralPath (Join-Path $root $_) }

Write-Host "Copying code + runtime to $dest ..."
foreach ($d in $dirs) { Copy-Tree (Join-Path $root $d) (Join-Path $dest $d) @('__pycache__') @('*.pyc') }
foreach ($f in $rootFiles) { Copy-Item -LiteralPath (Join-Path $root $f) -Destination $dest -Force }

if (-not $SkipModels) {
  Write-Host 'Copying model weights (this is the long part)...'
  $exclude = @('__pycache__')
  if (-not $IncludeFullScienceModel) { $exclude += 'Intern-S1-mini' }
  Copy-Tree (Join-Path $root 'models') (Join-Path $dest 'models') $exclude @('*.pyc')
}

# --- verify ----------------------------------------------------------------------
$sentinels = @(
  'start-ai-teacher.bat',
  'server\index.mjs',
  'runtime\node\node.exe',
  'runtime\llama-server.exe',
  'runtime\python\python.exe',
  'runtime\cudart64_12.dll',
  'node_modules\vite\bin\vite.js'
)
if (-not $SkipModels) {
  $sentinels += @('models\Qwen3VL-4B-Instruct-Q4_K_M.gguf', 'models\Intern-S1-mini-GGUF', 'models\Qwen2.5-Math-7B-Instruct')
}
$missing = @($sentinels | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dest $_)) })
if ($missing.Count -gt 0) { throw ("Copy incomplete, missing:`n" + ($missing -join "`n")) }

$copied = (Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1GB
Write-Host ("Done. {0:N1} GB copied to {1}" -f $copied, $dest)
Write-Host 'On the target PC: open the folder and double-click start-ai-teacher.bat.'
Write-Host 'First launch takes a few minutes: the science model is loaded from disk.'
