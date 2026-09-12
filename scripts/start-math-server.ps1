param(
  [int]$Port = 8090,
  [string]$ModelPath = "$PSScriptRoot\..\models\Qwen2.5-Math-7B-Instruct",
  [string]$PythonExe = ''
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedModel = [System.IO.Path]::GetFullPath($ModelPath)
. (Join-Path $PSScriptRoot 'resolve-python.ps1')
$python = Resolve-PythonExe -Modules @('torch', 'transformers', 'fastapi', 'uvicorn') -Root $root -Prefer $PythonExe
if ($null -eq $python) {
  throw 'No Python interpreter with torch/transformers/fastapi/uvicorn. Install them first.'
}
if (-not (Test-Path -LiteralPath $resolvedModel)) {
  throw "Math model directory not found: $resolvedModel"
}

$env:MATH_MODEL_PATH = $resolvedModel
$env:MATH_MODEL_NAME = 'Qwen2.5-Math-7B-Instruct'
$env:MATH_MAX_NEW_TOKENS = '2048'
Set-Location -LiteralPath $root
Write-Host "Starting local math model service on 127.0.0.1:$Port"
Write-Host "Model path: $resolvedModel"
Write-Host 'The model is loaded on the first math request.'
& $python -m uvicorn math_service.math_server:app --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
