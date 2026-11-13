@echo off
setlocal
title 谜案剧本杀 - 运行中（关闭此窗口即停止）
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [!] 没有找到 Node.js，请先安装：https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "server\dist\server.mjs" (
  echo.
  echo   [!] 缺少 server\dist\server.mjs
  echo       先在本文件夹执行：npm run server:build
  echo.
  pause
  exit /b 1
)

rem 端口已经在监听就不再重复启动
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',5274); exit 0}catch{exit 1}finally{if($c){$c.Close()}}" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   服务器已经在运行，直接打开浏览器。
  start "" http://127.0.0.1:5274
  exit /b 0
)

echo.
echo   ============================================
echo      谜案剧本杀 · 正在启动
echo      地址：http://127.0.0.1:5274
echo      关闭这个窗口 = 停止服务
echo   ============================================
echo.

rem 3 秒后自动打开浏览器（服务启动比这快）
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:5274'"

node server\dist\server.mjs

echo.
echo   服务已停止（若上面有报错，把这段截图发我）。
pause
