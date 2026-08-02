"""
bambu.py — Bambu Lab Cloud integration for SpoolStats
=====================================================

What this does
--------------
Talks to the Bambu Lab Cloud API (the same service the Bambu Handy app and
Bambu Studio use) to pull your finished print jobs, then automatically
subtracts the filament those prints used from the matching spool in your
inventory.

Why the Cloud API (and not the printer directly)?
  • The per-print filament weight is the slicer's estimate, which Bambu
    stores in the cloud against every job (field `weight` per AMS slot).
    That is exactly the number we want to deduct from stock.
  • It works no matter where SpoolStats is running (PC, Mac, TrueNAS, Docker)
    as long as the box has internet access.

Login note
----------
Bambu now protects login with a 6-digit code emailed to you (MFA). The flow
is therefore two steps:
    1. POST /api/bambu/login  with email + password   -> a code is emailed
    2. POST /api/bambu/verify with that 6-digit code   -> we get a token
The token is stored in the `settings` table and reused until it expires.

Everything here is defensive: any network/parse error is caught and logged,
and never takes the web app down.
"""

import json
import sqlite3
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

# ─── Cloud endpoints ─────────────────────────────────────────────────────────
REGIONS = {
    "global": "https://api.bambulab.com",
    "china":  "https://api.bambulab.cn",
}
LOGIN_PATH = "/v1/user-service/user/login"
TASKS_PATH = "/v1/user-service/my/tasks"

USER_AGENT = "SpoolStats/1.0 (bambu-sync)"
HTTP_TIMEOUT = 20  # seconds

# Status codes Bambu uses for a finished, successful print
SUCCESS_STATUSES = {2, "2", "success", "FINISH", "FINISHED"}


# ─── Small settings helpers (key/value in the `settings` table) ──────────────
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
    """Create the tables Bambu sync needs. Safe to call repeatedly."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        -- One row per Bambu print job we've seen, so we never double-count.
        CREATE TABLE IF NOT EXISTS bambu_tasks (
            task_id     TEXT PRIMARY KEY,
            title       TEXT,
            printer     TEXT,
            weight_g    REAL,
            status      TEXT,
            cover_url   TEXT,
            finished_at TEXT,
            deducted    INTEGER DEFAULT 0,   -- 1 once stock has been subtracted
            pending     INTEGER DEFAULT 0,   -- 1 if it needs a manual spool pick
            raw         TEXT,                -- original JSON for review
            synced_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        -- Learned mapping: an AMS tray (material+colour) -> a spool in inventory.
        -- Once you assign a tray to a spool, future identical trays auto-match.
        CREATE TABLE IF NOT EXISTS bambu_tray_map (
            tray_key    TEXT PRIMARY KEY,    -- e.g. "PLA|#FF0000"
            filament_id INTEGER REFERENCES filaments(id) ON DELETE SET NULL,
            updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );
        -- One row per (print, nozzle position) so nozzle hours can be totalled
        -- per printer + nozzle + size. task_key dedupes Bambu prints; NULL = manual.
        CREATE TABLE IF NOT EXISTS nozzle_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            task_key    TEXT UNIQUE,
            printer     TEXT,
            nozzle_pos  TEXT,
            nozzle_size TEXT,
            time_s      INTEGER DEFAULT 0,
            project     TEXT,
            source      TEXT DEFAULT 'bambu',
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );
        -- Friendly label + Equipment link for each physical nozzle position.
        -- Bambu's nozzle id is hardware-fixed, so (printer,pos) is stable.
        CREATE TABLE IF NOT EXISTS nozzle_names (
            printer      TEXT,
            nozzle_pos   TEXT,
            label        TEXT,
            equipment_id INTEGER,
            PRIMARY KEY (printer, nozzle_pos)
        );
        """
    )
    db.commit()
    # Print time + nozzle size on the per-task record (added by migration)
    for _col, _ddl in (("print_time_s", "INTEGER DEFAULT 0"), ("nozzle_size", "TEXT")):
        try:
            db.execute(f"ALTER TABLE bambu_tasks ADD COLUMN {_col} {_ddl}")
        except Exception:
            pass
    db.commit()


