param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$commercialRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ((Get-Content -LiteralPath (Join-Path $commercialRoot 'package.json') -Raw | ConvertFrom-Json).name -ne 'yunji-business-commercial') { throw 'This launcher only starts the commercial project.' }
Set-Location -LiteralPath $commercialRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js 24 LTS and reopen this launcher.' }
$localDir = Join-Path $commercialRoot '.local'
New-Item -ItemType Directory -Path $localDir -Force | Out-Null
$created = @()
function Start-CommercialService([string]$Name, [int]$Port, [string]$Entry, [string[]]$Arguments) {
  $pidFile = Join-Path $commercialRoot ".commercial-$Name.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $recordedId = [int](Get-Content -LiteralPath $pidFile)
    $recorded = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedId" -ErrorAction SilentlyContinue
    if ($recorded -and $recorded.Name -eq 'node.exe' -and $recorded.CommandLine.Contains($Entry)) { return }
  }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already occupied. No existing process was stopped." }
  if (-not (Test-Path -LiteralPath $Entry)) { throw 'Dependencies or server entry are missing. Run pnpm install in this commercial folder.' }
  $child = Start-Process -FilePath $nodePath -ArgumentList $Arguments -WorkingDirectory $commercialRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localDir "$Name.log") -RedirectStandardError (Join-Path $localDir "$Name-error.log") -PassThru
  Set-Content -LiteralPath $pidFile -Value $child.Id
  $script:created += $child
}
try {
  $apiEntry = Join-Path $commercialRoot 'server\index.ts'
  $webEntry = Join-Path $commercialRoot 'node_modules\vite\bin\vite.js'
  Start-CommercialService 'api' 4100 $apiEntry @('--env-file-if-exists=.env', '--experimental-strip-types', ('"' + $apiEntry + '"'))
  $apiReady = $false
  for ($attempt=0; $attempt -lt 80; $attempt++) {
    foreach ($child in $created) { if ($child.HasExited) { throw 'Commercial API exited. Inspect .local/api-error.log.' } }
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4100/api/health' -TimeoutSec 2
      if ($health.ok -and $health.service -eq 'yunji-commercial') { $apiReady=$true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (-not $apiReady) { throw 'Commercial API did not become ready. Inspect .local/api-error.log.' }
  Start-CommercialService 'web' 5174 $webEntry @(('"' + $webEntry + '"'), '--host', '127.0.0.1', '--port', '5174', '--strictPort')
  $ready = $false
  for ($attempt=0; $attempt -lt 80; $attempt++) {
    foreach ($child in $created) { if ($child.HasExited) { throw 'Commercial service exited. Inspect .local/*-error.log.' } }
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5174/api/health' -TimeoutSec 2
      $web = Invoke-WebRequest -Uri 'http://127.0.0.1:5174' -UseBasicParsing -TimeoutSec 2
      if ($health.ok -and $health.service -eq 'yunji-commercial' -and $web.Content.Contains('Yunji Commercial')) { $ready=$true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'Commercial services did not become ready. Inspect .local logs.' }
  if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5174' }
  Write-Host 'Yunji Commercial: http://127.0.0.1:5174 (the presentation version uses its original port).'
} catch {
  foreach ($child in $created) { if (-not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue } }
  throw
}
