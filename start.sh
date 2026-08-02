#!/usr/bin/env bash
# FilamentFlow launcher
# Double-click this or run: bash start.sh

cd "$(dirname "$0")"

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "❌  Python 3 not found. Install from https://python.org"
    read -p "Press Enter to exit..."
    exit 1
fi

# Install Flask if missing
python3 -c "import flask" 2>/dev/null || {
    echo "📦  Installing Flask (first run only)..."
    pip3 install flask --break-system-packages 2>/dev/null || pip3 install flask
}

# Open browser after 1 second
(sleep 1.2 && open "http://localhost:5000" 2>/dev/null || xdg-open "http://localhost:5000" 2>/dev/null) &

python3 app.py
