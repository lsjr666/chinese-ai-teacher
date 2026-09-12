param(
  [int]$Port = 8100,
  [string]$GgufDir = "$PSScriptRoot\..\models\Intern-S1-mini-GGUF",
  [string]$FullModelDir = "$PSScriptRoot\..\models\Intern-S1-mini",
  [int]$GpuLayers = -1,
  [int]$ContextSize = 8192,
  [int]$Threads = 0,
  [string]$LlamaServer = "$PSScriptRoot\..\runtime\llama-server.exe",
  [string]$PythonExe = '',
  [ValidateSet('auto', 'cpu', 'cuda')]
  [string]$Device = 'auto',
  [ValidateSet('auto', 'bfloat16', 'float16', 'float32')]
  [string]$Dtype = 'auto',
  [switch]$LoadIn4Bit
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedGgufDir = [System.IO.Path]::GetFullPath($GgufDir)
$resolvedFullDir = [System.IO.Path]::GetFullPath($FullModelDir)

function Get-HintMessage {
  Write-Host ''
  Write-Host 'Intern-S1-mini is not ready yet.' -ForegroundColor Yellow
  Write-Host 'Download the quantised weights (recommended, ~8.7 GB):' -ForegroundColor Yellow
  Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\download-science-model.ps1 -Background' -ForegroundColor Yellow
  Write-Host 'The backend keeps working meanwhile: deep science questions fall back to Qwen3-VL.' -ForegroundColor Yellow
  Write-Host ''
}

function Get-PendingFiles {
  param([string]$Directory)
  if (-not (Test-Path -LiteralPath $Directory)) { return @() }
  return @(
    @(Get-ChildItem -LiteralPath $Directory -Filter '*.part' -File -ErrorAction SilentlyContinue) +
    @(Get-ChildItem -LiteralPath $Directory -Filter '*.incomplete' -File -ErrorAction SilentlyContinue)
  )
}

# ---------------------------------------------------------------------------
# Pick a backend.
#   GGUF + llama.cpp : Q8_0 weights, ~9 GB of RAM, this project's default.
#   safetensors      : the original bfloat16 checkpoint served by Python. Needs
#                      32 GB+ of RAM (or CUDA PyTorch), so it is the fallback.
# ---------------------------------------------------------------------------
$ggufModel = $null
$ggufMmproj = $null
$ggufPending = @()
if (Test-Path -LiteralPath $resolvedGgufDir) {
  $ggufPending = Get-PendingFiles -Directory $resolvedGgufDir
  $ggufModel = Get-ChildItem -LiteralPath $resolvedGgufDir -Filter '*.gguf' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*mmproj*' -and $_.Name -notlike '*.part' } |
    Sort-Object Length -Descending | Select-Object -First 1
  $ggufMmproj = Get-ChildItem -LiteralPath $resolvedGgufDir -Filter '*mmproj*.gguf' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*.part' } | Select-Object -First 1
}

# A half-written GGUF means the user deliberately chose this path and is still
# downloading it. Say so, instead of silently falling through to the 16 GB
# Transformers checkpoint, which would start fine here and then die on the first
# request when it cannot allocate 16 GB.
if ($ggufPending.Count -gt 0) {
  Write-Host 'The GGUF download is still running:' -ForegroundColor Yellow
  Write-Host "  $($ggufPending.Name -join ', ')" -ForegroundColor Yellow
  Get-HintMessage
  exit 2
}

if ($ggufModel) {
  if (-not (Test-Path -LiteralPath $LlamaServer)) {
    throw "llama-server.exe not found at $LlamaServer"
  }

  # -GpuLayers -1 means "auto": offload what comfortably fits the free VRAM.
  if ($GpuLayers -lt 0) {
    $GpuLayers = 0
    $smi = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
    if (Test-Path -LiteralPath $smi) {
      try {
        $free = [int](& $smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        $devices = (& $LlamaServer --list-devices 2>&1 | Out-String)
        if ($devices -notmatch '\(none\)') {
          # Q8_0 8B is roughly 245 MB per transformer layer. The reserve must be
          # generous: llama.cpp allocates the graph/compute buffer on the *first
          # request*, not at load time, so a server started with a thin margin
          # loads fine, answers /health, and then never returns a token from
          # generate(). Measured on a 8 GB laptop GPU: with ~300 MB free the
          # request hangs forever; the offload is only worth ~15% anyway.
          $layers = [math]::Floor(($free - 3000) / 245)
          if ($layers -gt 36) { $layers = 36 }
          if ($layers -gt 0) { $GpuLayers = $layers }
        }
      } catch {
        $GpuLayers = 0
      }
    }
  }

  $arguments = @(
    '-m', $ggufModel.FullName,
    '--host', '127.0.0.1',
    '--port', "$Port",
    '-c', "$ContextSize",
    '-ngl', "$GpuLayers",
    '--jinja'
  )
  if ($ggufMmproj) { $arguments += @('--mmproj', $ggufMmproj.FullName) }
  if ($Threads -gt 0) { $arguments += @('-t', "$Threads") }

  Set-Location -LiteralPath $root
  Write-Host "Starting local science model service on 127.0.0.1:$Port (llama.cpp)"
  Write-Host "Model   : $($ggufModel.Name)"
  if ($ggufMmproj) { Write-Host "Projector: $($ggufMmproj.Name)" }
  Write-Host "GPU layers: $GpuLayers  Context: $ContextSize"
  Write-Host 'Weights are memory-mapped, so the first token takes a few seconds.'
  & $LlamaServer @arguments
  exit $LASTEXITCODE
}

# --- fallback: original bfloat16 checkpoint through the Python service --------
$required = @('config.json', 'tokenizer_config.json')
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $resolvedFullDir $_)) })
$pending = Get-PendingFiles -Directory $resolvedFullDir
if (-not (Test-Path -LiteralPath $resolvedFullDir) -or $missing.Count -gt 0 -or $pending.Count -gt 0) {
  if ($pending.Count -gt 0) {
    Write-Host 'The safetensors download is still running:' -ForegroundColor Yellow
    Write-Host "  $($pending.Name -join ', ')" -ForegroundColor Yellow
  }
  Get-HintMessage
  exit 2
}

