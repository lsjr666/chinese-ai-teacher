param(
  [string]$ModelUrl = "",
  [string]$MmprojUrl = "",
  [long]$ModelSize = 0,
  [long]$MmprojSize = 0,
  [string]$Variant = "4B"
)

$modelDir = [System.IO.Path]::GetFullPath("$PSScriptRoot\..\models")
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

if ([string]::IsNullOrWhiteSpace($ModelUrl)) {
  $ModelUrl = "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3VL-4B-Instruct-Q4_K_M.gguf?download=true"
}
if ([string]::IsNullOrWhiteSpace($MmprojUrl)) {
  $MmprojUrl = "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf?download=true"
}
if ($ModelSize -eq 0) { $ModelSize = 2497281664 }
if ($MmprojSize -eq 0) { $MmprojSize = 453974304 }

function Download-File($url, $target, [long]$expectedSize) {
  if (Test-Path -LiteralPath $target) {
    $existing = Get-Item -LiteralPath $target
    if ($existing.Length -eq $expectedSize) {
      Write-Host "Already exists, skipping: $target"
      return
    }
  }

  $segmentCount = if ($expectedSize -ge 268435456) { 8 } else { 4 }
  $segmentSize = [long][Math]::Ceiling($expectedSize / $segmentCount)
  $segmentPaths = @()
  $appendPaths = @()
  $processes = @()

  Write-Host "Downloading: $target"
  Write-Host "Source: $url"
  for ($index = 0; $index -lt $segmentCount; $index += 1) {
    $start = [long]($index * $segmentSize)
    $end = [long][Math]::Min($expectedSize - 1, (($index + 1) * $segmentSize) - 1)
    $expectedSegmentSize = $end - $start + 1
    $segment = "$target.part.$index"
    $append = "$segment.append"
    $currentSegmentSize = if (Test-Path -LiteralPath $segment) {
      (Get-Item -LiteralPath $segment).Length
    } else {
      0
    }
    if ($currentSegmentSize -gt $expectedSegmentSize) {
      throw "分段文件过大：$segment"
    }

    $segmentPaths += $segment
    $appendPaths += $append
    if ($currentSegmentSize -lt $expectedSegmentSize) {
      Remove-Item -LiteralPath $append -Force -ErrorAction SilentlyContinue
      $rangeStart = $start + $currentSegmentSize
      $arguments = @(
        '--fail', '--location', '--retry', '8', '--retry-delay', '3',
        '--connect-timeout', '20', '--max-time', '900',
        '--http1.1', '--tlsv1.2', '--range', "$rangeStart-$end",
        '--silent', '--show-error', '--output', $append, $url
      )
      $processes += Start-Process -FilePath 'curl.exe' -ArgumentList $arguments `
        -PassThru -WindowStyle Hidden
    }
  }

  while (($processes | Where-Object { -not $_.HasExited }).Count -gt 0) {
    Start-Sleep -Seconds 5
  }
  foreach ($process in $processes) {
    if ($process.ExitCode -ne 0) {
      throw "分段下载失败：$target，退出码 $($process.ExitCode)"
    }
  }

  for ($index = 0; $index -lt $segmentCount; $index += 1) {
    $start = [long]($index * $segmentSize)
    $end = [long][Math]::Min($expectedSize - 1, (($index + 1) * $segmentSize) - 1)
    $expectedSegmentSize = $end - $start + 1
    $segment = $segmentPaths[$index]
    $append = $appendPaths[$index]
    if (Test-Path -LiteralPath $append) {
      $currentSegmentSize = if (Test-Path -LiteralPath $segment) {
        (Get-Item -LiteralPath $segment).Length
      } else {
        0
      }
      $appendSize = (Get-Item -LiteralPath $append).Length
      if ($appendSize -ne ($expectedSegmentSize - $currentSegmentSize)) {
        throw "分段下载大小不正确：$segment"
      }
      $merged = "$segment.merged"
      $output = [IO.File]::Open($merged, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $buffer = New-Object byte[] (1024 * 1024)
        foreach ($source in @($segment, $append)) {
          if (-not (Test-Path -LiteralPath $source)) { continue }
          $input = [IO.File]::OpenRead($source)
          try {
            while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
              $output.Write($buffer, 0, $read)
            }
          } finally {
            $input.Dispose()
          }
        }
      } finally {
        $output.Dispose()
      }
      Move-Item -LiteralPath $merged -Destination $segment -Force
      Remove-Item -LiteralPath $append -Force
    }
    if ((Get-Item -LiteralPath $segment).Length -ne $expectedSegmentSize) {
      throw "分段文件大小不正确：$segment"
    }
  }

  $combined = "$target.combined"
  $output = [IO.File]::Open($combined, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $buffer = New-Object byte[] (1024 * 1024)
    foreach ($segment in $segmentPaths) {
      $input = [IO.File]::OpenRead($segment)
      try {
        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $output.Write($buffer, 0, $read)
        }
      } finally {
        $input.Dispose()
      }
    }
  } finally {
    $output.Dispose()
  }
  if ((Get-Item -LiteralPath $combined).Length -ne $expectedSize) {
    throw "合并文件大小不正确：$target"
  }
  Move-Item -LiteralPath $combined -Destination $target -Force
  $segmentPaths | ForEach-Object { Remove-Item -LiteralPath $_ -Force }
}

Download-File $ModelUrl (Join-Path $modelDir "Qwen3VL-$Variant-Instruct-Q4_K_M.gguf") $ModelSize
Download-File $MmprojUrl (Join-Path $modelDir "mmproj-Qwen3VL-$Variant-Instruct-Q8_0.gguf") $MmprojSize
Write-Host "Open-source vision model files are ready."
