$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 22.12+ is required. Install Node.js LTS and reopen this launcher.' }
$vitePath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $vitePath)) { throw 'Dependencies are missing. Run npm install in this folder first.' }
$serverUrl = 'http://127.0.0.1:5173'
$ready = $false
try { $response = Invoke-WebRequest -Uri $serverUrl -UseBasicParsing -TimeoutSec 3; $ready = $response.StatusCode -eq 200 -and $response.Content.Contains('Yunji Business') } catch {}
if (-not $ready) {
  $viteArgs = @('"' + $vitePath + '"', '--host', '127.0.0.1', '--port', '5173', '--strictPort')
  $serverProcess = Start-Process -FilePath $nodePath -ArgumentList $viteArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'server.log') -RedirectStandardError (Join-Path $projectRoot 'server-error.log') -PassThru
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($serverProcess.HasExited) { throw 'Server could not start. Check server-error.log. Port 5173 may be in use.' }
    try { $response = Invoke-WebRequest -Uri $serverUrl -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200 -and $response.Content.Contains('Yunji Business')) { $ready = $true; break } } catch {}
  }
  if (-not $ready) { throw 'Server did not become ready. Check server.log and server-error.log.' }
  Set-Content -LiteralPath (Join-Path $projectRoot '.server.pid') -Value $serverProcess.Id
}
Start-Process $serverUrl
Write-Host "Yunji is running at $serverUrl"
