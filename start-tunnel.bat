@echo off
REM Cloudflare 무료 임시 터널 (trycloudflare) - 계속 켜두면 주소 유지됨
REM 이 창에 뜨는 https://....trycloudflare.com 주소 뒤에 /remote.html 붙여서 접속
cd /d "%~dp0"
:loop
echo [%date% %time%] tunnel starting - URL shown below AND saved to tunnel-url.txt
powershell -NoProfile -Command "cloudflared tunnel --url http://localhost:3001 2>&1 | Tee-Object -FilePath '%~dp0tunnel-url.txt'"
echo [%date% %time%] tunnel stopped - restarting in 5s (URL may change)
timeout /t 5 /nobreak >nul
goto loop
