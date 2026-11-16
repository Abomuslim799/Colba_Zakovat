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
const { OAuth2Client } = require('google-auth-library');

// ---------- Sozlamalar ----------
const isProd = process.env.NODE_ENV === 'production';
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase().trim();
const SESSION_SECRET = process.env.SESSION_SECRET || '';

function checkConfig() {
  const problems = [];
  if (!DATABASE_URL) problems.push('DATABASE_URL berilmagan (Railway: ${{Postgres.DATABASE_URL}})');
  if (isProd && SESSION_SECRET.length < 32) problems.push('SESSION_SECRET kamida 32 belgi bo‘lishi kerak');
  if (!OWNER_EMAIL) console.warn('OGOHLANTIRISH: OWNER_EMAIL berilmagan — hech kim sayt egasi bo‘la olmaydi');
  if (!GOOGLE_CLIENT_ID) console.warn('OGOHLANTIRISH: GOOGLE_CLIENT_ID berilmagan — Google orqali kirish ishlamaydi');
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
const google = new OAuth2Client(GOOGLE_CLIENT_ID);

const QUESTIONS = 36;
const MAX_TOURS = 36;

// ---------- Ma'lumotlar bazasi ----------
const seed = () => ({
  league: 'COLBA ZAKOVAT LIGASI',
  venue: 'O‘tkaziladigan joy boshqaruv panelida belgilanadi',
  news: [],
  teams: [],
  tours: Array.from({ length: 9 }, (_, i) => newTour(i + 1)),
  appealEnabled: false,
  appeals: [],
});
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
  // OWNER_EMAIL o'zgargan bo'lsa: eski egani oddiy foydalanuvchiga tushirish, yangisini egaga ko'tarish
  await pool.query(`UPDATE app_users SET role = 'user' WHERE role = 'owner' AND email <> $1`, [OWNER_EMAIL]);
  await pool.query(`UPDATE app_users SET role = 'owner' WHERE email = $1`, [OWNER_EMAIL]);
}

// ---------- Ilova ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '80kb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: SESSION_SECRET || 'local-dev-secret-only',
  resave: false,
  saveUninitialized: false,
  name: 'colba.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 7 * 86400000 },
}));

const USER_FIELDS = 'id, email, name, picture, role, first_seen, last_seen';
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
    if (!req.user) return res.status(401).json({ error: 'Google orqali kiring' });
    if (role === 'staff' && !isStaff(req.user)) return res.status(403).json({ error: 'Administrator huquqi kerak' });
    if (role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Faqat sayt egasi uchun' });
    next();
  };
}

