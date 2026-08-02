@echo off
cd /d "%~dp0"

echo.
echo  Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python not found. Download from https://python.org
    pause
    exit /b 1
)

echo  Checking Flask...
python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo  Installing Flask...
    pip install flask
)

echo.
echo  Starting FilamentFlow...
start "" "http://localhost:5000"
python app.py
pause
