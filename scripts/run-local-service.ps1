$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) {
  $nodeCommand.Source
} else {
  Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}

if (-not (Test-Path -LiteralPath $node)) {
  throw "Node.js was not found."
}

try {
  $health = Invoke-RestMethod -Uri "http://localhost:8787/health" -TimeoutSec 2
  if ($health.ok -eq $true) {
    $sourcePath = Join-Path $root "server\index.js"
    $sourceMtimeMs = [DateTimeOffset]::new((Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc).ToUnixTimeMilliseconds()
    if ($null -ne $health.sourceMtimeMs -and [Math]::Abs([long]$health.sourceMtimeMs - $sourceMtimeMs) -le 1) {
      exit 0
    }
    $listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction Stop | Select-Object -First 1
    if (-not $listener.OwningProcess) { throw "The stale Draft Goblin service could not be identified." }
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
  }
} catch {
  # No healthy service is running yet; start it below.
}

Set-Location -LiteralPath $root
& $node "server\index.js"

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
