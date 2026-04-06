# Filament Flow — Setup Guide

## Repo structure

```
/
├── index.html              ← single-page app
├── wrangler.toml           ← Cloudflare config (add your DB ID)
├── schema.sql              ← run once in D1 Console
└── functions/
    └── api/
        ├── filaments.js    ← GET/POST /api/filaments
        └── usage.js        ← GET/POST /api/usage
```

---

## Step 1 — Create the D1 database

1. Go to **Cloudflare dashboard → Workers & Pages → D1**
2. Click **Create database**, name it `filament-stock`
3. Copy the **Database ID** (looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
4. Paste it into `wrangler.toml` where it says `YOUR_DATABASE_ID`

---

## Step 2 — Run the SQL schema

1. In D1, open your database → click **Console**
2. Paste the entire contents of `schema.sql` and click **Execute**
3. You should see the `filaments` and `usage_logs` tables appear

---

## Step 3 — Link D1 to your Pages project

1. Go to **Workers & Pages → your Pages project → Settings → Functions**
2. Under **D1 database bindings**, add:
   - Variable name: `DB`
   - D1 database: `filament-stock`
3. Save — this makes `context.env.DB` available in your functions

---

## Step 4 — Push to GitHub

Commit and push everything. Cloudflare Pages will auto-deploy.

```
git add .
git commit -m "Add Filament Flow app"
git push
```

---

## Step 5 — Import your Excel data

1. Open your deployed site
2. Click **Import Excel** and select your `Filament_Stock.xlsx`
3. Your spools will appear immediately

---

## Using the app

| Feature | How |
|---|---|
| **Import Excel** | Reads your spreadsheet (Brand, Colour, Material, Style, Amount In Stock columns) |
| **Add Spool** | Manual single-spool entry |
| **Log 3MF Print** | Upload a `.3mf` file — auto-reads grams from gcode, then asks which spool to deduct from |
| **Log Use (button)** | Click `− Log Use` on any card to manually subtract grams |
| **Buy link** | `↗ Buy` on each card links to your Web Address column |
| **Low Stock** | Anything under 150g triggers an orange warning |

---

## Troubleshooting

**"Could not load data"** → Check that your D1 binding variable is exactly `DB` (uppercase)

**Excel import shows 0 items** → Your sheet must have headers in row 2 (first row blank). The importer handles this automatically.

**3MF shows no weight** → The print must be sliced in Bambu Studio first. Re-slice and re-export.

**Functions 404** → Make sure your functions are in `/functions/api/` — Cloudflare Pages maps these to `/api/` automatically.
