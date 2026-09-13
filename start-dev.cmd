@echo off
rem Запуск dev-сервера портфолио (http://localhost:3000).
rem Ярлык на этот файл лежит в автозагрузке Windows (shell:startup),
rem чтобы сервер поднимался сам после перезагрузки.
title portfolio dev
set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
cd /d "%~dp0site"
npm run dev
echo.
echo Сервер остановлен. Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
