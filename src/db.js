'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

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
`);

// ---------- Ajustes por defecto ----------
const DEFAULTS = {
  site_title: 'Green Bears Rancagua',
  tagline: 'Club de Básquetbol · Rancagua',
  about: 'Green Bears es un club de básquetbol de Rancagua. Formamos jugadores dentro y fuera de la cancha, con trabajo, disciplina y comunidad.',
  email: '',
  instagram: '',
  facebook: '',
  whatsapp: '',
  primary: '#1f9b57',
  hero_image: ''
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

module.exports = { db, settings, setSetting, slugify, uniqueSlug, DATA_DIR };
