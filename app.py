"""
SpoolStats – local Flask server with SQLite
Run: python app.py
Access at: http://localhost:5000
"""

import csv
import io
import os
import random
import socket
import sqlite3
import string
import traceback
from pathlib import Path
from time import time_ns

from flask import Flask, g, jsonify, render_template, request, send_file, send_from_directory
from werkzeug.utils import secure_filename

import bambu
import bambuddy_sync
import export_to_bambuddy_csv as bb_export

# ─── Config ────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
DATA_DIR   = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
DEFAULT_DB = DATA_DIR / "spoolstats.db"

app = Flask(__name__, static_folder=".", static_url_path="", template_folder=".")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config["TEMPLATES_AUTO_RELOAD"] = True


@app.errorhandler(500)
def internal_error(e):
    tb = traceback.format_exc()
    print("=== 500 ERROR ===")
    print(tb)
    # Do not expose stack traces to clients in production.
    if app.debug:
        return jsonify({"error": str(e), "traceback": tb}), 500
    return jsonify({"error": "Internal server error"}), 500


# ─── DB helpers ────────────────────────────────────────────────────────────
def db_path_for(name):
    safe = Path(name).name
    if not safe.endswith(".db"):
        safe += ".db"
    return DATA_DIR / safe


def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        name = request.args.get("db") or "spoolstats"
        path = db_path_for(name)
        db = g._database = sqlite3.connect(path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        _migrate(db)
    return db


def _migrate(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS filaments (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            brand           TEXT,
            material        TEXT,
            color_name      TEXT,
            style           TEXT,
            code            TEXT,
            barcode         TEXT,
            color_image     TEXT,
            web_address     TEXT,
            weight_current  REAL    DEFAULT 1000,
            color_hex       TEXT,
            total_purchased REAL,
            ams_compatible  INTEGER DEFAULT 1,
            notes           TEXT,
            price_paid      REAL,
            price_is_free   INTEGER DEFAULT 0,
            spool_weight    REAL    DEFAULT 1000,
            hide_from_reorder INTEGER DEFAULT 0,
            last_updated    TEXT    DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS usage_logs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            filament_id  INTEGER REFERENCES filaments(id),
            weight_used  REAL,
            project_name TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS usage_projects (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            project_name TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS usage_prints (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            project_name TEXT,
            project_id   INTEGER REFERENCES usage_projects(id),
            source_type  TEXT DEFAULT 'manual',
            file_name    TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS materials (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            brand        TEXT,
            type         TEXT,
            model_no     TEXT,
            barcode      TEXT,
            purchased    REAL DEFAULT 1,
            used         REAL DEFAULT 0,
            stock_unit   TEXT DEFAULT 'items',
            amount_per_purchase REAL DEFAULT 1,
            roll_width   REAL,
            roll_length  REAL,
            price_paid   REAL,
            notes        TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS equipment (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            category     TEXT,
            brand        TEXT,
            model        TEXT,
            variant      TEXT,
            barcode      TEXT,
            notes        TEXT,
            purchased    INTEGER DEFAULT 1,
            price_paid   REAL,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS model_kits (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            brand        TEXT,
            kit_name     TEXT,
            scale        TEXT,
            barcode      TEXT,
            notes        TEXT,
            purchased    INTEGER DEFAULT 1,
            used         INTEGER DEFAULT 0,
            price_paid   REAL,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS barcode_db (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            barcode      TEXT UNIQUE NOT NULL,
            item_type    TEXT DEFAULT 'filament',
            brand        TEXT,
            material     TEXT,
            color_name   TEXT,
            style        TEXT,
            color_hex    TEXT,
            weight_full  REAL DEFAULT 1000,
            ams_compatible INTEGER DEFAULT 1,
            web_address  TEXT,
            price        REAL,
            notes        TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS purchase_history (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            source_filament_id INTEGER,
            item_category     TEXT DEFAULT 'filament',
            brand             TEXT,
            material          TEXT,
            color_name        TEXT,
            style             TEXT,
            barcode           TEXT,
            color_hex         TEXT,
            ams_compatible    INTEGER DEFAULT 1,
            price_paid        REAL,
            qty               REAL DEFAULT 1,
            notes             TEXT,
            price_is_free     INTEGER DEFAULT 0,
            purchased_at      TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sell_products (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT NOT NULL,
            description   TEXT,
            cost_per_item REAL DEFAULT 0,
            stock         INTEGER DEFAULT 0,
            notes         TEXT,
            created_at    TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sell_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            event_date  TEXT,
            location    TEXT,
            stand_cost  REAL DEFAULT 0,
            notes       TEXT,
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sell_event_sales (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id   INTEGER NOT NULL REFERENCES sell_events(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES sell_products(id) ON DELETE CASCADE,
            qty_sold   INTEGER DEFAULT 0,
            sale_price REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
    """)
    db.commit()

    # Ensure purchase_history allows multiple rows per filament (no UNIQUE on source_filament_id).
    ph_sql_row = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='purchase_history'").fetchone()
    if ph_sql_row is None:
        ph_sql = ""
    elif isinstance(ph_sql_row, sqlite3.Row):
        ph_sql = (ph_sql_row["sql"] or "")
    else:
        # Startup migration may use default tuple rows.
        ph_sql = (ph_sql_row[0] or "")
    if "source_filament_id INTEGER UNIQUE" in ph_sql:
        db.executescript("""
            ALTER TABLE purchase_history RENAME TO purchase_history_old;
            CREATE TABLE purchase_history (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                source_filament_id INTEGER,
                brand             TEXT,
                material          TEXT,
                color_name        TEXT,
                style             TEXT,
                barcode           TEXT,
                color_hex         TEXT,
                ams_compatible    INTEGER DEFAULT 1,
                price_paid        REAL,
                qty               REAL DEFAULT 1,
                notes             TEXT,
                purchased_at      TEXT DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO purchase_history
            (id, source_filament_id, brand, material, color_name, style, barcode, color_hex, ams_compatible, price_paid, qty, purchased_at)
            SELECT id, source_filament_id, brand, material, color_name, style, barcode, color_hex, ams_compatible, price_paid, qty, purchased_at
            FROM purchase_history_old;
            DROP TABLE purchase_history_old;
        """)
        db.commit()

    # Column migrations — add any missing columns to existing tables
    fcols = [r[1] for r in db.execute("PRAGMA table_info(filaments)").fetchall()]
    for col, defn in [
        ("ams_compatible", "INTEGER DEFAULT 1"),
        ("notes",          "TEXT"),
        ("price_paid",     "REAL"),
        ("price_is_free",  "INTEGER DEFAULT 0"),
        ("spool_weight",   "REAL DEFAULT 1000"),
        ("hide_from_reorder", "INTEGER DEFAULT 0"),
        ("color_image",    "TEXT"),
    ]:
        if col not in fcols:
            db.execute(f"ALTER TABLE filaments ADD COLUMN {col} {defn}")
    db.commit()

    mcols = [r[1] for r in db.execute("PRAGMA table_info(materials)").fetchall()]
    if "price_paid" not in mcols:
        db.execute("ALTER TABLE materials ADD COLUMN price_paid REAL")
    for col, defn in [
        ("used", "REAL DEFAULT 0"),
        ("stock_unit", "TEXT DEFAULT 'items'"),
        ("amount_per_purchase", "REAL DEFAULT 1"),
        ("roll_width", "REAL"),
        ("roll_length", "REAL"),
        ("color_name", "TEXT"),
        ("color_hex", "TEXT"),
    ]:
        if col not in mcols:
            db.execute(f"ALTER TABLE materials ADD COLUMN {col} {defn}")
    db.commit()

    ecols = [r[1] for r in db.execute("PRAGMA table_info(equipment)").fetchall()]
    if "barcode" not in ecols:
        db.execute("ALTER TABLE equipment ADD COLUMN barcode TEXT")
    if "variant" not in ecols:
        db.execute("ALTER TABLE equipment ADD COLUMN variant TEXT")
    db.commit()

    mkcols = [r[1] for r in db.execute("PRAGMA table_info(model_kits)").fetchall()]
    if "used" not in mkcols:
        db.execute("ALTER TABLE model_kits ADD COLUMN used INTEGER DEFAULT 0")
    db.commit()

    bcols = [r[1] for r in db.execute("PRAGMA table_info(barcode_db)").fetchall()]
    if "item_type" not in bcols:
        db.execute("ALTER TABLE barcode_db ADD COLUMN item_type TEXT DEFAULT 'filament'")
    db.execute("UPDATE barcode_db SET item_type = 'filament' WHERE item_type IS NULL OR TRIM(item_type) = ''")
    db.commit()

    # ─── Usage print grouping (3MF import groups) ─────────────────────────
    # Newer versions store one row per filament in usage_logs, but group them
    # under one "print" record for UI grouping. Prints can optionally belong
    # to a higher-level "project" (e.g. a car project containing many prints).
    db.executescript("""
        CREATE TABLE IF NOT EXISTS usage_projects (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            project_name TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS usage_prints (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            project_name TEXT,
            project_id   INTEGER REFERENCES usage_projects(id),
            source_type  TEXT DEFAULT 'manual',
            file_name    TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # Column migrations for existing DBs
    pcols = [r[1] for r in db.execute("PRAGMA table_info(usage_prints)").fetchall()]
    if "project_id" not in pcols:
        db.execute("ALTER TABLE usage_prints ADD COLUMN project_id INTEGER")
        db.commit()
    if "timelapse" not in pcols:
        db.execute("ALTER TABLE usage_prints ADD COLUMN timelapse TEXT")
        db.commit()

    ucols = [r[1] for r in db.execute("PRAGMA table_info(usage_logs)").fetchall()]
    if "print_id" not in ucols:
        db.execute("ALTER TABLE usage_logs ADD COLUMN print_id INTEGER")
    db.commit()

    # Backfill legacy rows with a best-effort print grouping:
    # - 3MF imports previously inserted multiple filament rows with the same `project_name`
    #   and (typically) the same `created_at` timestamp (SQLite DEFAULT CURRENT_TIMESTAMP).
    # - We group by (project_name, created_at) to collapse those into a single print entry.
    groups = db.execute("""
        SELECT project_name, created_at
        FROM usage_logs
        WHERE print_id IS NULL
        GROUP BY project_name, created_at
    """).fetchall()
    for g in groups:
        cur = db.execute(
            "INSERT INTO usage_prints (project_name, source_type, file_name, created_at) VALUES (?, ?, ?, ?)",
            (g["project_name"], "legacy", None, g["created_at"]),
        )
        pid = cur.lastrowid
        db.execute(
            "UPDATE usage_logs SET print_id = ? WHERE print_id IS NULL AND project_name = ? AND created_at = ?",
            (pid, g["project_name"], g["created_at"]),
        )
    db.commit()

    # Ensure purchase_history has notes and price_is_free columns (older databases).
    ph_cols = [r[1] for r in db.execute("PRAGMA table_info(purchase_history)").fetchall()]
    if "notes" not in ph_cols:
        db.execute("ALTER TABLE purchase_history ADD COLUMN notes TEXT")
    if "price_is_free" not in ph_cols:
        db.execute("ALTER TABLE purchase_history ADD COLUMN price_is_free INTEGER DEFAULT 0")
    if "item_category" not in ph_cols:
        db.execute("ALTER TABLE purchase_history ADD COLUMN item_category TEXT DEFAULT 'filament'")
        db.execute("UPDATE purchase_history SET item_category = 'filament' WHERE item_category IS NULL")
    if "source" not in ph_cols:
        # Tags rows created by the Bambuddy CSV round-trip import so a repeat
        # import can cleanly replace its own previous rows (idempotent)
        # without touching purchases you entered by hand.
        db.execute("ALTER TABLE purchase_history ADD COLUMN source TEXT DEFAULT 'manual'")
    db.commit()

    # Backfill one baseline purchase-history row per filament (only if none exists).
    rows = db.execute("""
        SELECT id, brand, material, color_name, style, barcode, color_hex, ams_compatible, price_paid, total_purchased
        FROM filaments
    """).fetchall()
    for r in rows:
        exists = db.execute("SELECT 1 FROM purchase_history WHERE source_filament_id = ? LIMIT 1", (r["id"],)).fetchone()
        if exists:
            continue
        db.execute("""
            INSERT INTO purchase_history
            (source_filament_id, brand, material, color_name, style, barcode, color_hex, ams_compatible, price_paid, qty)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            r["id"], r["brand"], r["material"], r["color_name"], r["style"],
            r["barcode"], r["color_hex"], r["ams_compatible"], r["price_paid"],
            r["total_purchased"] if r["total_purchased"] else 1,
        ))
    db.commit()

    # Column migrations for sell_products (colour support + SKU + image)
    spcols = [r[1] for r in db.execute("PRAGMA table_info(sell_products)").fetchall()]
    for col, defn in [("color_name", "TEXT"), ("color_hex", "TEXT"), ("sku", "TEXT"), ("image", "TEXT")]:
        if col not in spcols:
            db.execute(f"ALTER TABLE sell_products ADD COLUMN {col} {defn}")
    if "filament_breakdown" not in spcols:
        db.execute("ALTER TABLE sell_products ADD COLUMN filament_breakdown TEXT")
    db.commit()


@app.teardown_appcontext
def close_db(exc):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()


# ─── Frontend ───────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(str(UPLOAD_DIR), filename)


# ─── Database management API ────────────────────────────────────────────────
@app.route("/api/databases", methods=["GET"])
def list_databases():
    dbs = [p.stem for p in sorted(DATA_DIR.glob("*.db"))]
    return jsonify(dbs)


@app.route("/api/databases", methods=["POST"])
def create_database():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Name required"}), 400
    path = db_path_for(name)
    conn = sqlite3.connect(path)
    _migrate(conn)
    conn.close()
    return jsonify({"ok": True, "name": path.stem})


@app.route("/api/databases/<name>/download")
def download_database(name):
    path = db_path_for(name)
    if not path.exists():
        return jsonify({"error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name=path.name)


# ─── App Settings API ───────────────────────────────────────────────────────
# Small key/value store for app-wide toggles (e.g. hiding the Filaments
# section once spool tracking has moved to a separate app like Bambuddy).
# Scoped per-database like everything else here, via get_db().
def _read_app_settings(db):
    rows = db.execute("SELECT key, value FROM app_settings").fetchall()
    kv = {r["key"]: r["value"] for r in rows}
    return {
        "filaments_enabled": kv.get("filaments_enabled", "1") != "0",
    }


@app.route("/api/settings", methods=["GET"])
def get_app_settings():
    db = get_db()
    return jsonify(_read_app_settings(db))


@app.route("/api/settings", methods=["POST"])
def post_app_settings():
    d = request.get_json(silent=True) or {}
    db = get_db()
    if "filaments_enabled" in d:
        db.execute(
            "INSERT INTO app_settings (key, value) VALUES ('filaments_enabled', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("1" if d["filaments_enabled"] else "0",),
        )
        db.commit()
    return jsonify(_read_app_settings(db))


# ─── Filament API ───────────────────────────────────────────────────────────
@app.route("/api/filaments", methods=["GET"])
def get_filaments():
    db = get_db()
    rows = db.execute("SELECT * FROM filaments ORDER BY material, brand, color_name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/filaments", methods=["POST"])
def post_filaments():
    payload = request.get_json(silent=True) or {}
    db = get_db()

    if payload.get("action") == "bulk_import":
        items = payload.get("items", [])
        if not items:
            return jsonify({"error": "No items supplied"}), 400
        db.execute("DELETE FROM filaments")
        db.execute("DELETE FROM usage_logs")
        db.execute("DELETE FROM usage_prints")
        db.execute("DELETE FROM usage_projects")
        stmt = """INSERT INTO filaments
              (brand, material, color_name, style, code, barcode,
               color_image, web_address, weight_current, color_hex, total_purchased,
               ams_compatible, notes, price_paid, price_is_free, spool_weight)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""
        for it in items:
            db.execute(stmt, (
                it.get("brand"), it.get("material"), it.get("color_name"),
                it.get("style"), it.get("code"), it.get("barcode"),
                it.get("color_image"),
                it.get("web_address"), it.get("weight_current", 1000),
                it.get("color_hex"), it.get("total_purchased"),
                1 if it.get("ams_compatible", True) else 0,
                it.get("notes"),
                it.get("price_paid"),
                1 if it.get("price_is_free") else 0,
                it.get("spool_weight") or 1000,
            ))
        db.commit()
        return jsonify({"ok": True, "count": len(items)}), 201

    if payload.get("action") == "add_single":
        i = payload.get("item", {})
        cur = db.execute("""INSERT INTO filaments
              (brand, material, color_name, style, weight_current, total_purchased, color_hex,
               color_image, web_address, ams_compatible, notes, price_paid, price_is_free, spool_weight, barcode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
            i.get("brand"), i.get("material"), i.get("color_name"),
            i.get("style"), i.get("weight_current", 1000),
            i.get("total_purchased", 1),
            i.get("color_hex"), i.get("color_image"), i.get("web_address"),
            1 if i.get("ams_compatible", True) else 0,
            i.get("notes"),
            i.get("price_paid"),
            1 if i.get("price_is_free") else 0,
            i.get("spool_weight") or 1000,
            i.get("barcode"),
        ))
        db.execute("""
            INSERT INTO purchase_history
            (source_filament_id, brand, material, color_name, style, barcode, color_hex, 
             ams_compatible, price_paid, price_is_free, qty, item_category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            cur.lastrowid,
            i.get("brand"), i.get("material"), i.get("color_name"), i.get("style"),
            i.get("barcode"), i.get("color_hex"),
            1 if i.get("ams_compatible", True) else 0,
            i.get("price_paid"),
            1 if i.get("price_is_free") else 0,
            i.get("total_purchased", 1),
            "filament"
        ))
        db.commit()
        return jsonify({"ok": True, "id": cur.lastrowid}), 201

    return jsonify({"error": "Unsupported action"}), 400


@app.route("/api/filaments/<int:fid>", methods=["PUT"])
def update_filament(fid):
    data = request.get_json() or {}
    db = get_db()
    price_paid = data.get("price_paid")
    db.execute("""UPDATE filaments
        SET brand=?, material=?, color_name=?, style=?,
            weight_current=?, total_purchased=?, color_hex=?, color_image=?, web_address=?,
            ams_compatible=?, notes=?, price_paid=?, price_is_free=?, spool_weight=?, barcode=?,
            last_updated=CURRENT_TIMESTAMP
        WHERE id=?""", (
        data.get("brand"), data.get("material"), data.get("color_name"),
        data.get("style"), data.get("weight_current", 1000),
        data.get("total_purchased", 1),
        data.get("color_hex"), data.get("color_image"), data.get("web_address"),
        1 if data.get("ams_compatible", True) else 0,
        data.get("notes"),
        price_paid,
        1 if data.get("price_is_free") else 0,
        data.get("spool_weight") or 1000,
        data.get("barcode"),
        fid,
    ))

    # Optional: add a new purchase/price history entry without changing qty manually.
    price_entry = data.get("price_entry") or None
    if price_entry and price_entry.get("price_paid") is not None:
        db.execute("""
            INSERT INTO purchase_history
            (source_filament_id, brand, material, color_name, style, barcode, color_hex, ams_compatible, price_paid, qty, purchased_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
        """, (
            fid,
            data.get("brand"), data.get("material"), data.get("color_name"), data.get("style"),
            data.get("barcode"), data.get("color_hex"),
            1 if data.get("ams_compatible", True) else 0,
            price_entry.get("price_paid"),
            price_entry.get("qty", 1),
            price_entry.get("purchased_at"),
        ))

    db.commit()
    return jsonify({"ok": True})


@app.route("/api/filaments/<int:fid>", methods=["DELETE"])
def delete_filament(fid):
    db = get_db()
    pids = [r["print_id"] for r in db.execute(
        "SELECT DISTINCT print_id FROM usage_logs WHERE filament_id = ? AND print_id IS NOT NULL",
        (fid,)
    ).fetchall()]
    project_ids = [r["project_id"] for r in db.execute(
        """
        SELECT DISTINCT p.project_id
        FROM usage_logs ul
        JOIN usage_prints p ON ul.print_id = p.id
        WHERE ul.filament_id = ? AND p.project_id IS NOT NULL
        """,
        (fid,),
    ).fetchall()]
    db.execute("DELETE FROM usage_logs WHERE filament_id = ?", (fid,))
    db.execute("DELETE FROM filaments WHERE id = ?", (fid,))
    db.commit()

    # Clean up any print groups that are now empty.
    for pid in pids:
        cnt = db.execute("SELECT COUNT(1) AS c FROM usage_logs WHERE print_id = ?", (pid,)).fetchone()["c"]
        if cnt == 0:
            db.execute("DELETE FROM usage_prints WHERE id = ?", (pid,))
    db.commit()

    # Clean up any now-empty projects.
    for project_id in project_ids:
        cnt = db.execute(
            "SELECT COUNT(1) AS c FROM usage_prints WHERE project_id = ?",
            (project_id,),
        ).fetchone()["c"]
        if cnt == 0:
            db.execute("DELETE FROM usage_projects WHERE id = ?", (project_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/filaments/<int:fid>/reorder", methods=["PUT"])
def update_reorder_visibility(fid):
    data = request.get_json() or {}
    hidden = 1 if data.get("hidden") else 0
    db = get_db()
    db.execute("UPDATE filaments SET hide_from_reorder = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?", (hidden, fid))
    db.commit()
    return jsonify({"ok": True, "hidden": bool(hidden)})


# ─── Usage API ──────────────────────────────────────────────────────────────
@app.route("/api/usage", methods=["GET"])
def get_usage():
    db = get_db()
    rows = db.execute("""
        SELECT
            ul.*,
            p.created_at  AS print_created_at,
            p.project_name AS print_project_name,
            p.source_type AS print_source_type,
            p.file_name   AS print_file_name,
            p.project_id  AS project_group_id,
            p.timelapse   AS print_timelapse,
            pr.project_name AS project_group_name,
            f.brand, f.material, f.color_name, f.style,
            (f.brand || ' ' || f.color_name || COALESCE(' ' || f.style, '')) AS filament_label
        FROM usage_logs ul
        LEFT JOIN usage_prints p ON ul.print_id = p.id
        LEFT JOIN usage_projects pr ON p.project_id = pr.id
        LEFT JOIN filaments f ON ul.filament_id = f.id
        ORDER BY COALESCE(p.created_at, ul.created_at) DESC, ul.created_at DESC
    """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/usage/print", methods=["POST"])
def create_usage_print():
    data = request.get_json(silent=True) or {}
    project = (data.get("project") or "Manual").strip() or "Manual"
    source  = (data.get("source") or "manual").strip() or "manual"
    file_name = data.get("file_name")
    parent_project = (data.get("parent_project") or data.get("project_parent") or "").strip()
    print_date = (data.get("print_date") or "").strip() or None

    db = get_db()
    project_id = None
    if parent_project:
        row = db.execute("SELECT id FROM usage_projects WHERE project_name = ?", (parent_project,)).fetchone()
        if row:
            project_id = row["id"]
        else:
            cur = db.execute("INSERT INTO usage_projects (project_name) VALUES (?)", (parent_project,))
            project_id = cur.lastrowid

    if print_date:
        ts = f"{print_date} 00:00:00" if len(print_date) == 10 else print_date
        cur = db.execute(
            "INSERT INTO usage_prints (project_name, project_id, source_type, file_name, created_at) VALUES (?, ?, ?, ?, ?)",
            (project, project_id, source, file_name, ts),
        )
    else:
        cur = db.execute(
            "INSERT INTO usage_prints (project_name, project_id, source_type, file_name) VALUES (?, ?, ?, ?)",
            (project, project_id, source, file_name),
        )
    db.commit()
    return jsonify({"ok": True, "print_id": cur.lastrowid, "project_id": project_id})


@app.route("/api/usage/prints/<int:print_id>/date", methods=["PUT"])
def update_print_date(print_id):
    """Update the date on a print record AND all its usage log entries."""
    body = request.get_json(silent=True) or {}
    date = (body.get("date") or "").strip()
    if not date:
        return jsonify({"error": "date required (YYYY-MM-DD)"}), 400
    ts = f"{date} 00:00:00" if len(date) == 10 else date
    db = get_db()
    db.execute("UPDATE usage_prints SET created_at = ? WHERE id = ?", (ts, print_id))
    db.execute("UPDATE usage_logs SET created_at = ? WHERE print_id = ?", (ts, print_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/usage/projects", methods=["GET"])
def list_usage_projects():
    db = get_db()
    rows = db.execute("""
        SELECT id, project_name, created_at
        FROM usage_projects
        ORDER BY created_at DESC, id DESC
    """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/usage/projects", methods=["POST"])
def create_usage_project():
    data = request.get_json(silent=True) or {}
    name = (data.get("project_name") or data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "project_name required"}), 400
    db = get_db()
    row = db.execute("SELECT id FROM usage_projects WHERE project_name = ?", (name,)).fetchone()
    if row:
        return jsonify({"ok": True, "id": row["id"], "created": False})
    cur = db.execute("INSERT INTO usage_projects (project_name) VALUES (?)", (name,))
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid, "created": True}), 201


@app.route("/api/usage/prints/<int:print_id>/project", methods=["PUT"])
def update_print_project(print_id):
    body = request.get_json(silent=True) or {}
    project_id = body.get("project_id")
    project_name = (body.get("project_name") or "").strip()

    db = get_db()

    # If a project name is provided, treat it as the source of truth.
    if project_name:
        row = db.execute("SELECT id FROM usage_projects WHERE project_name = ?", (project_name,)).fetchone()
        if row:
            project_id = row["id"]
        else:
            cur = db.execute("INSERT INTO usage_projects (project_name) VALUES (?)", (project_name,))
            project_id = cur.lastrowid

        db.execute("UPDATE usage_prints SET project_id = ? WHERE id = ?", (int(project_id), print_id))
        db.commit()
        return jsonify({"ok": True, "project_id": int(project_id)})

    # No name -> clear if project_id is nullish, otherwise set by id.
    if project_id in ("", None):
        db.execute("UPDATE usage_prints SET project_id = NULL WHERE id = ?", (print_id,))
        db.commit()
        return jsonify({"ok": True, "project_id": None})

    db.execute("UPDATE usage_prints SET project_id = ? WHERE id = ?", (int(project_id), print_id))
    db.commit()

    return jsonify({"ok": True})

@app.route("/api/usage/prints/<int:print_id>/timelapse", methods=["PUT"])
def update_print_timelapse(print_id):
    body = request.get_json(silent=True) or {}
    filename = body.get("filename")
    db = get_db()
    db.execute("UPDATE usage_prints SET timelapse = ? WHERE id = ?", (filename, print_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/usage/prints/<int:print_id>/rename", methods=["PUT"])
def rename_usage_print(print_id):
    body = request.get_json(silent=True) or {}
    name = (body.get("project_name") or "").strip()
    if not name:
        return jsonify({"error": "project_name required"}), 400
    db = get_db()
    db.execute("UPDATE usage_prints SET project_name = ? WHERE id = ?", (name, print_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/usage", methods=["POST"])
def post_usage():
    data = request.get_json(silent=True) or {}
    fid     = data.get("filament_id")
    grams   = data.get("grams")
    project = data.get("project", "Manual")
    print_id = data.get("print_id")
    date     = (data.get("date") or "").strip() or None
    source_type = data.get("print_source") or data.get("source_type") or data.get("source") or "manual"
    if not fid or not grams or grams <= 0:
        return jsonify({"error": "Invalid payload"}), 400
    db = get_db()

    if print_id:
        print_id = int(print_id)
    else:
        if date:
            ts = f"{date} 00:00:00" if len(date) == 10 else date
            cur = db.execute(
                "INSERT INTO usage_prints (project_name, source_type, created_at) VALUES (?, ?, ?)",
                (project, source_type, ts),
            )
        else:
            cur = db.execute(
                "INSERT INTO usage_prints (project_name, source_type) VALUES (?, ?)",
                (project, source_type),
            )
        print_id = cur.lastrowid

    row = db.execute("SELECT weight_current FROM filaments WHERE id = ?", (fid,)).fetchone()
    if not row:
        return jsonify({"error": "Filament not found"}), 404
    current = float(row["weight_current"] or 0)
    if grams > current:
        return jsonify({"error": f"Not enough stock ({current:.1f}g remaining)"}), 400
    db.execute("UPDATE filaments SET weight_current = weight_current - ? WHERE id = ?", (grams, fid))
    if date:
        ts = f"{date} 00:00:00" if len(date) == 10 else date
        db.execute(
            "INSERT INTO usage_logs (filament_id, weight_used, project_name, print_id, created_at) VALUES (?, ?, ?, ?, ?)",
            (fid, grams, project, print_id, ts),
        )
    else:
        db.execute(
            "INSERT INTO usage_logs (filament_id, weight_used, project_name, print_id) VALUES (?, ?, ?, ?)",
            (fid, grams, project, print_id),
        )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/usage/<int:uid>", methods=["PUT"])
def update_usage(uid):
    data = request.get_json() or {}
    fid = data.get("filament_id")
    grams = data.get("grams")
    project = data.get("project", "Manual")
    date = data.get("date")
    if not fid or not grams or grams <= 0:
        return jsonify({"error": "Invalid payload"}), 400

    db = get_db()
    entry = db.execute("SELECT filament_id, weight_used, print_id FROM usage_logs WHERE id = ?", (uid,)).fetchone()
    if not entry:
        return jsonify({"error": "Not found"}), 404

    old_fid = entry["filament_id"]
    old_grams = float(entry["weight_used"] or 0)
    new_fid = int(fid)
    new_grams = float(grams)

    current_row = db.execute("SELECT weight_current FROM filaments WHERE id = ?", (new_fid,)).fetchone()
    if not current_row:
        return jsonify({"error": "Filament not found"}), 404
    available = float(current_row["weight_current"] or 0)
    if old_fid == new_fid:
        available += old_grams
    if new_grams > available:
        return jsonify({"error": f"Not enough stock ({available:.1f}g available)"}), 400

    if old_fid:
        db.execute("UPDATE filaments SET weight_current = weight_current + ? WHERE id = ?", (old_grams, old_fid))
    db.execute("UPDATE filaments SET weight_current = weight_current - ? WHERE id = ?", (new_grams, new_fid))

    if date:
        db.execute(
            "UPDATE usage_logs SET filament_id = ?, weight_used = ?, project_name = ?, created_at = ? WHERE id = ?",
            (new_fid, new_grams, project, f"{date} 00:00:00", uid),
        )
    else:
        db.execute(
            "UPDATE usage_logs SET filament_id = ?, weight_used = ?, project_name = ? WHERE id = ?",
            (new_fid, new_grams, project, uid),
        )

    if entry["print_id"]:
        if date:
            db.execute(
                "UPDATE usage_prints SET project_name = ?, created_at = ? WHERE id = ?",
                (project, f"{date} 00:00:00", entry["print_id"]),
            )
        else:
            db.execute(
                "UPDATE usage_prints SET project_name = ? WHERE id = ?",
                (project, entry["print_id"]),
            )

    db.commit()
    return jsonify({"ok": True})


@app.route("/api/usage/<int:uid>", methods=["DELETE"])
def delete_usage(uid):
    body    = request.get_json(silent=True) or {}
    restore = bool(body.get("restore"))
    db = get_db()
    entry = db.execute("SELECT filament_id, weight_used, print_id FROM usage_logs WHERE id = ?", (uid,)).fetchone()
    if not entry:
        return jsonify({"error": "Not found"}), 404
    pid = entry["print_id"]
    project_id = None
    if pid:
        project_id = db.execute("SELECT project_id FROM usage_prints WHERE id = ?", (pid,)).fetchone()["project_id"]
    db.execute("DELETE FROM usage_logs WHERE id = ?", (uid,))
    if restore and entry["filament_id"]:
        db.execute("UPDATE filaments SET weight_current = weight_current + ? WHERE id = ?",
                   (entry["weight_used"], entry["filament_id"]))

    if pid:
        cnt = db.execute("SELECT COUNT(1) AS c FROM usage_logs WHERE print_id = ?", (pid,)).fetchone()["c"]
        if cnt == 0:
            db.execute("DELETE FROM usage_prints WHERE id = ?", (pid,))

    if project_id:
        cntp = db.execute("SELECT COUNT(1) AS c FROM usage_prints WHERE project_id = ?", (project_id,)).fetchone()["c"]
        if cntp == 0:
            db.execute("DELETE FROM usage_projects WHERE id = ?", (project_id,))

    db.commit()
    return jsonify({"ok": True, "restored": restore})


# ─── Materials API ──────────────────────────────────────────────────────────
@app.route("/api/materials", methods=["GET"])
def get_materials():
    db = get_db()
    rows = db.execute("SELECT * FROM materials ORDER BY brand, type").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/materials", methods=["POST"])
def post_materials():
    payload = request.get_json(silent=True) or {}
    db = get_db()

    if payload.get("action") == "bulk_import":
        items = payload.get("items", [])
        if not items:
            return jsonify({"error": "No items"}), 400
        db.execute("DELETE FROM materials")
        for it in items:
            db.execute("""INSERT INTO materials
                (brand, type, model_no, barcode, purchased, used, stock_unit, amount_per_purchase, roll_width, roll_length, price_paid, notes, color_name, color_hex)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
                it.get("brand"), it.get("type"), it.get("model_no"),
                it.get("barcode"), it.get("purchased", 1), it.get("used", 0),
                it.get("stock_unit", "items"), it.get("amount_per_purchase", 1),
                it.get("roll_width"), it.get("roll_length"),
                it.get("price_paid"), it.get("notes"),
                it.get("color_name"), it.get("color_hex"),
            ))
        db.commit()
        return jsonify({"ok": True, "count": len(items)}), 201

    if payload.get("action") == "add_single":
        i = payload.get("item", {})
        cur = db.execute("""INSERT INTO materials
            (brand, type, model_no, barcode, purchased, used, stock_unit, amount_per_purchase, roll_width, roll_length, price_paid, notes, color_name, color_hex)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
            i.get("brand"), i.get("type"), i.get("model_no"),
            i.get("barcode"), i.get("purchased", 1), i.get("used", 0),
            i.get("stock_unit", "items"), i.get("amount_per_purchase", 1),
            i.get("roll_width"), i.get("roll_length"),
            i.get("price_paid"), i.get("notes"),
            i.get("color_name"), i.get("color_hex"),
        ))
        db.commit()
        return jsonify({"ok": True, "id": cur.lastrowid}), 201

    return jsonify({"error": "Unsupported action"}), 400


@app.route("/api/materials/<int:mid>", methods=["PUT"])
def update_material(mid):
    data = request.get_json(silent=True) or {}
    db = get_db()
    db.execute("""UPDATE materials
        SET brand=?, type=?, model_no=?, barcode=?, purchased=?, used=?, stock_unit=?, amount_per_purchase=?, roll_width=?, roll_length=?, price_paid=?, notes=?, color_name=?, color_hex=?
        WHERE id=?""", (
        data.get("brand"), data.get("type"), data.get("model_no"),
        data.get("barcode"), data.get("purchased", 1), data.get("used", 0),
        data.get("stock_unit", "items"), data.get("amount_per_purchase", 1),
        data.get("roll_width"), data.get("roll_length"),
        data.get("price_paid"), data.get("notes"),
        data.get("color_name"), data.get("color_hex"), mid,
    ))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/materials/<int:mid>", methods=["DELETE"])
def delete_material(mid):
    db = get_db()
    db.execute("DELETE FROM materials WHERE id = ?", (mid,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/materials/<int:mid>/usage", methods=["POST"])
def adjust_material_usage(mid):
    data = request.get_json(silent=True) or {}
    delta = data.get("delta")
    try:
        delta = float(delta)
    except (TypeError, ValueError):
        return jsonify({"error": "delta required"}), 400
    if delta == 0:
        return jsonify({"error": "delta cannot be 0"}), 400

    db = get_db()
    row = db.execute("""
        SELECT purchased, used, amount_per_purchase
        FROM materials
        WHERE id = ?
    """, (mid,)).fetchone()
    if not row:
        return jsonify({"error": "Material not found"}), 404

    purchased = float(row["purchased"] or 0)
    used = float(row["used"] or 0)
    amount_per_purchase = float(row["amount_per_purchase"] or 1)
    total_available = max(0.0, purchased * amount_per_purchase)
    new_used = used + delta
    if new_used < 0:
        return jsonify({"error": "Used amount cannot be negative"}), 400
    if new_used > total_available:
        return jsonify({"error": f"Not enough stock ({total_available - used:.2f} remaining)"}), 400

    db.execute("UPDATE materials SET used = ? WHERE id = ?", (new_used, mid))
    db.commit()
    return jsonify({"ok": True, "used": new_used, "remaining": total_available - new_used})


# ─── Equipment API ──────────────────────────────────────────────────────────
@app.route("/api/equipment", methods=["GET"])
def get_equipment():
    db = get_db()
    rows = db.execute("SELECT * FROM equipment ORDER BY category, brand, model").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/equipment", methods=["POST"])
def post_equipment():
    payload = request.get_json() or {}
    db = get_db()
    if payload.get("action") == "add_single":
        i = payload.get("item", {})
        cur = db.execute("""INSERT INTO equipment (category, brand, model, variant, barcode, notes, purchased, price_paid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", (
            i.get("category"), i.get("brand"), i.get("model"), i.get("variant"), i.get("barcode"), i.get("notes"),
            i.get("purchased", 1), i.get("price_paid"),
        ))
        db.commit()
        return jsonify({"ok": True, "id": cur.lastrowid}), 201
    return jsonify({"error": "Unsupported action"}), 400


@app.route("/api/equipment/<int:eid>", methods=["PUT"])
def update_equipment(eid):
    data = request.get_json() or {}
    db = get_db()
    db.execute("""UPDATE equipment SET category=?, brand=?, model=?, variant=?, barcode=?, notes=?, purchased=?, price_paid=?
        WHERE id=?""", (
        data.get("category"), data.get("brand"), data.get("model"), data.get("variant"), data.get("barcode"), data.get("notes"),
        data.get("purchased", 1), data.get("price_paid"), eid,
    ))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/equipment/<int:eid>", methods=["DELETE"])
def delete_equipment(eid):
    db = get_db()
    db.execute("DELETE FROM equipment WHERE id = ?", (eid,))
    db.commit()
    return jsonify({"ok": True})


# ─── Model Kits API ─────────────────────────────────────────────────────────
@app.route("/api/modelkits", methods=["GET"])
def get_modelkits():
    db = get_db()
    rows = db.execute("SELECT * FROM model_kits ORDER BY brand, kit_name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/modelkits", methods=["POST"])
def post_modelkits():
    payload = request.get_json(silent=True) or {}
    db = get_db()
    if payload.get("action") == "add_single":
        i = payload.get("item", {})
        cur = db.execute("""INSERT INTO model_kits (brand, kit_name, scale, barcode, notes, purchased, used, price_paid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", (
            i.get("brand"), i.get("kit_name"), i.get("scale"), i.get("barcode"), i.get("notes"),
            i.get("purchased", 1), i.get("used", 0), i.get("price_paid"),
        ))
        db.commit()
        return jsonify({"ok": True, "id": cur.lastrowid}), 201
    return jsonify({"error": "Unsupported action"}), 400


@app.route("/api/modelkits/<int:mid>", methods=["PUT"])
def update_modelkit(mid):
    data = request.get_json(silent=True) or {}
    db = get_db()
    db.execute("""UPDATE model_kits SET brand=?, kit_name=?, scale=?, barcode=?, notes=?, purchased=?, used=?, price_paid=?
        WHERE id=?""", (
        data.get("brand"), data.get("kit_name"), data.get("scale"), data.get("barcode"), data.get("notes"),
        data.get("purchased", 1), data.get("used", 0), data.get("price_paid"), mid,
    ))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/modelkits/<int:mid>", methods=["DELETE"])
def delete_modelkit(mid):
    db = get_db()
    db.execute("DELETE FROM model_kits WHERE id = ?", (mid,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/modelkits/<int:mid>/used", methods=["POST"])
def adjust_modelkit_used(mid):
    data = request.get_json(silent=True) or {}
    delta = data.get("delta")
    try:
        delta = int(delta)
    except (TypeError, ValueError):
        return jsonify({"error": "delta required"}), 400
    if delta == 0:
        return jsonify({"error": "delta cannot be 0"}), 400

    db = get_db()
    row = db.execute("SELECT purchased, used FROM model_kits WHERE id = ?", (mid,)).fetchone()
    if not row:
        return jsonify({"error": "Model kit not found"}), 404

    purchased = int(row["purchased"] or 0)
    used = int(row["used"] or 0)
    new_used = used + delta
    if new_used < 0:
        return jsonify({"error": "Used count cannot be negative"}), 400
    if new_used > purchased:
        return jsonify({"error": f"Only {purchased - used} remaining"}), 400

    db.execute("UPDATE model_kits SET used = ? WHERE id = ?", (new_used, mid))
    db.commit()
    return jsonify({"ok": True, "used": new_used, "remaining": purchased - new_used})


# ─── Barcode DB API ─────────────────────────────────────────────────────────
@app.route("/api/barcodedb", methods=["GET"])
def get_barcodedb():
    db = get_db()
    rows = db.execute("SELECT * FROM barcode_db ORDER BY item_type, brand, material, color_name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/barcodedb/lookup/<barcode>", methods=["GET"])
def lookup_barcode(barcode):
    db = get_db()
    row = db.execute("SELECT * FROM barcode_db WHERE barcode = ?", (barcode,)).fetchone()
    if row:
        return jsonify({"found": True, "data": dict(row)})
    return jsonify({"found": False})


@app.route("/api/barcodedb", methods=["POST"])
def post_barcodedb():
    payload = request.get_json(silent=True) or {}
    db = get_db()

    if payload.get("action") == "upsert":
        it = payload.get("item", {})
        bc = (it.get("barcode") or "").strip()
        item_type = normalize_item_type(it.get("item_type"))
        if not bc:
            return jsonify({"error": "Barcode required"}), 400
        existing = db.execute("SELECT id FROM barcode_db WHERE barcode = ?", (bc,)).fetchone()
        if existing:
            db.execute("""UPDATE barcode_db SET item_type=?, brand=?, material=?, color_name=?, style=?,
                color_hex=?, weight_full=?, ams_compatible=?, web_address=?, price=?, notes=?,
                updated_at=CURRENT_TIMESTAMP WHERE barcode=?""", (
                item_type, it.get("brand"), it.get("material"), it.get("color_name"),
                it.get("style"), it.get("color_hex"), it.get("weight_full", 1000),
                1 if it.get("ams_compatible", True) else 0,
                it.get("web_address"), it.get("price"), it.get("notes"), bc,
            ))
        else:
            db.execute("""INSERT INTO barcode_db
                (barcode, item_type, brand, material, color_name, style, color_hex,
                 weight_full, ams_compatible, web_address, price, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
                bc, item_type, it.get("brand"), it.get("material"), it.get("color_name"),
                it.get("style"), it.get("color_hex"), it.get("weight_full", 1000),
                1 if it.get("ams_compatible", True) else 0,
                it.get("web_address"), it.get("price"), it.get("notes"),
            ))
        db.commit()
        return jsonify({"ok": True}), 201

    if payload.get("action") == "bulk_import":
        items = payload.get("items", [])
        for it in items:
            bc = (it.get("barcode") or "").strip()
            item_type = normalize_item_type(it.get("item_type"))
            if not bc:
                continue
            db.execute("""INSERT INTO barcode_db
                (barcode, item_type, brand, material, color_name, style, color_hex,
                 weight_full, ams_compatible, web_address, price, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(barcode) DO UPDATE SET
                    item_type=excluded.item_type,
                    brand=excluded.brand, material=excluded.material,
                    color_name=excluded.color_name, style=excluded.style,
                    color_hex=excluded.color_hex, weight_full=excluded.weight_full,
                    ams_compatible=excluded.ams_compatible, web_address=excluded.web_address,
                    price=excluded.price, notes=excluded.notes,
                    updated_at=CURRENT_TIMESTAMP""", (
                bc, item_type, it.get("brand"), it.get("material"), it.get("color_name"),
                it.get("style"), it.get("color_hex"), it.get("weight_full", 1000),
                1 if it.get("ams_compatible", True) else 0,
                it.get("web_address"), it.get("price"), it.get("notes"),
            ))
        db.commit()
        return jsonify({"ok": True, "count": len(items)}), 201

    return jsonify({"error": "Unsupported action"}), 400


@app.route("/api/barcodedb/<int:bid>", methods=["PUT"])
def update_barcodedb(bid):
    data = request.get_json(silent=True) or {}
    db = get_db()
    item_type = normalize_item_type(data.get("item_type"))
    db.execute("""UPDATE barcode_db SET item_type=?, brand=?, material=?, color_name=?, style=?,
        color_hex=?, weight_full=?, ams_compatible=?, web_address=?, price=?, notes=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?""", (
        item_type, data.get("brand"), data.get("material"), data.get("color_name"),
        data.get("style"), data.get("color_hex"), data.get("weight_full", 1000),
        1 if data.get("ams_compatible", True) else 0,
        data.get("web_address"), data.get("price"), data.get("notes"), bid,
    ))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/barcodedb/<int:bid>", methods=["DELETE"])
def delete_barcodedb(bid):
    db = get_db()
    db.execute("DELETE FROM barcode_db WHERE id = ?", (bid,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/purchases", methods=["GET"])
def get_purchases():
    db = get_db()
    rows = db.execute("""
        SELECT *,
               COALESCE(item_category, 'filament') AS item_category,
               (COALESCE(price_paid, 0) * COALESCE(qty, 1)) AS total_spent
        FROM purchase_history
        ORDER BY purchased_at DESC, id DESC
    """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/purchases/by-filament", methods=["GET"])
def get_purchases_by_filament():
    """Return purchase history grouped by filament id, newest first.
    Includes spool_weight and price_is_free so the frontend can do layered FIFO cost."""
    db = get_db()
    rows = db.execute("""
        SELECT ph.source_filament_id, ph.price_paid, ph.qty, ph.purchased_at,
               COALESCE(f.spool_weight, 1000) AS spool_weight,
               COALESCE(f.price_is_free, 0)  AS price_is_free
        FROM purchase_history ph
        LEFT JOIN filaments f ON ph.source_filament_id = f.id
        WHERE ph.source_filament_id IS NOT NULL
        ORDER BY ph.source_filament_id, ph.purchased_at DESC, ph.id DESC
    """).fetchall()
    result = {}
    for r in rows:
        fid = str(r["source_filament_id"])
        if fid not in result:
            result[fid] = []
        result[fid].append({
            "price_paid":   float(r["price_paid"]) if r["price_paid"] is not None else None,
            "qty":          float(r["qty"] or 1),
            "spool_weight": float(r["spool_weight"] or 1000),
            "price_is_free": bool(r["price_is_free"]),
            "purchased_at": r["purchased_at"],
        })
    # Filaments marked free but with no purchase history rows yet
    free_rows = db.execute("""
        SELECT id, COALESCE(spool_weight, 1000) AS spool_weight
        FROM filaments
        WHERE price_is_free = 1
          AND id NOT IN (
              SELECT DISTINCT source_filament_id FROM purchase_history
              WHERE source_filament_id IS NOT NULL
          )
    """).fetchall()
    for r in free_rows:
        fid = str(r["id"])
        if fid not in result:
            result[fid] = [{
                "price_paid": 0.0, "qty": 1,
                "spool_weight": float(r["spool_weight"]),
                "price_is_free": True,
            }]
    return jsonify(result)


@app.route("/api/purchases/sync-all", methods=["POST"])
def sync_all_purchase_totals():
    """Iterate all filaments and update total_purchased to match the sum of their log entries."""
    db = get_db()
    db.execute("""
        UPDATE filaments
        SET total_purchased = (
            SELECT COALESCE(SUM(qty), 0)
            FROM purchase_history
            WHERE source_filament_id = filaments.id
        ),
        last_updated = CURRENT_TIMESTAMP
    """)
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/purchases", methods=["POST"])
def add_purchase():
    data = request.get_json() or {}
    source_filament_id = data.get("source_filament_id")
    item_category = data.get("item_category", "filament")
    price_is_free = bool(data.get("price_is_free", False))
    price_paid = 0 if price_is_free else data.get("price_paid")
    qty = data.get("qty", 1)
    purchased_at = data.get("purchased_at")
    notes = data.get("notes")

    if not qty or qty <= 0:
        return jsonify({"error": "qty must be > 0"}), 400

    db = get_db()

    brand = data.get("brand")
    material = data.get("material")
    color_name = data.get("color_name")
    style = data.get("style")
    barcode = data.get("barcode")
    color_hex = data.get("color_hex")
    ams_compatible = data.get("ams_compatible", 1)

    # For filaments, look up spool details if source_filament_id given
    if item_category == "filament":
        if not source_filament_id:
            return jsonify({"error": "source_filament_id required for filament"}), 400
        if price_paid is None:
            return jsonify({"error": "price_paid required"}), 400
        spool = db.execute(
            "SELECT id, brand, material, color_name, style, barcode, color_hex, ams_compatible FROM filaments WHERE id = ?",
            (source_filament_id,)
        ).fetchone()
        if not spool:
            return jsonify({"error": "Filament not found"}), 404
        brand, material, color_name, style = spool["brand"], spool["material"], spool["color_name"], spool["style"]
        barcode, color_hex, ams_compatible = spool["barcode"], spool["color_hex"], spool["ams_compatible"]
    elif price_paid is None and not price_is_free:
        return jsonify({"error": "price_paid required"}), 400

    cur = db.execute("""
        INSERT INTO purchase_history
        (source_filament_id, item_category, brand, material, color_name, style, barcode, color_hex, ams_compatible, price_paid, price_is_free, qty, notes, purchased_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    """, (
        source_filament_id, item_category, brand, material, color_name, style,
        barcode, color_hex, ams_compatible,
        price_paid, 1 if price_is_free else 0, qty, notes, purchased_at,
    ))

    # Sync price, free flag, and total purchased count back to the filament record
    if item_category == "filament" and source_filament_id:
        db.execute(
            "UPDATE filaments SET price_paid = ?, price_is_free = ?, total_purchased = COALESCE(total_purchased, 0) + ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?",
            (price_paid, 1 if price_is_free else 0, qty, source_filament_id),
        )
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid}), 201


@app.route("/api/purchases/<int:pid>", methods=["PUT"])
def update_purchase(pid):
    data = request.get_json() or {}
    db = get_db()
    existing = db.execute("SELECT * FROM purchase_history WHERE id = ?", (pid,)).fetchone()
    if not existing:
        return jsonify({"error": "Not found"}), 404

    price_is_free = bool(data.get("price_is_free", existing["price_is_free"] if "price_is_free" in existing.keys() else False))
    price_paid = 0 if price_is_free else data.get("price_paid", existing["price_paid"])
    qty = data.get("qty", existing["qty"])
    purchased_at = data.get("purchased_at", existing["purchased_at"])
    notes = data.get("notes", existing["notes"])
    db.execute("""
        UPDATE purchase_history
        SET price_paid = ?, price_is_free = ?, qty = ?, notes = ?, purchased_at = ?
        WHERE id = ?
    """, (price_paid, 1 if price_is_free else 0, qty, notes, purchased_at, pid))

    # Sync filament's "total_purchased" and price
    if existing["source_filament_id"]:
        db.execute("""
            UPDATE filaments 
            SET total_purchased = (SELECT SUM(qty) FROM purchase_history WHERE source_filament_id = ?),
                price_paid = ?, price_is_free = ?, last_updated = CURRENT_TIMESTAMP 
            WHERE id = ?""", (existing["source_filament_id"], price_paid, 1 if price_is_free else 0, existing["source_filament_id"]))

    db.commit()
    return jsonify({"ok": True})


@app.route("/api/purchases/<int:pid>", methods=["DELETE"])
def delete_purchase(pid):
    db = get_db()
    existing = db.execute("SELECT * FROM purchase_history WHERE id = ?", (pid,)).fetchone()
    if not existing:
        return jsonify({"error": "Not found"}), 404
    source_filament_id = existing["source_filament_id"]
    db.execute("DELETE FROM purchase_history WHERE id = ?", (pid,))

    if source_filament_id:
        db.execute("""
            UPDATE filaments 
            SET total_purchased = (SELECT COALESCE(SUM(qty), 0) FROM purchase_history WHERE source_filament_id = ?),
                last_updated = CURRENT_TIMESTAMP 
            WHERE id = ?""", (source_filament_id, source_filament_id))
            
        latest = db.execute(
            """
            SELECT price_paid
            FROM purchase_history
            WHERE source_filament_id = ?
            ORDER BY purchased_at DESC, id DESC
            LIMIT 1
            """,
            (source_filament_id,),
        ).fetchone()
        if latest and latest["price_paid"] is not None:
            db.execute(
                "UPDATE filaments SET price_paid = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?",
                (latest["price_paid"], source_filament_id),
            )
        else:
            db.execute(
                "UPDATE filaments SET price_paid = NULL, last_updated = CURRENT_TIMESTAMP WHERE id = ?",
                (source_filament_id,),
            )

    db.commit()
    return jsonify({"ok": True})


@app.route("/api/export/all.csv", methods=["GET"])
def export_all_csv():
    db = get_db()
    filaments_rows = db.execute("SELECT * FROM filaments").fetchall()
    usage_rows = db.execute("SELECT * FROM usage_logs").fetchall()
    usage_prints_rows = db.execute("SELECT * FROM usage_prints").fetchall()
    usage_projects_rows = db.execute("SELECT * FROM usage_projects").fetchall()
    materials_rows = db.execute("SELECT * FROM materials").fetchall()
    equipment_rows = db.execute("SELECT * FROM equipment").fetchall()
    modelkits_rows = db.execute("SELECT * FROM model_kits").fetchall()
    purchases_rows = db.execute("SELECT * FROM purchase_history").fetchall()
    barcodes_rows = db.execute("SELECT * FROM barcode_db").fetchall()

    out = io.StringIO()
    out.write("section,id,field,value\n")

    def dump(section, rows):
        for r in rows:
            d = dict(r)
            rid = d.get("id", "")
            for k, v in d.items():
                if k == "id":
                    continue
                val = "" if v is None else str(v).replace('"', '""')
                out.write(f'{section},{rid},{k},"{val}"\n')

    dump("filaments", filaments_rows)
    dump("usage_projects", usage_projects_rows)
    dump("usage_prints", usage_prints_rows)
    dump("usage_logs", usage_rows)
    dump("materials", materials_rows)
    dump("equipment", equipment_rows)
    dump("model_kits", modelkits_rows)
    dump("purchase_history", purchases_rows)
    dump("barcode_db", barcodes_rows)

    mem = io.BytesIO(out.getvalue().encode("utf-8"))
    mem.seek(0)
    return send_file(mem, as_attachment=True, download_name="spoolstats_all_data.csv", mimetype="text/csv")


@app.route("/api/export/bambuddy.csv", methods=["GET"])
def export_bambuddy_csv():
    """Export the current inventory in Bambuddy's own Inventory-import CSV
    format (backend/app/services/spool_csv.py's CSV_COLUMNS) — one row per
    physical spool, reusing the exact same logic as the standalone
    export_to_bambuddy_csv.py script so the in-app button and the CLI script
    can never drift apart."""
    db = get_db()
    rows, _skipped = bb_export.build_rows(db)

    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=bb_export.CSV_COLUMNS)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)

    mem = io.BytesIO(out.getvalue().encode("utf-8"))
    mem.seek(0)
    return send_file(mem, as_attachment=True, download_name="bambuddy_import.csv", mimetype="text/csv")


def _bambuddy_note_to_barcode(note):
    """Pull a 'Barcode: XXXX' token back out of a note, if present (our own
    export writes it that way) — round-trips barcodes without a dedicated
    CSV column for them."""
    if not note:
        return None
    for part in note.split("|"):
        part = part.strip()
        if part.lower().startswith("barcode:"):
            val = part.split(":", 1)[1].strip()
            return val if val and val not in ("#", "n/a") else None
    return None


def _bambuddy_clean_note(note):
    """Strip our own 'Imported from SpoolStats' boilerplate back off a note
    so re-importing a file we exported ourselves doesn't pile up redundant
    prefixes on every round trip; leaves genuinely Bambuddy-native notes
    (spools you added directly in Bambuddy) untouched."""
    if not note:
        return ""
    text = note.strip()
    prefix = "Imported from SpoolStats"
    if text.startswith(prefix):
        text = text[len(prefix):].lstrip(" —-")
    # Drop a lone "Barcode: X" fragment — it's re-derived separately — but
    # keep any other pipe-separated fragments (e.g. a real note alongside it).
    parts = [p.strip() for p in text.split("|") if p.strip() and not p.strip().lower().startswith("barcode:")]
    return " | ".join(parts)


@app.route("/api/import/bambuddy-csv", methods=["POST"])
def import_bambuddy_csv():
    """Import a CSV exported from Bambuddy's Inventory page (or produced by
    our own /api/export/bambuddy.csv) back into SpoolStats.

    Bambuddy tracks one row per physical spool; SpoolStats tracks one row
    per colour with a running weight_current. Rows are grouped back into a
    colour by (material, brand, color_name); each row within a group becomes
    one purchase_history entry (source='bambuddy_import') and, if it shows
    consumption, one usage_logs entry (project_name='Imported from
    Bambuddy') — both tagged so a repeat import cleanly replaces its own
    previous rows for that colour instead of piling up duplicates, without
    touching anything you entered by hand.

    A colour's weight_current is REPLACED with the sum of `remaining` across
    its rows — Bambuddy is treated as the current source of truth for
    whatever colours appear in the file being imported.
    """
    data = request.get_json(silent=True) or {}
    csv_text = data.get("csv_text") or ""
    if not csv_text.strip():
        return jsonify({"error": "CSV content required"}), 400

    reader = csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames or "material" not in reader.fieldnames or "color_name" not in reader.fieldnames:
        return jsonify({"error": "This doesn't look like a Bambuddy inventory CSV (missing material/color_name columns)"}), 400

    groups = {}
    skipped = 0
    for row in reader:
        material = (row.get("material") or "").strip()
        color_name = (row.get("color_name") or "").strip()
        if not material or not color_name:
            skipped += 1
            continue
        brand = (row.get("brand") or "").strip()
        key = (material, brand, color_name)
        groups.setdefault(key, []).append(row)

    db = get_db()
    colours_created = 0
    colours_updated = 0
    spool_rows = 0

    for (material, brand, color_name), csv_rows in groups.items():
        subtype = (csv_rows[0].get("subtype") or "").strip()
        rgba = next((r.get("rgba") or "" for r in csv_rows if (r.get("rgba") or "").strip()), "")
        color_hex = ("#" + rgba.strip()[:6].upper()) if len(rgba.strip()) >= 6 else None

        spool_weight = None
        total_remaining = 0.0
        for r in csv_rows:
            try:
                label = float(r.get("label_weight") or 0)
            except (TypeError, ValueError):
                label = 0
            if label and spool_weight is None:
                spool_weight = label
            try:
                total_remaining += float(r.get("remaining") or 0)
            except (TypeError, ValueError):
                pass
        spool_weight = spool_weight or 1000.0

        barcode = next((b for r in csv_rows if (b := _bambuddy_note_to_barcode(r.get("note")))), None)
        notes = next((n for r in csv_rows if (n := _bambuddy_clean_note(r.get("note")))), "")

        existing = db.execute(
            "SELECT id FROM filaments WHERE material = ? AND brand = ? AND color_name = ?",
            (material, brand, color_name),
        ).fetchone()

        if existing:
            fid = existing["id"]
            db.execute(
                "UPDATE filaments SET weight_current = ?, spool_weight = ?, style = COALESCE(NULLIF(?, ''), style), "
                "color_hex = COALESCE(?, color_hex), total_purchased = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?",
                (total_remaining, spool_weight, subtype, color_hex, len(csv_rows), fid),
            )
            colours_updated += 1
        else:
            db.execute(
                "INSERT INTO filaments (brand, material, color_name, style, barcode, color_hex, "
                "weight_current, spool_weight, total_purchased, notes) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (brand, material, color_name, subtype, barcode, color_hex,
                 total_remaining, spool_weight, len(csv_rows), notes),
            )
            fid = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            colours_created += 1

        # Idempotent re-import: clear this colour's previous Bambuddy-sourced
        # purchase/usage rows before writing fresh ones, leaving any
        # hand-entered ('manual') purchase history alone.
        db.execute("DELETE FROM purchase_history WHERE source_filament_id = ? AND source = 'bambuddy_import'", (fid,))
        db.execute("DELETE FROM usage_logs WHERE filament_id = ? AND project_name = 'Imported from Bambuddy'", (fid,))

        for r in csv_rows:
            cost_raw = (r.get("cost_per_kg") or "").strip()
            price_paid, price_is_free = None, 0
            if cost_raw not in ("",):
                try:
                    cost = float(cost_raw)
                    if cost <= 0:
                        price_is_free = 1
                        price_paid = 0
                    else:
                        price_paid = round(cost * spool_weight / 1000, 2)
                except ValueError:
                    pass

            row_note = _bambuddy_clean_note(r.get("note"))
            purchased_at = r.get("last_used") or None

            db.execute(
                "INSERT INTO purchase_history "
                "(source_filament_id, item_category, brand, material, color_name, style, barcode, "
                "color_hex, price_paid, qty, notes, price_is_free, source, purchased_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, CURRENT_TIMESTAMP))",
                (fid, "filament", brand, material, color_name, subtype, barcode,
                 color_hex, price_paid, 1, row_note, price_is_free, "bambuddy_import", purchased_at),
            )
            spool_rows += 1

            try:
                weight_used = float(r.get("weight_used") or 0)
            except (TypeError, ValueError):
                weight_used = 0
            if weight_used > 0:
                db.execute(
                    "INSERT INTO usage_logs (filament_id, weight_used, project_name, created_at) "
                    "VALUES (?, ?, 'Imported from Bambuddy', COALESCE(?, CURRENT_TIMESTAMP))",
                    (fid, weight_used, purchased_at),
                )

    db.commit()
    return jsonify({
        "ok": True,
        "colours_created": colours_created,
        "colours_updated": colours_updated,
        "spool_rows_processed": spool_rows,
        "skipped_rows": skipped,
    })


@app.route("/api/import/global-csv", methods=["POST"])
def import_global_csv():
    data = request.get_json(silent=True) or {}
    csv_text = data.get("csv_text") or ""
    if not csv_text.strip():
        return jsonify({"error": "CSV content required"}), 400

    reader = csv.DictReader(io.StringIO(csv_text))
    required = {"section", "id", "field", "value"}
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        return jsonify({"error": "Invalid global CSV format"}), 400

    grouped = {}
    row_count = 0
    for row in reader:
        section = (row.get("section") or "").strip()
        row_id = (row.get("id") or "").strip()
        field = (row.get("field") or "").strip()
        value = row.get("value")
        if not section or row_id == "" or not field:
            continue
        grouped.setdefault(section, {}).setdefault(row_id, {"id": row_id})
        grouped[section][row_id][field] = value
        row_count += 1

    section_map = {
        "filaments": "filaments",
        "usage_projects": "usage_projects",
        "usage_prints": "usage_prints",
        "usage_logs": "usage_logs",
        "materials": "materials",
        "equipment": "equipment",
        "model_kits": "model_kits",
        "purchase_history": "purchase_history",
        "barcode_db": "barcode_db",
    }
    insert_order = ["filaments", "usage_projects", "usage_prints", "usage_logs", "materials", "equipment", "model_kits", "purchase_history", "barcode_db"]
    delete_order = ["usage_logs", "usage_prints", "usage_projects", "purchase_history", "barcode_db", "materials", "equipment", "model_kits", "filaments"]

    def coerce_for_column(col_type, raw_value):
        if raw_value == "":
            return None
        col_type = (col_type or "").upper()
        if "INT" in col_type:
            return int(float(raw_value))
        if "REAL" in col_type or "FLOA" in col_type or "DOUB" in col_type:
            return float(raw_value)
        return raw_value

    db = get_db()
    try:
        db.execute("PRAGMA foreign_keys = OFF")
        for table in delete_order:
            db.execute(f"DELETE FROM {table}")

        restored = {}
        for section in insert_order:
            table = section_map[section]
            columns = db.execute(f"PRAGMA table_info({table})").fetchall()
            col_types = {col[1]: col[2] for col in columns}
            records = grouped.get(section, {})
            restored[section] = len(records)
            for row_id in sorted(records.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x)):
                record = records[row_id]
                payload = {}
                for col in col_types:
                    if col in record:
                        payload[col] = coerce_for_column(col_types[col], record[col])
                if not payload:
                    continue
                cols_sql = ", ".join(payload.keys())
                placeholders = ", ".join(["?"] * len(payload))
                db.execute(
                    f"INSERT INTO {table} ({cols_sql}) VALUES ({placeholders})",
                    tuple(payload.values()),
                )

        db.commit()
    except Exception as exc:
        db.rollback()
        return jsonify({"error": f"Import failed: {exc}"}), 400
    finally:
        db.execute("PRAGMA foreign_keys = ON")

    return jsonify({"ok": True, "rows": row_count, "restored": restored})


@app.route("/api/uploads/color-image", methods=["POST"])
def upload_color_image():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files["file"]
    if not file or not file.filename:
        return jsonify({"error": "No file selected"}), 400

    safe_name = Path(file.filename).name
    ext = Path(safe_name).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return jsonify({"error": "Unsupported file type"}), 400

    final_name = f"colour_{time_ns()}_{safe_name}".replace(" ", "_")
    out_path = UPLOAD_DIR / final_name
    file.save(out_path)
    return jsonify({"ok": True, "url": f"/uploads/{final_name}"})

@app.route("/api/upload/timelapse", methods=["POST"])
def upload_timelapse():
    """Upload a timelapse video and return the filename."""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400
    
    allowed_extensions = {"mp4", "webm", "mov", "avi"}
    ext = file.filename.rsplit(".", 1)[1].lower() if "." in file.filename else ""
    
    if ext not in allowed_extensions:
        return jsonify({"error": f"Video type not allowed. Allowed: {', '.join(allowed_extensions)}"}), 400
    
    # 50MB limit for timelapses
    max_size = 50 * 1024 * 1024
    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)
    
    if file_size > max_size:
        return jsonify({"error": "File exceeds 50MB limit"}), 400
    
    safe_name = secure_filename(file.filename.rsplit(".", 1)[0])
    filename = f"timelapse_{int(time_ns() // 1e6)}_{safe_name}.{ext}"
    filepath = UPLOAD_DIR / filename
    
    try:
        file.save(str(filepath))
        return jsonify({"ok": True, "filename": filename}), 201
    except Exception as e:
        return jsonify({"error": f"Upload failed: {str(e)}"}), 500


# ─── Utility ────────────────────────────────────────────────────────────────
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def normalize_item_type(value):
    item_type = (value or "filament").strip().lower()
    if item_type == "materials":
        item_type = "material"
    if item_type in {"equip", "equipments"}:
        item_type = "equipment"
    if item_type in {"model_kit", "modelkit", "model kit", "modelkits"}:
        item_type = "model_kit"
    if item_type not in {"filament", "material", "equipment", "model_kit"}:
        item_type = "filament"
    return item_type



# ─── Selling: Products ──────────────────────────────────────────────────────

@app.route("/api/sell/products", methods=["GET"])
def sell_get_products():
    db = get_db()
    rows = db.execute("SELECT *, COALESCE(filament_breakdown, '[]') AS filament_breakdown FROM sell_products ORDER BY name ASC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/sell/products", methods=["POST"])
def sell_add_product():
    d = request.get_json() or {}
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    sku = (d.get("sku") or "").strip()
    if not sku:
        words = [w for w in name.upper().split() if w.isalpha()]
        prefix = "".join(w[:3] for w in words[:3]) or name[:4].upper()
        suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=4))
        sku = f"{prefix}-{suffix}"
    filament_breakdown = d.get("filament_breakdown") or "[]"
    db = get_db()
    cur = db.execute(
        "INSERT INTO sell_products (name, description, cost_per_item, stock, color_name, color_hex, notes, sku, image, filament_breakdown) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (name, d.get("description") or None,
         float(d.get("cost_per_item") or 0), int(d.get("stock") or 0),
         d.get("color_name") or None, d.get("color_hex") or None,
         d.get("notes") or None, sku, d.get("image") or None, filament_breakdown),
    )
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid, "sku": sku}), 201

@app.route("/api/sell/products/<int:pid>", methods=["PUT"])
def sell_update_product(pid):
    d = request.get_json() or {}
    db = get_db()
    existing = db.execute("SELECT * FROM sell_products WHERE id=?", (pid,)).fetchone()
    if not existing:
        return jsonify({"error": "Not found"}), 404
    sku = (d.get("sku") or "").strip() if "sku" in d else (existing["sku"] or "") # Allow explicit empty string
    filament_breakdown = d.get("filament_breakdown") if "filament_breakdown" in d else (existing["filament_breakdown"] or "[]")
    db.execute(
        "UPDATE sell_products SET name=?, description=?, cost_per_item=?, stock=?, color_name=?, color_hex=?, notes=?, sku=?, filament_breakdown=?, image=? WHERE id=?",
        (d.get("name", existing["name"]).strip(),
         d.get("description") if "description" in d else existing["description"],
         float(d.get("cost_per_item", existing["cost_per_item"]) or 0),
         int(d.get("stock", existing["stock"]) or 0),
         d.get("color_name") if "color_name" in d else existing["color_name"],
         d.get("color_hex") if "color_hex" in d else existing["color_hex"],
         d.get("notes") if "notes" in d else existing["notes"],
         sku, # Use the provided SKU, even if empty, or existing
         filament_breakdown,
         d.get("image") if "image" in d else existing.get("image"),
         pid),
    )
    db.commit()
    return jsonify({"ok": True})

@app.route("/api/sell/products/<int:pid>/adjust", methods=["POST"])
def sell_adjust_stock(pid):
    d = request.get_json() or {}
    delta = int(d.get("delta", 0))
    db = get_db()
    existing = db.execute("SELECT stock FROM sell_products WHERE id=?", (pid,)).fetchone()
    if not existing:
        return jsonify({"error": "Not found"}), 404
    new_stock = max(0, (existing["stock"] or 0) + delta)
    db.execute("UPDATE sell_products SET stock=? WHERE id=?", (new_stock, pid))
    db.commit()
    return jsonify({"ok": True, "stock": new_stock})

@app.route("/api/sell/products/<int:pid>", methods=["DELETE"])
def sell_delete_product(pid):
    db = get_db()
    db.execute("DELETE FROM sell_products WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


# ─── Selling: Events ────────────────────────────────────────────────────────

@app.route("/api/sell/events", methods=["GET"])
def sell_get_events():
    db = get_db()
    events = db.execute("SELECT * FROM sell_events ORDER BY event_date DESC, id DESC").fetchall()
    result = []
    for e in events:
        ev = dict(e)
        sales = db.execute("""
            SELECT es.*, sp.name AS product_name, sp.cost_per_item
            FROM sell_event_sales es
            JOIN sell_products sp ON es.product_id = sp.id
            WHERE es.event_id = ?
        """, (e["id"],)).fetchall()
        ev["sales"] = [dict(s) for s in sales]
        revenue = sum((s["qty_sold"] or 0) * (s["sale_price"] or 0) for s in sales)
        cost    = sum((s["qty_sold"] or 0) * (s["cost_per_item"] or 0) for s in sales)
        ev["revenue"]  = revenue
        ev["cost"]     = cost
        ev["profit"]   = revenue - cost - (e["stand_cost"] or 0)
        result.append(ev)
    return jsonify(result)

@app.route("/api/sell/events", methods=["POST"])
def sell_add_event():
    d = request.get_json() or {}
    if not (d.get("name") or "").strip():
        return jsonify({"error": "name required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO sell_events (name, event_date, location, stand_cost, notes) VALUES (?,?,?,?,?)",
        (d["name"].strip(), d.get("event_date") or None, d.get("location") or None,
         float(d.get("stand_cost") or 0), d.get("notes") or None),
    )
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid}), 201

@app.route("/api/sell/events/<int:eid>", methods=["PUT"])
def sell_update_event(eid):
    d = request.get_json() or {}
    db = get_db()
    existing = db.execute("SELECT * FROM sell_events WHERE id=?", (eid,)).fetchone()
    if not existing:
        return jsonify({"error": "Not found"}), 404
    db.execute(
        "UPDATE sell_events SET name=?, event_date=?, location=?, stand_cost=?, notes=? WHERE id=?",
        (d.get("name", existing["name"]).strip(),
         d.get("event_date") if "event_date" in d else existing["event_date"],
         d.get("location") if "location" in d else existing["location"],
         float(d.get("stand_cost", existing["stand_cost"]) or 0),
         d.get("notes") if "notes" in d else existing["notes"],
         eid),
    )
    db.commit()
    return jsonify({"ok": True})

@app.route("/api/sell/events/<int:eid>", methods=["DELETE"])
def sell_delete_event(eid):
    db = get_db()
    db.execute("DELETE FROM sell_events WHERE id=?", (eid,))
    db.commit()
    return jsonify({"ok": True})


# ─── Selling: Event Sales (line items) ───────────────────────────────────────

@app.route("/api/sell/events/<int:eid>/sales", methods=["POST"])
def sell_add_sale(eid):
    d = request.get_json() or {}
    db = get_db()
    if not db.execute("SELECT 1 FROM sell_events WHERE id=?", (eid,)).fetchone():
        return jsonify({"error": "Event not found"}), 404
    cur = db.execute(
        "INSERT INTO sell_event_sales (event_id, product_id, qty_sold, sale_price) VALUES (?,?,?,?)",
        (eid, int(d["product_id"]), int(d.get("qty_sold") or 0), float(d.get("sale_price") or 0)),
    )
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid}), 201

@app.route("/api/sell/sales/<int:sid>", methods=["PUT"])
def sell_update_sale(sid):
    d = request.get_json() or {}
    db = get_db()
    existing = db.execute("SELECT * FROM sell_event_sales WHERE id=?", (sid,)).fetchone()
    if not existing:
        return jsonify({"error": "Not found"}), 404
    db.execute(
        "UPDATE sell_event_sales SET product_id=?, qty_sold=?, sale_price=? WHERE id=?",
        (int(d.get("product_id", existing["product_id"])),
         int(d.get("qty_sold", existing["qty_sold"]) or 0),
         float(d.get("sale_price", existing["sale_price"]) or 0),
         sid),
    )
    db.commit()
    return jsonify({"ok": True})

@app.route("/api/sell/sales/<int:sid>", methods=["DELETE"])
def sell_delete_sale(sid):
    db = get_db()
    db.execute("DELETE FROM sell_event_sales WHERE id=?", (sid,))
    db.commit()
    return jsonify({"ok": True})


# ─── Upload: Product Images ────────────────────────────────────────────────────

@app.route("/api/upload/product-image", methods=["POST"])
def upload_product_image():
    """Upload an image for a product and return the filename."""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400
    
    # Allowed extensions
    allowed_extensions = {"png", "jpg", "jpeg", "gif", "webp"}
    ext = file.filename.rsplit(".", 1)[1].lower() if "." in file.filename else ""
    
    if ext not in allowed_extensions:
        return jsonify({"error": f"File type not allowed. Allowed: {', '.join(allowed_extensions)}"}), 400
    
    # Limit file size (10MB)
    max_size = 10 * 1024 * 1024
    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)
    
    if file_size > max_size:
        return jsonify({"error": "File size exceeds 10MB limit"}), 400
    
    # Generate safe filename with timestamp
    from time import time_ns
    safe_name = secure_filename(file.filename.rsplit(".", 1)[0])
    filename = f"product_{int(time_ns() // 1e6)}_{safe_name}.{ext}"
    filepath = UPLOAD_DIR / filename
    
    try:
        file.save(str(filepath))
        return jsonify({"ok": True, "filename": filename}), 201
    except Exception as e:
        return jsonify({"error": f"Upload failed: {str(e)}"}), 500



# ─── Bambu Lab Cloud auto-sync ───────────────────────────────────────────────
@app.route("/api/bambu/status", methods=["GET"])
def bambu_status():
    db = get_db(); bambu.ensure_tables(db)
    return jsonify(bambu.status(db))


@app.route("/api/bambu/login", methods=["POST"])
def bambu_login():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip()
    password = d.get("password") or ""
    region = (d.get("region") or "global").strip()
    if not email or not password:
        return jsonify({"error": "Email and password required"}), 400
    db = get_db(); bambu.ensure_tables(db)
    res = bambu.login(db, email, password, region)
    return jsonify(res), (400 if res.get("error") else 200)


@app.route("/api/bambu/verify", methods=["POST"])
def bambu_verify():
    d = request.get_json(silent=True) or {}
    code = (d.get("code") or "").strip()
    if not code:
        return jsonify({"error": "Verification code required"}), 400
    db = get_db(); bambu.ensure_tables(db)
    res = bambu.verify(db, code)
    return jsonify(res), (400 if res.get("error") else 200)


@app.route("/api/bambu/logout", methods=["POST"])
def bambu_logout():
    db = get_db(); bambu.ensure_tables(db)
    return jsonify(bambu.logout(db))


@app.route("/api/bambu/settings", methods=["POST"])
def bambu_settings():
    d = request.get_json(silent=True) or {}
    db = get_db(); bambu.ensure_tables(db)
    if "auto_sync" in d:
        bambu.set_setting(db, "bambu_auto_sync", "1" if d["auto_sync"] else "0")
    if "auto_deduct" in d:
        bambu.set_setting(db, "bambu_auto_deduct", "1" if d["auto_deduct"] else "0")
    if "interval_min" in d:
        try:
            bambu.set_setting(db, "bambu_interval_min", max(2, int(d["interval_min"])))
        except (ValueError, TypeError):
            pass
    return jsonify(bambu.status(db))


@app.route("/api/bambu/sync", methods=["POST"])
def bambu_sync_now():
    d = request.get_json(silent=True) or {}
    db = get_db(); bambu.ensure_tables(db)
    res = bambu.sync(db, deduct=True,
                     date_from=(d.get("from") or None), date_to=(d.get("to") or None))
    return jsonify(res), (400 if res.get("error") else 200)


@app.route("/api/bambu/pending", methods=["GET"])
def bambu_pending():
    db = get_db(); bambu.ensure_tables(db)
    return jsonify(bambu.pending_list(db))


@app.route("/api/bambu/assign", methods=["POST"])
def bambu_assign():
    d = request.get_json(silent=True) or {}
    task_id = d.get("task_id"); fid = d.get("filament_id"); grams = d.get("grams")
    if not task_id or not fid or grams in (None, ""):
        return jsonify({"error": "task_id, filament_id and grams required"}), 400
    db = get_db(); bambu.ensure_tables(db)
    res = bambu.assign(db, str(task_id), int(fid), float(grams),
                       d.get("material", ""), d.get("colour", ""), bool(d.get("learn", True)))
    return jsonify(res), (400 if res.get("error") else 200)


@app.route("/api/bambu/dismiss", methods=["POST"])
def bambu_dismiss():
    d = request.get_json(silent=True) or {}
    task_id = d.get("task_id")
    if not task_id:
        return jsonify({"error": "task_id required"}), 400
    db = get_db(); bambu.ensure_tables(db)
    return jsonify(bambu.dismiss(db, str(task_id)))


@app.route("/api/bambu/restore_skipped", methods=["POST"])
def bambu_restore_skipped():
    db = get_db(); bambu.ensure_tables(db)
    return jsonify(bambu.restore_skipped(db))


@app.route("/api/bambu/debug", methods=["GET"])
def bambu_debug():
    """Diagnostic: shows the raw shape of your Bambu tasks + inventory colour data.
    Open http://<host>:5000/api/bambu/debug in a browser and share the output."""
    db = get_db(); bambu.ensure_tables(db)
    tasks, err = bambu.fetch_tasks(db, limit=3)
    sample = tasks[:2] if isinstance(tasks, list) else []
    resolved = bambu._filaments_for(db, sample[0]) if sample else []
    sp = db.execute(
        "SELECT COUNT(*) AS c, "
        "SUM(CASE WHEN color_hex IS NOT NULL AND TRIM(color_hex) != '' THEN 1 ELSE 0 END) AS h "
        "FROM filaments"
    ).fetchone()
    sample_spools = [dict(r) for r in db.execute(
        "SELECT id, brand, material, color_name, color_hex, weight_current FROM filaments LIMIT 5"
    ).fetchall()]
    return jsonify({
        "fetch_error": err,
        "task_count": len(tasks) if isinstance(tasks, list) else 0,
        "spools_total": sp["c"],
        "spools_with_colour_hex": sp["h"],
        "first_task_resolved_filaments": resolved,
        "sample_spools": sample_spools,
        "tasks_sample": sample,
    })


@app.route("/api/bambuddy/status", methods=["GET"])
def bambuddy_status():
    db = get_db(); bambu.ensure_tables(db); bambuddy_sync.ensure_tables(db)
    return jsonify(bambuddy_sync.status(db))


@app.route("/api/bambuddy/connect", methods=["POST"])
def bambuddy_connect():
    d = request.get_json(silent=True) or {}
    url = (d.get("url") or "").strip()
    api_key = (d.get("api_key") or "").strip()
    if not url or not api_key:
        return jsonify({"error": "Bambuddy URL and API key are required"}), 400
    db = get_db(); bambu.ensure_tables(db); bambuddy_sync.ensure_tables(db)
    res = bambuddy_sync.connect(db, url, api_key)
    return jsonify(res), (400 if res.get("error") else 200)


@app.route("/api/bambuddy/disconnect", methods=["POST"])
def bambuddy_disconnect():
    db = get_db(); bambuddy_sync.ensure_tables(db)
    return jsonify(bambuddy_sync.disconnect(db))


@app.route("/api/bambuddy/settings", methods=["POST"])
def bambuddy_settings():
    d = request.get_json(silent=True) or {}
    db = get_db(); bambuddy_sync.ensure_tables(db)
    if "auto_sync" in d:
        bambuddy_sync.set_setting(db, "bambuddy_auto_sync", "1" if d["auto_sync"] else "0")
    if "interval_min" in d:
        try:
            bambuddy_sync.set_setting(db, "bambuddy_interval_min", max(2, int(d["interval_min"])))
        except (ValueError, TypeError):
            pass
    return jsonify(bambuddy_sync.status(db))


@app.route("/api/bambuddy/sync", methods=["POST"])
def bambuddy_sync_now():
    db = get_db(); bambu.ensure_tables(db); bambuddy_sync.ensure_tables(db)
    res = bambuddy_sync.sync(db)
    return jsonify(res), (400 if res.get("error") else 200)


@app.route("/api/nozzles", methods=["GET"])
def nozzles_list():
    db = get_db(); bambu.ensure_tables(db)
    bambu.backfill_nozzles(db)   # fill in history from previously-synced prints
    totals = [dict(r) for r in db.execute(
        "SELECT nl.printer AS printer, nl.nozzle_pos AS nozzle_pos, nl.nozzle_size AS nozzle_size, "
        "SUM(nl.time_s) AS total_s, COUNT(*) AS prints, MAX(nl.created_at) AS last_used, "
        "nn.label AS label, nn.equipment_id AS equipment_id, "
        "eq.brand AS eq_brand, eq.model AS eq_model, eq.variant AS eq_variant "
        "FROM nozzle_logs nl "
        "LEFT JOIN nozzle_names nn ON nn.printer = nl.printer AND nn.nozzle_pos = nl.nozzle_pos "
        "LEFT JOIN equipment eq ON eq.id = nn.equipment_id "
        "GROUP BY nl.printer, nl.nozzle_pos, nl.nozzle_size "
        "ORDER BY total_s DESC"
    ).fetchall()]
    manual = [dict(r) for r in db.execute(
        "SELECT id, printer, nozzle_pos, nozzle_size, time_s, created_at "
        "FROM nozzle_logs WHERE source = 'manual' ORDER BY created_at DESC"
    ).fetchall()]
    bambuddy_sync.ensure_tables(db)
    recent = [dict(r) for r in db.execute(
        "SELECT task_id, title, printer, nozzle_size, print_time_s, finished_at FROM bambu_tasks "
        "WHERE print_time_s > 0 "
        "UNION ALL "
        "SELECT task_id, title, printer, nozzle_size, duration_s AS print_time_s, finished_at FROM bambuddy_prints "
        "WHERE duration_s > 0 "
        "ORDER BY finished_at DESC LIMIT 100"
    ).fetchall()]
    return jsonify({"totals": totals, "manual": manual, "recent": recent})


@app.route("/api/nozzles/manual", methods=["POST"])
def nozzles_manual_add():
    d = request.get_json(silent=True) or {}
    size = (d.get("nozzle_size") or "").strip()
    printer = (d.get("printer") or "").strip()
    pos = (d.get("nozzle_pos") or "").strip()
    try:
        hours = float(d.get("hours") or 0)
    except (TypeError, ValueError):
        hours = 0
    if not size or hours <= 0:
        return jsonify({"error": "Nozzle size and a positive hours value are required"}), 400
    db = get_db(); bambu.ensure_tables(db)
    db.execute(
        "INSERT INTO nozzle_logs (task_key, printer, nozzle_pos, nozzle_size, time_s, project, source) "
        "VALUES (NULL, ?, ?, ?, ?, 'Manual entry', 'manual')",
        (printer, pos, size, int(hours * 3600)),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/nozzles/manual/<int:nid>", methods=["DELETE"])
def nozzles_manual_delete(nid):
    db = get_db(); bambu.ensure_tables(db)
    db.execute("DELETE FROM nozzle_logs WHERE id = ? AND source = 'manual'", (nid,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/nozzles/print/<task_id>", methods=["PUT"])
def nozzles_edit_print(task_id):
    d = request.get_json(silent=True) or {}
    db = get_db(); bambu.ensure_tables(db); bambuddy_sync.ensure_tables(db)
    # "bb<id>" task_ids come from Bambuddy (bambuddy_prints); everything else
    # is a Bambu Cloud task (bambu_tasks). nozzle_logs rows use the same
    # task_key pattern ("<task_id>#<pos>") for both sources.
    is_bambuddy = task_id.startswith("bb")
    table, time_col = ("bambuddy_prints", "duration_s") if is_bambuddy else ("bambu_tasks", "print_time_s")
    cur = db.execute(f"SELECT {time_col} AS time_s, nozzle_size, printer FROM {table} WHERE task_id = ?", (task_id,)).fetchone()
    if not cur:
        return jsonify({"error": "Unknown print"}), 404
    # accept minutes (friendly) or raw seconds
    if "minutes" in d and d.get("minutes") not in (None, ""):
        try:
            time_s = int(round(float(d["minutes"]) * 60))
        except (TypeError, ValueError):
            time_s = cur["time_s"]
    else:
        time_s = int(d.get("print_time_s") or cur["time_s"] or 0)
    size = (d.get("nozzle_size") if d.get("nozzle_size") is not None else cur["nozzle_size"]) or ""
    printer = (d.get("printer") if d.get("printer") is not None else cur["printer"]) or ""
    db.execute(f"UPDATE {table} SET {time_col} = ?, nozzle_size = ?, printer = ? WHERE task_id = ?",
               (time_s, size, printer, task_id))
    db.execute("UPDATE nozzle_logs SET time_s = ?, nozzle_size = ?, printer = ? WHERE task_key LIKE ?",
               (time_s, size, printer, task_id + "#%"))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/nozzles/print/delete", methods=["POST"])
def nozzles_delete_prints():
    d = request.get_json(silent=True) or {}
    ids = d.get("task_ids") or ([d["task_id"]] if d.get("task_id") else [])
    if not ids:
        return jsonify({"error": "task_ids required"}), 400
    db = get_db(); bambu.ensure_tables(db); bambuddy_sync.ensure_tables(db)
    for tid in ids:
        tid = str(tid)
        db.execute("DELETE FROM nozzle_logs WHERE task_key LIKE ?", (tid + "#%",))
        # keep the task row (so it isn't re-imported) but drop it from the prints list
        if tid.startswith("bb"):
            db.execute("UPDATE bambuddy_prints SET duration_s = 0 WHERE task_id = ?", (tid,))
        else:
            db.execute("UPDATE bambu_tasks SET print_time_s = 0 WHERE task_id = ?", (tid,))
    db.commit()
    return jsonify({"ok": True, "deleted": len(ids)})


@app.route("/api/nozzles/name", methods=["POST"])
def nozzles_set_name():
    d = request.get_json(silent=True) or {}
    printer = (d.get("printer") or "").strip()
    pos = (d.get("nozzle_pos") or "").strip()
    label = (d.get("label") or "").strip()
    eq_id = d.get("equipment_id")
    try:
        eq_id = int(eq_id) if eq_id not in (None, "", "null") else None
    except (TypeError, ValueError):
        eq_id = None
    if pos == "":
        return jsonify({"error": "nozzle_pos required"}), 400
    db = get_db(); bambu.ensure_tables(db)
    db.execute(
        "INSERT INTO nozzle_names (printer, nozzle_pos, label, equipment_id) VALUES (?,?,?,?) "
        "ON CONFLICT(printer, nozzle_pos) DO UPDATE SET label = excluded.label, equipment_id = excluded.equipment_id",
        (printer, pos, label, eq_id),
    )
    db.commit()
    return jsonify({"ok": True})


# Start the Bambu auto-sync poller (stays idle until you connect + enable it).
# It scans every SpoolStats database in the data folder, so it works no matter
# what your inventory database is called.
try:
    import glob as _glob
    for _dbfile in _glob.glob(str(DATA_DIR / "*.db")):
        _c = sqlite3.connect(_dbfile); _c.row_factory = sqlite3.Row
        if _c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='filaments'").fetchone():
            bambu.ensure_tables(_c)
            bambuddy_sync.ensure_tables(_c)
        _c.close()
    bambu.start_poller(str(DATA_DIR))
    bambuddy_sync.start_poller(str(DATA_DIR))
except Exception as _e:
    print("Could not start Bambu poller:", _e)


if __name__ == "__main__":
    conn = sqlite3.connect(DEFAULT_DB)
    conn.row_factory = sqlite3.Row
    _migrate(conn)
    conn.close()

    ip   = get_local_ip()
    port = 5000
    print("\n" + "═" * 52)
    print("  🧵  SpoolStats — Local Server")
    print("═" * 52)
    print(f"  💻  Desktop  →  http://localhost:{port}")
    print(f"  📱  Phone    →  http://{ip}:{port}")
    print("═" * 52 + "\n")
    app.run(host="0.0.0.0", port=port, debug=False)
