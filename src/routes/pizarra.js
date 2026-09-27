'use strict';
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, settings, verifyCoach, teamsForCoach, createTeam, getTeam, renameTeam, saveTeamPayload, deleteTeam, listTeamVersions, restoreTeamVersion,
  listTeamTrainings, getTraining, createTeamTraining, deleteTraining, trAttendanceMap, saveTrAttendance, teamAttendanceSummary, getTrLog, saveTrLog } = require('../db');

const PIZARRA_DIR = path.join(__dirname, '..', '..', 'pizarra');

// Áreas de la evaluación 1–5 de la bitácora (comparten forma con el Word).
const EVAL_AREAS = [
  ['intensidad', 'Intensidad'], ['concentracion', 'Concentración'], ['ejecucion', 'Ejecución técnica'],
  ['decisiones', 'Toma de decisiones'], ['comunicacion', 'Comunicación'], ['competitividad', 'Competitividad']
];
// Próximo viernes (o hoy si es viernes) en AAAA-MM-DD, hora de Chile.
function nextFridayISO() {
  const cl = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  cl.setDate(cl.getDate() + ((5 - cl.getDay() + 7) % 7));
  const p = n => String(n).padStart(2, '0');
  return cl.getFullYear() + '-' + p(cl.getMonth() + 1) + '-' + p(cl.getDate());
}
// Arma el objeto de la bitácora desde los campos planos del formulario.
function parseBitacora(b) {
  const s = k => String(b[k] == null ? '' : b[k]).trim();
  const objetivos = [1, 2, 3].map(i => ({
    especifico: s('obj_' + i + '_especifico'), trabajo: b['obj_' + i + '_trabajo'] ? 1 : 0,
    logro: b['obj_' + i + '_logro'] ? 1 : 0, obs: s('obj_' + i + '_obs')
  }));
  const evaluacion = {};
  EVAL_AREAS.forEach(a => { evaluacion[a[0]] = { n: Number(b['ev_' + a[0] + '_n']) || 0, obs: s('ev_' + a[0] + '_obs') }; });
  const proxima = [1, 2, 3].map(i => ({ prioridad: s('prox_' + i + '_prioridad'), como: s('prox_' + i + '_como'), indicador: s('prox_' + i + '_indicador') }));
  return {
    categoria: s('categoria'), duracion: s('duracion'), entrenador: s('entrenador'), n_jugadores: s('n_jugadores'), tipo_sesion: s('tipo_sesion'),
    objetivo_general: s('objetivo_general'), concepto_dia: s('concepto_dia'), objetivos, evaluacion,
    analisis: { funciono: s('an_funciono'), no_funciono: s('an_no_funciono'), repetir: s('an_repetir'), corregir: s('an_corregir'), destacaron: s('an_destacaron'), atencion: s('an_atencion') },
    cma: { corregir: s('cma_corregir'), mantener: s('cma_mantener'), agregar: s('cma_agregar') },
    ideas: { idea: s('idea_nueva'), situacion: s('idea_situacion'), notas: s('idea_notas') }, proxima
  };
}
// Roster del equipo para asistencia/bitácora: Green Bears usa el plantel del sitio;
// los demás usan el roster guardado en su payload (los jugadores que arma el coach).
function teamRoster(team) {
  if (team.linked_plantel) return sitePlantel().map(p => ({ id: 'gb' + p.id, name: p.name, num: p.number || '' }));
  try {
    const pl = JSON.parse(team.payload || '{}') || {};
    const r = JSON.parse(pl['pizarra.roster'] || '[]');
    if (Array.isArray(r)) return r.map(x => ({ id: String(x.id), name: x.name || '', num: x.num || '' }));
  } catch (e) {}
  return [];
}
const TR_PLACE = 'Ex Supermercado 45', TR_START = '21:00', TR_END = '22:00';

// Plantel del sitio para los equipos enlazados (Green Bears).
function sitePlantel() {
  return db.prepare("SELECT id, name, number FROM players WHERE active = 1 AND staff = 0 ORDER BY sort, CAST(number AS INTEGER), name").all();
}

