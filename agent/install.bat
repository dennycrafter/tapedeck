@echo off
REM ===========================================================================
REM Tapedeck PC downloader installer (SPEC 8.3). The owner double-clicks this
REM once. It:
REM   1. installs Python 3.12, Deno and FFmpeg with winget (skipped when the
REM      tool is already available),
REM   2. installs the Python libraries from requirements.txt,
REM   3. copies .env.example to .env if missing and opens it in Notepad,
REM   4. registers a Task Scheduler task "Tapedeck Downloader" that starts
REM      the downloader with pythonw.exe (no console window) at log on,
REM   5. starts it now and offers a one-time connection self-test.
REM ===========================================================================
setlocal
pushd "%~dp0"

echo Step 1 of 5: installing Python 3.12, Deno and FFmpeg if needed...
py -3.12 --version >nul 2>&1
if errorlevel 1 (
    echo   Python 3.12 was not found. Installing it with winget. This can take a few minutes.
    winget install --id=Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
    py -3.12 --version >nul 2>&1
    if errorlevel 1 (
        echo   Python 3.12 was installed but is not available in this window yet.
        echo   Close this window and run install.bat again to continue.
        pause
        exit /b 1
    )
)
deno --version >nul 2>&1 || winget install --id=DenoLand.Deno -e --accept-source-agreements --accept-package-agreements
ffmpeg -version >nul 2>&1 || winget install --id=Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements

echo Step 2 of 5: installing the Python libraries...
py -3.12 -m pip install -r requirements.txt
if errorlevel 1 (
    echo   The pip install failed. Check your internet connection and run install.bat again.
    pause
    exit /b 1
)

echo Step 3 of 5: creating agent\.env...
if not exist .env copy .env.example .env >nul
echo   Notepad is opening with the .env file.
echo   Open the Tapedeck app, go to Profile, then Downloader setup,
echo   copy APP_URL and AGENT_TOKEN into the file, save, and close Notepad.
notepad .env

echo Step 4 of 5: registering the Task Scheduler task...
for /f "usebackq delims=" %%P in (`py -3.12 -c "import os, sys; print(os.path.join(os.path.dirname(sys.executable), 'pythonw.exe'))"`) do set "PYTHONW=%%P"
if "%PYTHONW%"=="" (
    echo   Could not find pythonw.exe. Open a new window and run install.bat again.
    pause
    exit /b 1
)
schtasks /Create /F /TN "Tapedeck Downloader" /SC ONLOGON /TR "\"%PYTHONW%\" \"%~dp0downloader.py\""
if errorlevel 1 (
    echo   The Task Scheduler task could not be created. You can still start the
    echo   downloader by hand: py -3.12 agent\downloader.py
    pause
    exit /b 1
)

echo Step 5 of 5: starting the downloader now...
schtasks /Run /TN "Tapedeck Downloader" >nul
echo.
echo Downloader installed. It will start every time you log in.
echo Logs go to agent\logs\downloader.log
echo.
choice /C YN /M "Run a one-time connection self-test now? Recommended"
if errorlevel 2 goto :done
py -3.12 "%~dp0downloader.py" --probe https://www.youtube.com/watch?v=jNQXAC9IVRw
echo.
echo SUCCESS means yt-dlp can reach YouTube from this PC.
echo BLOCKED means YouTube asked for a bot verification; the downloader
echo above is already running and may still work on the next attempt.

:done
pause
popd
endlocal
