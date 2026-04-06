-- =============================================
-- Filament Flow — D1 Database Schema
-- Run this in the Cloudflare dashboard:
--   Workers & Pages → D1 → your-db → Console
-- =============================================

-- Drop tables (useful for re-initialising during dev)
-- DROP TABLE IF EXISTS usage_logs;
-- DROP TABLE IF EXISTS filaments;

CREATE TABLE IF NOT EXISTS filaments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    brand           TEXT,
    material        TEXT,
    color_name      TEXT,
    color_hex       TEXT,
    style           TEXT,
    code            TEXT,          
    barcode         TEXT,
    web_address     TEXT,
    weight_current  REAL NOT NULL DEFAULT 1000,
    total_purchased INTEGER,
    last_updated    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filament_id INTEGER NOT NULL REFERENCES filaments(id),
    project_name TEXT,
    weight_used  REAL NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
);

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_filaments_material ON filaments(material);
CREATE INDEX IF NOT EXISTS idx_usage_filament ON usage_logs(filament_id);
CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_logs(created_at DESC);
