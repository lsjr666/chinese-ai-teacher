# migrate-sql-and-ssms.ps1 — 卸载过期 Enterprise → Express 重装到 D 盘 → 重建库 → 安装 SSMS 到 D 盘 → 桌面快捷方式 + 固定任务栏
# 用法（管理员终端）：
#   powershell -ExecutionPolicy Bypass -File "D:\中国人能教\scripts\migrate-sql-and-ssms.ps1"

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 0. 自检管理员权限 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限，正在请求 UAC 授权（请在弹窗中点"是"）...'
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-ExecutionPolicy','Bypass','-File',$PSCommandPath) -Verb RunAs
  exit 0
}

$mediaDir = 'D:\SQLExprMedia'
$logFile = Join-Path $mediaDir 'migrate-log.txt'
New-Item -ItemType Directory -Force -Path $mediaDir | Out-Null
Start-Transcript -Path $logFile -Force | Out-Null

$setupExe = 'C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\SQL2022\setup.exe'
$envelope = Join-Path $mediaDir 'SQLEXPR_x64_ENU.exe'
$instance = 'SQLEXPRESS'
$serviceName = "MSSQL`$$instance"

function Test-Service([string]$Name) {
  return $null -ne (Get-Service -Name $Name -ErrorAction SilentlyContinue)
}

