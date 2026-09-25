'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  verifyAttUser, trainingPlayers, listTrainingSessions, getTrainingSession,
  createTrainingSession, deleteTrainingSession, attendanceMap, saveAttendance, attendanceSummary,
  getTrainingLog, saveTrainingLog
} = require('../db');

// Áreas de la evaluación 1–5 y campos repetidos de la bitácora.
const EVAL_AREAS = [
  ['intensidad', 'Intensidad'], ['concentracion', 'Concentración'], ['ejecucion', 'Ejecución técnica'],
  ['decisiones', 'Toma de decisiones'], ['comunicacion', 'Comunicación'], ['competitividad', 'Competitividad']
];

// Arma el objeto estructurado de la bitácora desde los campos planos del formulario.
function parseBitacora(b) {
  const s = k => String(b[k] == null ? '' : b[k]).trim();
  const objetivos = [1, 2, 3].map(i => ({
    especifico: s('obj_' + i + '_especifico'),
    trabajo: b['obj_' + i + '_trabajo'] ? 1 : 0,
    logro: b['obj_' + i + '_logro'] ? 1 : 0,
    obs: s('obj_' + i + '_obs')
  }));
  const evaluacion = {};
  EVAL_AREAS.forEach(a => { evaluacion[a[0]] = { n: Number(b['ev_' + a[0] + '_n']) || 0, obs: s('ev_' + a[0] + '_obs') }; });
  const proxima = [1, 2, 3].map(i => ({
    prioridad: s('prox_' + i + '_prioridad'), como: s('prox_' + i + '_como'), indicador: s('prox_' + i + '_indicador')
  }));
  return {
    categoria: s('categoria'), duracion: s('duracion'), entrenador: s('entrenador'),
    n_jugadores: s('n_jugadores'), tipo_sesion: s('tipo_sesion'),
    objetivo_general: s('objetivo_general'), concepto_dia: s('concepto_dia'),
    objetivos, evaluacion,
    analisis: {
      funciono: s('an_funciono'), no_funciono: s('an_no_funciono'),
      repetir: s('an_repetir'), corregir: s('an_corregir'),
      destacaron: s('an_destacaron'), atencion: s('an_atencion')
    },
    cma: { corregir: s('cma_corregir'), mantener: s('cma_mantener'), agregar: s('cma_agregar') },
    ideas: { idea: s('idea_nueva'), situacion: s('idea_situacion'), notas: s('idea_notas') },
    proxima
  };
}

// Valores por defecto del entrenamiento.
const TRAIN_PLACE = 'Ex Supermercado 45', TRAIN_START = '21:00', TRAIN_END = '22:00';

// Próximo viernes (o hoy si es viernes) en AAAA-MM-DD, hora de Chile.
function nextFridayISO() {
  const cl = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  cl.setDate(cl.getDate() + ((5 - cl.getDay() + 7) % 7));
  const p = n => String(n).padStart(2, '0');
  return cl.getFullYear() + '-' + p(cl.getMonth() + 1) + '-' + p(cl.getDate());
}

