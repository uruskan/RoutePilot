param([Alias('NoBrowser')][switch]$Headless)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$appUrl = 'http://127.0.0.1:47856'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:/GameDev/Tools/Node-v22.23.2/node.exe' }
if (-not (Test-Path -LiteralPath $node)) { throw 'Node.js bulunamadı. README dosyasındaki çalışma ortamını kontrol edin.' }
Push-Location -LiteralPath $appRoot
try {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    $env:electron_config_cache = 'D:/GameDev/Cache/RoutePilot/electron'
    if (-not (Test-Path -LiteralPath 'node_modules/vite') -or (-not $Headless -and -not (Test-Path -LiteralPath 'node_modules/electron'))) {
        if (-not $npm) { throw 'npm bulunamadı.' }
        & $npm ci --cache D:/GameDev/Cache/RoutePilot/npm --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Arayüz bağımlılıkları kurulamadı.' }
    }
    if (-not $Headless -and -not (Test-Path -LiteralPath 'node_modules/electron/dist/electron.exe')) {
        & $node 'node_modules/electron/install.js'
        if ($LASTEXITCODE -ne 0) { throw 'Masaüstü çalışma ortamı indirilemedi.' }
    }
    $index = Get-Item 'public/index.html' -ErrorAction SilentlyContinue
    $newest = Get-ChildItem -LiteralPath 'web' -File -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $config = Get-Item 'vite.config.mjs'
    if (-not $index -or $newest.LastWriteTimeUtc -gt $index.LastWriteTimeUtc -or $config.LastWriteTimeUtc -gt $index.LastWriteTimeUtc) {
        & $node 'node_modules/vite/bin/vite.js' build
        if ($LASTEXITCODE -ne 0) { throw 'Arayüz derlenemedi.' }
    }
    New-Item -ItemType Directory -Force -Path 'work' | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (-not $Headless) {
        $electronPath = Join-Path $appRoot 'node_modules/electron/dist/electron.exe'
        Start-Process -FilePath $electronPath -ArgumentList ('"' + $appRoot + '"') -WorkingDirectory $appRoot -RedirectStandardOutput (Join-Path $appRoot "work/desktop-$stamp.log") -RedirectStandardError (Join-Path $appRoot "work/desktop-$stamp.err.log") | Out-Null
        Write-Output 'RoutePilot masaüstü uygulaması açılıyor. Uçuş kendiliğinden başlamaz.'
        return
    }
    $health = $null
    try { $health = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 2 } catch {}
    if ($health -and $health.app -ne 'RoutePilot') { throw '47856 portunda başka bir uygulama var.' }
    if (-not $health) {
        $server = Start-Process -FilePath $node -ArgumentList 'server/index.mjs' -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot "work/server-$stamp.log") -RedirectStandardError (Join-Path $appRoot "work/server-$stamp.err.log") -PassThru
        $server.Id | Set-Content -LiteralPath (Join-Path $appRoot 'work/server.pid')
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            try { $health = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 1 } catch {}
            if ($server.HasExited) { throw 'Yerel servis açılamadı. work klasöründeki hata kaydını kontrol edin.' }
        } until ($health -or [DateTime]::UtcNow -gt $deadline)
        if (-not $health -or $health.app -ne 'RoutePilot') { throw 'RoutePilot yanıt vermedi.' }
    }
    Write-Output 'RoutePilot konsol servisi hazır. RoutePilot-CLI.cmd durum / izle / baslat / durdur / kapat'
} finally { Pop-Location }
