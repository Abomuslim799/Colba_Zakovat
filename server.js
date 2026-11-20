'use strict';
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const store = require('./db');
const monitor = require('./monitor');
const teamImport = require('./teamImport');

// ---------- Sozlamalar ----------
const isProd = process.env.NODE_ENV === 'production';
const DATABASE_URL = (process.env.DATABASE_URL || '').trim(); // faqat eski Postgres'dan bir martalik ko'chirish uchun
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase().trim();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkConfig() {
  const problems = [];
  // Railway'da disk (volume) ulanmagan bo'lsa, har deploy'da ma'lumot o'chib ketadi
  if (process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR)
    problems.push('Servisga disk (Volume) ulanmagan. Railway: servis → Settings → Volume, Mount path: /data');
  if (isProd && SESSION_SECRET.length < 32) problems.push('SESSION_SECRET kamida 32 belgi bo‘lishi kerak');
  if (!EMAIL_RE.test(OWNER_EMAIL)) problems.push('OWNER_EMAIL berilmagan yoki noto‘g‘ri (sayt egasining emaili)');
  if (OWNER_PASSWORD.length < 8) problems.push('OWNER_PASSWORD kamida 8 belgi bo‘lishi kerak (sayt egasining paroli)');
  if (problems.length) {
    console.error('Server ishga tushmadi. Railway Variables bo‘limini tekshiring:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}
checkConfig();

const db = store.open();
const readState = () => {
  const r = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
  return { data: JSON.parse(r.data), version: r.version };
};
const writeState = (s) => db.prepare('UPDATE app_state SET data = ?, version = version + 1 WHERE id = 1').run(JSON.stringify(s));
const auditRow = (userId, action, detail) =>
  db.prepare('INSERT INTO audit_log(user_id, action, detail) VALUES (?, ?, ?)').run(userId, action, JSON.stringify(detail || {}));
const dropSessionsOf = (uid) => db.prepare("DELETE FROM session WHERE json_extract(sess, '$.uid') = ?").run(uid);

const QUESTIONS = 36;
const MAX_TOURS = 36;
const APPEAL = { SENT: 'Yuborildi', REVIEW: 'Ko‘rib chiqilmoqda', DONE: 'Ko‘rib chiqildi' };
const APPEAL_STATUSES = Object.values(APPEAL);
const DEFAULT_WORD_LIMIT = 100;
const SUPPORT_CATEGORIES = {
  participation: 'Turda qatnashganimiz belgilanmagan',
  result: 'Natija yoki hisobda xato',
  team: 'Jamoa va ro‘yxatdan o‘tish',
  site: 'Saytdagi texnik xato',
  other: 'Boshqa',
};
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
  support: [],
});

// Eski ma'lumotlarni yangi tuzilishga keltirish (har ishga tushishda xavfsiz)
function migrate(s) {
  s.appealWordLimit ??= DEFAULT_WORD_LIMIT;
  s.support ??= [];
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
  const fresh = !db.prepare('SELECT 1 FROM app_state WHERE id = 1').get();
  if (fresh && DATABASE_URL) {
    console.log('Eski Postgres ma’lumotlari diskdagi bazaga ko‘chirilmoqda…');
    const r = await store.importFromPostgres(db, DATABASE_URL);
    console.log(r ? `Ko‘chirildi: ${r.users} foydalanuvchi, ${r.photos} surat, ${r.audit} jurnal yozuvi, ${r.sessions} sessiya`
      : 'Postgres bo‘sh — yangi baza yaratildi');
  }
  db.prepare('INSERT INTO app_state(id, data) VALUES (1, ?) ON CONFLICT DO NOTHING').run(JSON.stringify(seed()));
  const hash = await hashPassword(OWNER_PASSWORD);
  db.transaction(() => {
    // O'chirilgan jamoalarning suratlarini tozalash
    const st = readState().data;
    const ids = new Set(st.teams.map((t) => t.id));
    for (const p of db.prepare('SELECT id, team_id FROM team_photo').all())
      if (!ids.has(p.team_id)) db.prepare('DELETE FROM team_photo WHERE id = ?').run(p.id);
    db.prepare('UPDATE app_state SET data = ? WHERE id = 1').run(JSON.stringify(migrate(st)));
    // Sayt egasi Railway'dagi OWNER_EMAIL / OWNER_PASSWORD dan yaratiladi (har ishga tushishda yangilanadi)
    db.prepare(`UPDATE app_users SET role = 'user' WHERE role = 'owner' AND email <> ?`).run(OWNER_EMAIL);
    db.prepare(`INSERT INTO app_users(id, email, name, role, password_hash) VALUES (?, ?, 'Sayt egasi', 'owner', ?)
      ON CONFLICT (email) DO UPDATE SET role = 'owner', password_hash = excluded.password_hash`)
      .run('u' + crypto.randomUUID(), OWNER_EMAIL, hash);
  })();
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
app.use(compression());
app.use(monitor.requestTimer);
// Surat yuklash uchun kattaroq so'rov tanasi (faqat shu yo'lda)
app.use('/api/teams/:id/photos', express.json({ limit: '1.2mb' }));
app.use(express.json({ limit: '80kb' }));
app.use(session({
  store: store.sessionStore(session, db),
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
    req.user = db.prepare(`SELECT ${USER_FIELDS} FROM app_users WHERE id = ?`).get(req.session.uid) || null;
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
  delete s.draws;
  const myIds = new Set(s.teams.filter((t) => t.createdBy === user.id).map((t) => t.id));
  for (const t of s.tours) {
    if (!t.published) {
      t.myTeamPlays = (t.activeTeams || []).some((id) => myIds.has(id));
      delete t.responses; delete t.activeTeams;
    }
  }
  s.support = (s.support || [])
    .filter((x) => x.userId === user.id)
    .map(({ userId, userEmail, answeredBy, ...x }) => x);
  s.appeals = s.appeals
    .filter((a) => a.userId === user.id || myIds.has(a.teamId))
    .map(({ userId, answeredBy, ...a }) => a);
  s.teams = s.teams
    .filter((t) => t.approved || t.status === 'closed' || t.createdBy === user.id)
    .map((t) => ({
      id: t.id, name: t.name, members: t.members, branch: t.branch, approved: !!t.approved, description: t.description,
      photos: t.photos || 0,
      status: t.status, mine: t.createdBy === user.id, closedAt: t.closedAt,
      change: t.createdBy === user.id ? t.change : undefined,
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

function update(req, res, action, detail, fn) {
  try {
    let msg, s;
    db.transaction(() => {
      s = migrate(readState().data);
      msg = fn(s);
      writeState(s);
      auditRow(req.user.id, action, detail);
    }).immediate();
    res.json({ ok: true, message: msg || 'Saqlandi', data: safeState(s, req.user) });
  } catch (e) {
    if (!e.status) { console.error(e); monitor.recordError(e, req); }
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Server xatoligi' });
  }
}

// ---------- API: kirish ----------
app.get('/api/health', async (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.get('/api/me', (req, res) => res.json({ user: req.user || null }));

// Kirish sahifasi uchun umumiy raqamlar (shaxsiy ma'lumotsiz)
let publicStatsCache = { at: 0, data: null };
app.get('/api/public/stats', async (req, res, next) => {
  try {
    if (Date.now() - publicStatsCache.at > 60_000) {
      const s = migrate(readState().data);
      const teams = s.teams.filter((t) => t.approved);
      const published = s.tours.filter((t) => t.published);
      let answers = 0;
      for (const t of published)
        for (const id of t.activeTeams || []) answers += Object.values((t.responses || {})[id] || {}).filter((v) => v === 1).length;
      publicStatsCache = {
        at: Date.now(),
        data: {
          league: s.league, teams: teams.length,
          branches: new Set(teams.map((t) => t.branch).filter(Boolean)).size,
          tours: s.tours.length, published: published.length, answers,
        },
      };
    }
    res.json(publicStatsCache.data);
  } catch (e) { next(e); }
});

const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Juda ko‘p urinish. 15 daqiqadan keyin qayta urinib ko‘ring.' } });

const audit = async (userId, action, detail) => {
  try { auditRow(userId, action, detail); } catch (e) { console.error('audit', e.message); }
};

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
    const rows = db.prepare(
      `INSERT INTO app_users(id, email, name, role, password_hash) VALUES (?, ?, ?, 'user', ?)
       ON CONFLICT (email) DO NOTHING RETURNING ${USER_FIELDS}`).all('u' + crypto.randomUUID(), email, name, hash);
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
    const rows = db.prepare(`SELECT ${USER_FIELDS}, password_hash FROM app_users WHERE email = ?`).all(email);
    const ok = await checkPassword(password, rows[0]?.password_hash);
    if (!ok) {
      await audit(rows[0]?.id || null, 'login_failed', { email: email.slice(0, 160) });
      return res.status(401).json({ error: 'Email yoki parol noto‘g‘ri' });
    }
    db.prepare(`UPDATE app_users SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(rows[0].id);
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
    const st = readState();
    res.json({ data: safeState(migrate(st.data), req.user), version: st.version });
  } catch (e) { next(e); }
});

app.get('/api/team/name-check', requires('user'), async (req, res, next) => {
  try {
    const name = String(req.query.name || '').slice(0, 80);
    const except = req.query.except ? String(req.query.except) : undefined;
    res.json({ similar: similar(name, readState().data.teams, except) });
  } catch (e) { next(e); }
});

app.post('/api/team', requires('user'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const members = req.body.members;
  const branch = teamImport.fixLetters(req.body.branch).slice(0, 60);
  update(req, res, 'team_register', { name }, (s) => {
    if (!branch) bad('Jamoa filialini kiriting');
    const okMembers = Array.isArray(members) && members.length >= 4 && members.length <= 8 &&
      members.every((x) => typeof x === 'string' && x.trim().length >= 3 && x.trim().length <= 100);
    if (!name || !okMembers) bad('Jamoa nomi va 4–8 nafar a’zoning ism-familiyasi (kamida 3 harf) talab etiladi');
    const own = s.teams.find((t) => t.createdBy === req.user.id && ACTIVE_STATUSES.includes(t.status));
    if (own) bad(own.status === 'pending'
      ? `Sizning “${own.name}” arizangiz ko‘rib chiqilmoqda. Bir foydalanuvchi faqat bitta jamoa ocha oladi.`
      : `Sizda “${own.name}” jamoasi bor. Yangi jamoa ochish uchun avval uning faoliyatini tugating.`);
    if (similar(name, s.teams)) bad('O‘xshash nom, iltimos boshqa nom tanlang.');
    s.teams.push({
      id: 't' + crypto.randomUUID(), name, members: members.map((x) => x.trim()), branch,
      status: 'pending', approved: false, created: Date.now(),
      createdBy: req.user.id, createdByName: req.user.name, createdByEmail: req.user.email,
    });
    return 'Ariza yuborildi. Jamoa admin tasdiqlagach ro‘yxatda ko‘rinadi.';
  });
});

// Jadvaldan import (admin/ega). dryRun: true — faqat ko'rib chiqish, hech narsa saqlanmaydi.
app.post('/api/teams/import', requires('staff'), async (req, res, next) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 300) : [];
  const dryRun = !!req.body.dryRun;
  if (!rows.length) return res.status(400).json({ error: 'Import uchun qator topilmadi' });
  const plan = (s) => {
    const taken = [...s.teams];
    return rows.map((r) => {
      const x = teamImport.cleanRow(r || {});
      if (!x.error && similar(x.name, taken)) x.error = 'Bunday yoki o‘xshash nomli jamoa allaqachon bor';
      if (!x.error) taken.push({ id: 'new', name: x.name, status: 'approved' });
      return x;
    });
  };
  if (dryRun) {
    try {
      return res.json({ preview: plan(migrate(readState().data)) });
    } catch (e) { return next(e); }
  }
  let result;
  update(req, res, 'importTeams', { count: rows.length }, (s) => {
    result = plan(s);
    const ok = result.filter((x) => !x.error);
    for (const x of ok) {
      s.teams.push({
        id: 't' + crypto.randomUUID(), name: x.name, members: x.members, branch: x.branch,
        status: 'approved', approved: true, created: Date.now(), source: 'import',
        importedBy: req.user.name, createdBy: null,
      });
    }
    if (!ok.length) bad('Import qilinadigan yangi jamoa yo‘q (hammasi xato yoki allaqachon mavjud)');
    return `${ok.length} ta jamoa qo‘shildi${result.length > ok.length ? `, ${result.length - ok.length} tasi o‘tkazib yuborildi` : ''}`;
  });
});

// Jamoaga sardor hisobini biriktirish (import qilingan jamoa uchun). userId bo'sh — ajratish.
app.post('/api/teams/:id/captain', requires('staff'), async (req, res, next) => {
  try {
    const userId = req.body.userId ? String(req.body.userId) : null;
    let u = null;
    if (userId) {
      u = db.prepare(`SELECT ${USER_FIELDS} FROM app_users WHERE id = ?`).get(userId);
      if (!u) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    }
    update(req, res, 'assignCaptain', { teamId: req.params.id, userId }, (s) => {
      const tm = s.teams.find((t) => t.id === req.params.id && ACTIVE_STATUSES.includes(t.status));
      if (!tm) bad('Faol jamoa topilmadi', 404);
      if (u) {
        const other = s.teams.find((t) => t.id !== tm.id && t.createdBy === u.id && ACTIVE_STATUSES.includes(t.status));
        if (other) bad(`${u.name} allaqachon “${other.name}” jamoasining sardori. Bir foydalanuvchi — bitta jamoa.`);
      }
      tm.createdBy = u?.id || null;
      tm.createdByName = u?.name || null;
      tm.createdByEmail = u?.email || null;
      return u ? `“${tm.name}” jamoasiga sardor hisobi biriktirildi: ${u.name}` : 'Sardor hisobi ajratildi';
    });
  } catch (e) { next(e); }
});

// ---------- Sardor jamoa nomi/tarkibini o'zgartirish arizasi ----------
// Ariza tasdiqlanmaguncha jamoa avvalgi holatida qoladi; admin/ega tasdiqlasa hammasi bir vaqtda o'zgaradi.
function cleanMembers(members) {
  const ok = Array.isArray(members) && members.length >= 4 && members.length <= 8 &&
    members.every((x) => typeof x === 'string' && x.trim().length >= 3 && x.trim().length <= 100);
  return ok ? members.map((x) => x.trim().replace(/\s+/g, ' ')) : null;
}
app.post('/api/teams/:id/change', requires('user'), (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const members = cleanMembers(req.body.members);
  update(req, res, 'teamChange', { teamId: req.params.id }, (s) => {
    const tm = s.teams.find((t) => t.id === req.params.id && t.status === 'approved');
    if (!tm) bad('Faol jamoa topilmadi', 404);
    if (!tm.createdBy || tm.createdBy !== req.user.id) bad('Jamoani faqat uning sardori o‘zgartira oladi', 403);
    if (!name || !members) bad('Jamoa nomi va 4–8 nafar a’zoning ism-familiyasi (kamida 3 harf) talab etiladi');
    if (new Set(members.map((x) => x.toLocaleLowerCase('uz'))).size !== members.length) bad('Bir a’zo ikki marta yozilgan');
    if (name === tm.name && JSON.stringify(members) === JSON.stringify(tm.members)) bad('Hech narsa o‘zgarmagan');
    if (name !== tm.name && similar(name, s.teams, tm.id)) bad('O‘xshash nom, iltimos boshqa nom tanlang.');
    tm.change = { status: 'pending', name, members, at: Date.now(), byName: req.user.name };
    return 'O‘zgartirish arizasi yuborildi. Admin tasdiqlagach jamoa nomi va tarkibi yangilanadi.';
  });
});
app.post('/api/teams/:id/change/cancel', requires('user'), (req, res) => {
  update(req, res, 'teamChangeCancel', { teamId: req.params.id }, (s) => {
    const tm = s.teams.find((t) => t.id === req.params.id);
    if (!tm?.change) bad('Ariza topilmadi', 404);
    if (!tm.createdBy || tm.createdBy !== req.user.id) bad('Arizani faqat jamoa sardori qaytarib oladi', 403);
    const was = tm.change.status;
    delete tm.change;
    return was === 'pending' ? 'O‘zgartirish arizasi qaytarib olindi' : 'Xabar yopildi';
  });
});

// ---------- Jamoa profili: tavsif va suratlar (sardor yoki admin/ega) ----------
const MAX_PHOTOS = 8, MAX_PHOTO_BYTES = 700 * 1024;
const canEditTeam = (tm, user) => tm && tm.status !== 'closed' && (isStaff(user) || (tm.createdBy && tm.createdBy === user.id));

app.post('/api/teams/:id/profile', requires('user'), (req, res) => {
  update(req, res, 'teamProfile', { teamId: req.params.id }, (s) => {
    const tm = s.teams.find((t) => t.id === req.params.id);
    if (!canEditTeam(tm, req.user)) bad('Profilni faqat jamoa sardori yoki admin tahrirlaydi', 403);
    const description = String(req.body.description || '').trim();
    if (description.length > 600) bad('Tavsif 600 belgidan oshmasin');
    tm.description = description;
    return 'Jamoa tavsifi saqlandi';
  });
});

app.get('/api/teams/:id/photos', requires('user'), async (req, res, next) => {
  try {
    res.json({ photos: db.prepare('SELECT id, created_at FROM team_photo WHERE team_id = ? ORDER BY created_at DESC').all(req.params.id) });
  } catch (e) { next(e); }
});

app.get('/api/photos/:pid', requires('user'), async (req, res, next) => {
  try {
    const p = db.prepare('SELECT mime, data FROM team_photo WHERE id = ?').get(req.params.pid);
    if (!p) return res.status(404).end();
    res.set('Content-Type', p.mime).set('Cache-Control', 'private, max-age=604800, immutable').send(p.data);
  } catch (e) { next(e); }
});

async function syncPhotoCount(teamId) {
  return db.prepare('SELECT COUNT(*) AS n FROM team_photo WHERE team_id = ?').get(teamId).n;
}

app.post('/api/teams/:id/photos', requires('user'), async (req, res, next) => {
  try {
    const tm = readState().data.teams.find((t) => t.id === req.params.id);
    if (!canEditTeam(tm, req.user)) return res.status(403).json({ error: 'Surat qo‘shishni faqat jamoa sardori yoki admin qila oladi' });
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
    if (!m) return res.status(400).json({ error: 'Faqat JPG, PNG yoki WEBP surat yuklanadi' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'Surat hajmi 700 KB dan oshmasin' });
    if ((await syncPhotoCount(tm.id)) >= MAX_PHOTOS) return res.status(400).json({ error: `Jamoada ko‘pi bilan ${MAX_PHOTOS} ta surat bo‘ladi` });
    const id = 'p' + crypto.randomUUID();
    db.prepare('INSERT INTO team_photo(id, team_id, mime, data, bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, tm.id, m[1], buf, buf.length, req.user.id);
    const n = await syncPhotoCount(tm.id);
    update(req, res, 'teamPhoto', { teamId: tm.id, photo: id }, (s) => {
      const t = s.teams.find((x) => x.id === tm.id);
      if (t) t.photos = n;
      return 'Surat qo‘shildi';
    });
  } catch (e) { next(e); }
});

app.post('/api/photos/:pid/delete', requires('user'), async (req, res, next) => {
  try {
    const ph = db.prepare('SELECT team_id FROM team_photo WHERE id = ?').get(req.params.pid);
    if (!ph) return res.status(404).json({ error: 'Surat topilmadi' });
    const tm = readState().data.teams.find((t) => t.id === ph.team_id);
    if (!canEditTeam(tm, req.user)) return res.status(403).json({ error: 'Suratni faqat jamoa sardori yoki admin o‘chiradi' });
    db.prepare('DELETE FROM team_photo WHERE id = ?').run(req.params.pid);
    const n = await syncPhotoCount(tm.id);
    update(req, res, 'teamPhotoDelete', { teamId: tm.id }, (s) => {
      const t = s.teams.find((x) => x.id === tm.id);
      if (t) t.photos = n;
      return 'Surat o‘chirildi';
    });
  } catch (e) { next(e); }
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
      case 'draw': {
        // Randomayzer: belgilangan jamoalardan bittasini serverda (kriptografik tasodif bilan) tanlaydi
        const ids = [...new Set(Array.isArray(payload.teamIds) ? payload.teamIds.map(String) : [])];
        const pool = ids.map((id) => s.teams.find((x) => x.id === id && x.approved && x.status === 'approved')).filter(Boolean);
        if (pool.length < 2) bad('Kamida 2 ta tasdiqlangan jamoani belgilang');
        if (pool.length !== ids.length) bad('Belgilangan jamoalardan biri topilmadi yoki faol emas — sahifani yangilang');
        const picked = pool[crypto.randomInt(pool.length)];
        const title = String(payload.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
        s.draws = [{ id: 'd' + crypto.randomUUID(), at: Date.now(), by: req.user.name, title,
          pool: pool.map((x) => ({ id: x.id, name: x.name })), picked: { id: picked.id, name: picked.name } }]
          .concat(s.draws || []).slice(0, 100);
        return `Tanlandi: ${picked.name}`;
      }
      case 'approveTeam':
        if (!tm || tm.status !== 'pending') bad('Jamoa topilmadi yoki allaqachon ko‘rib chiqilgan');
        if (similar(tm.name, s.teams.filter((x) => x.approved), tm.id)) bad('Tasdiqlangan jamoalar orasida o‘xshash nom bor');
        tm.approved = true; tm.status = 'approved';
        return 'Jamoa tasdiqlandi';
      case 'rejectTeam':
        if (!tm || tm.status !== 'pending') bad('Jamoani rad etish mumkin emas');
        tm.status = 'rejected';
        return 'Ariza rad etildi';
      case 'approveChange': {
        if (!tm || tm.status !== 'approved' || tm.change?.status !== 'pending') bad('Kutilayotgan o‘zgartirish arizasi topilmadi');
        const c = tm.change;
        if (c.name !== tm.name && similar(c.name, s.teams, tm.id)) bad('Bu orada o‘xshash nomli jamoa paydo bo‘lgan — arizani rad eting');
        tm.history = (tm.history || []).concat({
          at: Date.now(), by: req.user.name, requestedBy: c.byName,
          from: { name: tm.name, members: tm.members }, to: { name: c.name, members: c.members },
        }).slice(-20);
        tm.name = c.name; tm.members = c.members;
        delete tm.change;
        return `“${c.name}” jamoasining yangi nomi va tarkibi tasdiqlandi`;
      }
      case 'rejectChange': {
        if (!tm || tm.change?.status !== 'pending') bad('Kutilayotgan o‘zgartirish arizasi topilmadi');
        tm.change.status = 'rejected';
        tm.change.reason = String(payload.reason || '').trim().slice(0, 300);
        tm.change.decidedAt = Date.now();
        return 'O‘zgartirish arizasi rad etildi';
      }
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
      case 'appealFix': {
        // Apellyatsiya qabul qilinsa: shu jamoaning shu savoldagi javobini almashtirish (e'lon qilingan turda ham)
        const a = s.appeals.find((x) => x.id === payload.id);
        if (!a) bad('Apellyatsiya topilmadi');
        const at = s.tours.find((x) => x.id === a.tourId);
        if (!at || !at.activeTeams.includes(a.teamId)) bad('Jamoa bu turda qatnashmagan');
        const q = a.question - 1;
        at.responses[a.teamId] ??= {};
        const value = at.responses[a.teamId][q] === 1 ? 0 : 1;
        at.responses[a.teamId][q] = value;
        (a.fixes ??= []).push({ by: req.user.name, at: Date.now(), value });
        return `${a.question}-savol javobi “${value ? '+' : '−'}” ga o‘zgartirildi${at.published ? '. Tur natijasi va reyting qayta hisoblandi' : ''}`;
      }
      case 'supportStatus': {
        const x = (s.support || []).find((y) => y.id === payload.id);
        if (!x) bad('Murojaat topilmadi');
        if (!APPEAL_STATUSES.includes(payload.status)) bad('Status noto‘g‘ri');
        const answer = String(payload.answer ?? x.answer ?? '').trim();
        if (answer.length > 3000) bad('Javob 3000 belgidan oshmasin');
        if (payload.status === APPEAL.DONE && answer.length < 2) bad('“Ko‘rib chiqildi” deyishdan oldin javob yozing');
        x.status = payload.status;
        if (answer !== (x.answer || '')) { x.answer = answer; x.answeredBy = req.user.name; x.answeredAt = Date.now(); }
        x.updated = Date.now();
        return payload.status === APPEAL.DONE ? 'Javob yuborildi' : 'Murojaat yangilandi';
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
        if (payload.branch !== undefined) tm.branch = teamImport.fixLetters(payload.branch).slice(0, 60);
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
    if (!t) bad('Tur topilmadi');
    if (!t.activeTeams.includes(tm.id))
      bad('Jamoangiz bu turda qatnashgani belgilanmagan. Qatnashgan bo‘lsangiz, “Yordam” bo‘limiga yozing.');
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

// ---------- API: yordam (texnik muammo va boshqa murojaatlar) ----------
app.post('/api/support', requires('user'), (req, res) => {
  update(req, res, 'support', { category: req.body.category }, (s) => {
    const category = String(req.body.category || '');
    const message = String(req.body.message || '').trim();
    const tourId = req.body.tourId ? Number(req.body.tourId) : null;
    if (!SUPPORT_CATEGORIES[category]) bad('Murojaat turini tanlang');
    if (message.length < 10) bad('Muammoni kamida 10 belgi bilan tushuntiring');
    if (message.length > 1500) bad('Matn 1500 belgidan oshmasin');
    if (tourId && !s.tours.some((t) => t.id === tourId)) bad('Tur topilmadi');
    s.support ??= [];
    const open = s.support.filter((x) => x.userId === req.user.id && x.status !== APPEAL.DONE).length;
    if (open >= 5) bad('Sizda 5 ta javob kutilayotgan murojaat bor. Avval ularga javob berilishini kuting.');
    const team = s.teams.find((t) => t.createdBy === req.user.id && ACTIVE_STATUSES.includes(t.status));
    s.support.push({
      id: crypto.randomUUID(), category, tourId, message, teamId: team?.id || null,
      userId: req.user.id, userName: req.user.name, userEmail: req.user.email,
      status: APPEAL.SENT, created: Date.now(),
    });
    return 'Murojaatingiz yuborildi. Javobni shu sahifada ko‘rasiz.';
  });
});

// ---------- API: monitoring (faqat ega) ----------
app.get('/api/monitoring', requires('owner'), async (req, res, next) => {
  try {
    res.json(monitor.report(String(req.query.range || '24h'), readState().data));
  } catch (e) { next(e); }
});

// ---------- API: foydalanuvchilar (faqat ega) ----------
app.get('/api/users', requires('staff'), async (req, res, next) => {
  try {
    res.json({ users: db.prepare(`SELECT ${USER_FIELDS} FROM app_users ORDER BY last_seen DESC LIMIT 3000`).all() });
  } catch (e) { next(e); }
});

app.post('/api/users/:id/role', requires('owner'), async (req, res, next) => {
  try {
    const role = req.body.role;
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Rol noto‘g‘ri' });
    const r = db.prepare(`UPDATE app_users SET role = ? WHERE id = ? AND role <> 'owner'`).run(role, req.params.id);
    if (!r.changes) return res.status(400).json({ error: 'Foydalanuvchi topilmadi yoki sayt egasi' });
    auditRow(req.user.id, 'userRole', { target: req.params.id, role });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Foydalanuvchini o'chirish: ega — istalgan (o'zidan tashqari), admin — faqat oddiy foydalanuvchini.
// Tasdiqlangan jamoasi bo'lsa avval jamoa o'chiriladi yoki faoliyati tugatiladi; kutilayotgan arizasi bekor qilinadi.
app.post('/api/users/:id/delete', requires('staff'), (req, res, next) => {
  try {
    let target, pending = [];
    db.transaction(() => {
      target = db.prepare(`SELECT ${USER_FIELDS} FROM app_users WHERE id = ?`).get(req.params.id);
      if (!target) bad('Foydalanuvchi topilmadi', 404);
      if (target.id === req.user.id) bad('O‘zingizni o‘chira olmaysiz');
      if (target.role === 'owner') bad('Sayt egasini o‘chirib bo‘lmaydi', 403);
      if (target.role === 'admin' && req.user.role !== 'owner') bad('Adminni faqat sayt egasi o‘chiradi', 403);
      const s = migrate(readState().data);
      const approved = s.teams.find((t) => t.createdBy === target.id && t.status === 'approved');
      if (approved) bad(`Foydalanuvchining “${approved.name}” jamoasi faol. Avval “Jamoalar” bo‘limida jamoani o‘chiring.`);
      pending = s.teams.filter((t) => t.createdBy === target.id && t.status === 'pending');
      if (pending.length) {
        s.teams = s.teams.filter((t) => !pending.includes(t));
        writeState(s);
      }
      dropSessionsOf(target.id);
      db.prepare('DELETE FROM app_users WHERE id = ?').run(target.id);
      auditRow(req.user.id, 'userDelete', { target: target.id, name: target.name, email: target.email });
    }).immediate();
    res.json({ ok: true, message: `“${target.name}” o‘chirildi${pending.length ? ' (kutilayotgan arizasi bekor qilindi)' : ''}` });
  } catch (e) {
    if (!e.status) return next(e);
    res.status(e.status).json({ error: e.message });
  }
});

app.post('/api/users/:id/password', requires('owner'), async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'Parol kamida 6 belgi bo‘lishi kerak' });
    const hash = await hashPassword(password);
    const r = db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ? AND role <> 'owner'`).run(hash, req.params.id);
    if (!r.changes) return res.status(400).json({ error: 'Foydalanuvchi topilmadi yoki sayt egasi' });
    dropSessionsOf(req.params.id);
    auditRow(req.user.id, 'passwordReset', { target: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Zaxira nusxa: butun baza bitta fayl (faqat ega). Disk bitta joyda — vaqti-vaqti bilan yuklab olib turish tavsiya etiladi.
app.get('/api/backup', requires('owner'), async (req, res, next) => {
  const tmp = path.join(store.DATA_DIR, `backup-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    auditRow(req.user.id, 'backup', {});
    res.download(tmp, `colba-zakovat-${new Date().toISOString().slice(0, 10)}.db`, () => require('fs').rm(tmp, { force: true }, () => {}));
  } catch (e) { require('fs').rm(tmp, { force: true }, () => {}); next(e); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API topilmadi' }));

// ---------- Sayt ----------
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, file) => res.set('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=86400'),
}));
app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  monitor.recordError(err, req);
  res.status(500).json({ error: 'Server xatoligi' });
});

init()
  .then(() => monitor.start(db, store.DB_FILE))
  .then(() => app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('COLBA server ishga tushdi')))
  .catch((e) => {
    console.error('Ma’lumotlar bazasini ochib bo‘lmadi (disk /data yoki eski Postgres’dan ko‘chirish).\n', e.message);
    process.exit(1);
  });
