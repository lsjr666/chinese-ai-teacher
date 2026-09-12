param(
  [ValidateSet('gguf', 'full')]
  [string]$Variant = 'gguf',
  [string]$ModelRepo = '',
  [string]$HuggingFaceRepo = '',
  [string]$ModelDir = '',
  [ValidateSet('direct', 'huggingface')]
  [string]$Source = 'direct',
  [string]$PythonExe = '',
  [int]$Workers = 4,
  [switch]$Background,
  [string]$TaskName = 'AITeacherScienceDownload'
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'resolve-python.ps1')

# Two shapes of the same model:
#   gguf -> Q8_0 weights + vision projector (~8.7 GB). Runs on CPU through the
#           llama.cpp runtime with ~9 GB of RAM, which is what this project uses.
#   full -> the original bfloat16 safetensors (~16 GB). Only usable when the
#           machine has 32 GB+ of RAM or a working CUDA build of PyTorch.
if ($Variant -eq 'gguf') {
  if (-not $ModelRepo) { $ModelRepo = 'Shanghai_AI_Laboratory/Intern-S1-mini-GGUF' }
  if (-not $ModelDir) { $ModelDir = "$PSScriptRoot\..\models\Intern-S1-mini-GGUF" }
  $entry = Join-Path $PSScriptRoot 'download_intern_gguf.py'
  $sizeHint = '~8.7 GB'
} else {
  if (-not $ModelRepo) { $ModelRepo = 'Shanghai_AI_Laboratory/Intern-S1-mini' }
  if (-not $ModelDir) { $ModelDir = "$PSScriptRoot\..\models\Intern-S1-mini" }
  $entry = Join-Path $PSScriptRoot 'download_intern_mini.py'
  $sizeHint = '~16 GB'
}

$resolvedDir = [System.IO.Path]::GetFullPath($ModelDir)
New-Item -ItemType Directory -Force -Path $resolvedDir | Out-Null

# The default engine is a stdlib-only downloader: it resumes with HTTP Range,
# verifies every file size before renaming, and keeps a progress JSON. It needs no
# third-party packages, so any working Python 3.8+ will do.
$needHelp = if ($Source -eq 'huggingface') { @('huggingface_hub') } else { @() }
$python = Resolve-PythonExe -Modules $needHelp -Root $root -Prefer $PythonExe
if ($null -eq $python) {
  if ($Source -eq 'huggingface') {
    throw "No Python interpreter with 'huggingface_hub'. Run: pip install huggingface_hub"
  }
  throw 'No usable Python 3 interpreter was found. Install Python 3.8+ first.'
}

if ($Background) {
  # A scheduled task runs python.exe directly and survives this console closing.
  # It is registered to repeat so an interrupted transfer picks itself back up.
  if ($PSBoundParameters.ContainsKey('ModelRepo') -or $PSBoundParameters.ContainsKey('ModelDir')) {
    Write-Host 'Note: -Background runs the stock entry point, so custom -ModelRepo/-ModelDir are ignored.' -ForegroundColor Yellow
  }
  $tr = '"' + $python + '" "' + $entry + '"'
  # schtasks writes to stderr for a missing task, and with
  # $ErrorActionPreference='Stop' that alone would abort the script. Native calls
  # are therefore run under 'Continue' and their exit codes checked instead.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & schtasks /query /tn $TaskName *> $null
  if ($LASTEXITCODE -eq 0) { & schtasks /delete /tn $TaskName /f *> $null }
  & schtasks /create /tn $TaskName /tr $tr /sc minute /mo 15 /f *> $null
  $created = ($LASTEXITCODE -eq 0)
  if ($created) { & schtasks /run /tn $TaskName *> $null }
  $ErrorActionPreference = $previousPreference
  if (-not $created) {
    throw "Could not register the scheduled task '$TaskName'. Try running this command as administrator."
  }
  Write-Host "Started a background download (scheduled task $TaskName, every 15 minutes)."
  Write-Host "Target : $resolvedDir ($sizeHint)"
  Write-Host "Progress: $root\.cache\download-gguf-progress.json"
  Write-Host "Log     : $root\.cache\download-science.log"
  Write-Host "Stop    : schtasks /delete /tn $TaskName /f"
  exit 0
}

Set-Location -LiteralPath $root
Write-Host "Downloading Intern-S1-mini ($Variant, $sizeHint) to $resolvedDir"
Write-Host "Source: $Source"
Write-Host "Python: $python"

$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
$env:SCIENCE_MODEL_REPO = $ModelRepo
$env:SCIENCE_MODEL_DIR = $resolvedDir
$env:SCIENCE_DOWNLOAD_WORKERS = "$Workers"
# Cache and scratch files stay inside the project so the system drive is untouched.
$cacheDir = Join-Path $root '.cache\modelscope'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$env:MODELSCOPE_CACHE = $cacheDir
# ModelScope is reachable directly from China; a broken system proxy would hurt.
$env:NO_PROXY = 'modelscope.cn,.modelscope.cn,aliyuncs.com,.aliyuncs.com,127.0.0.1,localhost'
$env:no_proxy = $env:NO_PROXY

if ($Source -eq 'huggingface') {
  if (-not $HuggingFaceRepo) { $HuggingFaceRepo = 'internlm/Intern-S1-mini' }
  & $python -c "from huggingface_hub import snapshot_download; snapshot_download('$HuggingFaceRepo', local_dir=r'$resolvedDir', resume_download=True)"
  if ($LASTEXITCODE -ne 0) {
    throw 'HuggingFace download failed. Run: pip install huggingface_hub'
  }
} else {
  & $python $entry
  $code = $LASTEXITCODE
  if ($code -eq 3) {
    Write-Host ''
    Write-Host 'Download is not finished yet. Run this same command again to resume.' -ForegroundColor Yellow
    Write-Host "Tip: add -Background to let it keep going without this window." -ForegroundColor Yellow
    exit 3
  }
  if ($code -ne 0) { throw "Download failed with exit code $code" }
}

Write-Host "Science model files are ready: $resolvedDir"
Write-Host 'Start it with: powershell -ExecutionPolicy Bypass -File .\scripts\start-science-server.ps1'
