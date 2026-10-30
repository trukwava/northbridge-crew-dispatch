import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export type Sqlite = DatabaseSync;
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const id = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0,16)}`;

export function openDb(path = ':memory:'): Sqlite {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS service_areas (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS crews (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, max_capacity INTEGER NOT NULL CHECK(max_capacity >= 0),
      baseline_load INTEGER NOT NULL CHECK(baseline_load >= 0), base_lat REAL, base_lon REAL,
      channel TEXT NOT NULL CHECK(channel IN ('in_app','unavailable')),
      token_hash TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crew_availability (
      crew_id TEXT PRIMARY KEY REFERENCES crews(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('available','unavailable')), updated_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crew_skills (
      crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
      skill TEXT NOT NULL REFERENCES skills(name), PRIMARY KEY(crew_id,skill)
    );
    CREATE TABLE IF NOT EXISTS crew_areas (
      crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
      area TEXT NOT NULL REFERENCES service_areas(name), PRIMARY KEY(crew_id,area)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, job_type TEXT NOT NULL,
      urgency TEXT NOT NULL CHECK(urgency IN ('emergency','urgent','routine')),
      address TEXT, region TEXT NOT NULL, lat REAL, lon REAL,
      location_status TEXT NOT NULL CHECK(location_status IN ('confirmed','needs_review')),
      status TEXT NOT NULL CHECK(status IN ('new','review','offering','unassigned','assigned','en_route','arrived','in_progress','completed','cancelled')),
      created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_skills (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      skill TEXT NOT NULL REFERENCES skills(name), PRIMARY KEY(job_id,skill)
    );
    CREATE TABLE IF NOT EXISTS offer_sequences (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('active','paused','exhausted','cancelled','accepted')),
      candidates_json TEXT NOT NULL, next_index INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      crew_id TEXT NOT NULL REFERENCES crews(id), ordinal INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','expired','cancelled')),
      created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, responded_ms INTEGER,
      UNIQUE(job_id,ordinal)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_offer ON offers(job_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
      crew_id TEXT NOT NULL REFERENCES crews(id), status TEXT NOT NULL,
      created_ms INTEGER NOT NULL, current INTEGER NOT NULL CHECK(current IN (0,1)),
      override_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_current_assignment ON assignments(job_id) WHERE current=1;
    CREATE TABLE IF NOT EXISTS capacity_reservations (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
      crew_id TEXT NOT NULL REFERENCES crews(id), active INTEGER NOT NULL CHECK(active IN (0,1)),
      created_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_reservation_job ON capacity_reservations(job_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS state_events (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), crew_id TEXT,
      kind TEXT NOT NULL, detail TEXT NOT NULL, at_ms INTEGER NOT NULL, operation_key TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, job_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_attempts (
      id TEXT PRIMARY KEY, offer_id TEXT NOT NULL REFERENCES offers(id),
      operation_key TEXT UNIQUE NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('simulated','failed')),
      detail TEXT NOT NULL, created_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS location_evidence (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
      kind TEXT NOT NULL, detail TEXT NOT NULL, confirmed_by TEXT,
      created_ms INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS capacity_insert_guard BEFORE INSERT ON capacity_reservations
    WHEN NEW.active=1 AND (
      SELECT baseline_load + (SELECT COUNT(*) FROM capacity_reservations r WHERE r.crew_id=NEW.crew_id AND r.active=1) >= max_capacity
      FROM crews WHERE id=NEW.crew_id
    )
    BEGIN SELECT RAISE(ABORT, 'capacity exceeded'); END;
    CREATE TRIGGER IF NOT EXISTS capacity_reactivate_guard BEFORE UPDATE OF active ON capacity_reservations
    WHEN NEW.active=1 AND OLD.active=0 AND (
      SELECT baseline_load + (SELECT COUNT(*) FROM capacity_reservations r WHERE r.crew_id=NEW.crew_id AND r.active=1) >= max_capacity
      FROM crews WHERE id=NEW.crew_id
    )
    BEGIN SELECT RAISE(ABORT, 'capacity exceeded'); END;
    CREATE TRIGGER IF NOT EXISTS crew_capacity_edit_guard BEFORE UPDATE OF max_capacity,baseline_load ON crews
    WHEN NEW.baseline_load+(SELECT COUNT(*) FROM capacity_reservations r WHERE r.crew_id=NEW.id AND r.active=1)>NEW.max_capacity
    BEGIN SELECT RAISE(ABORT, 'capacity exceeded'); END;
  `);
  return db;
}

export function transaction<T>(db: Sqlite, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
