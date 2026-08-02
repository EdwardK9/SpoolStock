# SpoolStats

A self-hosted 3D-printing filament tracker. Keep an inventory of your spools,
log how much filament each print uses, and watch your stock and spending update
automatically. Runs entirely on your own computer or home server — your data
never leaves your machine (except the optional Bambu Cloud sync, which only
*reads* your print history from Bambu).

> **This is V27.** It makes the layout fill your whole screen, works properly
> on phones, tidies up the header, and adds usage-rate insights. Your previous
> version (V26) is untouched in the folder next to this one, so you can always
> go back.

---

## What's new in this version

- **Full-width layout.** The page is no longer capped at 1280px — it fills any
  monitor, and the inventory grid automatically shows as many spool cards per
  row as fit (4–6 on a big screen instead of 3).
- **Better on phones.** Tables scroll sideways instead of being cut off, spool
  cards compact themselves so you can quickly check remaining filament and
  colours, and modals stack their fields in one column.
- **Tidier header.** Global CSV, Import Excel, Export and Download Database now
  live in one **🗂 Import / Export** menu, so the header is much less cluttered.
- **Compact low-stock alerts.** The dashboard's Low Stock section shows small
  one-line cards (colour · name · grams left · Refill button) sorted most-urgent
  first, instead of full-size cards — far less scrolling.
- **Usage insights.** The dashboard System panel now shows your average grams
  used per week (last 8 weeks) and roughly how long your current stock will
  last at that rate.

---

## 1. Install & run

You need **Python 3.9 or newer**. That's the only requirement — everything else
installs itself on first run.

### Windows
1. Copy the `V25` folder anywhere you like (e.g. `Documents\SpoolStats`).
2. Double-click **`start.bat`**.
3. Your browser opens at **http://localhost:5000**.

If Windows blocks it, click *More info → Run anyway* (it's just a local script).

### Mac / Linux
1. Copy the `V25` folder anywhere you like.
2. In Terminal, run:
   ```bash
   cd /path/to/V25
   bash start.sh
   ```
3. Open **http://localhost:5000**.

### Run it manually (any OS)
```bash
cd V25
pip install flask
python app.py
```

### Open it from your phone
While the server is running, the terminal prints a phone address like
`http://192.168.1.50:5000`. Open that on any device on the same Wi-Fi.

---

## 2. Run it on a server (Docker / TrueNAS)

The folder includes a `dockerfile` and `docker-compose.yml`.

```bash
cd V25
docker compose up -d
```

Then browse to `http://<server-ip>:5000`. Your database lives in the `data/`
folder, which is mounted as a volume so it survives container rebuilds.

On **TrueNAS SCALE**, add a *Custom App* and point it at this folder's compose
file, or build the image from the `dockerfile`. Make sure the container has
internet access if you want Bambu auto-sync to work.

---

## 3. First-time setup

1. **Bring in your spools.** Top-right → **Import Excel** (or **Import Global
   CSV**) and pick your spreadsheet. You can also add spools by hand with
   **＋ Add Entry**.
2. **Moving from an older version?** Copy your existing
   `data/spoolstats.db` into this version's `data/` folder *before* starting it,
   and all your spools, usage and settings come across.

---

## 4. Bambu Lab auto-sync (the new bit)

This connects to **Bambu Cloud** — the same service the Bambu Handy app uses —
and reads your finished print jobs. For each print, Bambu records how many grams
of each filament it used (the slicer's estimate). SpoolStats matches that to a
spool in your inventory and subtracts it automatically.

> **Why not read the printer directly?** The per-print weight isn't something
> the printer streams live — it's stored in the cloud against each job. The
> Bambu Studio source code calculates that number at slice time, but the place
> to *read it back* is the cloud account, so that's what we use. It works from
> anywhere with internet, including a headless server.

### Connecting
1. Click **🔗 Bambu Sync** in the top-right.
2. Enter your **Bambu email and password**, choose your region (Global or
   China), and click **Send code & connect**.
3. Bambu emails you a **6-digit verification code** (their login now requires
   this). Type it in and click **Verify & Connect**.

Your password is sent **once** to Bambu to log in and is never stored.
SpoolStats only keeps the access token Bambu hands back.

### Turning on automatic deduction
Once connected:
- Tick **Auto-sync every N minutes** (default 15). The server then checks for
  new finished prints in the background and deducts filament on its own — even
  while the page is closed.
- Or click **🔄 Sync now** any time to pull immediately.

### How matching works
For each filament in a print, SpoolStats finds the best in-stock spool by
**material + colour**:
- **Confident match** (same material, near-identical colour) → deducted
  automatically.
- **Not sure** → the print is parked in a **"needs a spool"** list inside the
  Bambu panel. Pick the right spool once and click **Assign**; SpoolStats
  **remembers that choice** and auto-matches the same tray next time.

Every Bambu deduction shows up in your **Usage** log tagged as a Bambu print,
and each print is only ever counted once.

### Good to know / limits
- Weights are the **slicer's estimate** (what Bambu stores), not a measured
  weigh-in — same number you'd see in Bambu Studio. Plenty accurate for stock
  tracking, but not to the milligram.
- Auto-sync always updates your **main `spoolstats` database**. If you keep
  inventory in a different database via the DB selector, the deductions still
  land in the main one.
- If Bambu logs you out (tokens expire), just open the panel and reconnect.

---

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| Browser won't open / "site can't be reached" | Make sure the terminal still shows the server running, and use `http://localhost:5000`. |
| `python` not found (Windows) | Install Python from python.org and tick **"Add Python to PATH"** during setup. |
| Bambu says "could not reach Bambu Cloud" | The machine running SpoolStats needs internet access. On Docker/TrueNAS, check the container's network. |
| Bambu login fails | Double-check email/password and region, and that you entered the latest emailed code (they expire quickly). |
| Prints aren't deducting | Open **🔗 Bambu Sync** → check **Auto-sync** is ticked and you're connected, then hit **Sync now**. Anything it couldn't match appears in the "needs a spool" list. |
| Wrong spool was deducted | Open the **Usage** tab and delete/restore that entry, then assign the print to the correct spool. |

---

## File overview

```
V25/
├── app.py              ← Flask web server + all API routes
├── bambu.py            ← Bambu Cloud login, sync, spool-matching, auto-deduct
├── app.js              ← the whole front-end
├── index.html          ← page layout
├── style.css           ← themes & styling
├── requirements.txt    ← Python dependency (Flask)
├── start.bat           ← Windows launcher
├── start.sh            ← Mac/Linux launcher
├── dockerfile          ← container build
├── docker-compose.yml  ← one-command server deploy
└── data/               ← your SQLite database lives here
```
