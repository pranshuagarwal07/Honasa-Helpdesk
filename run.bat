@echo off
cd /d "%~dp0"
if not exist node_modules call npm install

set APP_ENV=SBX_HONASA_UAT
set PORT=8765

rem already running (another window, or started in the background): stop it so code changes load
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":8765 .*LISTENING"') do (
  echo Restarting the UAT desk server ^(was pid %%p^)...
  taskkill /pid %%p /f >nul 2>&1
)
timeout /t 1 >nul

rem open the browser once the server has had a moment to start listening
start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:8765"
node server.js
echo.
echo The UAT desk server stopped. The message above says why.
pause
