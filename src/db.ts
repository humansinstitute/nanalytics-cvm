import { mkdirSync } from "fs";
import { Database } from "bun:sqlite";
import crypto from "crypto";

let db: Database | null = null;

export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initializeDatabase() first.");
  return db;
}

export function initializeDatabase() {
  if (db) return db;

  mkdirSync("data", { recursive: true });
  db = new Database("data/analytics.db", { create: true, strict: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_uuid TEXT NOT NULL UNIQUE,
      name TEXT,
      owner_npub TEXT,
      owner_signature TEXT,
      secret_token TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS page_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      page_path TEXT NOT NULL,
      device_type TEXT NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 0,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, page_path, device_type),
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      page_path TEXT NOT NULL,
      device_type TEXT NOT NULL,
      nostr_event_id TEXT,
      visited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sites_uuid ON sites(site_uuid);
    CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites(owner_npub);
    CREATE INDEX IF NOT EXISTS idx_page_stats_site ON page_stats(site_id);
    CREATE INDEX IF NOT EXISTS idx_visits_site ON visits(site_id);
    CREATE INDEX IF NOT EXISTS idx_visits_site_page ON visits(site_id, page_path);
  `);

  ensureSiteColumn("secret_token", "TEXT NOT NULL DEFAULT ''");
  ensureVisitColumn("nostr_event_id", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_event ON visits(nostr_event_id);
  `);

  return db;
}

function ensureSiteColumn(column: string, type: string) {
  const hasColumn = db!
    .query(`SELECT 1 FROM pragma_table_info('sites') WHERE name = ?`)
    .get(column);
  if (!hasColumn) {
    db!.exec(`ALTER TABLE sites ADD COLUMN ${column} ${type};`);
    if (column === "secret_token") {
      // Backfill empties with random tokens for existing rows
      const rows = db!.query(`SELECT id FROM sites`).all() as { id: number }[];
      for (const row of rows) {
        const token = crypto.randomUUID().replace(/-/g, "");
        db!.prepare(`UPDATE sites SET secret_token = ? WHERE id = ?`).run(token, row.id);
      }
    }
  }
}

function ensureVisitColumn(column: string, type: string) {
  const hasColumn = db!
    .query(`SELECT 1 FROM pragma_table_info('visits') WHERE name = ?`)
    .get(column);
  if (!hasColumn) {
    db!.exec(`ALTER TABLE visits ADD COLUMN ${column} ${type};`);
  }
}
