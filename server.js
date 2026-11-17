'use strict';
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const monitor = require('./monitor');

// ---------- Sozlamalar ----------
const isProd = process.env.NODE_ENV === 'production';
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase().trim();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkConfig() {
  const problems = [];
  if (!DATABASE_URL) problems.push('DATABASE_URL berilmagan (Railway: ${{Postgres.DATABASE_URL}})');
  if (isProd && SESSION_SECRET.length < 32) problems.push('SESSION_SECRET kamida 32 belgi bo‘lishi kerak');
  if (!EMAIL_RE.test(OWNER_EMAIL)) problems.push('OWNER_EMAIL berilmagan yoki noto‘g‘ri (sayt egasining emaili)');
  if (OWNER_PASSWORD.length < 8) problems.push('OWNER_PASSWORD kamida 8 belgi bo‘lishi kerak (sayt egasining paroli)');
  if (problems.length) {
    console.error('Server ishga tushmadi. Railway Variables bo‘limini tekshiring:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}
checkConfig();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const QUESTIONS = 36;
const MAX_TOURS = 36;
const APPEAL = { SENT: 'Yuborildi', REVIEW: 'Ko‘rib chiqilmoqda', DONE: 'Ko‘rib chiqildi' };
const APPEAL_STATUSES = Object.values(APPEAL);
const DEFAULT_WORD_LIMIT = 100;
const countWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

// ---------- Ma'lumotlar bazasi ----------
const seed = () => ({
  league: 'COLBA ZAKOVAT LIGASI',
  venue: 'O‘tkaziladigan joy boshqaruv panelida belgilanadi',
  news: [],
  teams: [],
  tours: Array.from({ length: 9 }, (_, i) => newTour(i + 1)),
  appealEnabled: false,
  appealWordLimit: DEFAULT_WORD_LIMIT,
  appeals: [],
});

// Eski ma'lumotlarni yangi tuzilishga keltirish (har ishga tushishda xavfsiz)
function migrate(s) {
  s.appealWordLimit ??= DEFAULT_WORD_LIMIT;
  for (const a of s.appeals || []) {
    if (a.status === 'Yangi') a.status = APPEAL.SENT;
    else if (a.status === 'Rad etildi') a.status = APPEAL.DONE;
    else if (!APPEAL_STATUSES.includes(a.status)) a.status = APPEAL.SENT;
    a.created ??= Date.now();
  }
  return s;
}
function newTour(id) {
  return { id, title: id + '-tur', published: false, activeTeams: [], responses: {} };
}

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state(
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1)`);
  await pool.query(`INSERT INTO app_state(id, data) VALUES (1, $1) ON CONFLICT DO NOTHING`, [JSON.stringify(seed())]);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_users(
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log(
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at)`);
  const st = await pool.query('SELECT data FROM app_state WHERE id = 1');
  await pool.query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(migrate(st.rows[0].data))]);
  // Sayt egasi Railway'dagi OWNER_EMAIL / OWNER_PASSWORD dan yaratiladi (har ishga tushishda yangilanadi)
  await pool.query(`UPDATE app_users SET role = 'user' WHERE role = 'owner' AND email <> $1`, [OWNER_EMAIL]);
  await pool.query(
    `INSERT INTO app_users(id, email, name, role, password_hash) VALUES ($1, $2, 'Sayt egasi', 'owner', $3)
     ON CONFLICT (email) DO UPDATE SET role = 'owner', password_hash = EXCLUDED.password_hash`,
    ['u' + crypto.randomUUID(), OWNER_EMAIL, await hashPassword(OWNER_PASSWORD)]);
}