try {
  # ---------- 1. 卸载过期的 Enterprise Evaluation（MSSQLSERVER） ----------
  if (Test-Service 'MSSQLSERVER') {
    Write-Host '[1/5] 卸载过期的 Enterprise Evaluation 实例（约 3-5 分钟）...'
    $u1 = Start-Process -FilePath $setupExe -ArgumentList @(
      '/q','/HIDECONSOLE','/ACTION=Uninstall','/INSTANCENAME=MSSQLSERVER','/FEATURES=SQLEngine'
    ) -PassThru -Wait
    Write-Host "      卸载退出码 $($u1.ExitCode)"
    if (Test-Service 'MSSQLSERVER') { Write-Host '      警告：MSSQLSERVER 服务仍在，可能需重启后再卸一次。' }
    else { Write-Host '      Enterprise Evaluation 已卸载。' }
  } else {
    Write-Host '[1/5] 未检测到 MSSQLSERVER（Enterprise），跳过卸载。'
  }

  # ---------- 2. 卸载 C 盘上的现有 SQLEXPRESS ----------
  if (Test-Service $serviceName) {
    Write-Host '[2/5] 卸载 C 盘现有 SQLEXPRESS（约 3-5 分钟，库为空无数据损失）...'
    $u2 = Start-Process -FilePath $setupExe -ArgumentList @(
      '/q','/HIDECONSOLE','/ACTION=Uninstall','/INSTANCENAME=SQLEXPRESS','/FEATURES=SQLEngine'
    ) -PassThru -Wait
    Write-Host "      卸载退出码 $($u2.ExitCode)"
    if (Test-Service $serviceName) { throw "SQLEXPRESS 卸载未完成（退出码 $($u2.ExitCode)），中止迁移。" }
  } else {
    Write-Host '[2/5] 未检测到现有 SQLEXPRESS，跳过卸载。'
  }

  # ---------- 3. 重装 SQLEXPRESS 到 D 盘 ----------
  # 2022 版合法参数：INSTANCEDIR=实例根目录，INSTALLSQLDATADIR=数据根目录（INSTALLSQLDIR 已不被识别）
  # 路径全部不带空格，避免引号传参被安装器吞掉
  Write-Host '[3/5] 重装 SQLEXPRESS 到 D 盘（10-20 分钟，期间可能无输出，请勿关闭）...'
  $dRoot = 'D:\SQLServer'
  New-Item -ItemType Directory -Force -Path $dRoot, "$dRoot\Backup" | Out-Null
  # 清理上次失败尝试留下的空目录
  Remove-Item 'D:\Microsoft SQL Server' -Recurse -Force -ErrorAction SilentlyContinue
  $install = Start-Process -FilePath $envelope -ArgumentList @(
    '/q','/HIDECONSOLE',
    '/ACTION=Install','/FEATURES=SQLEngine',
    '/INSTANCENAME=SQLEXPRESS',
    '/INSTANCEDIR=D:\SQLServer',
    '/INSTALLSQLDATADIR=D:\SQLServer',
    '/SQLBACKUPDIR=D:\SQLServer\Backup',
    '/ADDCURRENTUSERASSQLADMIN',
    '/SQLSVCACCOUNT="NT AUTHORITY\SYSTEM"','/SQLSVCSTARTUPTYPE=Automatic',
    '/TCPENABLED=1','/NPENABLED=1',
    '/IACCEPTSQLSERVERLICENSETERMS',
    '/UpdateEnabled=0',
    '/SkipRules=RebootRequiredCheck'
  ) -PassThru -Wait
  Write-Host "      安装退出码 $($install.ExitCode)"
  if (-not (Test-Service $serviceName)) {
    throw "重装后未检测到 $serviceName 服务。日志：C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log\Summary.txt"
  }
  Set-Service -Name $serviceName -StartupType Automatic
  Start-Service -Name $serviceName
  Start-Sleep -Seconds 5
  Write-Host "      SQLEXPRESS 已就绪（主体与数据均在 D 盘）。"

  # ---------- 4. 重建 AITeacherDB 与记录表 ----------
  Write-Host '[4/5] 重建 AITeacherDB 与答题记录表...'
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

  # ---------- 5. 安装 SSMS 到 D 盘 ----------
  Write-Host '[5/5] 下载并安装 SSMS 管理工具到 D:\SSMS22（约 700 MB，10-30 分钟）...'
  $bootstrapper = Join-Path $mediaDir 'vs_SSMS.exe'
  if (-not (Test-Path $bootstrapper)) {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path $curl) {
      & $curl --fail --location --retry 3 -o $bootstrapper 'https://aka.ms/ssmsfullsetup'
      if ($LASTEXITCODE -ne 0) { throw "SSMS 引导器下载失败（curl 退出码 $LASTEXITCODE）" }
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri 'https://aka.ms/ssmsfullsetup' -OutFile $bootstrapper -UseBasicParsing
    }
  }
  $ssmsDir = 'D:\SSMS22'
  $ssms = Start-Process -FilePath $bootstrapper -ArgumentList @(
    '--quiet','--norestart','--wait',"--installPath=$ssmsDir"
  ) -PassThru
  # 轮询等待 Ssms.exe 出现（最长 60 分钟）
  $candidates = @("$ssmsDir\Common7\IDE\Ssms.exe",
                  'C:\Program Files\Microsoft SQL Server Management Studio 22\Common7\IDE\Ssms.exe',
                  'C:\Program Files\Microsoft SQL Server Management Studio 21\Common7\IDE\Ssms.exe')
  $ssmsExe = $null
  $deadline = (Get-Date).AddMinutes(60)
  while ((Get-Date) -lt $deadline) {
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) { $ssmsExe = $found; break }
    if ($ssms.HasExited -and -not $found) { Start-Sleep -Seconds 20; $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1; if ($found) { $ssmsExe = $found }; break }
    Start-Sleep -Seconds 20
  }
  if (-not $ssmsExe) { throw "SSMS 安装超时或失败（安装器退出码 $($ssms.ExitCode)），其余步骤已成功，可稍后手动安装 SSMS。" }
  Write-Host "      SSMS 已安装：$ssmsExe"

  # ---------- 6. 桌面快捷方式 + 固定任务栏 ----------
  Write-Host '创建桌面快捷方式并固定到任务栏...'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnkPath = Join-Path $desktop 'SQL Server Management Studio.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = $ssmsExe
  $lnk.WorkingDirectory = Split-Path $ssmsExe
  $lnk.IconLocation = "$ssmsExe,0"
  $lnk.Description = 'SQL Server 管理工具（连接 localhost\SQLEXPRESS）'
  $lnk.Save()

  $pinned = $false
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace((Split-Path $lnkPath))
    $item = $folder.ParseName((Split-Path $lnkPath -Leaf))
    foreach ($v in $item.Verbs()) {
      $plain = ($v.Name -replace '&','')
      if ($plain -match '固定到任务栏|Pin to taskbar') { $v.DoIt(); $pinned = $true; break }
    }
  } catch { }
  if ($pinned) { Write-Host '      已固定到任务栏。' }
  else { Write-Host '      未能自动固定任务栏（Windows 限制），请右键桌面快捷方式 →「固定到任务栏」手动点一次。' }

  Write-Host ''
  Write-Host '=================== 全部完成 ==================='
  Write-Host "SQL Server Express：localhost\$instance（主体与数据在 D:\SQLServer）"
  Write-Host '数据库：AITeacherDB / dbo.query_records（项目 .env 无需改动）'
  Write-Host "SSMS：$ssmsExe（快捷方式在桌面并固定任务栏）"
  Write-Host '重启后端（start-ai-teacher.bat）后答题记录继续写入新库。'
} catch {
  Write-Host ''
  Write-Host '!!!!!!!!!! 出错了 !!!!!!!!!!'
  Write-Host $_.Exception.Message
  Write-Host "完整日志：$logFile"
} finally {
  Stop-Transcript | Out-Null
  Write-Host ''
  Write-Host '按回车键关闭窗口...'
  Read-Host
}
