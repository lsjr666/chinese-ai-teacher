# install-sql-express.ps1 — 一键安装 SQL Server 2022 Express 并接好 AITeacherDB
# 用法：右键"以管理员身份运行"本脚本，或在管理员 PowerShell 中：
#   powershell -ExecutionPolicy Bypass -File scripts\install-sql-express.ps1
# 完成后：本机出现 SQLEXPRESS 实例（免费、无时间限制），AITeacherDB 建好，
# 项目 .env 自动切换到该实例。答题记录即写入正式 SQL Server。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 0. 自检管理员权限 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限，正在请求 UAC 授权（请在弹窗中点"是"）...'
  $args = @('-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Verb RunAs
  exit 0
}

$instance = 'SQLEXPRESS'
$serviceName = "MSSQL`$$instance"
$mediaDir = 'D:\SQLExprMedia'

function Test-Service {
  param([string]$Name)
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  return $null -ne $svc
}

# ---------- 1. 已装过就直接跳到建库 ----------
if (Test-Service -Name $serviceName) {
  Write-Host "[1/4] 检测到 $instance 实例已存在，跳过安装。"
} else {
  # ---------- 1a. 准备引导器 ----------
  $ssei = 'D:\ait-ssei.exe'
  if (-not (Test-Path $ssei)) {
    Write-Host '[1/4] 下载 SQL Server 2022 Express 官方引导器（约 4 MB）...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?linkid=2215160' -OutFile $ssei
  } else {
    Write-Host '[1/4] 使用已下载的引导器 D:\ait-ssei.exe。'
  }

  # ---------- 1b. 下载 Core 安装包（数据库引擎，约 250 MB） ----------
  Write-Host "[1/4] 下载 Express 安装包到 $mediaDir（约 250 MB，视网速 3-10 分钟）..."
  New-Item -ItemType Directory -Force -Path $mediaDir | Out-Null
  $dl = Start-Process -FilePath $ssei -ArgumentList @(
    '/Action=Download', '/MediaType=Core', "/DestinationPath=$mediaDir", '/Quiet'
  ) -PassThru -Wait
  Write-Host "      引导器退出码 $($dl.ExitCode)"

  # 找到信封安装包（SQLEXPR_x64*.exe 或 SQLEXPR2022*.exe）
  $envelope = Get-ChildItem -Path $mediaDir -Recurse -Filter 'SQLEXPR*.exe' |
    Sort-Object Length -Descending | Select-Object -First 1
  if (-not $envelope) {
    throw "未在 $mediaDir 找到 SQLEXPR 安装包。请检查网络后重跑，或手动从 https://www.microsoft.com/zh-cn/download/details.aspx?id=104781 下载。"
  }
  Write-Host "      安装包：$($envelope.FullName)（$([math]::Round($envelope.Length/1MB)) MB）"

  # ---------- 1c. 静默安装（只装数据库引擎，默认 SQLEXPRESS 实例） ----------
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
  $setup = Start-Process -FilePath $envelope.FullName -ArgumentList $setupArgs -PassThru -Wait
  Write-Host "      安装程序退出码 $($setup.ExitCode)"
  if (-not (Test-Service -Name $serviceName)) {
    throw "安装后未检测到 $serviceName 服务（退出码 $($setup.ExitCode)）。" +
      '可改为双击引导器图形界面安装（一路默认，实例名保持 SQLEXPRESS），装完再运行一次本脚本。'
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
