"""
export_to_bambuddy_csv.py — Convert a SpoolStats database into a CSV that
Bambuddy's Inventory → Import can read.
============================================================================

Why this exists
----------------
SpoolStats and Bambuddy model spools differently:

  • SpoolStats has ONE ROW PER COLOUR (e.g. "Bambu PLA Basic — Black"),
    tracking a single running `weight_current` that purchases add to and
    prints subtract from. It never deletes a colour when it hits 0g — it
    just sits there at zero, which is exactly the "track everything,
    including emptied spools" behaviour you liked. Each colour can have
    several `purchase_history` rows behind it (bought more of the same
    colour on different dates, sometimes at different prices, sometimes
    free/bundled).

  • Bambuddy has ONE ROW PER PHYSICAL SPOOL, with `label_weight` (nominal
    size when new) and `weight_used` (consumed so far); remaining is
    computed as label_weight - weight_used.

This script expands each SpoolStats colour back out into one Bambuddy row
PER PHYSICAL SPOOL, using its purchase history:

  1. Every `purchase_history` row for a colour is exploded into `qty`
     individual spool units (a purchase of 2 becomes 2 units), each
     carrying that purchase's own price and note — a free/bundled spool
     doesn't get blended into the average price of a paid one anymore.
  2. Units are sorted newest-purchase-first, and the colour's current
     `weight_current` is allocated against them starting from the newest:
     a unit gets marked untouched (weight_used=0) if there's still a full
     spool's worth of stock left to account for, partially used if only
     part of a spool's worth remains, and fully used (weight_used =
     label_weight) once the remaining stock runs out. This mirrors the
     same "newest stock is what's left" assumption SpoolStats' own
     cost-basis calculation already uses (see app.js's per-purchase FIFO
     costing comment).
  3. A colour with no purchase_history at all (older/legacy data) falls
     back to one unit per `total_purchased` count using the filament
     card's own price_paid.

So a colour you've fully used up still imports with every physical spool's
weight_used == label_weight (remaining = 0g each) — nothing is skipped —
but now as separate rows with their own accurate purchase price, instead of
one combined mega-spool with a blended (and potentially misleading) cost.

Usage
-----
    python export_to_bambuddy_csv.py                     # uses data/spoolstats.db
    python export_to_bambuddy_csv.py --db data/other.db --out other.csv

Then in Bambuddy: Inventory → Import → choose the CSV → it shows a dry-run
preview (per-row valid/error/skipped) before you confirm anything is written.
"""

import argparse
import csv
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Must match Bambuddy's backend/app/services/spool_csv.py CSV_COLUMNS exactly
# (order doesn't matter to Bambuddy's importer — it reads by header name — but
# matching it keeps the file human-readable/diffable against its own exports).
CSV_COLUMNS = [
    "material",
    "brand",
    "subtype",
    "color_name",
    "rgba",
    "extra_colors",
    "effect_type",
    "label_weight",
    "weight_used",
    "remaining",
    "cost_per_kg",
    "nozzle_temp_min",
    "nozzle_temp_max",
    "last_used",
    "note",
    "storage_location",
    "category",
    "low_stock_threshold_pct",
]


def _norm_rgba(color_hex):
    """SpoolStats stores '#RRGGBB' (or blank) — but a few older rows have a
    plain colour word ('white', 'pink', 'black') in this field instead of a
    hex code, apparently a past data-entry fallback. Bambuddy's importer
    validates rgba strictly and REJECTS THE WHOLE ROW if it isn't 6/8-char
    hex, so a bad value here wouldn't just lose the colour swatch — it would
    silently drop the entire spool (and its usage history) from the import.
    Only pass through values that are actually hex; blank out anything else
    so Bambuddy just falls back to no colour for that row instead of
    rejecting it."""
    if not color_hex:
        return ""
    raw = color_hex.strip().lstrip("#")
    if len(raw) not in (6, 8):
        return ""
    try:
        int(raw, 16)
    except ValueError:
        return ""
    return raw


def _iso(dt_text):
    """SpoolStats timestamps are already 'YYYY-MM-DD HH:MM:SS' (sqlite
    CURRENT_TIMESTAMP format); Bambuddy's importer wants ISO-8601. Swap the
    space for a 'T' and call it done — both are UTC-naive in practice."""
    if not dt_text:
        return ""
    return dt_text.strip().replace(" ", "T", 1)


