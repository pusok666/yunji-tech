param([string]$Destination = 'D:\云迹科技')
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [System.IO.Path]::GetFullPath($Destination)
if ($targetRoot -ne 'D:\云迹科技') { throw 'This delivery script only writes to D:\云迹科技.' }
if (Test-Path -LiteralPath $targetRoot) {
  $manifestPath = Join-Path $targetRoot 'package.json'
  if ((Get-ChildItem -LiteralPath $targetRoot -Force | Measure-Object).Count -gt 0) {
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Destination is not an existing Yunji project. No files were changed.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne 'yunji-business-mvp') { throw 'Destination belongs to another project. No files were changed.' }
  }
} else { New-Item -ItemType Directory -Path $targetRoot | Out-Null }
$excluded = @('node_modules', '.pnpm-store', '.git', '.server.pid', 'server.log', 'server-error.log', 'test-results')
foreach ($entry in Get-ChildItem -LiteralPath $sourceRoot -Force) {
  if ($entry.Name -in $excluded -or $entry.Name.EndsWith('.tsbuildinfo')) { continue }
  Copy-Item -LiteralPath $entry.FullName -Destination $targetRoot -Recurse -Force
}
Write-Host "Yunji sources, documentation, build and verification artifacts saved to $targetRoot"
