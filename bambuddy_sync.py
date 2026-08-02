"""
bambuddy_sync.py — Bambuddy REST API integration for SpoolStats
================================================================

What this does
--------------
Talks to a self-hosted Bambuddy instance (https://github.com/maziggy/bambuddy)
over its REST API and pulls finished print records (Bambuddy's "Archives"),
logging each print's duration against a nozzle position so the Nozzles tab's
hour totals stay accurate automatically.

Why Bambuddy instead of/as well as Bambu Cloud?
  • Bambuddy already watches your printers over local MQTT in real time, so
    its print history is available immediately and doesn't depend on Bambu's
    cloud account working.
  • This sits ALONGSIDE the existing Bambu Cloud sync (bambu.py), not instead
    of it — Bambu Cloud stays as a fallback for anyone who doesn't run
    Bambuddy. Both sources write into the same `nozzle_logs` table, tagged
    with a different `source` value ('bambu' vs 'bambuddy'), so hour totals
    are never double-counted (each print is only ever pulled from one source
    since task_key is unique) and the Nozzles tab shows a combined total.

Auth
----
Bambuddy is authenticated with a per-instance API key (created in Bambuddy
under Settings → API Keys) sent as an `X-API-Key` header. The key needs at
least the "Read Status" scope — that's what gates read access to
/api/v1/printers and /api/v1/archives.

Nozzle position
----------------
Bambuddy's Archives don't record which physical nozzle (for dual-nozzle
printers like the H2D) a given print used — only the nozzle *diameter*
(`nozzle_diameter`). So every synced print is logged against nozzle position
"0". Single-nozzle printers (the vast majority of Bambu Lab machines) are
unaffected by this; dual-nozzle owners get correct total hours but not a
left/right split from this source (manual entries still work as before).

Everything here is defensive: any network/parse error is caught and
returned as an {"error": ...} dict, and never takes the web app down.
"""

import json
import sqlite3
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "SpoolStats/1.0 (bambuddy-sync)"
HTTP_TIMEOUT = 20  # seconds
PAGE_SIZE = 100
MAX_PAGES = 20  # safety cap: 2000 archives per sync call, at most

# Bambuddy's FastAPI routes are mounted under /api/v1 (backend/app/core/
# config.py: api_prefix = "/api/v1"), not plain /api — hitting /api/... 404s.
API_PREFIX = "/api/v1"

# Statuses Bambuddy uses for a finished, successful print
SUCCESS_STATUSES = {"completed"}


# ─── Small settings helpers (key/value in the shared `settings` table —
#     same table bambu.py uses, so both sources share one settings store) ────
def get_setting(db, key, default=""):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    val = row["value"] if not isinstance(row, tuple) else row[0]
    return default if val is None else val


def set_setting(db, key, value):
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, "" if value is None else str(value)),
    )
    db.commit()


def ensure_tables(db):
    """Create the tables Bambuddy sync needs. Safe to call repeatedly.

    Assumes the `settings` and `nozzle_logs` tables already exist — both are
    created by bambu.ensure_tables(), which app.py always calls first.
    """
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        -- One row per Bambuddy archive (print) we've seen, so we never
        -- double-count. Mirrors bambu_tasks but sourced from Bambuddy.
        CREATE TABLE IF NOT EXISTS bambuddy_prints (
            task_id     TEXT PRIMARY KEY,   -- "bb<archive id>"
            title       TEXT,
            printer     TEXT,
            status      TEXT,
            duration_s  INTEGER DEFAULT 0,
            nozzle_size TEXT,
            finished_at TEXT,
            synced_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    db.commit()


# ─── HTTP helper (urllib, no third-party deps) ───────────────────────────────
def _request(url, api_key):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json", "X-API-Key": api_key}
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            text = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(text) if text.strip() else {})
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace") if e.fp else ""
        try:
            payload = json.loads(text) if text.strip() else {}
        except Exception:
            payload = {"detail": text[:300]}
        return e.code, payload
    except Exception as e:
        return 0, {"detail": str(e)}


