@echo off
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%runtime\node.exe" (
  echo Runtime not found: %ROOT%runtime\node.exe
  exit /b 1
)
"%ROOT%runtime\node.exe" "%ROOT%app-control\launcher.js" start
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
