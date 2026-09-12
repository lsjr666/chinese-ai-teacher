# install-sql-express.ps1 — 一键安装 SQL Server 2022 Express 并接好 AITeacherDB
# 用法：右键开始菜单 →「终端(管理员)」→ 运行：
#   powershell -ExecutionPolicy Bypass -File "D:\中国人能教\scripts\install-sql-express.ps1"
# 完成后：本机出现 SQLEXPRESS 实例（免费、无时间限制），AITeacherDB 建好，
# 项目 .env 自动切换到该实例。答题记录即写入正式 SQL Server。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 0. 自检管理员权限 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限，正在请求 UAC 授权（请在弹窗中点"是"）...'
  $argList = @('-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
  exit 0
}

$instance = 'SQLEXPRESS'
$serviceName = "MSSQL`$$instance"
$mediaDir = 'D:\SQLExprMedia'
$logFile = Join-Path $mediaDir 'install-log.txt'
New-Item -ItemType Directory -Force -Path $mediaDir | Out-Null
Start-Transcript -Path $logFile -Force | Out-Null

# 官方直链（微软服务器，跳过会静默失败的 SSEI 引导器）
$envelopeUrl = 'https://download.microsoft.com/download/3/8/d/38de7036-2433-4207-8eae-06e247e17b25/SQLEXPR_x64_ENU.exe'
$envelopeSha256 = '2E61C8BBDE6021F9026C54AD9DB4BBB1227E68761D4C00A6A50A2C70FE7AFE05'

try {
  function Test-Service {
    param([string]$Name)
    return $null -ne (Get-Service -Name $Name -ErrorAction SilentlyContinue)
  }

  # ---------- 1. 已装过就直接跳到建库 ----------
  if (Test-Service -Name $serviceName) {
    Write-Host "[1/4] 检测到 $instance 实例已存在，跳过安装。"
  } else {
    # ---------- 1a. 直接下载安装包（约 280 MB） ----------
    $envelope = Join-Path $mediaDir 'SQLEXPR_x64_ENU.exe'
    $needDownload = $true
    if (Test-Path $envelope) {
      $size = (Get-Item $envelope).Length
      if ($size -gt 200MB) { $needDownload = $false }
      else { Remove-Item $envelope -Force }
    }
    if ($needDownload) {
      Write-Host "[1/4] 下载 SQL Server Express 安装包（约 280 MB，视网速 3-15 分钟）..."
      $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
      if (Test-Path $curl) {
        & $curl --fail --location --retry 3 -o $envelope $envelopeUrl
        if ($LASTEXITCODE -ne 0) { throw "curl 下载失败（退出码 $LASTEXITCODE）" }
      } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $envelopeUrl -OutFile $envelope -UseBasicParsing
      }
    }
    # 校验完整性
    $hash = (Get-FileHash $envelope -Algorithm SHA256).Hash
    Write-Host "      SHA256 校验：$hash"
    if ($hash -ne $envelopeSha256) { throw '安装包校验和不符合官方值，请删除后重跑脚本重新下载。' }
    Write-Host "      安装包就绪：$envelope"

    # ---------- 1b. 静默安装（只装数据库引擎，默认 SQLEXPRESS 实例） ----------
    Write-Host '[2/4] 静默安装 SQL Server Express（10-20 分钟，期间窗口可能无输出，请勿关闭）...'
    $setupArgs = @(
      '/q', '/HIDECONSOLE',
      '/ACTION=Install', '/FEATURES=SQLEngine',
      "/INSTANCENAME=$instance",
      '/ADDCURRENTUSERASSQLADMIN',
      '/SQLSVCACCOUNT="NT AUTHORITY\SYSTEM"', '/SQLSVCSTARTUPTYPE=Automatic',
      '/TCPENABLED=1', '/NPENABLED=1',
      '/IACCEPTSQLSERVERLICENSETERMS',
      '/UpdateEnabled=0',
      '/SkipRules=RebootRequiredCheck'
    )
    $setup = Start-Process -FilePath $envelope -ArgumentList $setupArgs -PassThru -Wait
    Write-Host "      安装程序退出码 $($setup.ExitCode)"
    if (-not (Test-Service -Name $serviceName)) {
      throw "安装后未检测到 $serviceName 服务（退出码 $($setup.ExitCode)）。" +
        '详细日志见 C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log\Summary.txt；' +
        '也可双击安装包走图形界面安装（一路默认，实例名保持 SQLEXPRESS），装完再运行一次本脚本。'
    }
  }

  # ---------- 2. 启动服务 ----------
  Write-Host '[3/4] 启动 SQL Server 服务...'
  Set-Service -Name $serviceName -StartupType Automatic
  Start-Service -Name $serviceName
  Start-Sleep -Seconds 5
  Get-Service -Name $serviceName | Format-Table Status, Name, DisplayName

  # ---------- 3. 建 AITeacherDB 与记录表 ----------
  Write-Host '[4/4] 创建 AITeacherDB 与答题记录表...'
  $sql = @'