// ---------- Parollar (scrypt) ----------
const scrypt = (pw, salt) => new Promise((ok, fail) =>
  crypto.scrypt(pw, salt, 64, (err, key) => (err ? fail(err) : ok(key))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex');
}
async function checkPassword(pw, stored) {
  const [kind, saltHex, keyHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) {
    await scrypt(pw, 'timing-equaliser');
    return false;
  }
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'));
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// ---------- Ilova ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(monitor.requestTimer);
app.use(express.json({ limit: '80kb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: SESSION_SECRET || 'local-dev-secret-only',
  resave: false,
  saveUninitialized: false,
  name: 'colba.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 7 * 86400000 },
}));

const USER_FIELDS = 'id, email, name, role, first_seen, last_seen';
const isStaff = (u) => u && (u.role === 'admin' || u.role === 'owner');

app.use(async (req, res, next) => {
  if (!req.session.uid) return next();
  try {
    const { rows } = await pool.query(`SELECT ${USER_FIELDS} FROM app_users WHERE id = $1`, [req.session.uid]);
    req.user = rows[0] || null;
    next();
  } catch (e) { next(e); }
});

function requires(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Tizimga kiring' });
    if (role === 'staff' && !isStaff(req.user)) return res.status(403).json({ error: 'Administrator huquqi kerak' });
    if (role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Faqat sayt egasi uchun' });
    next();
  };
}

// Jamoa holatlari: pending (kutilmoqda), approved (tasdiqlangan), rejected (rad etilgan),
// closed (faoliyati tugatilgan — e'lon qilingan natijalarda tarix sifatida qoladi)
const ACTIVE_STATUSES = ['pending', 'approved'];
const playedPublished = (s, teamId) => s.tours.filter((x) => x.published && (x.activeTeams || []).includes(teamId));

// Jamoani olib tashlash. E'lon qilingan turda qatnashgan bo'lsa — natijalar buzilmasligi uchun arxivlanadi.
function removeTeam(s, tm) {
  for (const x of s.tours) {
    if (x.published) continue;
    x.activeTeams = (x.activeTeams || []).filter((id) => id !== tm.id);
    if (x.responses) delete x.responses[tm.id];
  }
  s.appeals = s.appeals.filter((a) => a.teamId !== tm.id || a.status === APPEAL.DONE);
  if (playedPublished(s, tm.id).length) {
    tm.status = 'closed'; tm.approved = false; tm.closedAt = Date.now();
    return 'archived';
  }
  s.teams = s.teams.filter((x) => x.id !== tm.id);
  s.appeals = s.appeals.filter((a) => a.teamId !== tm.id);
  return 'deleted';
}

// Foydalanuvchiga uning roliga mos ma'lumotni qaytaradi
function safeState(src, user) {
  const s = structuredClone(src);
  if (isStaff(user)) return s;
  const myIds = new Set(s.teams.filter((t) => t.createdBy === user.id).map((t) => t.id));
  for (const t of s.tours) {
    if (!t.published) {
      t.myTeamPlays = (t.activeTeams || []).some((id) => myIds.has(id));
      delete t.responses; delete t.activeTeams;
    }
  }
  s.appeals = s.appeals
    .filter((a) => a.userId === user.id || myIds.has(a.teamId))
    .map(({ userId, answeredBy, ...a }) => a);
  s.teams = s.teams
    .filter((t) => t.approved || t.status === 'closed' || t.createdBy === user.id)
    .map((t) => ({
      id: t.id, name: t.name, members: t.members, approved: !!t.approved,
      status: t.status, mine: t.createdBy === user.id, closedAt: t.closedAt,
    }));
  return s;
}

// ---------- Jamoa nomlarini solishtirish ----------
function norm(s) {
  return String(s || '').normalize('NFKC').toLocaleLowerCase('uz')
    .replace(/[xҳh]/g, 'h').replace(/[’‘ʻ`']/g, '')
    .replace(/\b(jamoasi|jamoa|team|club|klub)\b/g, '')
    .replace(/\d+/g, '').replace(/[^\p{L}]/gu, '').trim();
}
function distance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return dp[b.length];
}
function similar(name, teams, exceptId) {
  const key = norm(name);
  if (key.length < 3) return true;
  return teams.some((t) => {
    if (t.id === exceptId || t.status === 'rejected') return false;
    const k = norm(t.name), min = Math.min(key.length, k.length);
    if (k === key) return true;
    if (min >= 5 && (key.includes(k) || k.includes(key)) && Math.abs(key.length - k.length) <= 3) return true;
    return min >= 5 && distance(key, k) <= Math.max(1, Math.floor(min * 0.2));
  });
}

// ---------- Holatni tranzaksiyada o'zgartirish ----------
const bad = (msg, status = 400) => { const e = Error(msg); e.status = status; throw e; };

async function update(req, res, action, detail, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
    const s = migrate(rows[0].data);
    const msg = fn(s);
    await client.query('UPDATE app_state SET data = $1, version = version + 1 WHERE id = 1', [JSON.stringify(s)]);
    await client.query('INSERT INTO audit_log(user_id, action, detail) VALUES ($1, $2, $3)',
      [req.user.id, action, JSON.stringify(detail || {})]);
    await client.query('COMMIT');
    res.json({ ok: true, message: msg || 'Saqlandi', data: safeState(s, req.user) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (!e.status) { console.error(e); monitor.recordError(e, req); }
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Server xatoligi' });
  } finally {
    client.release();
  }
}

// ---------- API: kirish ----------
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.get('/api/me', (req, res) => res.json({ user: req.user || null }));

const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Juda ko‘p urinish. 15 daqiqadan keyin qayta urinib ko‘ring.' } });

const audit = (userId, action, detail) =>
  pool.query('INSERT INTO audit_log(user_id, action, detail) VALUES ($1, $2, $3)', [userId, action, JSON.stringify(detail || {})])
    .catch((e) => console.error('audit', e.message));

async function startSession(req, userId) {
  await new Promise((ok, fail) => req.session.regenerate((err) => (err ? fail(err) : ok())));
  req.session.uid = userId;
  await new Promise((ok, fail) => req.session.save((err) => (err ? fail(err) : ok())));
}

app.post('/api/auth/register', authLimit, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 3 || name.length > 80) bad('Ism-familiya 3–80 belgi bo‘lishi kerak');
    if (!EMAIL_RE.test(email) || email.length > 160) bad('Email manzil noto‘g‘ri');
    if (password.length < 6 || password.length > 200) bad('Parol kamida 6 belgi bo‘lishi kerak');
    if (email === OWNER_EMAIL) bad('Bu email bilan ro‘yxatdan o‘tib bo‘lmaydi');
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO app_users(id, email, name, role, password_hash) VALUES ($1, $2, $3, 'user', $4)
       ON CONFLICT (email) DO NOTHING RETURNING ${USER_FIELDS}`,
      ['u' + crypto.randomUUID(), email, name, hash]);
    if (!rows.length) bad('Bu email bilan allaqachon ro‘yxatdan o‘tilgan. “Kirish” bo‘limidan foydalaning.', 409);
    await audit(rows[0].id, 'register');
    await startSession(req, rows[0].id);
    res.json({ user: rows[0] });
  } catch (e) {
    if (!e.status) { console.error(e); monitor.recordError(e, req); }
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Server xatoligi' });
  }
});

app.post('/api/auth/login', authLimit, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await pool.query(`SELECT ${USER_FIELDS}, password_hash FROM app_users WHERE email = $1`, [email]);
    const ok = await checkPassword(password, rows[0]?.password_hash);
    if (!ok) {
      await audit(rows[0]?.id || null, 'login_failed', { email: email.slice(0, 160) });
      return res.status(401).json({ error: 'Email yoki parol noto‘g‘ri' });
    }
    await pool.query('UPDATE app_users SET last_seen = NOW() WHERE id = $1', [rows[0].id]);
    await audit(rows[0].id, 'login');
    const { password_hash, ...user } = rows[0];
    await startSession(req, user.id);
    res.json({ user });
  } catch (e) {
    console.error(e);
    monitor.recordError(e, req);
    res.status(500).json({ error: 'Server xatoligi' });
  }
});