# ─── HTTP helper (urllib, no third-party deps) ───────────────────────────────
def _request(url, method="GET", token=None, body=None):
    headers = {"User-Agent": USER_AGENT, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            text = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(text) if text.strip() else {})
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace") if e.fp else ""
        try:
            payload = json.loads(text) if text.strip() else {}
        except Exception:
            payload = {"message": text[:300]}
        return e.code, payload
    except Exception as e:
        return 0, {"message": str(e)}


def _base(db):
    return REGIONS.get(get_setting(db, "bambu_region", "global"), REGIONS["global"])


# ─── Auth ────────────────────────────────────────────────────────────────────
def login(db, email, password, region="global"):
    """
    Step 1 of login. Returns one of:
      {"connected": True}                 -> password alone was enough (rare now)
      {"need_code": True}                 -> a 6-digit code was emailed; call verify()
      {"error": "..."}                    -> something went wrong
    """
    region = region if region in REGIONS else "global"
    set_setting(db, "bambu_region", region)
    set_setting(db, "bambu_email", email)

    status, data = _request(
        REGIONS[region] + LOGIN_PATH, method="POST",
        body={"account": email, "password": password},
    )

    if status == 0:
        return {"error": "Could not reach Bambu Cloud: " + str(data.get("message", ""))}

    token = data.get("accessToken") or data.get("access_token")
    if token:
        _store_tokens(db, data)
        return {"connected": True}

    login_type = (data.get("loginType") or data.get("login_type") or "").lower()
    if login_type in ("verifycode", "verify_code", "email") or data.get("tfaKey"):
        # A verification code has been emailed (or 2FA challenge issued)
        if data.get("tfaKey"):
            set_setting(db, "bambu_tfa_key", data["tfaKey"])
        return {"need_code": True}

    msg = data.get("message") or data.get("error") or f"Login failed (HTTP {status})"
    return {"error": msg}


def verify(db, code):
    """Step 2: exchange the emailed 6-digit code for an access token."""
    email = get_setting(db, "bambu_email")
    region = get_setting(db, "bambu_region", "global")
    if not email:
        return {"error": "No login in progress — start with email + password first."}

    body = {"account": email, "code": str(code).strip()}
    tfa_key = get_setting(db, "bambu_tfa_key")
    if tfa_key:
        body["tfaKey"] = tfa_key

    status, data = _request(REGIONS[region] + LOGIN_PATH, method="POST", body=body)
    token = data.get("accessToken") or data.get("access_token")
    if token:
        _store_tokens(db, data)
        set_setting(db, "bambu_tfa_key", "")
        return {"connected": True}

    msg = data.get("message") or data.get("error") or f"Verification failed (HTTP {status})"
    return {"error": msg}


def _store_tokens(db, data):
    set_setting(db, "bambu_access_token", data.get("accessToken") or data.get("access_token") or "")
    set_setting(db, "bambu_refresh_token", data.get("refreshToken") or data.get("refresh_token") or "")
    set_setting(db, "bambu_connected_at", datetime.now(timezone.utc).isoformat())


def logout(db):
    for k in ("bambu_access_token", "bambu_refresh_token", "bambu_tfa_key"):
        set_setting(db, k, "")
    return {"ok": True}


def status(db):
    return {
        "connected":    bool(get_setting(db, "bambu_access_token")),
        "email":        get_setting(db, "bambu_email"),
        "region":       get_setting(db, "bambu_region", "global"),
        "auto_sync":    get_setting(db, "bambu_auto_sync", "0") == "1",
        "auto_deduct":  get_setting(db, "bambu_auto_deduct", "0") == "1",
        "interval_min": int(get_setting(db, "bambu_interval_min", "15") or 15),
        "last_sync":    get_setting(db, "bambu_last_sync"),
        "last_result":  get_setting(db, "bambu_last_result"),
        "pending":      _pending_count(db),
    }


def _pending_count(db):
    row = db.execute("SELECT COUNT(*) AS n FROM bambu_tasks WHERE pending = 1 AND deducted = 0").fetchone()
    return (row["n"] if not isinstance(row, tuple) else row[0]) if row else 0


# ─── Spool matching ──────────────────────────────────────────────────────────
def _hex_to_rgb(h):
    if not h:
        return None
    h = h.strip().lstrip("#")
    if len(h) == 8:      # RRGGBBAA
        h = h[:6]
    if len(h) != 6:
        return None
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def _colour_distance(a, b):
    ra, rb = _hex_to_rgb(a), _hex_to_rgb(b)
    if not ra or not rb:
        return 999
    return sum((x - y) ** 2 for x, y in zip(ra, rb)) ** 0.5


