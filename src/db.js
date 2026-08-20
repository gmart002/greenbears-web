'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'greenbears.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Esquema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  excerpt     TEXT DEFAULT '',
  body        TEXT DEFAULT '',
  cover       TEXT DEFAULT '',
  published   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  number      TEXT DEFAULT '',
  position    TEXT DEFAULT '',
  height      TEXT DEFAULT '',
  birthdate   TEXT DEFAULT '',
  photo       TEXT DEFAULT '',
  bio         TEXT DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS matches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  opponent    TEXT NOT NULL,
  date        TEXT NOT NULL,          -- ISO (YYYY-MM-DDTHH:mm)
  location    TEXT DEFAULT '',
  home        INTEGER NOT NULL DEFAULT 1,
  our_score   INTEGER,
  opp_score   INTEGER,
  status      TEXT NOT NULL DEFAULT 'upcoming', -- upcoming | played
  notes       TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gallery (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT DEFAULT '',
  image       TEXT DEFAULT '',
  video_url   TEXT DEFAULT '',
  season      TEXT DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sponsors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  logo        TEXT DEFAULT '',
  url         TEXT DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  contact     TEXT DEFAULT '',
  reason      TEXT DEFAULT '',
  body        TEXT DEFAULT '',
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  day     TEXT PRIMARY KEY,        -- YYYY-MM-DD
  visits  INTEGER NOT NULL DEFAULT 0,  -- visitantes únicos por día (por sesión)
  views   INTEGER NOT NULL DEFAULT 0   -- páginas vistas
);
CREATE TABLE IF NOT EXISTS highlights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT DEFAULT '',
  video       TEXT DEFAULT '',    -- archivo subido (/uploads/..)
  video_url   TEXT DEFAULT '',    -- enlace externo (YouTube, etc.)
  poster      TEXT DEFAULT '',    -- miniatura (imagen)
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'editor',  -- 'super' | 'editor'
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
`);

// Migraciones incrementales (agregar columnas nuevas sin perder datos)
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('matches', 'tournament', "TEXT DEFAULT ''");
addColumn('matches', 'confirmed', 'INTEGER NOT NULL DEFAULT 1');
addColumn('players', 'staff', 'INTEGER NOT NULL DEFAULT 0');   // 0 = jugador, 1 = cuerpo técnico
addColumn('players', 'staff_role', "TEXT DEFAULT ''");         // ej. Entrenador, Asistente

// ---------- Ajustes por defecto ----------
const DEFAULTS = {
  site_title: 'Green Bears',
  tagline: 'Club de Básquetbol · Rancagua',
  about: 'Green Bears es un club de básquetbol de Rancagua. Formamos jugadores dentro y fuera de la cancha, con trabajo, disciplina y comunidad.',
  email: '',
  instagram: '',
  facebook: '',
  whatsapp: '',
  primary: '#1f9b57',
  hero_image: '',
  logo_image: '',
  club_history: '',
  club_values: '',
  club_achievements: '',
  club_tournaments: '',
  club_photo: '',
  actualidad_label: 'Actualidad',
  instagram_embed: '',
  show_visits: '1'   // mostrar el contador de visitas en el pie ('1' sí, '0' no)
};
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!getSetting.get(k)) setSettingStmt.run(k, v);
}

function settings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const o = { ...DEFAULTS };
  for (const r of rows) o[r.key] = r.value;
  return o;
}

// ---------- Usuarios ----------
// Crea el superadmin la primera vez, usando la clave del .env (ADMIN_PASSWORD / _HASH).
(function seedSuperadmin() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n > 0) return;
  const uname = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
  const hash = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'greenbears', 10);
  db.prepare('INSERT INTO users (username, pass_hash, role, active, created_at) VALUES (?,?,?,1,?)')
    .run(uname, hash, 'super', new Date().toISOString());
})();

function listUsers() { return db.prepare('SELECT id, username, role, active, created_at FROM users ORDER BY role, username').all(); }
function findUser(username) { return db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase()); }
function createUser(username, password, role) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('Usuario inválido (3-32, letras/números/._-).');
  if (String(password || '').length < 6) throw new Error('La clave debe tener al menos 6 caracteres.');
  db.prepare('INSERT INTO users (username, pass_hash, role, active, created_at) VALUES (?,?,?,1,?)')
    .run(u, bcrypt.hashSync(String(password), 10), role === 'super' ? 'super' : 'editor', new Date().toISOString());
}
function setUserPassword(id, password) {
  if (String(password || '').length < 6) throw new Error('La clave debe tener al menos 6 caracteres.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), id);
}
function setUserActive(id, active) { db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id); }
function deleteUser(id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); }
function countSupers() { return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='super' AND active=1").get().c; }
function verifyLogin(username, password) {
  const u = findUser(username);
  if (!u) return null;
  try { if (!bcrypt.compareSync(String(password || ''), u.pass_hash)) return null; } catch (e) { return null; }
  return { id: u.id, username: u.username, role: u.role };
}
function setSetting(key, value) { setSettingStmt.run(key, String(value == null ? '' : value)); }

// ---------- Utilidades ----------
function slugify(s) {
  return String(s).toLowerCase().trim()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'nota';
}
function uniqueSlug(base, excludeId) {
  let slug = slugify(base), i = 2;
  const q = db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?');
  while (q.get(slug, excludeId || 0)) slug = slugify(base) + '-' + (i++);
  return slug;
}

// ---------- Contador de visitas ----------
// Día calendario en hora de Chile (no UTC), para que no "salte" al día siguiente por la tarde.
const _chileFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d) => _chileFmt.format(d || new Date());
function daysAgoKey(n) { return dayKey(new Date(Date.now() - n * 86400000)); }

const _recordVisit = db.prepare(`
  INSERT INTO visits (day, visits, views) VALUES (@day, @u, 1)
  ON CONFLICT(day) DO UPDATE SET visits = visits + @u, views = views + 1`);
function recordVisit(unique) { _recordVisit.run({ day: dayKey(), u: unique ? 1 : 0 }); }

const _totals = db.prepare('SELECT COALESCE(SUM(visits),0) AS visits, COALESCE(SUM(views),0) AS views FROM visits');
const _oneDay = db.prepare('SELECT visits, views FROM visits WHERE day = ?');
const _sumSince = db.prepare('SELECT COALESCE(SUM(visits),0) AS v FROM visits WHERE day >= ?');
const _recentDays = db.prepare('SELECT day, visits, views FROM visits ORDER BY day DESC LIMIT 14');

function visitsTotal() { return _totals.get().visits; }
function resetVisits() { db.prepare('DELETE FROM visits').run(); }
function visitStats() {
  const totals = _totals.get();
  const today = _oneDay.get(dayKey()) || { visits: 0, views: 0 };
  return {
    totalVisits: totals.visits,
    totalViews: totals.views,
    todayVisits: today.visits,
    todayViews: today.views,
    week: _sumSince.get(daysAgoKey(6)).v,
    month: _sumSince.get(daysAgoKey(29)).v,
    days: _recentDays.all()
  };
}

module.exports = {
  db, settings, setSetting, slugify, uniqueSlug, DATA_DIR,
  recordVisit, visitStats, visitsTotal, resetVisits, dayKey,
  listUsers, findUser, createUser, setUserPassword, setUserActive, deleteUser, countSupers, verifyLogin
};
