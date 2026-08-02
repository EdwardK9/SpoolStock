#!/usr/bin/env bash
# FilamentFlow updater
# Drop new files in this folder, then run: sudo bash update.sh

cd "$(dirname "$0")"

echo ""
echo "═══════════════════════════════════════"
echo "  🧵  FilamentFlow — Updating..."
echo "═══════════════════════════════════════"

echo "  ⏹  Stopping and removing container..."
docker stop spoolstats 2>/dev/null || true
docker rm   spoolstats 2>/dev/null || true

echo "  🗑  Removing old image to force full rebuild..."
docker rmi filamentflow:latest 2>/dev/null || true

echo "  🔨  Building fresh image..."
docker build -t filamentflow:latest .

echo "  ✅  Verifying app.py was included..."
docker run --rm filamentflow:latest grep -c "12 supplied\|notes" /app/app.py || true

echo "  🚀  Handing back to TrueNAS..."
midclt call app.start spoolstats 2>/dev/null || true

echo ""
echo "  ✅  Done! Start the app in TrueNAS UI if it didn't auto-start."
echo "═══════════════════════════════════════"
echo ""
