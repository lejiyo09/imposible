@echo off
REM Cloudflare 무료 임시 터널 (trycloudflare) - 계속 켜두면 주소 유지됨
REM 이 창에 뜨는 https://....trycloudflare.com 주소 뒤에 /remote.html 붙여서 접속
cd /d "%~dp0"
:loop
echo [%date% %time%] 터널 시작 - 아래 trycloudflare.com 주소를 확인하세요
cloudflared tunnel --url http://localhost:3001
echo [%date% %time%] 터널 종료됨 - 5초 후 재시작 (주소가 바뀔 수 있음)
timeout /t 5 /nobreak >nul
goto loop
