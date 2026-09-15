param(
  [int]$Port = 8090,
  [string]$ModelPath = '',
  [string]$LlamaServer = '',
  [int]$GpuLayers = -1,
  [int]$ContextSize = 8192,
  [int]$Threads = 0
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $LlamaServer) { $LlamaServer = Join-Path $root 'runtime\llama-server.exe' }
if (-not $ModelPath) { $ModelPath = Join-Path $root 'models\Qwen2.5-Math-7B-Instruct-GGUF' }
$resolvedDir = [System.IO.Path]::GetFullPath($ModelPath)

if (-not (Test-Path -LiteralPath $LlamaServer)) {
  throw "llama-server.exe not found at $LlamaServer"
}

# 权重优先选 Q4_K_M：7B 量化后约 4.4 GB，比 bfloat16 的 15 GB 省得多，
# 纯 CPU 推理实测也快好几倍（PyTorch bf16 单题要 5-14 分钟）。
$gguf = $null
if (Test-Path -LiteralPath $resolvedDir) {
  $candidates = @(Get-ChildItem -LiteralPath $resolvedDir -Filter '*.gguf' -File -ErrorAction SilentlyContinue)
  $gguf = $candidates | Where-Object { $_.Name -match 'Q4_K_M' } | Select-Object -First 1
  if (-not $gguf) { $gguf = $candidates | Select-Object -First 1 }
}

if (-not $gguf) {
  Write-Host '还未下载数学模型的 GGUF 权重。' -ForegroundColor Yellow
  Write-Host '请先运行：'
  Write-Host '  python scripts\download_math_gguf.py'
  Write-Host '（约 4.4 GB；跑完后本脚本即可直接启动）'
  exit 2
}

if ($GpuLayers -lt 0) {
  $GpuLayers = 0
  $smi = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
  if (Test-Path -LiteralPath $smi) {
    try {
      $free = [int](& $smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
      $devices = (& $LlamaServer --list-devices 2>&1 | Out-String)
      if ($devices -notmatch '\(none\)') {
        # Q4_K_M 7B 每层约 140 MB。和科学模型同理：llama.cpp 的 graph/compute
        # buffer 是首个请求才分配的，余量给少了会「加载成功、/health 正常、
        # 但第一次生成永久挂住」，所以统一留 3 GB 余量，不够就退回纯 CPU。
        $layers = [math]::Floor(($free - 3000) / 140)
        if ($layers -gt 28) { $layers = 28 }
        if ($layers -gt 0) { $GpuLayers = $layers }
      }
    } catch {
      $GpuLayers = 0
    }
  }
}

$arguments = @(
  '-m', $gguf.FullName,
  '--host', '127.0.0.1',
  '--port', "$Port",
  '-c', "$ContextSize",
  '-ngl', "$GpuLayers",
  '--jinja'
)
if ($Threads -gt 0) { $arguments += @('-t', "$Threads") }

Set-Location -LiteralPath $root
Write-Host "正在启动数学服务（llama.cpp 版）127.0.0.1:$Port" -ForegroundColor Green
Write-Host "模型    : $($gguf.Name)"
Write-Host "GPU 层数: $GpuLayers  上下文: $ContextSize"
Write-Host ''
Write-Host '后端还需要这两个变量才会走这条通道（写在 .env 里）：'
Write-Host '  MATH_MODEL_RUNTIME=llama.cpp'
Write-Host '  MATH_MODEL_NAME=Qwen2.5-Math-7B-Instruct-GGUF'
Write-Host ''
& $LlamaServer @arguments
exit $LASTEXITCODE
