$ErrorActionPreference = 'Stop'
$commercialRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ((Get-Content -LiteralPath (Join-Path $commercialRoot 'package.json') -Raw | ConvertFrom-Json).name -ne 'yunji-business-commercial') { throw 'Wrong project. Nothing stopped.' }
foreach ($service in @(@{Name='api'; Entry='server\index.ts'}, @{Name='web'; Entry='node_modules\vite\bin\vite.js'})) {
  $pidFile = Join-Path $commercialRoot ('.commercial-' + $service.Name + '.pid')
  if (-not (Test-Path -LiteralPath $pidFile)) { continue }
  $recordedId = [int](Get-Content -LiteralPath $pidFile)
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedId" -ErrorAction SilentlyContinue
  $expectedEntry = Join-Path $commercialRoot $service.Entry
  if ($processInfo -and $processInfo.Name -eq 'node.exe' -and $processInfo.CommandLine.Contains($expectedEntry)) {
    Stop-Process -Id $recordedId
    Write-Host ('Stopped commercial ' + $service.Name)
  } else { Write-Host 'Recorded process is absent or belongs to another application; nothing stopped.' }
  Remove-Item -LiteralPath $pidFile
}
