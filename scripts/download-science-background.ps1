param(
  [string]$Log = "$PSScriptRoot\..\.cache\download-science.log"
)

# Wrapper so the download can be launched as a detached process and keep
# running after the parent shell exits. All output is appended to $Log.
$ErrorActionPreference = 'Continue'
$logPath = [System.IO.Path]::GetFullPath($Log)
New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null

"=== runner start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') pid=$PID ===" |
  Out-File -FilePath $logPath -Encoding UTF8 -Append

& (Join-Path $PSScriptRoot 'download-science-model.ps1') *>&1 |
  Out-File -FilePath $logPath -Encoding UTF8 -Append

"=== runner exit=$LASTEXITCODE $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" |
  Out-File -FilePath $logPath -Encoding UTF8 -Append