// Foydalanuvchiga uning roliga mos ma'lumotni qaytaradi
function safeState(src, user) {
  const s = structuredClone(src);
  if (isStaff(user)) return s;
  for (const t of s.tours) {
    if (!t.published) { delete t.responses; delete t.activeTeams; }
  }
  delete s.appeals;
  s.teams = s.teams
    .filter((t) => t.approved || t.createdBy === user.id)
    .map((t) => ({
      id: t.id, name: t.name, members: t.members, approved: !!t.approved,
      status: t.status, mine: t.createdBy === user.id,
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
    const s = rows[0].data;
    const msg = fn(s);
    await client.query('UPDATE app_state SET data = $1, version = version + 1 WHERE id = 1', [JSON.stringify(s)]);
    await client.query('INSERT INTO audit_log(user_id, action, detail) VALUES ($1, $2, $3)',
      [req.user.id, action, JSON.stringify(detail || {})]);
    await client.query('COMMIT');
    res.json({ ok: true, message: msg || 'Saqlandi', data: safeState(s, req.user) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Server xatoligi' });
  } finally {
    client.release();
  }
}

// ---------- API: kirish ----------
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));
app.get('/api/me', (req, res) => res.json({ user: req.user || null }));

app.post('/api/auth/google',
  rateLimit({ windowMs: 60000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false }),
  async (req, res) => {
    let p;
    try {
      const credential = String(req.body.credential || '');
      if (!credential || credential.length > 5000) bad('Google tasdiqlash tokeni yo‘q', 401);
      const ticket = await google.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      p = ticket.getPayload();
      if (!p?.email_verified) bad('Google email tasdiqlanmagan', 401);
    } catch (e) {
      return res.status(401).json({ error: 'Google orqali kirish tasdiqlanmadi: ' + e.message });
    }
    try {
      const email = p.email.toLowerCase();
      const isOwner = !!OWNER_EMAIL && email === OWNER_EMAIL;
      const { rows } = await pool.query(
        `INSERT INTO app_users(id, email, name, picture, role) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
           picture = EXCLUDED.picture, last_seen = NOW(),
           role = CASE WHEN $6 THEN 'owner'
                       WHEN app_users.role = 'owner' THEN 'user'
                       ELSE app_users.role END
         RETURNING ${USER_FIELDS}`,
        [p.sub, email, (p.name || email).slice(0, 180), (p.picture || '').slice(0, 800), isOwner ? 'owner' : 'user', isOwner]);
      await new Promise((ok, fail) => req.session.regenerate((err) => (err ? fail(err) : ok())));
      req.session.uid = p.sub;
      await new Promise((ok, fail) => req.session.save((err) => (err ? fail(err) : ok())));
      res.json({ user: rows[0] });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Server xatoligi, qaytadan urinib ko‘ring' });
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
    res.json({ data: safeState(rows[0].data, req.user), version: rows[0].version });
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
    if (s.teams.some((t) => t.createdBy === req.user.id && t.status === 'pending'))
      bad('Sizda tasdiqlanishi kutilayotgan ariza bor. Admin uni ko‘rib chiqishini kuting.');
    if (similar(name, s.teams)) bad('O‘xshash nom, iltimos boshqa nom tanlang.');
    s.teams.push({
      id: 't' + crypto.randomUUID(), name, members: members.map((x) => x.trim()),
      status: 'pending', approved: false, createdBy: req.user.id, created: Date.now(),
    });
    return 'Ariza yuborildi. Jamoa admin tasdiqlagach ro‘yxatda ko‘rinadi.';
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
      case 'participation':
        if (!t || t.published || !tm?.approved) bad('Jamoa yoki tur noto‘g‘ri');
        t.activeTeams = t.activeTeams.filter((id) => id !== tm.id);
        if (payload.on) t.activeTeams.push(tm.id);
        return 'Tur tarkibi saqlandi';
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
        if (!a) bad('Apellyatsiya yo‘q');
        if (!['Ko‘rib chiqildi', 'Rad etildi'].includes(payload.status)) bad('Status noto‘g‘ri');
        a.status = payload.status;
        return 'Apellyatsiya yangilandi';
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
    if (!s.appealEnabled) bad('Apellyatsiya yopiq');
    const tm = s.teams.find((x) => x.id === req.body.teamId && x.approved);
    const t = s.tours.find((x) => x.id === Number(req.body.tourId));
    const q = Number(req.body.question);
    const message = String(req.body.message || '').trim();
    if (!tm || tm.createdBy !== req.user.id) bad('Apellyatsiyani faqat jamoani ro‘yxatdan o‘tkazgan sardor yuboradi', 403);
    if (!t || t.published) bad('Bu tur natijalari allaqachon tasdiqlangan');
    if (!t.activeTeams.includes(tm.id)) bad('Jamoangiz bu turda qatnashmagan');
    if (!Number.isInteger(q) || q < 1 || q > QUESTIONS) bad(`Savol raqami 1–${QUESTIONS} bo‘lishi kerak`);
    if (message.length < 10 || message.length > 3000) bad('E’tiroz matni 10–3000 belgi bo‘lishi kerak');
    s.appeals.push({
      id: crypto.randomUUID(), teamId: tm.id, tourId: t.id, question: q, message,
      status: 'Yangi', userId: req.user.id, date: new Date().toLocaleDateString('uz-UZ'),
    });
    return 'Apellyatsiya yuborildi';
  });
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

app.use('/api', (req, res) => res.status(404).json({ error: 'API topilmadi' }));

// ---------- Sayt ----------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server xatoligi' });
});

init()
  .then(() => app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('COLBA server ishga tushdi')))
  .catch((e) => {
    console.error('Ma’lumotlar bazasiga ulanib bo‘lmadi. DATABASE_URL va PGSSL ni tekshiring.\n', e.message);
    process.exit(1);
  });
