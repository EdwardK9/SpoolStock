
CREATE TABLE filaments (
id INTEGER PRIMARY KEY AUTOINCREMENT,
brand TEXT,
material TEXT,
color_name TEXT,
color_hex TEXT,
style TEXT,
barcode TEXT,
qr_code TEXT,
ams_slot TEXT,
spool_weight REAL,
weight_current REAL DEFAULT 1000
);

CREATE TABLE usage_logs (
id INTEGER PRIMARY KEY AUTOINCREMENT,
filament_id INTEGER,
project_name TEXT,
weight_used REAL,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