def _normalise_url(base_url):
    url = (base_url or "").strip().rstrip("/")
    if url and not url.startswith(("http://", "https://")):
        url = "http://" + url
    return url


def _fmt_size(d):
    try:
        return ("%.2f" % float(d)).rstrip("0").rstrip(".")
    except Exception:
        return str(d or "")


def test_connection(base_url, api_key):
    """Quick reachability + auth check. Returns (ok, error_message)."""
    base_url = _normalise_url(base_url)
    if not base_url:
        return False, "Bambuddy URL is required."
    if not api_key:
        return False, "Bambuddy API key is required."
    status, data = _request(f"{base_url}{API_PREFIX}/printers/", api_key)
    if status == 0:
        return False, f"Could not reach Bambuddy at {base_url}: {data.get('detail', '')}"
    if status in (401, 403):
        return False, "Bambuddy rejected the API key — check it has the 'Read Status' scope enabled."
    if status != 200:
        return False, f"Bambuddy API error (HTTP {status}): {data.get('detail', '')}"
    return True, ""


# ─── Connect / disconnect / status ───────────────────────────────────────────
def connect(db, base_url, api_key):
    base_url = _normalise_url(base_url)
    ok, err = test_connection(base_url, api_key)
    if not ok:
        return {"error": err}
    set_setting(db, "bambuddy_url", base_url)
    set_setting(db, "bambuddy_api_key", api_key)
    set_setting(db, "bambuddy_connected_at", datetime.now(timezone.utc).isoformat())
    return {"connected": True}


def disconnect(db):
    for k in ("bambuddy_url", "bambuddy_api_key"):
        set_setting(db, k, "")
    return {"ok": True}


def status(db):
    return {
        "connected":    bool(get_setting(db, "bambuddy_api_key")),
        "url":          get_setting(db, "bambuddy_url"),
        "auto_sync":    get_setting(db, "bambuddy_auto_sync", "0") == "1",
        "interval_min": int(get_setting(db, "bambuddy_interval_min", "15") or 15),
        "last_sync":    get_setting(db, "bambuddy_last_sync"),
        "last_result":  get_setting(db, "bambuddy_last_result"),
    }


# ─── Fetching from Bambuddy ───────────────────────────────────────────────────
def _fetch_printer_names(base_url, api_key):
    """Returns {printer_id: name}. Tolerant of failure — callers fall back to
    a generic label if this comes back empty."""
    status_code, data = _request(f"{base_url}{API_PREFIX}/printers/", api_key)
    if status_code != 200 or not isinstance(data, list):
        return {}
    out = {}
    for p in data:
        pid = p.get("id")
        if pid is not None:
            out[pid] = p.get("name") or f"Printer #{pid}"
    return out


def _fetch_archives_page(base_url, api_key, limit, offset):
    url = f"{base_url}{API_PREFIX}/archives/?limit={int(limit)}&offset={int(offset)}"
    status_code, data = _request(url, api_key)
    if status_code != 200 or not isinstance(data, list):
        return None, f"Bambuddy API error (HTTP {status_code}): {data.get('detail', '') if isinstance(data, dict) else ''}"
    return data, None