module.exports = function (checkCsrf) {
  const router = express.Router();
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

  // ---- Login propio (independiente del admin) ----
  router.get('/login', (req, res) => {
    if (req.session && req.session.att) return res.redirect('/asistencia');
    res.render('asistencia-login', { error: null });
  });
  router.post('/login', loginLimiter, checkCsrf, (req, res) => {
    const u = verifyAttUser(req.body.user || '', req.body.password || '');
    if (u) { req.session.att = { id: u.id, username: u.username, name: u.name }; return res.redirect('/asistencia'); }
    res.status(401).render('asistencia-login', { error: 'Usuario o clave incorrectos.' });
  });
  router.post('/logout', checkCsrf, (req, res) => { if (req.session) req.session.att = null; res.redirect('/asistencia/login'); });
  router.get('/logout', (req, res) => { if (req.session) req.session.att = null; res.redirect('/asistencia/login'); });

  // Puerta: exige sesión de asistencia (no la del admin).
  function gate(req, res, next) {
    if (req.session && req.session.att) return next();
    return res.redirect('/asistencia/login');
  }

  // Lista de entrenamientos + resumen + crear.
  router.get('/', gate, (req, res) => {
    res.render('asistencia-portal', {
      sessions: listTrainingSessions(), summary: attendanceSummary(),
      hoy: nextFridayISO(), def: { place: TRAIN_PLACE, start: TRAIN_START, end: TRAIN_END },
      att: req.session.att
    });
  });
  router.post('/', gate, checkCsrf, (req, res) => {
    try {
      const id = createTrainingSession({
        date: req.body.date, place: req.body.place || TRAIN_PLACE,
        start: req.body.start || TRAIN_START, end: req.body.end || TRAIN_END, notes: req.body.notes || ''
      });
      res.redirect('/asistencia/' + id);
    } catch (e) { res.status(400).send(e.message + ' — <a href="/asistencia">volver</a>'); }
  });

  // Descargar resumen CSV (antes de la ruta numérica para no chocar).
  router.get('/resumen.csv', gate, (req, res) => {
    const { totalSessions, rows } = attendanceSummary();
    const esc = v => { v = String(v == null ? '' : v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    let csv = ['Nº', 'Jugador', 'Presente', 'Justificado', 'Ausente', 'Entrenamientos', '% Asistencia'].join(';') + '\n';
    rows.forEach(r => { csv += [r.player.number, r.player.name, r.present, r.justified, r.absent, totalSessions, r.pct + '%'].map(esc).join(';') + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="asistencia-resumen.csv"');
    res.send('﻿' + csv);
  });

  // Hoja de asistencia de un entrenamiento.
  router.get('/:id(\\d+)', gate, (req, res, next) => {
    const session = getTrainingSession(Number(req.params.id));
    if (!session) return next();
    res.render('asistencia-hoja-pub', { session, players: trainingPlayers(), marks: attendanceMap(session.id), att: req.session.att });
  });
  router.post('/:id(\\d+)', gate, checkCsrf, (req, res) => {
    const session = getTrainingSession(Number(req.params.id));
    if (!session) return res.status(404).send('Entrenamiento no encontrado.');
    const entries = trainingPlayers().map(p => ({ player_id: p.id, status: req.body['st_' + p.id] || 'absent' }));
    saveAttendance(session.id, entries);
    res.redirect('/asistencia/' + session.id + '?ok=1');
  });
  router.post('/:id(\\d+)/eliminar', gate, checkCsrf, (req, res) => {
    deleteTrainingSession(Number(req.params.id));
    res.redirect('/asistencia');
  });

  // ---- Bitácora del entrenamiento (una por sesión; se puede armar antes de la asistencia) ----
  router.get('/:id(\\d+)/bitacora', gate, (req, res, next) => {
    const session = getTrainingSession(Number(req.params.id));
    if (!session) return next();
    const log = getTrainingLog(session.id);
    res.render('bitacora-form', { session, data: (log && log.data) || {}, areas: EVAL_AREAS, att: req.session.att });
  });
  router.post('/:id(\\d+)/bitacora', gate, checkCsrf, (req, res) => {
    const session = getTrainingSession(Number(req.params.id));
    if (!session) return res.status(404).send('Entrenamiento no encontrado.');
    saveTrainingLog(session.id, parseBitacora(req.body), (req.session.att && req.session.att.name) || (req.session.att && req.session.att.username) || '');
    res.redirect('/asistencia/' + session.id + '/bitacora?ok=1');
  });
  // Vista imprimible / PDF (formato del Word).
  router.get('/:id(\\d+)/bitacora/print', gate, (req, res, next) => {
    const session = getTrainingSession(Number(req.params.id));
    if (!session) return next();
    const log = getTrainingLog(session.id);
    res.render('bitacora-print', { session, data: (log && log.data) || {}, areas: EVAL_AREAS, log });
  });

  return router;
};