app.post('/api/logout', (req, res) => req.session.destroy(() => {
  res.clearCookie('colba.sid');
  res.json({ ok: true });
}));

// ---------- API: liga ma'lumoti ----------
app.get('/api/state', requires('user'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT data, version FROM app_state WHERE id = 1');
    res.json({ data: safeState(migrate(rows[0].data), req.user), version: rows[0].version });
  } catch (e) { next(e); }
});

app.get('/api/team/name-check', requires('user'), async (req, res, next) => {
  try {
    const name = String(req.query.name || '').slice(0, 80);
    const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
    res.json({ similar: similar(name, rows[0].data.teams) });
  } catch (e) { next(e); }
});

app.post('/api/team', requires('user'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const members = req.body.members;
  update(req, res, 'team_register', { name }, (s) => {
    const okMembers = Array.isArray(members) && members.length >= 4 && members.length <= 8 &&
      members.every((x) => typeof x === 'string' && x.trim().length >= 3 && x.trim().length <= 100);
    if (!name || !okMembers) bad('Jamoa nomi va 4–8 nafar a’zoning ism-familiyasi (kamida 3 harf) talab etiladi');
    const own = s.teams.find((t) => t.createdBy === req.user.id && ACTIVE_STATUSES.includes(t.status));
    if (own) bad(own.status === 'pending'
      ? `Sizning “${own.name}” arizangiz ko‘rib chiqilmoqda. Bir foydalanuvchi faqat bitta jamoa ocha oladi.`
      : `Sizda “${own.name}” jamoasi bor. Yangi jamoa ochish uchun avval uning faoliyatini tugating.`);
    if (similar(name, s.teams)) bad('O‘xshash nom, iltimos boshqa nom tanlang.');
    s.teams.push({
      id: 't' + crypto.randomUUID(), name, members: members.map((x) => x.trim()),
      status: 'pending', approved: false, created: Date.now(),
      createdBy: req.user.id, createdByName: req.user.name, createdByEmail: req.user.email,
    });
    return 'Ariza yuborildi. Jamoa admin tasdiqlagach ro‘yxatda ko‘rinadi.';
  });
});

