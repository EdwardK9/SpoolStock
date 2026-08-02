# Updating SpoolStats on TrueNAS (and making future updates easy)

Your current app bakes the code **inside** the `filamentflow:latest` image, so
every update means rebuilding that image. These steps switch it to read the code
from a **folder on the NAS** instead — so this update, and every future one, is
just *copy the files in and restart*.

Your database is **not touched** by any of this.

---

## Step 1 — Put the code on the NAS

You already have a `data` folder at `/mnt/Applications/SpoolStats/data`.
Create a new sibling folder next to it called **`app`**, and copy **all** the
V25 files into it.

Final layout on the NAS:

```
/mnt/Applications/SpoolStats/
├── app/                ← NEW: the code goes here
│   ├── app.py
│   ├── bambu.py        ← the new Bambu sync file
│   ├── app.js
│   ├── index.html
│   ├── style.css
│   └── requirements.txt
└── data/               ← unchanged, your database stays here
    └── spoolstats.db
```

How to copy them over: open the SpoolStats share in Windows Explorer
(e.g. `\\TRUENAS\Applications\SpoolStats`), make the `app` folder, and drag the
files from the V25 folder into it. (You don't need the `data`, `start.bat`,
`start.sh`, `dockerfile`, or the docker-compose files inside `app/` — just the
six code files above. Copying extras does no harm, though.)

---

## Step 2 — Swap the compose YAML

In TrueNAS: **Apps → spoolstats → Edit**, find the YAML box, delete what's there
and paste this in:

```yaml
services:
  spoolstats:
    container_name: spoolstats
    image: python:3.11-slim
    working_dir: /app
    command: sh -c "pip install --no-cache-dir flask && python app.py"
    ports:
      - '5000:5000'
    restart: unless-stopped
    volumes:
      - /mnt/Applications/SpoolStats/app:/app
      - /mnt/Applications/SpoolStats/data:/app/data
```

Save / Update. TrueNAS will pull the standard `python:3.11-slim` image, install
Flask, and start the app from your `app` folder.

> The NAS needs internet for this (to grab Flask, and for Bambu sync). It already
> does if Bambu sync is going to work.

---

## Step 3 — Check it

Open `http://<your-nas-ip>:5000`. You should see the new 3-tab layout
(Dashboard · Inventory · Usage) and a **🔗 Bambu Sync** button top-right.
Your spools and history are all still there.

---

## From now on, updating is trivial

1. Drop the changed files into `/mnt/Applications/SpoolStats/app/`.
2. Restart the app in TrueNAS (Stop ▸ Start, or the restart button).

No image rebuilds, ever.

---

## If you'd rather keep building the image instead

You can stay on `image: filamentflow:latest` if you prefer — just rebuild it
from the V25 `dockerfile` (which now includes `bambu.py`) before redeploying:

```bash
cd /path/to/V25/on/the/nas
docker build -t filamentflow:latest .
```

Then keep your original YAML. But the folder-mount method above avoids needing
to do this every time, which is why it's the recommended route.
