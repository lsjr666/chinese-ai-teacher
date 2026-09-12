param(
  [string]$ModelDir = "$PSScriptRoot\..\models\Qwen2.5-Math-7B-Instruct",
  [string]$Endpoint = 'https://www.modelscope.cn/models/Qwen/Qwen2.5-Math-7B-Instruct/resolve/master'
)

$ErrorActionPreference = 'Stop'
$resolvedDir = [System.IO.Path]::GetFullPath($ModelDir)
New-Item -ItemType Directory -Force -Path $resolvedDir | Out-Null
$files = @('tokenizer.json', 'tokenizer_config.json', 'vocab.json', 'model.safetensors.index.json')
foreach ($file in $files) {
  $target = Join-Path $resolvedDir $file
  if (Test-Path -LiteralPath $target) { Write-Host "Already exists: $file"; continue }
  $url = "$Endpoint/$file"
  Write-Host "Downloading: $file"
  & curl.exe --fail --location --retry 8 --retry-delay 3 --connect-timeout 20 --max-time 900 --http1.1 --tlsv1.2 --output $target $url
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $file" }
}
Write-Host "Math model files are complete: $resolvedDir"