// Foydalanuvchi o'z jamoasi faoliyatini tugatadi (kutilayotgan arizani qaytarib oladi)
app.post('/api/team/close', requires('user'), (req, res) => {
  update(req, res, 'team_close', { teamId: req.body.teamId }, (s) => {
    const tm = s.teams.find((t) => t.id === req.body.teamId && t.createdBy === req.user.id && ACTIVE_STATUSES.includes(t.status));
    if (!tm) bad('Jamoa topilmadi yoki uni yopish huquqingiz yo‘q', 404);
    if (tm.status === 'pending') {
      s.teams = s.teams.filter((x) => x.id !== tm.id);
      return 'Ariza qaytarib olindi. Endi yangi jamoa ochishingiz mumkin.';
    }
    return removeTeam(s, tm) === 'archived'
      ? `“${tm.name}” faoliyati tugatildi. Uning e’lon qilingan natijalari tarixda qoladi. Endi yangi jamoa ochishingiz mumkin.`
      : `“${tm.name}” o‘chirildi. Endi yangi jamoa ochishingiz mumkin.`;
  });
});

const OWNER_ONLY = ['site', 'addNews', 'removeNews', 'toursCount', 'renameTour', 'appealEnabled', 'unpublishTour', 'editTeam'];

app.post('/api/action', requires('staff'), (req, res) => {
  const { action } = req.body;
  const payload = req.body.payload || {};
  if (OWNER_ONLY.includes(action) && req.user.role !== 'owner')
    return res.status(403).json({ error: 'Ushbu amal faqat sayt egasiga ruxsat etilgan' });

  update(req, res, action, payload, (s) => {
    const t = s.tours.find((x) => x.id === Number(payload.tourId));
    const tm = s.teams.find((x) => x.id === payload.teamId);
    switch (action) {
      case 'approveTeam':
        if (!tm || tm.status !== 'pending') bad('Jamoa topilmadi yoki allaqachon ko‘rib chiqilgan');
        if (similar(tm.name, s.teams.filter((x) => x.approved), tm.id)) bad('Tasdiqlangan jamoalar orasida o‘xshash nom bor');
        tm.approved = true; tm.status = 'approved';
        return 'Jamoa tasdiqlandi';
      case 'rejectTeam':
        if (!tm || tm.status !== 'pending') bad('Jamoani rad etish mumkin emas');
        tm.status = 'rejected';
        return 'Ariza rad etildi';
      case 'deleteTeam': {
        if (!tm) bad('Jamoa topilmadi');
        if (tm.status === 'closed') bad('Faoliyati tugatilgan jamoa natijalar tarixida saqlanadi');
        return removeTeam(s, tm) === 'archived'
          ? `“${tm.name}” e’lon qilingan turda qatnashgani uchun arxivlandi (faoliyati tugatildi), natijalari saqlanadi`
          : `“${tm.name}” jamoasi o‘chirildi`;
      }
      case 'participation':
        if (!t || t.published || !tm?.approved) bad('Jamoa yoki tur noto‘g‘ri');
        t.activeTeams = t.activeTeams.filter((id) => id !== tm.id);
        if (payload.on) t.activeTeams.push(tm.id);
        return 'Tur tarkibi saqlandi';
      case 'participationAll': {
        if (!t || t.published) bad('E’lon qilingan tur tarkibini o‘zgartirib bo‘lmaydi');
        const ids = s.teams.filter((x) => x.approved).map((x) => x.id);
        t.activeTeams = payload.on ? ids : [];
        return payload.on ? `Barcha ${ids.length} ta jamoa belgilandi` : 'Barcha belgilar olib tashlandi';
      }
      case 'flip': {
        const q = Number(payload.q);
        if (!t || t.published || !tm?.approved || !t.activeTeams.includes(tm.id) || !Number.isInteger(q) || q < 0 || q >= QUESTIONS)
          bad('Javobni o‘zgartirish mumkin emas');
        t.responses[tm.id] ??= {};
        t.responses[tm.id][q] = t.responses[tm.id][q] === 1 ? 0 : 1;
        return 'Javob saqlandi';
      }
      case 'publishTour':
        if (!t || t.published || !t.activeTeams.length) bad('Turda qatnashuvchi jamoalar bo‘lishi kerak');
        t.published = true;
        return 'Natija e’lon qilindi';
      case 'unpublishTour':
        if (!t || !t.published) bad('Tur topilmadi yoki e’lon qilinmagan');
        t.published = false;
        return 'Tur qayta ochildi';
      case 'site':
        s.league = String(payload.league || '').trim().slice(0, 150);
        s.venue = String(payload.venue || '').trim().slice(0, 250);
        if (!s.league || !s.venue) bad('Maydonlar bo‘sh bo‘lmasin');
        return 'Asosiy ma’lumotlar saqlandi';
      case 'addNews': {
        const title = String(payload.title || '').trim().slice(0, 150);
        const body = String(payload.body || '').trim().slice(0, 3000);
        if (!title || !body) bad('Sarlavha va matn kerak');
        s.news.unshift({ id: crypto.randomUUID(), title, body, date: new Date().toLocaleDateString('uz-UZ') });
        return 'Yangilik qo‘shildi';
      }
      case 'removeNews':
        s.news = s.news.filter((x) => x.id !== payload.id);
        return 'O‘chirildi';
      case 'toursCount': {
        const n = Number(payload.count);
        if (!Number.isInteger(n) || n < 1 || n > MAX_TOURS) bad(`Tur soni 1–${MAX_TOURS} bo‘lishi kerak`);
        if (s.tours.slice(n).some((x) => x.published)) bad('E’lon qilingan turni o‘chirib bo‘lmaydi');
        while (s.tours.length > n) s.tours.pop();
        while (s.tours.length < n) s.tours.push(newTour(s.tours.length + 1));
        return 'Turlar soni yangilandi';
      }
      case 'renameTour':
        if (!t) bad('Tur yo‘q');
        t.title = String(payload.title || '').trim().slice(0, 90);
        if (!t.title) bad('Nom bo‘sh');
        return 'Tur nomi saqlandi';
      case 'appealEnabled':
        s.appealEnabled = !!payload.enabled;
        return 'Sozlama saqlandi';
      case 'appealStatus': {
        const a = s.appeals.find((x) => x.id === payload.id);
        if (!a) bad('Apellyatsiya topilmadi');
        if (!APPEAL_STATUSES.includes(payload.status)) bad('Status noto‘g‘ri');
        const answer = String(payload.answer ?? a.answer ?? '').trim();
        if (answer.length > 3000) bad('Javob 3000 belgidan oshmasin');
        if (payload.status === APPEAL.DONE && answer.length < 2) bad('“Ko‘rib chiqildi” deyishdan oldin javob yozing');
        a.status = payload.status;
        if (answer !== (a.answer || '')) {
          a.answer = answer;
          a.answeredBy = req.user.name;
          a.answeredAt = Date.now();
        }
        a.updated = Date.now();
        return payload.status === APPEAL.DONE ? 'Javob yuborildi' : 'Apellyatsiya yangilandi';
      }
      case 'appealWordLimit': {
        const n = Number(payload.limit);
        if (!Number.isInteger(n) || n < 10 || n > 1000) bad('So‘z chegarasi 10–1000 oralig‘ida bo‘lsin');
        s.appealWordLimit = n;
        return 'So‘z chegarasi saqlandi';
      }
      case 'editTeam': {
        if (!tm?.approved) bad('Jamoa yo‘q');
        const name = String(payload.name || '').trim().slice(0, 80);
        if (!name) bad('Nom bo‘sh');
        if (similar(name, s.teams, tm.id)) bad('O‘xshash nom, iltimos boshqa nom tanlang');
        tm.name = name;
        return 'Jamoa o‘zgartirildi';
      }
      default:
        bad('Amal qo‘llab-quvvatlanmaydi');
    }
  });
});

