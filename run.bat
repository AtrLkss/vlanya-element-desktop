@echo off
setlocal
set "ROOT=%~dp0"
set "NODE_HOME=%ROOT%..\tools\node-v24.18.0-win-x64"
set "PATH=%NODE_HOME%;%NODE_HOME%\node_modules\npm\bin;%PATH%"
cd /d "%ROOT%"
npm start
