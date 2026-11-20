'use strict';
// Monitoring: server resurslari, so'rovlar, xatolar, qayta ishga tushishlar va xarajat taxmini.
// Ma'lumotlar diskdagi SQLite bazada 30 kun saqlanadi. Faqat sayt egasi ko'radi (/api/monitoring).
const fs = require('fs');
const os = require('os');

// Railway narxlari (docs.railway.com/pricing, 2026-11 holatiga)
const PRICES = { ramGbMonth: 10, cpuVcpuMonth: 20, volumeGbMonth: 0.15, hobbyIncluded: 5, checked: '2026-11' };
const KEEP_DAYS = 30;
const SAMPLE_MS = Number(process.env.MONITOR_SAMPLE_MS) || 60_000;
const SLOW_MS = 1000;

let db = null;
let dbFile = null;
const sinceIso = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const startedAt = Date.now();
const minute = { count: 0, errors: 0, totalMs: 0 };
const sinceStart = { count: 0, errors: 0 };
const durations = []; // oxirgi 500 ta so'rov davomiyligi (p95 uchun)
let cpuMark = { usage: process.cpuUsage(), at: process.hrtime.bigint() };
let lastSample = null;
let lastCleanup = 0;

const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const round = (n, d = 1) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);

// Konteynerga ajratilgan resurslar (Railway cgroup), topilmasa butun server
function limits() {
  let memMb = null;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const v = read(f);
    if (v && /^\d+$/.test(v) && Number(v) < 2 ** 50) { memMb = Number(v) / 1048576; break; }
  }
  let cpu = null;
  const cpuMax = read('/sys/fs/cgroup/cpu.max');
  if (cpuMax) {
    const [quota, period] = cpuMax.split(' ');
    if (/^\d+$/.test(quota) && Number(period) > 0) cpu = Number(quota) / Number(period);
  }
  return {
    memMb: round(memMb ?? os.totalmem() / 1048576, 0),
    memSource: memMb ? 'konteyner limiti' : 'butun server',
    cpu: round(cpu ?? (os.availableParallelism?.() || os.cpus().length), 2),
    cpuSource: cpu ? 'konteyner limiti' : 'server yadrolari',
  };
}
function containerMemMb() {
  for (const f of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    const v = read(f);
    if (v && /^\d+$/.test(v)) return Number(v) / 1048576;
  }
  return null;
}

function event(kind, f = {}) {
  if (!db) return Promise.resolve();
  try {
    db.prepare('INSERT INTO monitor_event(kind, method, path, status, ms, message) VALUES (?, ?, ?, ?, ?, ?)').run(
      kind, f.method || null, f.path ? String(f.path).slice(0, 300) : null, f.status ?? null, f.ms ?? null,
      f.message ? String(f.message).slice(0, 4000) : null);
  } catch (e) { console.error('monitor event', e.message); }
  return Promise.resolve();
}

function requestTimer(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api/')) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    minute.count++; sinceStart.count++; minute.totalMs += ms;
    durations.push(ms); if (durations.length > 500) durations.shift();
    if (res.statusCode >= 500) { minute.errors++; sinceStart.errors++; }
    if (ms >= SLOW_MS && !req.originalUrl.startsWith('/api/monitoring'))
      event('slow', { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms) });
  });
  next();
}

function recordError(err, req) {
  return event('error', {
    method: req?.method, path: req?.originalUrl?.split('?')[0], status: 500,
    message: err?.stack || err?.message || String(err),
  });
}

