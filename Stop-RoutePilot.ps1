$ErrorActionPreference = 'Stop'
$appUrl = 'http://127.0.0.1:47856'
try { $session = Invoke-RestMethod "$appUrl/api/session" -TimeoutSec 3 }
catch { Write-Output 'RoutePilot zaten kapalı veya ulaşılamıyor.'; exit 0 }
$result = Invoke-RestMethod "$appUrl/api/command" -Method Post -ContentType 'application/json' -Headers @{ 'X-RoutePilot-Token' = $session.token } -Body '{"action":"shutdown"}' -TimeoutSec 10
Write-Output $result.message
