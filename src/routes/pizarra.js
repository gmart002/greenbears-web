'use strict';
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, settings, verifyCoach, teamsForCoach, createTeam, getTeam, renameTeam, saveTeamPayload, deleteTeam, listTeamVersions, restoreTeamVersion } = require('../db');

const PIZARRA_DIR = path.join(__dirname, '..', '..', 'pizarra');

// Plantel del sitio para los equipos enlazados (Green Bears).
function sitePlantel() {
  return db.prepare("SELECT name, number FROM players WHERE active = 1 AND staff = 0 ORDER BY sort, CAST(number AS INTEGER), name").all();
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
