# resolve-python.ps1
# Pick a Python interpreter that can actually import the modules we need.
#
# Why: on some machines `python.exe` resolves to a managed/Store placeholder
# interpreter that has no torch / transformers / modelscope. Never rely on
# `Get-Command python.exe` alone.
#
# Usage (dot-source first, then call):
#   . (Join-Path $PSScriptRoot 'resolve-python.ps1')
#   $py = Resolve-PythonExe -Modules @('torch','transformers') -Root $root
#
# Returns: absolute path to the interpreter (string), or $null when none match.

function Resolve-PythonExe {
  param(
    [string[]]$Modules = @(),
    [string]$Root = '',
    [string]$Prefer = ''
  )

  # Callers usually run with $ErrorActionPreference = 'Stop'. Native commands
  # that write to stderr (e.g. `py -3.13` when 3.13 is not installed) would then
  # become terminating errors, so keep this whole probe quiet and non-fatal.
  $ErrorActionPreference = 'Continue'

  if ($Modules.Count -gt 0) {
    $probe = ($Modules | ForEach-Object { "import $_" }) -join '; '
  } else {
    $probe = 'pass'
  }

  $exes = @()

  # 1) explicit override wins
  if ($Prefer) { $exes += $Prefer }
  if ($env:AI_TEACHER_PYTHON) { $exes += $env:AI_TEACHER_PYTHON }

  # 2) bundled portable interpreter (runtime\python, packed by make-portable.ps1).
  #    A full CPython install directory is relocatable on Windows: python.exe
  #    derives sys.prefix from its own location, so no registry or venv needed.
  if ($Root) {
    $exes += (Join-Path $Root 'runtime\python\python.exe')
    $exes += (Join-Path $Root '.venv\Scripts\python.exe')
    $exes += (Join-Path $Root 'venv\Scripts\python.exe')
  }

  # 3) interpreters registered with the Windows `py` launcher.
  #    Use `py -0p` (plain listing) instead of probing each version, because
  #    probing an unregistered version prints an error to stderr.
  $pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    $listed = & $pyLauncher.Source -0p 2>$null
    foreach ($line in @($listed)) {
      if (-not $line) { continue }
      if ($line -match '(?i)([A-Za-z]:\\.*?python\.exe)\s*$') { $exes += $matches[1] }
    }
  }

  # 4) common install locations
  $globs = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python3*\python.exe'),
    'C:\Python3*\python.exe',
    'D:\Python3*\python.exe',
    (Join-Path $env:ProgramFiles 'Python3*\python.exe')
  )
  foreach ($g in $globs) {
    Get-ChildItem -Path $g -ErrorAction SilentlyContinue | ForEach-Object { $exes += $_.FullName }
  }

  # 5) last resort: bare python.exe
  $bare = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($bare) { $exes += $bare.Source }

  $seen = @{}
  foreach ($exe in $exes) {
    if (-not $exe) { continue }
    if (-not (Test-Path -LiteralPath $exe)) { continue }
    $full = [System.IO.Path]::GetFullPath($exe)
    if ($seen.ContainsKey($full)) { continue }
    $seen[$full] = $true

    & $exe -c $probe 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return $full }
  }

  return $null
}
