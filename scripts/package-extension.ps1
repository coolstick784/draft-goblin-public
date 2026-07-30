param([string]$OutputPath)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" }
if (-not (Test-Path -LiteralPath $node)) { throw "Node.js was not found." }
& $node (Join-Path $PSScriptRoot "build-extension-engine.js")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$extensionRoot = Join-Path $repoRoot "extension"
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot "manifest.json") -Raw | ConvertFrom-Json
$distRoot = Join-Path $repoRoot "dist"
if (-not $OutputPath) { $OutputPath = Join-Path $distRoot "draft-goblin-$($manifest.version).zip" }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$temporaryPath = "$OutputPath.tmp"

New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$files = Get-ChildItem -LiteralPath $extensionRoot -Recurse -File | Sort-Object { $_.FullName.Substring($extensionRoot.Length + 1).Replace("\", "/") }
$stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($extensionRoot.Length + 1).Replace("\", "/")
      $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $output = $entry.Open()
      try {
        $input = $file.OpenRead()
        try { $input.CopyTo($output) } finally { $input.Dispose() }
      } finally { $output.Dispose() }
    }
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

$check = [IO.Compression.ZipFile]::OpenRead($temporaryPath)
try {
  $actual = @($check.Entries | ForEach-Object { $_.FullName })
  $expected = @($files | ForEach-Object { $_.FullName.Substring($extensionRoot.Length + 1).Replace("\", "/") })
  if (Compare-Object $expected $actual) { throw "Packaged file list does not match extension source." }
  foreach ($entry in $check.Entries) {
    $localPath = Join-Path $extensionRoot $entry.FullName.Replace("/", [IO.Path]::DirectorySeparatorChar)
    $entryStream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace("-", "") } finally { $sha.Dispose(); $entryStream.Dispose() }
    if ($entryHash -ne (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash) {
      throw "Packaged bytes differ for $($entry.FullName)."
    }
  }
} finally { $check.Dispose() }

Move-Item -LiteralPath $temporaryPath -Destination $OutputPath -Force
Write-Output $OutputPath
