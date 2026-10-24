@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Procurement System - Server / تشغيل نظام إدارة المشتريات

REM Change the port here if 8080 is busy / غيّر المنفذ هنا إذا كان 8080 مشغولًا
set "PORT=8080"

cd /d "%~dp0"

echo ==============================================================
echo   Procurement System - Run
echo   تشغيل نظام إدارة مشتريات المطاعم متعددة الفروع
echo ==============================================================
echo.

REM ---------- pre-flight checks / فحوص ما قبل التشغيل ----------
where node >nul 2>nul || goto :no_node
if not exist "package.json" goto :wrong_dir
if not exist "node_modules\" goto :not_installed

if not exist "data\app.db" (
    echo First run detected - creating database ...
    echo أول تشغيل - جارٍ إنشاء قاعدة البيانات ...
    call npm run seed
    if errorlevel 1 goto :seed_fail
    echo.
)

REM ---------- start / التشغيل ----------
echo Starting server / جارٍ تشغيل الخادم ...
echo.
echo   Dashboard  : http://localhost:%PORT%
echo   Health     : http://localhost:%PORT%/health
echo   Stop       : Ctrl+C  ثم Y  /  press Ctrl+C then Y
echo.
echo   The browser will open automatically in a few seconds.
echo   سيفتح المتصفح تلقائيًا بعد بضع ثوانٍ
echo.
echo   If Windows Firewall asks for permission, click
echo   "Allow access" / إذا سأل جدار الحماية اضغط Allow access
echo.

start "" /min cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:%PORT%"

call npm start

echo.
echo Server stopped / تم إيقاف الخادم
pause
exit /b 0

:no_node
echo.
echo [ERROR] Node.js not found / Node.js غير موجود
echo   Run install.bat first - it installs everything needed.
echo   شغّل ملف install.bat أولاً فهو يتولى كل التثبيت
pause
exit /b 1

:wrong_dir
echo.
echo [ERROR] package.json not found in this folder.
echo [خطأ] ضع هذا الملف داخل مجلد  procurement-system  نفسه
echo   (next to package.json) and run it again.
echo   بجانب ملف package.json ثم أعد التشغيل
pause
exit /b 1

:not_installed
echo.
echo [ERROR] Packages are not installed yet / الحزم غير مثبتة بعد
echo.
echo   Run install.bat first (double-click it), then try run.bat again.
echo   شغّل ملف install.bat أولاً ثم أعد تشغيل run.bat
pause
exit /b 1

:seed_fail
echo.
echo [ERROR] Database creation failed / فشل إنشاء قاعدة البيانات
echo   Make sure this folder is writable / تأكد أن المجلد قابل للكتابة
pause
exit /b 1