async function sample() {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage(cpuMark.usage);
  const elapsedUs = Number(now - cpuMark.at) / 1000;
  cpuMark = { usage: process.cpuUsage(), at: now };
  const mem = process.memoryUsage();
  const row = {
    rss: mem.rss / 1048576,
    heap: mem.heapUsed / 1048576,
    cpu: elapsedUs > 0 ? (100 * (usage.user + usage.system)) / elapsedUs : 0,
    container: containerMemMb(),
    count: minute.count, errors: minute.errors,
    avg: minute.count ? minute.totalMs / minute.count : null,
  };
  minute.count = 0; minute.errors = 0; minute.totalMs = 0;
  lastSample = { ...row, at: Date.now() };
  try {
    db.prepare(`INSERT INTO monitor_resource(rss_mb, heap_mb, cpu_pct, container_mb, req_count, err_count, avg_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(round(row.rss), round(row.heap), round(row.cpu, 2), round(row.container), row.count, row.errors, round(row.avg));
    if (Date.now() - lastCleanup > 86_400_000) {
      lastCleanup = Date.now();
      const cut = sinceIso(KEEP_DAYS * 24);
      db.prepare('DELETE FROM monitor_resource WHERE ts < ?').run(cut);
      db.prepare('DELETE FROM monitor_event WHERE ts < ?').run(cut);
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } catch (e) { console.error('monitor sample', e.message); }
}

async function start(database, file) {
  db = database;
  dbFile = file;
  // Oldingi nusxa to'g'ri to'xtamagan bo'lsa (stop yozuvi yo'q) — kutilmagan to'xtash deb belgilanadi
  const last = db.prepare(`SELECT kind, ts FROM monitor_event WHERE kind IN ('start','stop','crash') ORDER BY ts DESC, id DESC LIMIT 1`).get();
  if (last?.kind === 'start') {
    const seen = db.prepare('SELECT MAX(ts) AS ts FROM monitor_resource').get();
    await event('crash', { message: 'Oldingi ishga tushish kutilmaganda to‘xtagan (xotira tugashi yoki jarayon yiqilishi). Oxirgi o‘lchov: '
      + (seen?.ts || 'noma’lum') });
  }
  const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
  await event('start', { message: `Node ${process.version}${commit ? ' · commit ' + commit : ''}` });

  setInterval(sample, SAMPLE_MS).unref();
  process.on('unhandledRejection', (e) => { console.error(e); recordError(e); });
  process.on('uncaughtException', async (e) => {
    console.error(e);
    await event('crash', { message: e?.stack || String(e) });
    process.exit(1);
  });
  process.once('SIGTERM', async () => {
    setTimeout(() => process.exit(0), 3000).unref();
    await event('stop', { message: 'To‘xtatildi (yangi deploy yoki qayta ishga tushirish)' });
    try { db.close(); } catch {} // WAL faylini bazaga yozib yopadi
    process.exit(0);
  });
}

const RANGES = {
  '1h': { hours: 1, bucket: 60 },
  '24h': { hours: 24, bucket: 600 },
  '7d': { hours: 168, bucket: 3600 },
  '30d': { hours: 720, bucket: 14400 },
};

function fileSize(f) { try { return fs.statSync(f).size; } catch { return 0; } }

function report(rangeKey, state) {
  const range = RANGES[rangeKey] || RANGES['24h'];
  const since = sinceIso(range.hours);
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const pingStart = process.hrtime.bigint();
  db.prepare('SELECT 1').get();
  const pingMs = round(Number(process.hrtime.bigint() - pingStart) / 1e6, 2);
  const B = range.bucket;
  const series = q(`SELECT (CAST(strftime('%s', ts) AS INTEGER) / ${B}) * ${B} AS t,
       AVG(rss_mb) AS rss, MAX(rss_mb) AS rss_max, AVG(container_mb) AS container,
       AVG(cpu_pct) AS cpu, MAX(cpu_pct) AS cpu_max,
       SUM(req_count) AS req, SUM(err_count) AS err,
       SUM(avg_ms * req_count) / NULLIF(SUM(req_count), 0) AS avg_ms
     FROM monitor_resource WHERE ts > ? GROUP BY 1 ORDER BY 1`, since).map((r) => ({ ...r, t: new Date(r.t * 1000).toISOString() }));
  const overall = q(`SELECT AVG(rss_mb) AS rss, AVG(container_mb) AS container, AVG(cpu_pct) AS cpu, MAX(rss_mb) AS rss_max,
       MAX(cpu_pct) AS cpu_max, SUM(req_count) AS req, SUM(err_count) AS err, COUNT(*) AS samples,
       SUM(avg_ms * req_count) / NULLIF(SUM(req_count), 0) AS avg_ms
     FROM monitor_resource WHERE ts > ?`, since);
  const errors = q(`SELECT ts, kind, method, path, status, message FROM monitor_event
     WHERE kind IN ('error','crash') AND ts > ? ORDER BY ts DESC LIMIT 50`, since);
  const slow = q(`SELECT ts, method, path, status, ms FROM monitor_event WHERE kind = 'slow' AND ts > ? ORDER BY ts DESC LIMIT 30`, since);
  const lifecycle = q(`SELECT ts, kind, message FROM monitor_event WHERE kind IN ('start','stop','crash') ORDER BY ts DESC, id DESC LIMIT 20`);
  const dbBytes = fileSize(dbFile) + fileSize(dbFile + '-wal');
  let tables;
  try {
    tables = q(`SELECT m.name AS name, COALESCE(SUM(s.pgsize), 0) AS bytes FROM sqlite_schema m
       LEFT JOIN dbstat s ON s.name = m.name OR s.name IN (SELECT name FROM sqlite_schema WHERE tbl_name = m.name AND type = 'index')
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' GROUP BY m.name ORDER BY 2 DESC`);
  } catch {
    tables = q(`SELECT name, NULL AS bytes FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  }
  for (const t of tables) t.rows = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '')}"`).get().n;
  const users = q(`SELECT role, COUNT(*) AS n, SUM(CASE WHEN first_seen > ? THEN 1 ELSE 0 END) AS new_n FROM app_users GROUP BY role`, since);
  const activity = q(`SELECT action, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM audit_log
     WHERE created_at > ? GROUP BY action`, since);
  const recentAudit = q(`SELECT a.created_at AS ts, a.action, a.detail, u.name, u.email FROM audit_log a
     LEFT JOIN app_users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 40`)
    .map((r) => { try { return { ...r, detail: r.detail ? JSON.parse(r.detail) : null }; } catch { return r; } });

  const o = overall[0] || {};
  const lim = limits();
  const memMb = Number(o.container ?? o.rss ?? lastSample?.rss ?? process.memoryUsage().rss / 1048576);
  const cpuV = Number(o.cpu ?? 0) / 100;
  const app = { ram: (memMb / 1024) * PRICES.ramGbMonth, cpu: cpuV * PRICES.cpuVcpuMonth };
  const sorted = [...durations].sort((a, b) => a - b);
  const count = (arr, key) => Object.fromEntries(arr.reduce((m, x) => m.set(x[key], (m.get(x[key]) || 0) + 1), new Map()));
  const act = Object.fromEntries(activity.map((r) => [r.action, r]));

  return {
    range: rangeKey in RANGES ? rangeKey : '24h',
    generatedAt: Date.now(),
    server: {
      startedAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version,
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      region: process.env.RAILWAY_REPLICA_REGION || null,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || null,
      limits: lim,
      now: {
        rssMb: round(process.memoryUsage().rss / 1048576), heapMb: round(process.memoryUsage().heapUsed / 1048576),
        containerMb: round(containerMemMb()), cpuPct: round(lastSample?.cpu, 2),
      },
      requests: {
        sinceStart: sinceStart.count, errorsSinceStart: sinceStart.errors,
        p95Ms: sorted.length ? round(sorted[Math.floor(sorted.length * 0.95)], 0) : null,
      },
    },
    series: series.map((r) => ({
      t: r.t, rss: round(r.rss), rssMax: round(r.rss_max), container: round(r.container),
      cpu: round(r.cpu, 2), cpuMax: round(r.cpu_max, 2),
      req: Number(r.req), err: Number(r.err), avgMs: round(r.avg_ms, 0),
    })),
    overall: {
      memMb: round(memMb), rssMaxMb: round(o.rss_max), cpuPct: round(o.cpu, 2), cpuMaxPct: round(o.cpu_max, 2),
      requests: Number(o.req || 0), errors: Number(o.err || 0), avgMs: round(o.avg_ms, 0),
      samples: Number(o.samples || 0),
    },
    cost: {
      prices: PRICES,
      appRam: round(app.ram, 2), appCpu: round(app.cpu, 2), appMonthly: round(app.ram + app.cpu, 2),
      dbStorageGb: round(dbBytes / 1073741824, 3), dbStorage: round((dbBytes / 1073741824) * PRICES.volumeGbMonth, 3),
      note: 'Taxmin: sayt servisining tanlangan davrdagi o‘rtacha xotira va protsessor sarfi bir oyga hisoblangan. '
        + 'Baza shu servisning diskida (alohida Postgres servisi yo‘q). Aniq summa Railway → Usage bo‘limida.',
    },
    db: {
      bytes: dbBytes, pingMs,
      file: dbFile,
      tables: tables.map((r) => ({ name: r.name, bytes: Number(r.bytes), rows: Math.max(0, Number(r.rows)) })),
    },
    activity: {
      users: users.reduce((m, r) => ({ ...m, [r.role]: r.n }), {}),
      newUsers: users.reduce((n, r) => n + r.new_n, 0),
      logins: act.login?.n || 0, activeUsers: act.login?.users || 0,
      failedLogins: act.login_failed?.n || 0, registrations: act.register?.n || 0,
      teams: count(state.teams || [], 'status'),
      appeals: count(state.appeals || [], 'status'),
      support: count(state.support || [], 'status'),
      tours: { total: (state.tours || []).length, published: (state.tours || []).filter((t) => t.published).length },
    },
    errors, slow, lifecycle,
    audit: recentAudit,
  };
}

module.exports = { requestTimer, recordError, start, report };
