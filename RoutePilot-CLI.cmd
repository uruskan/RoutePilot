@echo off
setlocal
chcp 65001 >nul
set "ROUTEPILOT_NODE=D:\GameDev\Tools\Node-v22.23.2\node.exe"
if not exist "%ROUTEPILOT_NODE%" (
  echo Node.js bulunamadi. RoutePilot README dosyasindaki calisma ortamini kontrol edin.
  exit /b 3
)
"%ROUTEPILOT_NODE%" "%~dp0cli\routepilot.mjs" %*
exit /b %errorlevel%