app.post('/api/appeal', requires('user'), (req, res) => {
  update(req, res, 'appeal', { teamId: req.body.teamId, tourId: req.body.tourId }, (s) => {
    if (!s.appealEnabled) bad('Apellyatsiya qabul qilinmayapti');
    const tm = s.teams.find((x) => x.id === req.body.teamId && x.approved);
    const t = s.tours.find((x) => x.id === Number(req.body.tourId));
    const q = Number(req.body.question);
    const message = String(req.body.message || '').trim();
    const words = countWords(message);
    if (!tm || tm.createdBy !== req.user.id) bad('Apellyatsiyani faqat jamoani ro‘yxatdan o‘tkazgan sardor yuboradi', 403);
    if (!t || t.published) bad('Bu tur natijalari allaqachon tasdiqlangan');
    if (!t.activeTeams.includes(tm.id)) bad('Jamoangiz bu turda qatnashmagan');
    if (!Number.isInteger(q) || q < 1 || q > QUESTIONS) bad(`Savol raqami 1–${QUESTIONS} bo‘lishi kerak`);
    if (words < 3) bad('E’tirozni kamida 3 so‘z bilan yozing');
    if (words > s.appealWordLimit) bad(`Matn ${s.appealWordLimit} so‘zdan oshmasin (hozir ${words} so‘z)`);
    if (s.appeals.some((a) => a.teamId === tm.id && a.tourId === t.id && a.question === q && a.status !== APPEAL.DONE))
      bad(`${q}-savol bo‘yicha apellyatsiyangiz allaqachon ko‘rib chiqilmoqda`);
    s.appeals.push({
      id: crypto.randomUUID(), teamId: tm.id, tourId: t.id, question: q, message,
      status: APPEAL.SENT, userId: req.user.id, created: Date.now(),
    });
    return 'Apellyatsiya yuborildi. Holatini shu sahifada kuzatib borasiz.';
  });
});

