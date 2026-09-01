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
-- ---- Pizarra multiusuario ----
CREATE TABLE IF NOT EXISTS coaches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  name        TEXT DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pz_teams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  linked_plantel INTEGER NOT NULL DEFAULT 0,   -- 1 = usa el plantel del sitio (Green Bears)
  payload        TEXT DEFAULT '',              -- JSON: jugadas + roster + ajustes del equipo
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (coach_id) REFERENCES coaches(id) ON DELETE CASCADE
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
addColumn('pz_teams', 'shared', 'INTEGER NOT NULL DEFAULT 0'); // 1 = visible/editable por todos los coaches
addColumn('coaches', 'role', "TEXT NOT NULL DEFAULT 'coach'"); // 'super' ve/revisa todos los equipos
// Green Bears (enlazado al plantel) es compartido entre coaches.
db.exec('UPDATE pz_teams SET shared = 1 WHERE linked_plantel = 1 AND shared = 0');
// Historial de versiones de cada equipo: antes de sobrescribir un payload se archiva
// el anterior aquí. Así ninguna sobrescritura es definitiva y todo es recuperable.
db.exec(`CREATE TABLE IF NOT EXISTS pz_team_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  roster_n   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES pz_teams(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pz_team_versions_team ON pz_team_versions(team_id, id)');
// Permisos por módulo para usuarios editores (CSV de claves de módulo).
addColumn('users', 'perms', "TEXT DEFAULT ''");
const ADMIN_MODULE_KEYS = ['noticias', 'jugadores', 'partidos', 'lbo', 'galeria', 'highlights', 'patrocinadores', 'mensajes', 'club'];

// ---------- Liga LBO 2026 (fixture + resultados + tabla) ----------
db.exec(`CREATE TABLE IF NOT EXISTS lbo_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rnd INTEGER NOT NULL,
  mdate TEXT, mtime TEXT,
  home TEXT NOT NULL, away TEXT NOT NULL,
  home_pts INTEGER, away_pts INTEGER,
  wo INTEGER NOT NULL DEFAULT 0,          -- 0 normal, 1 gana local por W.O., 2 gana visita por W.O.
  sort INTEGER NOT NULL DEFAULT 0
);`);
(function seedLbo() {
  if (db.prepare('SELECT COUNT(*) AS c FROM lbo_matches').get().c > 0) return;
  const LBO_SEED = [
    [1,"2026-09-27","10:00","OLD'S MAGIC","LOS CHAMOS"],
    [1,"2026-09-27","11:30","RANCAGUA CAF","PLACILLA"],
    [1,"2026-09-27","13:00","UNCA","PATRIOTAS"],
    [1,"2026-09-27","14:30","PESTAÑAS","GREEN BEARS"],
    [1,"2026-09-27","16:00","PARROTS","SANTA CRUZ"],
    [1,"2026-09-27","17:30","UBC","O'HIGGINS"],
    [2,"2026-10-03","13:00","OLD'S MAGIC","UNCA"],
    [2,"2026-10-03","14:30","PATRIOTAS","RANCAGUA CAF"],
    [2,"2026-10-03","16:00","PLACILLA","UBC"],
    [2,"2026-10-03","17:30","O'HIGGINS","PARROTS"],
    [2,"2026-10-03","19:00","SANTA CRUZ","PESTAÑAS"],
    [2,"2026-10-03","20:30","LOS CHAMOS","GREEN BEARS"],
    [3,"2026-10-10","13:00","PESTAÑAS","O'HIGGINS"],
    [3,"2026-10-10","14:30","UBC","PATRIOTAS"],
    [3,"2026-10-10","16:00","PARROTS","PLACILLA"],
    [3,"2026-10-10","17:30","OLD'S MAGIC","RANCAGUA CAF"],
    [3,"2026-10-10","19:00","GREEN BEARS","SANTA CRUZ"],
    [3,"2026-10-10","20:30","UNCA","LOS CHAMOS"],
    [4,"2026-10-18","10:00","LOS CHAMOS","SANTA CRUZ"],
    [4,"2026-10-18","11:30","UNCA","RANCAGUA CAF"],
    [4,"2026-10-18","13:00","PLACILLA","PESTAÑAS"],
    [4,"2026-10-18","14:30","PATRIOTAS","PARROTS"],
    [4,"2026-10-18","16:00","OLD'S MAGIC","UBC"],
    [4,"2026-10-18","17:30","O'HIGGINS","GREEN BEARS"],
    [5,"2026-10-24","13:00","OLD'S MAGIC","PARROTS"],
    [5,"2026-10-24","14:30","UBC","UNCA"],
    [5,"2026-10-24","16:00","PESTAÑAS","PATRIOTAS"],
    [5,"2026-10-24","17:30","PLACILLA","GREEN BEARS"],
    [5,"2026-10-24","19:00","O'HIGGINS","SANTA CRUZ"],
    [5,"2026-10-24","20:30","RANCAGUA CAF","LOS CHAMOS"],
    [6,"2026-11-07","13:00","PATRIOTAS","GREEN BEARS"],
    [6,"2026-11-07","14:30","UNCA","PARROTS"],
    [6,"2026-11-07","16:00","RANCAGUA CAF","UBC"],
    [6,"2026-11-07","17:30","OLD'S MAGIC","PESTAÑAS"],
    [6,"2026-11-07","19:00","PLACILLA","SANTA CRUZ"],
    [6,"2026-11-07","20:30","LOS CHAMOS","O'HIGGINS"],
    [7,"2026-11-14","13:00","PARROTS","RANCAGUA CAF"],
    [7,"2026-11-14","14:30","PESTAÑAS","UNCA"],
    [7,"2026-11-14","16:00","OLD'S MAGIC","GREEN BEARS"],
    [7,"2026-11-14","17:30","O'HIGGINS","PLACILLA"],
    [7,"2026-11-14","19:00","UBC","LOS CHAMOS"],
    [7,"2026-11-14","20:30","SANTA CRUZ","PATRIOTAS"],
    [8,"2026-11-21","13:00","UNCA","GREEN BEARS"],
    [8,"2026-11-21","14:30","RANCAGUA CAF","PESTAÑAS"],
    [8,"2026-11-21","16:00","UBC","PARROTS"],
    [8,"2026-11-21","17:30","OLD'S MAGIC","SANTA CRUZ"],
    [8,"2026-11-21","19:00","PATRIOTAS","O'HIGGINS"],
    [8,"2026-11-21","20:30","LOS CHAMOS","PLACILLA"],
    [9,"2026-12-05","13:00","OLD'S MAGIC","O'HIGGINS"],
    [9,"2026-12-05","14:30","SANTA CRUZ","UNCA"],
    [9,"2026-12-05","16:00","GREEN BEARS","RANCAGUA CAF"],
    [9,"2026-12-05","17:30","PESTAÑAS","UBC"],
    [9,"2026-12-05","19:00","PLACILLA","PATRIOTAS"],
    [9,"2026-12-05","20:30","PARROTS","LOS CHAMOS"],
    [10,"2026-12-12","13:00","PARROTS","PESTAÑAS"],
    [10,"2026-12-12","14:30","LOS CHAMOS","PATRIOTAS"],
    [10,"2026-12-12","16:00","OLD'S MAGIC","PLACILLA"],
    [10,"2026-12-12","17:30","UNCA","O'HIGGINS"],
    [10,"2026-12-12","19:00","UBC","GREEN BEARS"],
    [10,"2026-12-12","20:30","SANTA CRUZ","RANCAGUA CAF"],
    [11,"2026-12-19","13:00","PARROTS","GREEN BEARS"],
    [11,"2026-12-19","14:30","PLACILLA","UNCA"],
    [11,"2026-12-19","16:00","O'HIGGINS","RANCAGUA CAF"],
    [11,"2026-12-19","17:30","SANTA CRUZ","UBC"],
    [11,"2026-12-19","19:00","OLD'S MAGIC","PATRIOTAS"],
    [11,"2026-12-19","20:30","PESTAÑAS","LOS CHAMOS"]
  ];
  const ins = db.prepare('INSERT INTO lbo_matches (rnd, mdate, mtime, home, away, sort) VALUES (?,?,?,?,?,?)');
  LBO_SEED.forEach((g, i) => ins.run(g[0], g[1], g[2], g[3], g[4], i));
})();
// Editores existentes sin permisos definidos: darles todo el contenido (no romper lo que ya tenían).
db.prepare("UPDATE users SET perms = ? WHERE role = 'editor' AND (perms = '' OR perms IS NULL)").run(ADMIN_MODULE_KEYS.join(','));

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

// Coach inicial de la pizarra (para no quedar sin acceso). Usa PIZARRA_USER/PIZARRA_PASSWORD.
(function seedCoach() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM coaches').get().c;
  if (n > 0) return;
  const uname = (process.env.PIZARRA_USER || 'greenbears').trim().toLowerCase();
  const pass = process.env.PIZARRA_PASSWORD || 'Green2026';
  const ts = new Date().toISOString();
  const info = db.prepare('INSERT INTO coaches (username, pass_hash, name, active, created_at) VALUES (?,?,?,1,?)')
    .run(uname, bcrypt.hashSync(pass, 10), 'Green Bears', ts);
  // Su primer equipo: Green Bears, enlazado al plantel del sitio y compartido entre coaches.
  db.prepare('INSERT INTO pz_teams (coach_id, name, linked_plantel, shared, payload, sort, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)')
    .run(info.lastInsertRowid, 'Green Bears', 1, 1, '', ts, ts);
})();

// Coach superadmin: puede abrir y revisar los equipos de todos los coaches (solo lectura).
(function seedSuperCoach() {
  const n = db.prepare("SELECT COUNT(*) AS c FROM coaches WHERE role = 'super'").get().c;
  if (n > 0) return;
  const uname = (process.env.PIZARRA_SUPER_USER || 'superadmin').trim().toLowerCase();
  const pass = process.env.PIZARRA_SUPER_PASSWORD || 'Super2026';
  const exists = db.prepare('SELECT id FROM coaches WHERE username = ?').get(uname);
  if (exists) { db.prepare("UPDATE coaches SET role = 'super' WHERE id = ?").run(exists.id); return; }
  db.prepare("INSERT INTO coaches (username, pass_hash, name, role, active, created_at) VALUES (?,?,?, 'super', 1, ?)")
    .run(uname, bcrypt.hashSync(pass, 10), 'Superadmin', new Date().toISOString());
})();

function cleanPerms(perms) {
  const arr = Array.isArray(perms) ? perms : String(perms || '').split(',');
  return arr.map(s => String(s).trim()).filter(s => ADMIN_MODULE_KEYS.indexOf(s) >= 0).join(',');
}
function listUsers() { return db.prepare('SELECT id, username, role, active, perms, created_at FROM users ORDER BY role, username').all(); }
function findUser(username) { return db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase()); }
function createUser(username, password, role, perms) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('Usuario inválido (3-32, letras/números/._-).');
  if (String(password || '').length < 6) throw new Error('La clave debe tener al menos 6 caracteres.');
  const r = role === 'super' ? 'super' : 'editor';
  db.prepare('INSERT INTO users (username, pass_hash, role, active, perms, created_at) VALUES (?,?,?,1,?,?)')
    .run(u, bcrypt.hashSync(String(password), 10), r, r === 'super' ? '' : cleanPerms(perms), new Date().toISOString());
}
function setUserPassword(id, password) {
  if (String(password || '').length < 6) throw new Error('La clave debe tener al menos 6 caracteres.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), id);
}
function setUserActive(id, active) { db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id); }
function setUserPerms(id, perms) { db.prepare("UPDATE users SET perms = ? WHERE id = ? AND role = 'editor'").run(cleanPerms(perms), id); }
function deleteUser(id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); }
function countSupers() { return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='super' AND active=1").get().c; }
function verifyLogin(username, password) {
  const u = findUser(username);
  if (!u) return null;
  try { if (!bcrypt.compareSync(String(password || ''), u.pass_hash)) return null; } catch (e) { return null; }
  return { id: u.id, username: u.username, role: u.role, perms: u.perms || '' };
}

// ---------- Pizarra: coaches y equipos ----------
function listCoaches() {
  return db.prepare(`SELECT c.id, c.username, c.name, c.role, c.active, c.created_at,
    (SELECT COUNT(*) FROM pz_teams t WHERE t.coach_id = c.id) AS teams
    FROM coaches c ORDER BY (c.role='super') DESC, c.username`).all();
}
function createCoach(username, password, name, role) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('Usuario inválido (3-32, letras/números/._-).');
  if (String(password || '').length < 6) throw new Error('La clave debe tener al menos 6 caracteres.');
  const r = role === 'super' ? 'super' : 'coach';
  db.prepare('INSERT INTO coaches (username, pass_hash, name, role, active, created_at) VALUES (?,?,?,?,1,?)')
    .run(u, bcrypt.hashSync(String(password), 10), String(name || '').trim(), r, new Date().toISOString());
}
function setCoachRole(id, role) { db.prepare("UPDATE coaches SET role = ? WHERE id = ?").run(role === 'super' ? 'super' : 'coach', id); }
function setCoachPassword(id, password) {
  if (String(password || '').length < 6) throw new Error('La clave debe tener al menos 6 caracteres.');
  db.prepare('UPDATE coaches SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), id);
}
function setCoachActive(id, active) { db.prepare('UPDATE coaches SET active = ? WHERE id = ?').run(active ? 1 : 0, id); }
function deleteCoach(id) { db.prepare('DELETE FROM coaches WHERE id = ?').run(id); }
function verifyCoach(username, password) {
  const c = db.prepare('SELECT * FROM coaches WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase());
  if (!c) return null;
  try { if (!bcrypt.compareSync(String(password || ''), c.pass_hash)) return null; } catch (e) { return null; }
  return { id: c.id, username: c.username, name: c.name, role: c.role || 'coach' };
}

function teamsForCoach(coachId, isSuper) {
  if (isSuper) {
    // Superadmin: ve TODOS los equipos de todos los coaches (para revisar).
    return db.prepare(`SELECT t.id, t.name, t.linked_plantel, t.shared, t.sort, t.updated_at,
        (t.coach_id = @c) AS owned, c.username AS owner, c.name AS ownerName
      FROM pz_teams t JOIN coaches c ON c.id = t.coach_id
      ORDER BY (t.coach_id = @c) DESC, c.username, t.shared DESC, t.sort, t.name`).all({ c: coachId });
  }
  // Equipos propios + equipos compartidos (Green Bears) de cualquier coach.
  return db.prepare(`SELECT id, name, linked_plantel, shared, sort, updated_at,
      (coach_id = @c) AS owned
    FROM pz_teams WHERE coach_id = @c OR shared = 1
    ORDER BY shared DESC, sort, name`).all({ c: coachId });
}
function createTeam(coachId, name, linkedPlantel) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('El equipo necesita un nombre.');
  const ts = new Date().toISOString();
  const info = db.prepare('INSERT INTO pz_teams (coach_id, name, linked_plantel, payload, sort, created_at, updated_at) VALUES (?,?,?,?,0,?,?)')
    .run(coachId, nm, linkedPlantel ? 1 : 0, '', ts, ts);
  return info.lastInsertRowid;
}
function getTeam(id, coachId, isSuper) {
  // Superadmin puede abrir cualquier equipo; el resto solo propios o compartidos.
  if (isSuper) return db.prepare('SELECT * FROM pz_teams WHERE id = ?').get(id);
  return db.prepare('SELECT * FROM pz_teams WHERE id = ? AND (coach_id = ? OR shared = 1)').get(id, coachId);
}
function renameTeam(id, coachId, name) {
  db.prepare('UPDATE pz_teams SET name = ?, updated_at = ? WHERE id = ? AND coach_id = ?')
    .run(String(name || '').trim() || 'Equipo', new Date().toISOString(), id, coachId);
}
// Cantidad de jugadores dentro de un payload (para detectar borrados accidentales).
function payloadRosterN(payload) {
  try { const p = JSON.parse(payload || '{}') || {}; const r = JSON.parse(p['pizarra.roster'] || '[]'); return Array.isArray(r) ? r.length : 0; }
  catch (e) { return 0; }
}
// Archiva la versión actual del equipo antes de sobrescribirla; conserva las últimas 30.
function archiveTeamVersion(teamId, payload) {
  if (!payload || String(payload).length <= 2) return;   // nada útil que archivar
  const p = String(payload);
  db.prepare('INSERT INTO pz_team_versions (team_id, payload, size, roster_n, created_at) VALUES (?,?,?,?,?)')
    .run(teamId, p, p.length, payloadRosterN(p), new Date().toISOString());
  db.prepare(`DELETE FROM pz_team_versions WHERE team_id = ? AND id NOT IN (
    SELECT id FROM pz_team_versions WHERE team_id = ? ORDER BY id DESC LIMIT 30)`).run(teamId, teamId);
}
// Guarda el payload de un equipo con protecciones contra pérdida/pisado.
// opts.baseUpdatedAt: fecha que tenía el cliente al cargar (control de versión).
// opts.force: permite un guardado que de otro modo se bloquearía (vaciar a propósito).
function saveTeamPayload(id, coachId, payload, opts) {
  opts = opts || {};
  const t = db.prepare('SELECT payload, updated_at FROM pz_teams WHERE id = ? AND coach_id = ?').get(id, coachId);
  if (!t) return { ok: false, reason: 'not-found' };          // no existe o no es el dueño
  const incoming = String(payload == null ? '' : payload);
  // C) Control de versión: si el cliente traía una base y el servidor ya es más nuevo, no pisar.
  if (opts.baseUpdatedAt && t.updated_at && opts.baseUpdatedAt !== t.updated_at) {
    return { ok: false, reason: 'conflict', updated_at: t.updated_at };
  }
  // B) Anti-borrado: no dejar que un payload vacío pise uno con datos (salvo force explícito).
  if (!opts.force && t.payload && t.payload.length > 50 && incoming.length <= 2) {
    return { ok: false, reason: 'would-empty', updated_at: t.updated_at, oldRoster: payloadRosterN(t.payload) };
  }
  // A) Historial: archiva lo actual antes de sobrescribir.
  archiveTeamVersion(id, t.payload);
  const ts = new Date().toISOString();
  db.prepare('UPDATE pz_teams SET payload = ?, updated_at = ? WHERE id = ? AND coach_id = ?').run(incoming, ts, id, coachId);
  return { ok: true, updated_at: ts };
}
function listTeamVersions(id, coachId, isSuper) {
  const t = getTeam(id, coachId, isSuper);
  if (!t) return null;
  return db.prepare('SELECT id, size, roster_n, created_at FROM pz_team_versions WHERE team_id = ? ORDER BY id DESC').all(id);
}
function getTeamVersion(id, coachId, versionId, isSuper) {
  const t = getTeam(id, coachId, isSuper);
  if (!t) return null;
  return db.prepare('SELECT id, payload, size, roster_n, created_at FROM pz_team_versions WHERE id = ? AND team_id = ?').get(versionId, id) || null;
}
// Restaura una versión archivada como payload actual (archivando antes lo vigente).
function restoreTeamVersion(id, coachId, versionId) {
  const t = db.prepare('SELECT payload FROM pz_teams WHERE id = ? AND coach_id = ?').get(id, coachId);
  if (!t) return { ok: false, reason: 'not-found' };
  const v = db.prepare('SELECT payload FROM pz_team_versions WHERE id = ? AND team_id = ?').get(versionId, id);
  if (!v) return { ok: false, reason: 'no-version' };
  archiveTeamVersion(id, t.payload);
  const ts = new Date().toISOString();
  db.prepare('UPDATE pz_teams SET payload = ?, updated_at = ? WHERE id = ? AND coach_id = ?').run(v.payload, ts, id, coachId);
  return { ok: true, updated_at: ts };
}
function deleteTeam(id, coachId) { db.prepare('DELETE FROM pz_teams WHERE id = ? AND coach_id = ?').run(id, coachId); }
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

// ---------- Liga LBO: funciones ----------
const LBO_TEAM = 'GREEN BEARS';
function lboAll() { return db.prepare('SELECT * FROM lbo_matches ORDER BY sort, id').all(); }
function lboGet(id) { return db.prepare('SELECT * FROM lbo_matches WHERE id = ?').get(id); }
function lboSaveResult(id, hp, ap, wo) {
  wo = wo ? Number(wo) : 0;
  if (wo === 1 || wo === 2) { db.prepare('UPDATE lbo_matches SET wo = ?, home_pts = NULL, away_pts = NULL WHERE id = ?').run(wo, id); return; }
  const h = (hp === '' || hp == null) ? null : Math.max(0, parseInt(hp, 10) || 0);
  const a = (ap === '' || ap == null) ? null : Math.max(0, parseInt(ap, 10) || 0);
  db.prepare('UPDATE lbo_matches SET home_pts = ?, away_pts = ?, wo = 0 WHERE id = ?').run(h, a, id);
}
function lboResolve(m) {
  // Devuelve {played, hp, ap} aplicando W.O. (20-0) si corresponde.
  if (m.wo === 1) return { played: true, hp: 20, ap: 0, wo: true };
  if (m.wo === 2) return { played: true, hp: 0, ap: 20, wo: true };
  if (m.home_pts != null && m.away_pts != null) return { played: true, hp: m.home_pts, ap: m.away_pts, wo: false };
  return { played: false };
}
function lboStandings() {
  const ms = lboAll();
  const T = {};
  const team = (n) => (T[n] = T[n] || { team: n, pj: 0, g: 0, p: 0, pf: 0, pc: 0, pts: 0 });
  ms.forEach(m => { team(m.home); team(m.away); });
  const key = (x, y) => [x, y].sort().join(' | ');
  const h2h = {};
  ms.forEach(m => {
    const r = lboResolve(m); if (!r.played) return;
    const H = team(m.home), A = team(m.away);
    H.pj++; A.pj++; H.pf += r.hp; H.pc += r.ap; A.pf += r.ap; A.pc += r.hp;
    if (r.wo) { // W.O.: ganador 2 pts, perdedor 0
      if (r.hp > r.ap) { H.g++; A.p++; H.pts += 2; } else { A.g++; H.p++; A.pts += 2; }
    } else if (r.hp === r.ap) { H.p++; A.p++; H.pts += 1; A.pts += 1; }
    else if (r.hp > r.ap) { H.g++; A.p++; H.pts += 2; A.pts += 1; h2h[key(m.home, m.away)] = m.home; }
    else { A.g++; H.p++; A.pts += 2; H.pts += 1; h2h[key(m.home, m.away)] = m.away; }
  });
  const arr = Object.values(T).map(t => Object.assign(t, { dif: t.pf - t.pc }));
  arr.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.dif !== a.dif) return b.dif - a.dif;
    const w = h2h[key(a.team, b.team)];            // desempate: ganador del partido directo
    if (w === a.team) return -1; if (w === b.team) return 1;
    if (b.pf !== a.pf) return b.pf - a.pf;
    return a.team.localeCompare(b.team);
  });
  arr.forEach((t, i) => { t.pos = i + 1; });
  return arr;
}
function lboShapeGB(m) {
  const gbHome = m.home === LBO_TEAM;
  const opp = gbHome ? m.away : m.home;
  const r = lboResolve(m);
  let our = null, opp_s = null;
  if (r.played) { our = gbHome ? r.hp : r.ap; opp_s = gbHome ? r.ap : r.hp; }
  return {
    id: m.id, opponent: opp, date: (m.mdate || '') + 'T' + (m.mtime || '00:00'),
    location: '', tournament: 'LBO 2026', home: gbHome ? 1 : 0, confirmed: 1,
    our_score: our, opp_score: opp_s, status: r.played ? 'played' : 'upcoming',
    rnd: m.rnd, icsUrl: '/lbo/' + m.id + '.ics'
  };
}
function lboGBGames() { return lboAll().filter(m => m.home === LBO_TEAM || m.away === LBO_TEAM).map(lboShapeGB); }
function lboGBUpcoming(limit) { const a = lboGBGames().filter(x => x.status === 'upcoming'); return limit ? a.slice(0, limit) : a; }
function lboGBLast(limit) { const a = lboGBGames().filter(x => x.status === 'played').reverse(); return limit ? a.slice(0, limit) : a; }

module.exports = {
  db, settings, setSetting, slugify, uniqueSlug, DATA_DIR,
  recordVisit, visitStats, visitsTotal, resetVisits, dayKey,
  listUsers, findUser, createUser, setUserPassword, setUserActive, setUserPerms, deleteUser, countSupers, verifyLogin, ADMIN_MODULE_KEYS,
  listCoaches, createCoach, setCoachPassword, setCoachActive, setCoachRole, deleteCoach, verifyCoach,
  teamsForCoach, createTeam, getTeam, renameTeam, saveTeamPayload, deleteTeam,
  listTeamVersions, getTeamVersion, restoreTeamVersion,
  lboAll, lboGet, lboSaveResult, lboStandings, lboGBUpcoming, lboGBLast, lboShapeGB
};
