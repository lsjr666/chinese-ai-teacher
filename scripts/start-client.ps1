param(
  [int]$Port = 5173
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

$vite = Join-Path $root 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $vite)) {
  throw "Frontend dependency node_modules\vite was not found. Keep the node_modules folder in the package."
}

$node = Resolve-Node
Write-Host "Starting frontend on http://0.0.0.0:$Port"
& $node $vite --host 0.0.0.0 --port $Port
exit $LASTEXITCODE