// ---------- API: monitoring (faqat ega) ----------
app.get('/api/monitoring', requires('owner'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
    res.json(await monitor.report(pool, String(req.query.range || '24h'), rows[0].data));
  } catch (e) { next(e); }
});

// ---------- API: foydalanuvchilar (faqat ega) ----------
app.get('/api/users', requires('owner'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${USER_FIELDS} FROM app_users ORDER BY last_seen DESC LIMIT 3000`);
    res.json({ users: rows });
  } catch (e) { next(e); }
});

app.post('/api/users/:id/role', requires('owner'), async (req, res, next) => {
  try {
    const role = req.body.role;
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Rol noto‘g‘ri' });
    const r = await pool.query(`UPDATE app_users SET role = $1 WHERE id = $2 AND role <> 'owner' RETURNING id`, [role, req.params.id]);
    if (!r.rowCount) return res.status(400).json({ error: 'Foydalanuvchi topilmadi yoki sayt egasi' });
    await pool.query('INSERT INTO audit_log(user_id, action, detail) VALUES ($1, $2, $3)',
      [req.user.id, 'userRole', JSON.stringify({ target: req.params.id, role })]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/users/:id/password', requires('owner'), async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'Parol kamida 6 belgi bo‘lishi kerak' });
    const r = await pool.query(`UPDATE app_users SET password_hash = $1 WHERE id = $2 AND role <> 'owner' RETURNING id`,
      [await hashPassword(password), req.params.id]);
    if (!r.rowCount) return res.status(400).json({ error: 'Foydalanuvchi topilmadi yoki sayt egasi' });
    await pool.query(`DELETE FROM session WHERE sess ->> 'uid' = $1`, [req.params.id]);
    await pool.query('INSERT INTO audit_log(user_id, action, detail) VALUES ($1, $2, $3)',
      [req.user.id, 'passwordReset', JSON.stringify({ target: req.params.id })]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API topilmadi' }));

// ---------- Sayt ----------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  monitor.recordError(err, req);
  res.status(500).json({ error: 'Server xatoligi' });
});

init()
  .then(() => monitor.start(pool))
  .then(() => app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('COLBA server ishga tushdi')))
  .catch((e) => {
    console.error('Ma’lumotlar bazasiga ulanib bo‘lmadi. DATABASE_URL va PGSSL ni tekshiring.\n', e.message);
    process.exit(1);
  });
