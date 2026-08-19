'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const PIZARRA_DIR = path.join(__dirname, '..', '..', 'pizarra');

function coachOk(user, pass) {
  const U = process.env.PIZARRA_USER || 'greenbears';
  const P = process.env.PIZARRA_PASSWORD || '';
  if (!P) return false;
  if (String(user) !== U) return false;
  const a = Buffer.from(String(pass)), b = Buffer.from(P);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });

  router.get('/login', (req, res) => {
    if (req.session.coach) return res.redirect('/pizarra');
    res.render('pizarra-login', { error: null });
  });
  router.post('/login', loginLimiter, checkCsrf, (req, res) => {
    if (coachOk(req.body.user || '', req.body.password || '')) {
      req.session.coach = true;
      return res.redirect('/pizarra');
    }
    res.status(401).render('pizarra-login', { error: 'Usuario o clave incorrectos.' });
  });
  router.post('/logout', checkCsrf, (req, res) => { if (req.session) req.session.coach = false; res.redirect('/pizarra/login'); });

  // Puerta: la app (index) exige sesión de cuerpo técnico.
  function gate(req, res, next) {
    if (req.session && req.session.coach) return next();
    return res.redirect('/pizarra/login');
  }
  const sendApp = (req, res) => res.sendFile(path.join(PIZARRA_DIR, 'index.html'));
  router.get('/', gate, sendApp);
  router.get('/index.html', gate, sendApp);

  // Recursos de la app (sw.js, manifest, íconos): públicos, no sensibles.
  router.use(express.static(PIZARRA_DIR, { index: false, maxAge: '7d' }));

  return router;
};
