
CREATE TABLE filaments(
id INTEGER PRIMARY KEY AUTOINCREMENT,
brand TEXT,
material TEXT,
colour TEXT,
filament_left REAL,
spools INTEGER,
finished_spools INTEGER
);

CREATE TABLE usage_logs(
id INTEGER PRIMARY KEY AUTOINCREMENT,
grams REAL,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
