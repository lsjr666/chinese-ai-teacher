param(
  [int]$Port = 8787,
  [string]$ModelBaseUrl = "http://127.0.0.1:8080/v1",
  [string]$ModelName = "",
  [string]$MathModelBaseUrl = "http://127.0.0.1:8090",
  [string]$MathModelName = "Qwen2.5-Math-7B-Instruct",
  [string]$ScienceModelBaseUrl = "http://127.0.0.1:8100/v1",
  [string]$ScienceModelName = "Intern-S1-mini"
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root

function Resolve-Node {
  $bundled = Join-Path $root 'runtime\node\node.exe'
  if (Test-Path -LiteralPath $bundled) {
    return $bundled
  }

  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $systemNode) {
    return $systemNode.Source
  }

  throw "Node.js was not found. Keep runtime\node\node.exe in the package, or install Node.js."
}

if ([string]::IsNullOrWhiteSpace($ModelName)) {
  $ModelName = "Qwen/Qwen3-VL-4B-Instruct-GGUF"
}

$env:PORT = "$Port"
$env:LOCAL_MODEL_RUNTIME = "llama.cpp"
$env:LOCAL_MODEL_BASE_URL = $ModelBaseUrl
$env:LOCAL_MODEL_NAME = $ModelName
$env:MATH_MODEL_BASE_URL = $MathModelBaseUrl
$env:MATH_MODEL_NAME = $MathModelName
$env:SCIENCE_MODEL_BASE_URL = $ScienceModelBaseUrl
$env:SCIENCE_MODEL_NAME = $ScienceModelName

Write-Host "Starting AI Teacher backend..."
Write-Host "Business API: http://127.0.0.1:$Port"
Write-Host "Model API: $ModelBaseUrl"
Write-Host "Math API: $MathModelBaseUrl"
Write-Host "Science API: $ScienceModelBaseUrl"
Write-Host "The LAN address will be printed after startup."
$node = Resolve-Node
& $node (Join-Path $root 'server\index.mjs')
exit $LASTEXITCODE