# The bfloat16 checkpoint is a 16 GB allocation at load time. Warn about it here
# instead of letting the first request trigger an allocation that gets killed.
$freeGb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
$needsGb = if ($LoadIn4Bit) { 6 } elseif ($Device -eq 'cuda') { 16 } else { 17 }
if ($freeGb -lt $needsGb) {
  Write-Host ''
  Write-Host "WARNING: about ${freeGb} GB of memory is free, but this configuration needs roughly ${needsGb} GB." -ForegroundColor Yellow
  Write-Host 'The Q8_0 GGUF only needs about 9 GB and is the recommended path:' -ForegroundColor Yellow
  Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\download-science-model.ps1 -Background' -ForegroundColor Yellow
  Write-Host 'Continuing anyway; the first deep science request may fail to load the weights.' -ForegroundColor Yellow
  Write-Host ''
}

. (Join-Path $PSScriptRoot 'resolve-python.ps1')
$python = Resolve-PythonExe -Modules @('torch', 'transformers', 'fastapi', 'uvicorn') -Root $root -Prefer $PythonExe
if ($null -eq $python) {
  throw 'No Python interpreter with torch/transformers/fastapi/uvicorn. Install them first.'
}

$env:SCIENCE_MODEL_PATH = $resolvedFullDir
$env:SCIENCE_MODEL_NAME = 'Intern-S1-mini'
$env:SCIENCE_MAX_NEW_TOKENS = '2048'
$env:SCIENCE_DEVICE = $Device
$env:SCIENCE_DTYPE = $Dtype
if ($LoadIn4Bit) { $env:SCIENCE_LOAD_IN_4BIT = '1' } else { $env:SCIENCE_LOAD_IN_4BIT = '0' }

Set-Location -LiteralPath $root
Write-Host "Starting local science model service on 127.0.0.1:$Port (transformers)"
Write-Host "Model path: $resolvedFullDir"
Write-Host "Device: $Device  Dtype: $Dtype  4bit: $($LoadIn4Bit.IsPresent)"
Write-Host 'Intern-S1-mini is loaded on the first deep-thinking science request.'
& $python -m uvicorn science_service.intern_server:app --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
