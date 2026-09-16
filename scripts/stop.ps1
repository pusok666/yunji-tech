$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot '.server.pid'
if (Test-Path -LiteralPath $pidPath) {
  $serverId = [int](Get-Content -LiteralPath $pidPath)
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId" -ErrorAction SilentlyContinue
  $expectedVite = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
  if ($processInfo -and $processInfo.Name -eq 'node.exe' -and $processInfo.CommandLine.Contains($expectedVite)) { Stop-Process -Id $serverId; Write-Host 'Yunji server stopped.' }
  else { Write-Host 'The recorded process is no longer this Yunji server; no process was stopped.' }
  Remove-Item -LiteralPath $pidPath
} else { Write-Host 'No launcher-managed Yunji server was found.' }
