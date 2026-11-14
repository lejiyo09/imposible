@echo off
REM Cloudflare 무료 임시 터널 (trycloudflare) - 계속 켜두면 주소 유지됨
REM 이 창에 뜨는 https://....trycloudflare.com 주소 뒤에 /remote.html 붙여서 접속
cd /d "%~dp0"
:loop
echo [%date% %time%] tunnel starting - see the https://xxx.trycloudflare.com URL below
cloudflared tunnel --url http://localhost:3001
echo [%date% %time%] tunnel stopped - restarting in 5s (URL may change)
timeout /t 5 /nobreak >nul
goto loop