IF DB_ID('AITeacherDB') IS NULL CREATE DATABASE AITeacherDB;
GO
USE AITeacherDB;
GO
IF OBJECT_ID('dbo.query_records') IS NULL CREATE TABLE dbo.query_records (
  id BIGINT IDENTITY(1,1) PRIMARY KEY,
  client_ip NVARCHAR(64) NOT NULL,
  user_name NVARCHAR(64) NULL,
  subject NVARCHAR(20) NULL,
  stage NVARCHAR(20) NULL,
  question_text NVARCHAR(MAX) NOT NULL,
  model_mode NVARCHAR(40) NULL,
  model_calls NVARCHAR(MAX) NULL,
  duration_ms INT NULL,
  created_at DATETIME2(3) NOT NULL DEFAULT SYSDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_query_records_ip')
  CREATE INDEX IX_query_records_ip ON dbo.query_records(client_ip, created_at DESC);
GO
SELECT name FROM sys.databases WHERE name='AITeacherDB';
'@
  $sqlFile = Join-Path $env:TEMP 'ait-create-db.sql'
  [System.IO.File]::WriteAllText($sqlFile, $sql, (New-Object System.Text.UTF8Encoding($true)))
  sqlcmd -S "localhost\$instance" -E -b -i $sqlFile
  if ($LASTEXITCODE -ne 0) { throw "建库失败（sqlcmd 退出码 $LASTEXITCODE）" }

  # ---------- 4. 切换项目 .env ----------
  Write-Host '切换项目 .env 到 SQLEXPRESS 实例...'
  $envFile = Join-Path $PSScriptRoot '..\.env'
  $content = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { '' }
  if ($content -match 'MSSQL_SERVER=.*') {
    $content = $content -replace 'MSSQL_SERVER=.*', 'MSSQL_SERVER=localhost\SQLEXPRESS'
  } else {
    $content = $content + "`nMSSQL_SERVER=localhost\SQLEXPRESS`n"
  }
  [System.IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ''
  Write-Host '=================== 全部完成 ==================='
  Write-Host "实例：localhost\$instance（免费 Express，无时间限制）"
  Write-Host '数据库：AITeacherDB，表 dbo.query_records 已就绪'
  Write-Host '项目 .env 已指向该实例；重启后端即可生效。'
  Write-Host '原 Enterprise Evaluation 实例未做改动，可随时卸载。'
} catch {
  Write-Host ''
  Write-Host "!!!!!!!!!! 出错了 !!!!!!!!!!"
  Write-Host $_.Exception.Message
  Write-Host "完整日志：$logFile"
} finally {
  Stop-Transcript | Out-Null
  # 结束后不自动关窗，方便查看结果
  Write-Host ''
  Write-Host '按回车键关闭窗口...'
  Read-Host
}