def _build_units(db, f):
    """Expand one SpoolStats colour into a list of individual physical-spool
    units, each with its own {'cost_per_kg', 'purchased_at', 'note'}.

    Preference order: purchase_history (accurate, per-purchase price/date/
    note) — falling back to `total_purchased` (a bare count with no per-unit
    price breakdown) only when the colour has no purchase_history rows at
    all (older data predating that feature)."""
    fid = f["id"]
    spool_weight = float(f["spool_weight"] or 1000)

    purchases = db.execute(
        "SELECT price_paid, qty, price_is_free, purchased_at, notes "
        "FROM purchase_history WHERE source_filament_id = ? ORDER BY purchased_at ASC",
        (fid,),
    ).fetchall()

    units = []
    if purchases:
        for p in purchases:
            try:
                qty = max(1, int(round(float(p["qty"] or 1))))
            except (TypeError, ValueError):
                qty = 1
            # SpoolStats' own cost calc (app.js) treats price_paid as the
            # price of ONE spool at spool_weight grams, not the total for
            # `qty` spools — qty is just "how many identical spools at this
            # price". Mirror that here rather than dividing by qty.
            is_free = bool(p["price_is_free"])
            price_per_spool = 0.0 if is_free else float(p["price_paid"] or 0)
            if price_per_spool > 0:
                cost_per_kg = round((price_per_spool / spool_weight) * 1000, 2)
            elif is_free:
                cost_per_kg = 0
            else:
                cost_per_kg = ""  # unknown, not confirmed free — leave blank rather than guess
            note = (p["notes"] or "").strip()
            purchased_at = p["purchased_at"]
            for _ in range(qty):
                units.append({"cost_per_kg": cost_per_kg, "purchased_at": purchased_at, "note": note})
    else:
        # Legacy colour with no purchase_history rows — fall back to a bare
        # spool count from total_purchased (min 1) at the filament card's
        # own price_paid, with no per-unit date/note to distinguish them.
        try:
            n = max(1, int(round(float(f["total_purchased"] or 0))))
        except (TypeError, ValueError):
            n = 1
        price = float(f["price_paid"] or 0)
        cost_per_kg = round((price / spool_weight) * 1000, 2) if price > 0 else ""
        for _ in range(n):
            units.append({"cost_per_kg": cost_per_kg, "purchased_at": None, "note": ""})

    # Newest-purchase-first: assume whatever's still in stock is the most
    # recently bought spool(s) — matches app.js's own FIFO cost-basis
    # comment ("consume ... from the newest purchase first").
    units.sort(key=lambda u: u["purchased_at"] or "", reverse=True)
    return units


def build_rows(db):
    db.row_factory = sqlite3.Row
    filaments = db.execute("SELECT * FROM filaments ORDER BY material, brand, color_name").fetchall()

    rows = []
    skipped_no_material = 0

    for f in filaments:
        material = (f["material"] or "").strip()
        if not material:
            # Bambuddy's importer requires `material`; a SpoolStats row
            # missing it can't be represented — flagged in the summary below
            # rather than silently dropped.
            skipped_no_material += 1
            continue

        fid = f["id"]
        spool_weight = float(f["spool_weight"] or 1000)
        remaining_pool = float(f["weight_current"] or 0)

        last_used = db.execute(
            "SELECT MAX(created_at) AS t FROM usage_logs WHERE filament_id = ?", (fid,)
        ).fetchone()["t"]

        units = _build_units(db, f)

        # Allocate the colour's current remaining stock across its spool
        # units, newest first: a unit is untouched while a full spool's
        # worth of stock is still unaccounted for, partially used once
        # only a fraction remains, fully used once the pool runs dry.
        allocated = []
        for u in units:
            if remaining_pool >= spool_weight - 1e-9:
                weight_used = 0.0
                remaining_pool -= spool_weight
            elif remaining_pool > 0:
                weight_used = round(spool_weight - remaining_pool, 2)
                remaining_pool = 0.0
            else:
                weight_used = spool_weight
            allocated.append((u, weight_used))

        # If weight_current is bigger than every known purchase can account
        # for (missing/incomplete purchase records), don't drop the excess —
        # add one extra untouched spool-sized unit to carry it.
        if remaining_pool > 0.5:
            allocated.append(({
                "cost_per_kg": "",
                "purchased_at": None,
                "note": "Extra stock not matched to a purchase record",
            }, 0.0))

        for u, weight_used in allocated:
            label_weight = round(spool_weight)
            weight_used = round(weight_used, 2)
            if weight_used > label_weight:
                weight_used = label_weight

            note_parts = []
            if f["notes"]:
                note_parts.append(f["notes"].strip())
            if u["note"]:
                note_parts.append(u["note"])
            if f["barcode"]:
                note_parts.append(f"Barcode: {f['barcode']}")
            note = " | ".join(note_parts)
            note = ("Imported from SpoolStats" + (" — " + note if note else ""))

            rows.append({
                "material": material,
                "brand": (f["brand"] or "").strip(),
                "subtype": (f["style"] or "").strip(),
                "color_name": (f["color_name"] or "").strip(),
                "rgba": _norm_rgba(f["color_hex"]),
                "extra_colors": "",
                "effect_type": "",
                "label_weight": label_weight,
                "weight_used": weight_used,
                "remaining": max(0, label_weight - weight_used),
                "cost_per_kg": u["cost_per_kg"],
                "nozzle_temp_min": "",
                "nozzle_temp_max": "",
                # Only stamp a last-used date on units that actually show
                # consumption — an untouched (weight_used=0) spool wasn't
                # the one last used.
                "last_used": _iso(last_used) if weight_used > 0 else "",
                "note": note,
                "storage_location": "",
                "category": "",
                "low_stock_threshold_pct": "",
            })

    return rows, skipped_no_material


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(BASE_DIR / "data" / "spoolstats.db"), help="Path to the SpoolStats .db file")
    ap.add_argument("--out", default=str(BASE_DIR / "bambuddy_import.csv"), help="Output CSV path")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        rows, skipped = build_rows(conn)
    finally:
        conn.close()

    out_path = Path(args.out)
    with out_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

    empty_count = sum(1 for r in rows if r["remaining"] <= 0)
    print(f"Wrote {len(rows)} spool(s) to {out_path}")
    print(f"  {empty_count} of them are fully-emptied (remaining = 0g) — history preserved via weight_used.")
    if skipped:
        print(f"  Skipped {skipped} row(s) with no material set (Bambuddy requires it).")
    print("\nNext step: in Bambuddy, go to Inventory -> Import, choose this CSV, "
          "check the dry-run preview, then confirm.")


if __name__ == "__main__":
    main()
