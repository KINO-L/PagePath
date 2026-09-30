$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $projectRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$requiredFiles = @('manifest.json', 'README.md', 'docs/USAGE.md',
  'vendor/opencv/opencv.js', 'vendor/opencv/LICENSE',
  'vendor/opencv/LICENSE.emscripten', 'vendor/opencv/README.md')
foreach ($relativePath in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
    throw "Missing release file: $relativePath"
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'src') -PathType Container)) {
  throw 'Missing extension source directory: src'
}

# The repository contains development tools; the installable archive uses this allowlist.
$releaseFiles = @($requiredFiles)
if (Test-Path -LiteralPath (Join-Path $projectRoot 'docs/PRIVACY.md') -PathType Leaf) {
  $releaseFiles += 'docs/PRIVACY.md'
}
$releaseFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -File -Recurse |
  ForEach-Object { $_.FullName.Substring($projectRoot.Length + 1).Replace('\', '/') }
$releaseFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'icons') -File |
  Where-Object { $_.Extension -in @('.png', '.svg') } |
  ForEach-Object { 'icons/' + $_.Name }
$releaseFiles = $releaseFiles | Sort-Object -Unique

# Refuse to publish an archive missing an entry point or a manifest icon.
$runtimeFiles = @($manifest.background.service_worker) + @($manifest.icons.PSObject.Properties.Value)
foreach ($relativePath in $runtimeFiles) {
  if ($relativePath -notin $releaseFiles) {
    throw "Manifest asset is not in the release: $relativePath"
  }
}

$outputDirectory = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$archivePath = Join-Path $outputDirectory ("PagePath-v" + $manifest.version + '.zip')
$temporaryArchive = Join-Path $outputDirectory ('.pagepath-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  $archive = [System.IO.Compression.ZipFile]::Open($temporaryArchive, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($relativePath in $releaseFiles) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        (Join-Path $projectRoot $relativePath),
        $relativePath,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
  Move-Item -LiteralPath $temporaryArchive -Destination $archivePath -Force
} finally {
  if (Test-Path -LiteralPath $temporaryArchive -PathType Leaf) {
    Remove-Item -LiteralPath $temporaryArchive -Force
  }
}
Write-Output $archivePath
