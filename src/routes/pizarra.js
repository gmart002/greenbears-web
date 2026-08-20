'use strict';
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, verifyCoach, teamsForCoach, createTeam, getTeam, renameTeam, saveTeamPayload, deleteTeam } = require('../db');

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
      req.session.coach = { id: c.id, username: c.username, name: c.name };
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
  api.use(express.json({ limit: '6mb' }));
  // Solo coach con sesión; defensa CSRF ligera para JSON: exige cabecera propia
  // (un formulario de otro sitio no puede enviar cabeceras personalizadas).
  api.use((req, res, next) => {
    if (!(req.session && req.session.coach && req.session.coach.id)) return res.status(401).json({ error: 'no-auth' });
    if (req.method !== 'GET' && req.get('x-pizarra') !== '1') return res.status(403).json({ error: 'bad-origin' });
    req.coachId = req.session.coach.id;
    next();
  });

  api.get('/me', (req, res) => res.json({ coach: { username: req.session.coach.username, name: req.session.coach.name } }));

  api.get('/teams', (req, res) => res.json({ teams: teamsForCoach(req.coachId) }));

  api.post('/teams', (req, res) => {
    try {
      const id = createTeam(req.coachId, req.body.name, req.body.linked);
      res.json({ id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  api.get('/teams/:id', (req, res) => {
    const t = getTeam(Number(req.params.id), req.coachId);
    if (!t) return res.status(404).json({ error: 'not-found' });
    const out = { team: { id: t.id, name: t.name, linked_plantel: t.linked_plantel, updated_at: t.updated_at }, payload: t.payload || '' };
    if (t.linked_plantel) out.plantel = sitePlantel();
    res.json(out);
  });

  api.put('/teams/:id', (req, res) => {
    const id = Number(req.params.id);
    const t = getTeam(id, req.coachId);
    if (!t) return res.status(404).json({ error: 'not-found' });
    if (typeof req.body.name === 'string' && req.body.name.trim()) renameTeam(id, req.coachId, req.body.name);
    if (typeof req.body.payload === 'string') saveTeamPayload(id, req.coachId, req.body.payload);
    const t2 = getTeam(id, req.coachId);
    res.json({ ok: true, updated_at: t2.updated_at });
  });

  api.delete('/teams/:id', (req, res) => {
    deleteTeam(Number(req.params.id), req.coachId);
    res.json({ ok: true });
  });

  router.use('/api', api);

  // Recursos de la app (sw.js, manifest, íconos): públicos, no sensibles.
  router.use(express.static(PIZARRA_DIR, { index: false, maxAge: '7d' }));

  return router;
};
