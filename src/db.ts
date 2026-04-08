import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./constants.ts";

export type SqlValue = string | number | null;
export type SqlParams = Record<string, SqlValue>;

export function openDb(dbPath = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function requireDb(dbPath = DB_PATH): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    console.error("Database not found. Run: npm run scan");
    process.exit(1);
  }
  return openDb(dbPath);
}

export function initDb(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project_name TEXT,
      first_timestamp TEXT,
      last_timestamp TEXT,
      git_branch TEXT,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_read INTEGER DEFAULT 0,
      total_cache_creation INTEGER DEFAULT 0,
      model TEXT,
      turn_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      timestamp TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      tool_name TEXT,
      cwd TEXT
    );

    CREATE TABLE IF NOT EXISTS processed_files (
      path TEXT PRIMARY KEY,
      mtime REAL,
      lines INTEGER,
      size INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_first ON sessions(first_timestamp);
  `);

  try {
    db.exec("ALTER TABLE processed_files ADD COLUMN size INTEGER DEFAULT 0");
  } catch {
    // Column already exists on upgraded databases.
  }
}
