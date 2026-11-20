'use strict';
// Ma'lumotlar bazasi: ilova servisining diskidagi (Railway volume, /data) bitta SQLite fayl.
// Alohida Postgres servisi kerak emas. Birinchi ishga tushishda DATABASE_URL berilgan bo'lsa,
// eski Postgres'dagi barcha ma'lumot bir marta shu faylga ko'chiriladi.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'colba.db');
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"; // ISO vaqt — JSON'da Postgres'dagidek ko'rinadi

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state(
      id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS app_users(
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, picture TEXT,
      role TEXT NOT NULL DEFAULT 'user', password_hash TEXT,
      first_seen TEXT NOT NULL DEFAULT ${NOW}, last_seen TEXT NOT NULL DEFAULT ${NOW});
    CREATE TABLE IF NOT EXISTS audit_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, detail TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW});
    CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at);
    CREATE TABLE IF NOT EXISTS team_photo(
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL,
      bytes INTEGER NOT NULL, uploaded_by TEXT, created_at TEXT NOT NULL DEFAULT ${NOW});
    CREATE INDEX IF NOT EXISTS team_photo_team ON team_photo(team_id, created_at);
    CREATE TABLE IF NOT EXISTS session(sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_expire ON session(expire);
    CREATE TABLE IF NOT EXISTS monitor_resource(
      ts TEXT NOT NULL DEFAULT ${NOW}, rss_mb REAL, heap_mb REAL, cpu_pct REAL, container_mb REAL,
      req_count INTEGER NOT NULL DEFAULT 0, err_count INTEGER NOT NULL DEFAULT 0, avg_ms REAL);
    CREATE INDEX IF NOT EXISTS monitor_resource_ts ON monitor_resource(ts);
    CREATE TABLE IF NOT EXISTS monitor_event(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT ${NOW}, kind TEXT NOT NULL,
      method TEXT, path TEXT, status INTEGER, ms INTEGER, message TEXT);
    CREATE INDEX IF NOT EXISTS monitor_event_ts ON monitor_event(kind, ts);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// Eski Postgres'dan bir martalik ko'chirish. Faqat yangi (bo'sh) faylga, bitta tranzaksiyada.
async function importFromPostgres(db, url) {
  const { Client } = require('pg');
  const pg = new Client({ connectionString: url, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await pg.connect();
  try {
    const has = async (t) => (await pg.query('SELECT to_regclass($1) AS r', ['public.' + t])).rows[0].r !== null;
    const rows = async (t, sql) => ((await has(t)) ? (await pg.query(sql)).rows : []);
    const state = await rows('app_state', 'SELECT data, version FROM app_state WHERE id = 1');
    if (!state.length) return null; // Postgres bo'sh — ko'chiradigan narsa yo'q
    const data = {
      users: await rows('app_users', 'SELECT * FROM app_users'),
      audit: await rows('audit_log', 'SELECT * FROM audit_log ORDER BY id'),
      photos: await rows('team_photo', 'SELECT * FROM team_photo'),
      sessions: await rows('session', 'SELECT sid, sess, expire FROM session WHERE expire > NOW()'),
      res: await rows('monitor_resource', `SELECT * FROM monitor_resource WHERE ts > NOW() - INTERVAL '30 days'`),
      ev: await rows('monitor_event', `SELECT * FROM monitor_event WHERE ts > NOW() - INTERVAL '30 days' ORDER BY id`),
    };
    db.transaction(() => {
      db.prepare('INSERT INTO app_state(id, data, version) VALUES (1, ?, ?)').run(JSON.stringify(state[0].data), state[0].version);
      const u = db.prepare('INSERT INTO app_users(id, email, name, picture, role, password_hash, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)');
      for (const r of data.users) u.run(r.id, r.email, r.name, r.picture, r.role, r.password_hash, iso(r.first_seen), iso(r.last_seen));
      const a = db.prepare('INSERT INTO audit_log(id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)');
      for (const r of data.audit) a.run(Number(r.id), r.user_id, r.action, r.detail == null ? null : JSON.stringify(r.detail), iso(r.created_at));
      const p = db.prepare('INSERT INTO team_photo(id, team_id, mime, data, bytes, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)');
      for (const r of data.photos) p.run(r.id, r.team_id, r.mime, r.data, r.bytes, r.uploaded_by, iso(r.created_at));
      const s = db.prepare('INSERT INTO session(sid, sess, expire) VALUES (?,?,?)');
      for (const r of data.sessions) s.run(r.sid, JSON.stringify(r.sess), new Date(r.expire).getTime());
      const m = db.prepare('INSERT INTO monitor_resource(ts, rss_mb, heap_mb, cpu_pct, container_mb, req_count, err_count, avg_ms) VALUES (?,?,?,?,?,?,?,?)');
      for (const r of data.res) m.run(iso(r.ts), r.rss_mb, r.heap_mb, r.cpu_pct, r.container_mb, r.req_count, r.err_count, r.avg_ms);
      const e = db.prepare('INSERT INTO monitor_event(id, ts, kind, method, path, status, ms, message) VALUES (?,?,?,?,?,?,?,?)');
      for (const r of data.ev) e.run(Number(r.id), iso(r.ts), r.kind, r.method, r.path, r.status, r.ms, r.message);
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('imported_from_postgres', ?)").run(new Date().toISOString());
    })();
    return { users: data.users.length, audit: data.audit.length, photos: data.photos.length, sessions: data.sessions.length };
  } finally {
    await pg.end().catch(() => {});
  }
}

// express-session uchun SQLite ombori
function sessionStore(session, db) {
  const get = db.prepare('SELECT sess FROM session WHERE sid = ? AND expire > ?');
  const set = db.prepare('INSERT INTO session(sid, sess, expire) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire');
  const touch = db.prepare('UPDATE session SET expire = ? WHERE sid = ?');
  const del = db.prepare('DELETE FROM session WHERE sid = ?');
  const purge = db.prepare('DELETE FROM session WHERE expire <= ?');
  const exp = (s) => (s?.cookie?.expires ? new Date(s.cookie.expires).getTime() : Date.now() + 86400000);
  class Store extends session.Store {
    get(sid, cb) { try { const r = get.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
    set(sid, s, cb) { try { set.run(sid, JSON.stringify(s), exp(s)); cb?.(null); } catch (e) { cb?.(e); } }
    touch(sid, s, cb) { try { touch.run(exp(s), sid); cb?.(null); } catch (e) { cb?.(e); } }
    destroy(sid, cb) { try { del.run(sid); cb?.(null); } catch (e) { cb?.(e); } }
  }
  setInterval(() => { try { purge.run(Date.now()); } catch {} }, 3600_000).unref();
  return new Store();
}

module.exports = { open, importFromPostgres, sessionStore, DATA_DIR, DB_FILE };