def _norm_hex(c):
    rgb = _hex_to_rgb(c)
    return "#%02X%02X%02X" % rgb if rgb else ""


def _fmt_size(d):
    try:
        return ("%.2f" % float(d)).rstrip("0").rstrip(".")
    except Exception:
        return str(d or "")


def _norm_time(when):
    if not when:
        return None
    try:
        if str(when).isdigit():
            return datetime.fromtimestamp(int(str(when)[:10]), timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        return str(when)[:19].replace("T", " ")
    except Exception:
        return None


def _nozzles_for(task):
    """Which nozzle position(s) a print used, with each one's diameter."""
    diam = {}
    for n in (task.get("nozzleInfos") or task.get("nozzleInfo") or []):
        nid = n.get("id")
        d = n.get("diameter")
        if nid is not None and d:
            diam[str(nid)] = _fmt_size(d)
    used = set()
    for a in (task.get("amsDetailMapping") or []):
        nz = a.get("nozzleId")
        if nz is not None:
            used.add(str(nz))
    if not used:
        used = set(diam.keys()) or {"0"}
    return [{"pos": nid, "size": diam.get(nid, "")} for nid in sorted(used)]


def _record_nozzle(db, task_id, printer, pos, size, time_s, project, when):
    db.execute(
        "INSERT OR IGNORE INTO nozzle_logs "
        "(task_key, printer, nozzle_pos, nozzle_size, time_s, project, source, created_at) "
        "VALUES (?,?,?,?,?,?, 'bambu', ?)",
        (f"{task_id}#{pos}", printer, pos, size, int(time_s or 0), project, _norm_time(when)),
    )


def backfill_nozzles(db):
    """Populate nozzle hours + print times for prints synced before this feature
    existed, using the raw JSON we already stored. Idempotent."""
    try:
        rows = db.execute("SELECT task_id, title, printer, finished_at, raw, print_time_s FROM bambu_tasks").fetchall()
    except Exception:
        return
    for r in rows:
        try:
            task = json.loads(r["raw"] or "{}")
        except Exception:
            continue
        time_s = int(float(task.get("costTime") or 0))
        nozzles = _nozzles_for(task)
        nsize = ",".join(sorted({n["size"] for n in nozzles if n["size"]}))
        if (not r["print_time_s"]) and time_s:
            db.execute("UPDATE bambu_tasks SET print_time_s = ?, nozzle_size = ? WHERE task_id = ?",
                       (time_s, nsize, r["task_id"]))
        if _is_success(task):
            for nz in nozzles:
                _record_nozzle(db, str(r["task_id"]), r["printer"], nz["pos"], nz["size"], time_s, r["title"], r["finished_at"])
    db.commit()


def _tray_key(material, colour):
    return f"{(material or '').upper()}|{(colour or '').upper()}"


def match_spool(db, material, colour):
    """
    Pick the best in-stock spool for a given material + colour.
    Returns (filament_id, confidence) where confidence is 'learned',
    'strong', 'weak', or None.
    """
    # 1) Learned mapping from a previous manual assignment
    key = _tray_key(material, colour)
    row = db.execute("SELECT filament_id FROM bambu_tray_map WHERE tray_key = ?", (key,)).fetchone()
    if row:
        fid = row["filament_id"] if not isinstance(row, tuple) else row[0]
        if fid:
            chk = db.execute("SELECT id FROM filaments WHERE id = ?", (fid,)).fetchone()
            if chk:
                return fid, "learned"

    # 2) Best colour match among same-material, in-stock spools
    rows = db.execute(
        "SELECT id, material, color_hex, weight_current FROM filaments "
        "WHERE weight_current > 0"
    ).fetchall()
    best, best_dist = None, 999
    for r in rows:
        rmat = (r["material"] or "").upper()
        if material and rmat and material.upper() not in rmat and rmat not in material.upper():
            continue
        d = _colour_distance(colour, r["color_hex"])
        if d < best_dist:
            best, best_dist = r["id"], d

    if best is None:
        return None, None
    if best_dist <= 25:     # very close colour -> confident
        return best, "strong"
    if best_dist <= 90:     # same colour family -> plausible
        return best, "weak"
    return best, "far"      # nearest spool, but not a real colour match


# ─── Core: fetch tasks + deduct ──────────────────────────────────────────────
def _extract_filaments(task):
    """
    Normalise a task's per-filament breakdown into
    [{material, colour, grams}, ...] across the API shapes Bambu has used.
    """
    if isinstance(task.get("_resolved_filaments"), list) and task["_resolved_filaments"]:
        return task["_resolved_filaments"]
    out = []
    ams = (task.get("amsDetailMapping") or task.get("ams_detail_mapping")
           or task.get("amsDetail") or [])
    for a in ams:
        grams = float(a.get("weight") or a.get("filamentWeight") or 0)
        colour = a.get("sourceColor") or a.get("targetColor") or a.get("color") or ""
        material = a.get("filamentType") or a.get("filament_type") or a.get("type") or ""
        if grams > 0:
            out.append({"material": material, "colour": _norm_hex(colour), "grams": grams})
    # Fallback: single total weight, no per-filament breakdown
    if not out:
        total = float(task.get("weight") or task.get("totalWeight") or 0)
        if total > 0:
            out.append({"material": "", "colour": "", "grams": total})
    return out


def _fetch_profile_filaments(db, task):
    """When the task list lacks colour, pull per-filament colour/grams from the
    print's stored profile (context.plates[].filaments[])."""
    pid = task.get("profileId") or task.get("profile_id")
    mid = task.get("modelId") or task.get("model_id")
    token = get_setting(db, "bambu_access_token")
    if not pid or not token:
        return []
    url = f"{_base(db)}/v1/iot-service/api/user/profile/{pid}"
    if mid:
        url += f"?model_id={mid}"
    code, data = _request(url, token=token)
    if code != 200 or not isinstance(data, dict):
        return []
    out = []
    ctx = data.get("context") or {}
    for plate in (ctx.get("plates") or []):
        for f in (plate.get("filaments") or []):
            grams = float(f.get("used_g") or 0)
            if grams > 0:
                out.append({
                    "material": f.get("type") or "",
                    "colour": _norm_hex(f.get("color") or ""),
                    "grams": grams,
                })
    return out


def _filaments_for(db, task):
    """Best available per-filament breakdown, enriched with colour if needed."""
    fils = _extract_filaments(task)
    if not any(f.get("colour") for f in fils):
        prof = _fetch_profile_filaments(db, task)
        if prof:
            return prof
    return fils


def _is_success(task):
    s = task.get("status")
    return s in SUCCESS_STATUSES or str(s).lower() in {"success", "finish", "finished"}


def fetch_tasks(db, limit=50):
    token = get_setting(db, "bambu_access_token")
    if not token:
        return None, "Not connected to Bambu Cloud."
    url = f"{_base(db)}{TASKS_PATH}?limit={int(limit)}"
    status_code, data = _request(url, token=token)
    if status_code == 401:
        set_setting(db, "bambu_access_token", "")  # force re-login
        return None, "Bambu session expired — please reconnect."
    if status_code != 200:
        return None, f"Bambu API error (HTTP {status_code}): {data.get('message','')}"
    tasks = data.get("hits") or data.get("data") or data.get("tasks") or []
    return tasks, None


def sync(db, deduct=True, limit=100, date_from=None, date_to=None):
    """
    Pull recent prints, record new ones, and (optionally) deduct stock for
    successful prints that we can confidently match to a spool.
    Returns a summary dict.
    """
    tasks, err = fetch_tasks(db, limit=limit)
    if err:
        set_setting(db, "bambu_last_result", err)
        return {"error": err}

    new, deducted, pending = 0, 0, 0
    # Filament is only deducted automatically if the user has opted in. By
    # default every finished print waits in the review list for confirmation.
    auto = bool(deduct) and get_setting(db, "bambu_auto_deduct", "0") == "1"
    for task in tasks:
        task_id = str(task.get("id") or task.get("taskId") or task.get("jobId") or "")
        if not task_id:
            continue
        # Date-range filter (by the print's finished/started day)
        if date_from or date_to:
            tday = (_norm_time(task.get("endTime") or task.get("startTime")) or "")[:10]
            if tday:
                if date_from and tday < date_from:
                    continue
                if date_to and tday > date_to:
                    continue
        seen = db.execute("SELECT deducted, pending FROM bambu_tasks WHERE task_id = ?", (task_id,)).fetchone()
        if seen:
            # Refresh the thumbnail URL for prints still waiting in review
            if not seen["deducted"] and seen["pending"]:
                fresh = task.get("snapShot") or task.get("cover") or task.get("coverUrl") or ""
                if fresh:
                    db.execute("UPDATE bambu_tasks SET cover_url = ? WHERE task_id = ?", (fresh, task_id))
            continue

        title    = task.get("title") or task.get("designTitle") or task.get("name") or "Bambu print"
        printer  = task.get("deviceName") or task.get("deviceModel") or ""
        total_g  = float(task.get("weight") or 0)
        cover    = task.get("snapShot") or task.get("cover") or task.get("coverUrl") or ""
        finished = task.get("endTime") or task.get("startTime") or ""
        print_time_s = int(float(task.get("costTime") or 0))
        nozzles = _nozzles_for(task)
        nozzle_size = ",".join(sorted({n["size"] for n in nozzles if n["size"]}))
        new += 1
        success = _is_success(task)

        unmatched, resolved = [], []
        if success:
            resolved = _filaments_for(db, task)
            for f in resolved:
                fid, conf = (None, None)
                if auto:
                    fid, conf = match_spool(db, f["material"], f["colour"])
                # Auto mode deducts ONLY high-confidence matches; weak/unknown
                # matches (and everything in review mode) wait for confirmation.
                if auto and fid and conf in ("learned", "strong"):
                    _deduct(db, fid, f["grams"], title, finished)
                    deducted += 1
                else:
                    unmatched.append(f)

        all_matched = success and not unmatched
        is_pending = 1 if (success and unmatched) else 0
        if is_pending:
            pending += 1
        task["_resolved_filaments"] = unmatched if unmatched else resolved

        db.execute(
            "INSERT OR IGNORE INTO bambu_tasks "
            "(task_id, title, printer, weight_g, status, cover_url, finished_at, deducted, pending, raw, print_time_s, nozzle_size) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (task_id, title, printer, total_g, str(task.get("status")), cover, str(finished),
             1 if all_matched else 0, is_pending, json.dumps(task), print_time_s, nozzle_size),
        )
        if success:
            for nz in nozzles:
                _record_nozzle(db, task_id, printer, nz["pos"], nz["size"], print_time_s, title, finished)

    db.commit()
    now = datetime.now(timezone.utc).isoformat()
    set_setting(db, "bambu_last_sync", now)
    result = f"{new} new, {deducted} deducted, {pending} need a spool"
    set_setting(db, "bambu_last_result", result)
    return {"ok": True, "new": new, "deducted": deducted, "pending": pending, "synced_at": now}


