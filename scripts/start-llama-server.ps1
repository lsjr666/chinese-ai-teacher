param(
  [string]$LlamaServerPath = "$PSScriptRoot\..\runtime\llama-server.exe",
  [string]$ModelPath = "",
  [string]$MmprojPath = "",
  [int]$Port = 8080,
  [int]$ContextSize = 4096
)

$resolvedServer = [System.IO.Path]::GetFullPath($LlamaServerPath)
if ([string]::IsNullOrWhiteSpace($ModelPath) -or [string]::IsNullOrWhiteSpace($MmprojPath)) {
  $modelCandidates = @(
    @{
      Model = "$PSScriptRoot\..\models\Qwen3VL-4B-Instruct-Q4_K_M.gguf"
      Mmproj = "$PSScriptRoot\..\models\mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf"
    }
  )
  $selected = $modelCandidates | Where-Object {
    (Test-Path -LiteralPath $_.Model) -and (Test-Path -LiteralPath $_.Mmproj)
  } | Select-Object -First 1
  if ($null -ne $selected) {
    $ModelPath = $selected.Model
    $MmprojPath = $selected.Mmproj
  }
}
$resolvedModel = [System.IO.Path]::GetFullPath($ModelPath)
$resolvedMmproj = [System.IO.Path]::GetFullPath($MmprojPath)
if (-not (Test-Path -LiteralPath $resolvedServer)) {
  Write-Error "llama-server.exe not found: $resolvedServer`nDownload the Windows CUDA build from https://github.com/ggml-org/llama.cpp/releases and put it in runtime\llama-server.exe."
  exit 1
}
if (-not (Test-Path -LiteralPath $resolvedModel)) {
  Write-Error "Local model not found: $resolvedModel`nRun scripts\download-open-model.ps1 first."
  exit 1
}
if (-not (Test-Path -LiteralPath $resolvedMmproj)) {
  Write-Error "Vision projector not found: $resolvedMmproj`nRun scripts\download-open-model.ps1 first."
  exit 1
}

$gpuLayers = 0
$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($null -ne $nvidiaSmi) {
  try {
    & $nvidiaSmi.Source -L *> $null
    if ($LASTEXITCODE -eq 0) {
      $gpuLayers = 99
    }
  } catch {}
}

Write-Host "Starting local open-source vision model: $resolvedModel"
Write-Host "The model files are local; no Internet is needed after startup."
Write-Host "GPU layers: $gpuLayers"
& $resolvedServer `
  -m $resolvedModel `
  --mmproj $resolvedMmproj `
  --host 127.0.0.1 `
  --port $Port `
  -c $ContextSize `
  --image-min-tokens 1024 `
  -ngl $gpuLayers `
  --jinja
