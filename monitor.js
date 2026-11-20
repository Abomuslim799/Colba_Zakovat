'use strict';
// Monitoring: server resurslari, so'rovlar, xatolar, qayta ishga tushishlar va xarajat taxmini.
// Ma'lumotlar Postgres'da 30 kun saqlanadi. Faqat sayt egasi ko'radi (/api/monitoring).
const fs = require('fs');
const os = require('os');

// Railway narxlari (docs.railway.com/pricing, 2026-11 holatiga)
const PRICES = { ramGbMonth: 10, cpuVcpuMonth: 20, volumeGbMonth: 0.15, hobbyIncluded: 5, checked: '2026-11' };
const KEEP_DAYS = 30;
const SAMPLE_MS = Number(process.env.MONITOR_SAMPLE_MS) || 60_000;
const SLOW_MS = 1000;

let pool = null;
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
  if (!pool) return Promise.resolve();
  return pool.query(
    'INSERT INTO monitor_event(kind, method, path, status, ms, message) VALUES ($1, $2, $3, $4, $5, $6)',
    [kind, f.method || null, f.path ? String(f.path).slice(0, 300) : null, f.status ?? null, f.ms ?? null,
      f.message ? String(f.message).slice(0, 4000) : null],
  ).catch((e) => console.error('monitor event', e.message));
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
    await pool.query(
      `INSERT INTO monitor_resource(rss_mb, heap_mb, cpu_pct, container_mb, req_count, err_count, avg_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [round(row.rss), round(row.heap), round(row.cpu, 2), round(row.container), row.count, row.errors, round(row.avg)]);
    if (Date.now() - lastCleanup > 86_400_000) {
      lastCleanup = Date.now();
      await pool.query(`DELETE FROM monitor_resource WHERE ts < NOW() - INTERVAL '${KEEP_DAYS} days'`);
      await pool.query(`DELETE FROM monitor_event WHERE ts < NOW() - INTERVAL '${KEEP_DAYS} days'`);
    }
  } catch (e) { console.error('monitor sample', e.message); }
}

async function start(p) {
  pool = p;
  await pool.query(`CREATE TABLE IF NOT EXISTS monitor_resource(
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), rss_mb REAL, heap_mb REAL, cpu_pct REAL, container_mb REAL,
    req_count INTEGER NOT NULL DEFAULT 0, err_count INTEGER NOT NULL DEFAULT 0, avg_ms REAL)`);
  await pool.query('CREATE INDEX IF NOT EXISTS monitor_resource_ts ON monitor_resource(ts)');
  await pool.query(`CREATE TABLE IF NOT EXISTS monitor_event(
    id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), kind TEXT NOT NULL,
    method TEXT, path TEXT, status INTEGER, ms INTEGER, message TEXT)`);
  await pool.query('CREATE INDEX IF NOT EXISTS monitor_event_ts ON monitor_event(kind, ts)');

  // Oldingi nusxa to'g'ri to'xtamagan bo'lsa (stop yozuvi yo'q) — kutilmagan to'xtash deb belgilanadi
  const last = await pool.query(`SELECT kind, ts FROM monitor_event WHERE kind IN ('start','stop','crash') ORDER BY ts DESC, id DESC LIMIT 1`);
  if (last.rows[0]?.kind === 'start') {
    const seen = await pool.query('SELECT MAX(ts) AS ts FROM monitor_resource');
    await event('crash', { message: 'Oldingi ishga tushish kutilmaganda to‘xtagan (xotira tugashi yoki jarayon yiqilishi). Oxirgi o‘lchov: '
      + (seen.rows[0].ts ? new Date(seen.rows[0].ts).toISOString() : 'noma’lum') });
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
    process.exit(0);
  });
}

const RANGES = {
  '1h': { hours: 1, bucket: '1 minute' },
  '24h': { hours: 24, bucket: '10 minutes' },
  '7d': { hours: 168, bucket: '1 hour' },
  '30d': { hours: 720, bucket: '4 hours' },
};

async function report(p, rangeKey, state) {
  const range = RANGES[rangeKey] || RANGES['24h'];
  const since = `NOW() - INTERVAL '${range.hours} hours'`;
  const q = (sql, args) => p.query(sql, args).then((r) => r.rows);
  const pingStart = Date.now();
  await p.query('SELECT 1');
  const pingMs = Date.now() - pingStart;

  const [series, overall, errors, slow, lifecycle, dbSize, tables, users, activity, recentAudit] = await Promise.all([
    q(`SELECT date_bin('${range.bucket}'::interval, ts, TIMESTAMPTZ '2000-01-01') AS t,
         AVG(rss_mb) AS rss, MAX(rss_mb) AS rss_max, AVG(container_mb) AS container,
         AVG(cpu_pct) AS cpu, MAX(cpu_pct) AS cpu_max,
         SUM(req_count) AS req, SUM(err_count) AS err,
         SUM(avg_ms * req_count) / NULLIF(SUM(req_count), 0) AS avg_ms
       FROM monitor_resource WHERE ts > ${since} GROUP BY 1 ORDER BY 1`),
    q(`SELECT AVG(rss_mb) AS rss, AVG(container_mb) AS container, AVG(cpu_pct) AS cpu, MAX(rss_mb) AS rss_max,
         MAX(cpu_pct) AS cpu_max, SUM(req_count) AS req, SUM(err_count) AS err, COUNT(*) AS samples,
         SUM(avg_ms * req_count) / NULLIF(SUM(req_count), 0) AS avg_ms
       FROM monitor_resource WHERE ts > ${since}`),
    q(`SELECT ts, kind, method, path, status, message FROM monitor_event
       WHERE kind IN ('error','crash') AND ts > ${since} ORDER BY ts DESC LIMIT 50`),
    q(`SELECT ts, method, path, status, ms FROM monitor_event WHERE kind = 'slow' AND ts > ${since} ORDER BY ts DESC LIMIT 30`),
    q(`SELECT ts, kind, message FROM monitor_event WHERE kind IN ('start','stop','crash') ORDER BY ts DESC, id DESC LIMIT 20`),
    q('SELECT pg_database_size(current_database()) AS bytes'),
    q(`SELECT relname AS name, pg_total_relation_size(relid) AS bytes, n_live_tup AS rows
       FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY 2 DESC`),
    q(`SELECT role, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE first_seen > ${since})::int AS new_n FROM app_users GROUP BY role`),
    q(`SELECT action, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS users FROM audit_log
       WHERE created_at > ${since} GROUP BY action`),
    q(`SELECT a.created_at AS ts, a.action, a.detail, u.name, u.email FROM audit_log a
       LEFT JOIN app_users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 40`),
  ]);

  const o = overall[0] || {};
  const lim = limits();
  const memMb = Number(o.container ?? o.rss ?? lastSample?.rss ?? process.memoryUsage().rss / 1048576);
  const cpuV = Number(o.cpu ?? 0) / 100;
  const dbBytes = Number(dbSize[0].bytes);
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
    railway: await railwayCost(),
    cost: {
      prices: PRICES,
      appRam: round(app.ram, 2), appCpu: round(app.cpu, 2), appMonthly: round(app.ram + app.cpu, 2),
      dbStorageGb: round(dbBytes / 1073741824, 3), dbStorage: round((dbBytes / 1073741824) * PRICES.volumeGbMonth, 3),
      note: 'Taxmin: sayt servisining tanlangan davrdagi o‘rtacha xotira va protsessor sarfi bir oyga hisoblangan. '
        + 'Postgres servisining o‘z xotira/protsessor sarfi bu yerga kirmaydi — aniq summa Railway → Usage bo‘limida.',
    },
    db: {
      bytes: dbBytes, pingMs,
      pool: { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount },
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


// ---------- Railway'ning haqiqiy sarfi (faqat shu loyiha, davr boshidan hozirgacha, +30% bilan) ----------
// Kerak: Variables'da RAILWAY_API_TOKEN (workspace tokeni). Loyiha id'sini Railway o'zi beradi (RAILWAY_PROJECT_ID).
const RW_API = 'https://backboard.railway.com/graphql/v2';
const RW_WS = process.env.RAILWAY_WORKSPACE_ID || '78692e9c-4e36-47ca-9c11-20aaa6fd035d';
const RW_PRICE = { MEMORY_USAGE_GB: 0.000231, CPU_USAGE: 0.000463, NETWORK_TX_GB: 0.05, DISK_USAGE_GB: 0.000003 };
const USTAMA = (Number(process.env.TOLOV_FOIZ ?? 12) + Number(process.env.XIZMAT_FOIZ ?? 18)) / 100;
let rwCache = { at: 0, data: null };

async function rwQuery(token, query, variables = {}) {
  const r = await fetch(RW_API, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.message || 'Railway API xatosi');
  return j.data;
}

function billingStart() {               // API bermasa: har oyning RAILWAY_BILLING_KUN (10) sanasi, 11:00 UTC
  const k = Number(process.env.RAILWAY_BILLING_KUN || 10), n = new Date();
  let b = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), k, 11));
  if (b > n) b = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, k, 11));
  return b.toISOString();
}

async function railwayCost() {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) return null;
  if (Date.now() - rwCache.at < 600_000) return rwCache.data;   // 10 daqiqada bir marta
  let data;
  try {
    let start = null;
    try {
      const w = await rwQuery(token, 'query($w:String!){workspace(workspaceId:$w){customer{billingPeriod{start}}}}', { w: RW_WS });
      start = w.workspace?.customer?.billingPeriod?.start || null;
    } catch { /* zaxira hisob */ }
    start = start || billingStart();
    const u = await rwQuery(token, 'query($w:String!,$s:DateTime!){usage(workspaceId:$w,measurements:[MEMORY_USAGE_GB,CPU_USAGE,NETWORK_TX_GB,DISK_USAGE_GB],'
      + 'groupBy:[PROJECT_ID],startDate:$s){measurement value tags{projectId}}}', { w: RW_WS, s: start });
    const pid = process.env.RAILWAY_PROJECT_ID;
    const sum = u.usage.filter((x) => !pid || x.tags.projectId === pid)
      .reduce((t, x) => t + (x.value || 0) * (RW_PRICE[x.measurement] || 0), 0);
    data = { total: round(sum * (1 + USTAMA), 2), since: start, at: Date.now() };
  } catch (e) {
    data = { error: String(e.message || e).slice(0, 200) };
  }
  rwCache = { at: Date.now(), data };
  return data;
}

module.exports = { requestTimer, recordError, start, report, railwayCost };
