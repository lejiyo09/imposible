@echo off
REM Geo-Zebra 원격 브라우저 서버 자동 실행 (로그인 세션에서 실행 → headful Chrome 정상)
REM 서버가 죽으면 3초 뒤 자동 재시작
cd /d "%~dp0"
:loop
echo [%date% %time%] 서버 시작
node remote-server.js
echo [%date% %time%] 서버 종료됨 - 3초 후 재시작
timeout /t 3 /nobreak >nul
goto loop