module.exports = function (checkCsrf) {
  const router = express.Router();

  // CSP propia para la pizarra (app autocontenida con scripts/estilos inline).
  router.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; " +
      "connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'self'");
    next();
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

  router.get('/login', (req, res) => {
    if (req.session.coach && req.session.coach.id) return res.redirect('/pizarra');
    res.render('pizarra-login', { error: null });
  });
  router.post('/login', loginLimiter, checkCsrf, (req, res) => {
    const c = verifyCoach(req.body.user || '', req.body.password || '');
    if (c) {
      req.session.coach = { id: c.id, username: c.username, name: c.name, role: c.role || 'coach' };
      return res.redirect('/pizarra');
    }
    res.status(401).render('pizarra-login', { error: 'Usuario o clave incorrectos.' });
  });
  router.post('/logout', checkCsrf, (req, res) => { if (req.session) req.session.coach = null; res.redirect('/pizarra/login'); });
  router.get('/logout', (req, res) => { if (req.session) req.session.coach = null; res.redirect('/pizarra/login'); });

  // Puerta: la app (index) exige sesión de coach.
  function gate(req, res, next) {
    if (req.session && req.session.coach && req.session.coach.id) return next();
    return res.redirect('/pizarra/login');
  }
  const sendApp = (req, res) => res.sendFile(path.join(PIZARRA_DIR, 'index.html'));
  router.get('/', gate, sendApp);
  router.get('/index.html', gate, sendApp);

  // ---------------- Entrenos: asistencia + bitácora POR EQUIPO (páginas) ----------------
  // Carga el equipo y valida acceso del coach (dueño o compartido/super).
  function loadTeam(req, res, next) {
    const c = req.session.coach;
    const team = getTeam(Number(req.params.tid), c.id, c.role === 'super');
    if (!team) return res.status(404).send('Equipo no encontrado o sin acceso. <a href="/pizarra">Volver</a>');
    req.team = team;
    req.canEdit = (team.coach_id === c.id);   // solo el dueño edita (Green Bears = cuenta greenbears)
    next();
  }
  function loadSess(req, res, next) {
    const s = getTraining(Number(req.params.sid));
    if (!s || s.team_id !== req.team.id) return res.status(404).send('Entrenamiento no encontrado. <a href="/pizarra/t/' + req.team.id + '/entrenos">Volver</a>');
    req.sess = s; next();
  }
  function requireEdit(req, res, next) {
    if (!req.canEdit) return res.status(403).send('Este equipo es de otra cuenta; solo su dueño puede editar. <a href="/pizarra/t/' + req.team.id + '/entrenos">Volver</a>');
    next();
  }

  router.get('/t/:tid/entrenos', gate, loadTeam, (req, res) => {
    res.render('entrenos-list', {
      team: req.team, canEdit: req.canEdit, coach: req.session.coach,
      sessions: listTeamTrainings(req.team.id), summary: teamAttendanceSummary(req.team.id, teamRoster(req.team)),
      hoy: nextFridayISO(), def: { place: req.team.linked_plantel ? TR_PLACE : '', start: TR_START, end: TR_END }
    });
  });
  router.post('/t/:tid/entrenos', gate, loadTeam, requireEdit, checkCsrf, (req, res) => {
    try {
      const id = createTeamTraining(req.team.id, { date: req.body.date, place: req.body.place, start: req.body.start, end: req.body.end, notes: req.body.notes });
      res.redirect('/pizarra/t/' + req.team.id + '/entrenos/' + id + '/asistencia');
    } catch (e) { res.status(400).send(e.message + ' — <a href="/pizarra/t/' + req.team.id + '/entrenos">volver</a>'); }
  });
  router.post('/t/:tid/entrenos/:sid/eliminar', gate, loadTeam, loadSess, requireEdit, checkCsrf, (req, res) => {
    deleteTraining(req.sess.id); res.redirect('/pizarra/t/' + req.team.id + '/entrenos');
  });

  router.get('/t/:tid/entrenos/:sid/asistencia', gate, loadTeam, loadSess, (req, res) => {
    res.render('entrenos-asistencia', { team: req.team, canEdit: req.canEdit, coach: req.session.coach, session: req.sess, players: teamRoster(req.team), marks: trAttendanceMap(req.sess.id) });
  });
  router.post('/t/:tid/entrenos/:sid/asistencia', gate, loadTeam, loadSess, requireEdit, checkCsrf, (req, res) => {
    const entries = teamRoster(req.team).map(p => ({ player_id: p.id, status: req.body['st_' + p.id] || 'absent' }));
    saveTrAttendance(req.sess.id, entries);
    res.redirect('/pizarra/t/' + req.team.id + '/entrenos/' + req.sess.id + '/asistencia?ok=1');
  });

  router.get('/t/:tid/entrenos/:sid/bitacora', gate, loadTeam, loadSess, (req, res) => {
    const log = getTrLog(req.sess.id);
    res.render('entrenos-bitacora', { team: req.team, canEdit: req.canEdit, coach: req.session.coach, session: req.sess, data: (log && log.data) || {}, areas: EVAL_AREAS });
  });
  router.post('/t/:tid/entrenos/:sid/bitacora', gate, loadTeam, loadSess, requireEdit, checkCsrf, (req, res) => {
    saveTrLog(req.sess.id, parseBitacora(req.body), req.session.coach.name || req.session.coach.username);
    res.redirect('/pizarra/t/' + req.team.id + '/entrenos/' + req.sess.id + '/bitacora?ok=1');
  });
  router.get('/t/:tid/entrenos/:sid/bitacora/print', gate, loadTeam, loadSess, (req, res) => {
    const log = getTrLog(req.sess.id);
    res.render('entrenos-bitacora-print', { team: req.team, session: req.sess, data: (log && log.data) || {}, areas: EVAL_AREAS, log });
  });

  // ---------------- API de equipos (JSON, protegida por sesión de coach) ----------------
  const api = express.Router();
  api.use(express.json({ limit: '25mb' }));
  // Solo coach con sesión; defensa CSRF ligera para JSON: exige cabecera propia
  // (un formulario de otro sitio no puede enviar cabeceras personalizadas).
  api.use((req, res, next) => {
    if (!(req.session && req.session.coach && req.session.coach.id)) return res.status(401).json({ error: 'no-auth' });
    if (req.method !== 'GET' && req.get('x-pizarra') !== '1') return res.status(403).json({ error: 'bad-origin' });
    req.coachId = req.session.coach.id;
    req.isSuper = req.session.coach.role === 'super';
    next();
  });

  api.get('/me', (req, res) => res.json({ coach: { username: req.session.coach.username, name: req.session.coach.name, role: req.session.coach.role || 'coach' } }));

  api.get('/teams', (req, res) => res.json({ teams: teamsForCoach(req.coachId, req.isSuper), super: req.isSuper ? 1 : 0 }));

  api.post('/teams', (req, res) => {
    try {
      const id = createTeam(req.coachId, req.body.name, req.body.linked);
      res.json({ id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  api.get('/teams/:id', (req, res) => {
    const t = getTeam(Number(req.params.id), req.coachId, req.isSuper);
    if (!t) return res.status(404).json({ error: 'not-found' });
    const owned = t.coach_id === req.coachId;
    const out = { team: { id: t.id, name: t.name, linked_plantel: t.linked_plantel, shared: t.shared, owned: owned ? 1 : 0, review: (req.isSuper && !owned) ? 1 : 0, updated_at: t.updated_at }, payload: t.payload || '' };
    if (t.linked_plantel) {
      out.plantel = sitePlantel();
      try { const lg = settings().logo_image; if (lg) out.clubLogo = lg; } catch (e) {}
    }
    res.json(out);
  });

  api.put('/teams/:id', (req, res) => {
    const id = Number(req.params.id);
    const t = getTeam(id, req.coachId);
    if (!t) return res.status(404).json({ error: 'not-found' });
    if (t.coach_id !== req.coachId) return res.status(403).json({ error: 'readonly' }); // compartido: solo el dueño edita
    if (typeof req.body.name === 'string' && req.body.name.trim()) renameTeam(id, req.coachId, req.body.name);
    if (typeof req.body.payload === 'string') {
      const r = saveTeamPayload(id, req.coachId, req.body.payload, { baseUpdatedAt: req.body.baseUpdatedAt, force: !!req.body.force });
      if (!r.ok) {
        // conflict: otro dispositivo ya guardó algo más nuevo. would-empty: intentó vaciar un equipo con datos.
        if (r.reason === 'conflict' || r.reason === 'would-empty') {
          return res.status(409).json({ error: r.reason, updated_at: r.updated_at, oldRoster: r.oldRoster });
        }
        return res.status(400).json({ error: r.reason || 'bad-request' });
      }
      return res.json({ ok: true, updated_at: r.updated_at });
    }
    const t2 = getTeam(id, req.coachId);
    res.json({ ok: true, updated_at: t2.updated_at });
  });

  // Historial de versiones del equipo (para recuperar de un borrado/pisado).
  api.get('/teams/:id/versions', (req, res) => {
    const v = listTeamVersions(Number(req.params.id), req.coachId, req.isSuper);
    if (!v) return res.status(404).json({ error: 'not-found' });
    res.json({ versions: v });
  });
  api.post('/teams/:id/restore', (req, res) => {
    const id = Number(req.params.id);
    const t = getTeam(id, req.coachId);
    if (!t) return res.status(404).json({ error: 'not-found' });
    if (t.coach_id !== req.coachId) return res.status(403).json({ error: 'readonly' });
    const r = restoreTeamVersion(id, req.coachId, Number(req.body.versionId));
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json({ ok: true, updated_at: r.updated_at });
  });

  api.delete('/teams/:id', (req, res) => {
    deleteTeam(Number(req.params.id), req.coachId);
    res.json({ ok: true });
  });

  // Errores del API en JSON (p. ej. payload demasiado grande → 413).
  api.use((err, req, res, next) => {
    const code = err.status || err.statusCode || 400;
    res.status(code).json({ error: code === 413 ? 'too-large' : 'bad-request' });
  });

  router.use('/api', api);

  // Recursos de la app (sw.js, manifest, íconos): públicos, no sensibles.
  router.use(express.static(PIZARRA_DIR, { index: false, maxAge: '7d' }));

  return router;
};
