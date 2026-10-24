@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Procurement System - Installer / مثبّت نظام إدارة المشتريات

cd /d "%~dp0"

echo ==============================================================
echo   Procurement System - Installer
echo   مثبّت نظام إدارة مشتريات المطاعم متعددة الفروع
echo   Node.js + Fastify + SQLite - الحزمة (أ) المجانية
echo ==============================================================
echo.

REM ---------- [1/6] correct folder? ----------
echo [1/6] Checking project folder / فحص مجلد المشروع ...
if not exist "package.json" goto :wrong_dir
if not exist "src\server.js" goto :wrong_dir
echo    OK: procurement-system folder detected.
echo.

REM ---------- [2/6] Node.js ----------
echo [2/6] Checking Node.js / فحص Node.js ...
where node >nul 2>nul || goto :no_node
for /f "tokens=1 delims=v. " %%a in ('node -v') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR goto :no_node
if %NODE_MAJOR% LSS 22 goto :node_old
for /f "tokens=*" %%v in ('node -v') do echo    OK: Node %%v
echo.

REM ---------- [3/6] npm ----------
echo [3/6] Checking npm / فحص npm ...
where npm >nul 2>nul || goto :no_npm
echo    OK: npm found.
echo.

REM ---------- [4/6] install packages ----------
echo [4/6] Installing packages / تثبيت الحزم ...
echo    This downloads ~400 MB including the Chrome headless-shell
echo    used for Arabic PDF reports (one-time, requires internet).
echo    قد يستغرق التثبيت من 5 إلى 15 دقيقة حسب سرعة الإنترنت
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :install_fail
echo    OK: packages installed.
echo.

REM ---------- [5/6] local database ----------
echo [5/6] Creating local database / إنشاء قاعدة البيانات المحلية ...
call npm run seed
if errorlevel 1 goto :seed_fail
echo    OK: data\app.db ready (26 tables + units + 5 categories).
echo.

REM ---------- [6/6] optional self-test ----------
echo [6/6] Optional self-test: 81 automated tests, about 30 seconds.
choice /c YN /m "   Run tests now? [Y]=Yes [N]=Skip"
if errorlevel 2 goto :skip_tests
call npm test
if errorlevel 1 goto :test_warn
echo    OK: all tests passed on this machine.
goto :skip_tests

:test_warn
echo.
echo    WARNING: some tests failed on this machine / تحذير: بعض الاختبارات فشلت
echo    The system may still work. Re-run later with: npm test
echo    قد يعمل النظام رغم ذلك - أعد الاختبار لاحقًا بأمر npm test

:skip_tests
echo.
echo ==============================================================
echo   INSTALLATION COMPLETE / اكتمل التثبيت بنجاح
echo.
echo   NEXT STEP / الخطوة التالية:
echo     Double-click  run.bat  -  the dashboard opens at
echo     http://localhost:8080
echo     شغّل الآن الملف  run.bat  وسيفتح المتصفح تلقائيًا
echo.
echo   First open shows the Setup Wizard: create the owner
echo   account, then optionally paste keys (Telegram/Gemini/R2).
echo   Without any keys the system runs fully in mock mode.
echo   أول فتح يعرض معالج الإعداد: أنشئ حساب المالك ثم أدخل
echo   المفاتيح إن أردت - النظام يعمل كامل الوظائف بدونها
echo ==============================================================
echo.
pause
exit /b 0

:wrong_dir
echo.
echo [ERROR] package.json not found in this folder.
echo [خطأ] ضع هذا الملف داخل مجلد  procurement-system  نفسه
echo   (next to package.json) and run it again.
echo   بجانب ملف package.json ثم أعد التشغيل
goto :fail

:no_node
echo.
echo [ERROR] Node.js is not installed or not in PATH.
echo [خطأ] Node.js غير مثبت أو غير موجود في PATH
echo.
echo   1. Download Node.js LTS v22 or newer:  https://nodejs.org
echo   2. Install with default options / ثبّته بالإعدادات الافتراضية
echo   3. Close this window and run install.bat again.
echo   ثم أغلق النافذة وأعد تشغيل install.bat
goto :fail

:node_old
echo.
echo [ERROR] Node.js v%NODE_MAJOR% found, but this project requires v22+.
echo [خطأ] الإصدار الحالي من Node.js هو v%NODE_MAJOR% والمطلوب 22 أو أحدث
echo   Download LTS from:  https://nodejs.org
goto :fail

:no_npm
echo.
echo [ERROR] npm not found although Node.js exists - reinstall Node.js LTS.
echo [خطأ] npm غير موجود رغم وجود Node.js - أعد تثبيت Node.js LTS
goto :fail

:install_fail
echo.
echo [ERROR] npm install failed / فشل تثبيت الحزم
echo   Check: internet connection / اتصال الإنترنت
echo          firewall or proxy / جدار الحماية أو البروكسي
echo          free disk space (need ~1 GB) / المساحة الحرة على القرص
echo   Then run install.bat again / ثم أعد تشغيل install.bat
goto :fail

:seed_fail
echo.
echo [ERROR] Database creation failed / فشل إنشاء قاعدة البيانات
echo   Make sure this folder is writable (not inside Program Files).
echo   تأكد أن المجلد قابل للكتابة و ليس داخل Program Files
goto :fail

:fail
echo.
echo Installation aborted / تم إيقاف التثبيت
pause
exit /b 1