def _deduct(db, filament_id, grams, project, when):
    """Subtract grams from a spool and write a usage record (source = bambu)."""
    row = db.execute("SELECT weight_current FROM filaments WHERE id = ?", (filament_id,)).fetchone()
    if not row:
        return
    grams = max(0.0, float(grams))
    # Create a print row so it shows in the Usage log like any other print
    when_sql = None
    if when:
        try:
            # Bambu times are ms epoch or ISO; normalise to a date string
            if str(when).isdigit():
                when_sql = datetime.fromtimestamp(int(str(when)[:10]), timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            else:
                when_sql = str(when)[:19].replace("T", " ")
        except Exception:
            when_sql = None
    if when_sql:
        cur = db.execute(
            "INSERT INTO usage_prints (project_name, source_type, created_at) VALUES (?, 'bambu', ?)",
            (project, when_sql),
        )
    else:
        cur = db.execute(
            "INSERT INTO usage_prints (project_name, source_type) VALUES (?, 'bambu')",
            (project,),
        )
    print_id = cur.lastrowid
    db.execute("UPDATE filaments SET weight_current = MAX(0, weight_current - ?) WHERE id = ?", (grams, filament_id))
    if when_sql:
        db.execute(
            "INSERT INTO usage_logs (filament_id, weight_used, project_name, print_id, created_at) VALUES (?,?,?,?,?)",
            (filament_id, grams, project, print_id, when_sql),
        )
    else:
        db.execute(
            "INSERT INTO usage_logs (filament_id, weight_used, project_name, print_id) VALUES (?,?,?,?)",
            (filament_id, grams, project, print_id),
        )


# ─── Manual review of unmatched prints ───────────────────────────────────────
def pending_list(db):
    rows = db.execute(
        "SELECT task_id, title, printer, weight_g, cover_url, finished_at, raw "
        "FROM bambu_tasks WHERE pending = 1 AND deducted = 0 ORDER BY synced_at DESC"
    ).fetchall()
    out = []
    for r in rows:
        try:
            task = json.loads(r["raw"])
        except Exception:
            task = {}
        fils = _extract_filaments(task)
        for f in fils:
            sid, _c = match_spool(db, f.get("material", ""), f.get("colour", ""))
            f["suggested_id"] = sid if _c in ("learned", "strong", "weak") else None
        out.append({
            "task_id":   r["task_id"],
            "title":     r["title"],
            "printer":   r["printer"],
            "weight_g":  r["weight_g"],
            "cover_url": r["cover_url"],
            "finished_at": r["finished_at"],
            "filaments": fils,
        })
    return out


def assign(db, task_id, filament_id, grams, material="", colour="", learn=True):
    """Deduct ONE filament of a print against a chosen spool, remember the choice,
    and only clear the print from review once all its filaments are assigned."""
    row = db.execute("SELECT title, finished_at, raw FROM bambu_tasks WHERE task_id = ?", (task_id,)).fetchone()
    if not row:
        return {"error": "Unknown task"}
    _deduct(db, int(filament_id), float(grams), row["title"] or "Bambu print", row["finished_at"])
    if learn and (material or colour):
        db.execute(
            "INSERT INTO bambu_tray_map (tray_key, filament_id, updated_at) VALUES (?,?,CURRENT_TIMESTAMP) "
            "ON CONFLICT(tray_key) DO UPDATE SET filament_id = excluded.filament_id, updated_at = CURRENT_TIMESTAMP",
            (_tray_key(material, colour), int(filament_id)),
        )
    try:
        task = json.loads(row["raw"] or "{}")
    except Exception:
        task = {}
    res = task.get("_resolved_filaments") or _extract_filaments(task)
    for i, f in enumerate(res):
        if (f.get("material") or "") == (material or "") and (f.get("colour") or "") == (colour or "") \
           and abs(float(f.get("grams") or 0) - float(grams or 0)) < 0.05:
            res.pop(i)
            break
    task["_resolved_filaments"] = res
    if res:
        db.execute("UPDATE bambu_tasks SET raw = ?, pending = 1, deducted = 0 WHERE task_id = ?",
                   (json.dumps(task), task_id))
        done = False
    else:
        db.execute("UPDATE bambu_tasks SET raw = ?, pending = 0, deducted = 1 WHERE task_id = ?",
                   (json.dumps(task), task_id))
        done = True
    db.commit()
    return {"ok": True, "done": done}


def restore_skipped(db):
    """Bring previously-skipped (dismissed) prints back into the review list."""
    rows = db.execute("SELECT task_id, raw FROM bambu_tasks WHERE deducted = 0 AND pending = 0").fetchall()
    n = 0
    for r in rows:
        try:
            task = json.loads(r["raw"] or "{}")
        except Exception:
            continue
        if _is_success(task) and _extract_filaments(task):
            db.execute("UPDATE bambu_tasks SET pending = 1 WHERE task_id = ?", (r["task_id"],))
            n += 1
    db.commit()
    return {"ok": True, "restored": n}


def dismiss(db, task_id):
    db.execute("UPDATE bambu_tasks SET pending = 0 WHERE task_id = ?", (task_id,))
    db.commit()
    return {"ok": True}


# ─── Background auto-sync poller ─────────────────────────────────────────────
_poller_started = False


def start_poller(data_dir):
    """Launch a daemon thread that auto-syncs every SpoolStats database in the
    data directory that has Bambu connected + auto-sync enabled."""
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
                        token = get_setting(conn, "bambu_access_token")
                        auto = get_setting(conn, "bambu_auto_sync", "0") == "1"
                        if token and auto:
                            interval = min(interval, int(get_setting(conn, "bambu_interval_min", "15") or 15))
                            sync(conn, deduct=True)
                        conn.close()
                    except Exception:
                        print("[bambu] poller db error (%s):\n%s" % (path, traceback.format_exc()))
            except Exception:
                print("[bambu] poller error:\n" + traceback.format_exc())
            time.sleep(max(2, interval) * 60)

    threading.Thread(target=loop, name="bambu-poller", daemon=True).start()
    print("  🔄  Bambu auto-sync poller started (scans all databases)")