# ─── Sync ─────────────────────────────────────────────────────────────────────
def sync(db, limit=200):
    """Pull recent archives from Bambuddy and log nozzle hours for the
    completed ones. Additive only — never touches Bambu Cloud's tables."""
    ensure_tables(db)
    base_url = get_setting(db, "bambuddy_url")
    api_key = get_setting(db, "bambuddy_api_key")
    if not base_url or not api_key:
        return {"error": "Not connected to Bambuddy."}

    printer_names = _fetch_printer_names(base_url, api_key)

    new, logged = 0, 0
    offset = 0
    collected = 0
    for _page in range(MAX_PAGES):
        page, err = _fetch_archives_page(base_url, api_key, PAGE_SIZE, offset)
        if err:
            set_setting(db, "bambuddy_last_result", err)
            return {"error": err}
        if not page:
            break

        page_all_seen = True
        for a in page:
            aid = a.get("id")
            if aid is None:
                continue
            task_id = f"bb{aid}"
            seen = db.execute("SELECT 1 FROM bambuddy_prints WHERE task_id = ?", (task_id,)).fetchone()
            if seen:
                continue
            page_all_seen = False

            title = a.get("print_name") or a.get("filename") or "Bambuddy print"
            printer = printer_names.get(a.get("printer_id")) or a.get("sliced_for_model") or "Bambuddy printer"
            pstatus = a.get("status") or ""
            duration_s = int(a.get("actual_time_seconds") or a.get("print_time_seconds") or 0)
            nozzle_size = _fmt_size(a.get("nozzle_diameter")) if a.get("nozzle_diameter") else ""
            finished = a.get("completed_at") or a.get("started_at") or ""

            db.execute(
                "INSERT OR IGNORE INTO bambuddy_prints "
                "(task_id, title, printer, status, duration_s, nozzle_size, finished_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (task_id, title, printer, pstatus, duration_s, nozzle_size, str(finished)),
            )
            new += 1

            if pstatus in SUCCESS_STATUSES and duration_s > 0:
                db.execute(
                    "INSERT OR IGNORE INTO nozzle_logs "
                    "(task_key, printer, nozzle_pos, nozzle_size, time_s, project, source, created_at) "
                    "VALUES (?,?,?,?,?,?, 'bambuddy', ?)",
                    (f"{task_id}#0", printer, "0", nozzle_size, duration_s, title, str(finished)),
                )
                logged += 1

        collected += len(page)
        offset += PAGE_SIZE
        # Bambuddy's archive list is newest-first by default. Once a whole
        # page comes back fully-known, everything older is known too —
        # stop paginating instead of re-scanning the entire print history
        # on every sync.
        if page_all_seen or len(page) < PAGE_SIZE or collected >= limit:
            break

    db.commit()
    now = datetime.now(timezone.utc).isoformat()
    set_setting(db, "bambuddy_last_sync", now)
    result = f"{new} new print(s), {logged} logged to nozzle hours"
    set_setting(db, "bambuddy_last_result", result)
    return {"ok": True, "new": new, "logged": logged, "synced_at": now}


# ─── Background auto-sync poller ─────────────────────────────────────────────
_poller_started = False


def start_poller(data_dir):
    """Launch a daemon thread that auto-syncs every SpoolStats database in the
    data directory that has Bambuddy connected + auto-sync enabled."""
    global _poller_started
    if _poller_started:
        return
    _poller_started = True

    import glob
    import os

    def loop():
        while True:
            interval = 15
            try:
                for path in glob.glob(os.path.join(str(data_dir), "*.db")):
                    try:
                        conn = sqlite3.connect(path, timeout=30)
                        conn.row_factory = sqlite3.Row
                        is_spoolstats = conn.execute(
                            "SELECT name FROM sqlite_master WHERE type='table' AND name='filaments'"
                        ).fetchone()
                        if not is_spoolstats:
                            conn.close()
                            continue
                        ensure_tables(conn)
                        connected = bool(get_setting(conn, "bambuddy_api_key"))
                        auto = get_setting(conn, "bambuddy_auto_sync", "0") == "1"
                        if connected and auto:
                            interval = min(interval, int(get_setting(conn, "bambuddy_interval_min", "15") or 15))
                            sync(conn)
                        conn.close()
                    except Exception:
                        print("[bambuddy] poller db error (%s):\n%s" % (path, traceback.format_exc()))
            except Exception:
                print("[bambuddy] poller error:\n" + traceback.format_exc())
            time.sleep(max(2, interval) * 60)

    threading.Thread(target=loop, name="bambuddy-poller", daemon=True).start()
    print("  🔄  Bambuddy auto-sync poller started (scans all databases)")
