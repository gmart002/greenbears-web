'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const { settings, DATA_DIR } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PIZARRA_URL = process.env.PIZARRA_URL || 'https://pizarra.grapmining.com';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Seguridad de cabeceras. CSP: recursos propios + Google Fonts + iframe de la pizarra.
// Hosts de widgets de Instagram permitidos (Behold, LightWidget, SnapWidget, Elfsight, IG nativo).
const IG = ['https://www.instagram.com', 'https://cdn.lightwidget.com', 'https://lightwidget.com',
  'https://snapwidget.com', 'https://widget.behold.so', 'https://behold.so', 'https://w.behold.so',
  'https://apps.elfsight.com', 'https://static.elfsight.com', 'https://core.service.elfsight.com'];
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...IG],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', ...IG],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      frameSrc: ["'self'", PIZARRA_URL, ...IG],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '30d' }));

app.use(cookieSession({
  name: 'gb_sess',
  secret: process.env.SESSION_SECRET || 'cambia-esta-clave',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 1000 * 60 * 60 * 24 * 14
}));

// CSRF simple basado en token de sesión.
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
});
function checkCsrf(req, res, next) {
  const t = req.body && req.body._csrf;
  if (!t || t !== req.session.csrf) return res.status(403).send('Sesión expirada. Vuelve a intentarlo.');
  next();
}

// Variables disponibles en todas las vistas.
app.use((req, res, next) => {
  res.locals.s = settings();
  res.locals.path = req.path;
  res.locals.isAdmin = !!(req.session && req.session.admin);
  res.locals.pizarraUrl = PIZARRA_URL;
  res.locals.year = new Date().getFullYear();
  next();
});

// Rutas
app.use('/pizarra', require('./routes/pizarra')(checkCsrf));
app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin')(checkCsrf));

// 404
app.use((req, res) => res.status(404).render('404'));
// Errores
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500');
});

app.listen(PORT, () => console.log('Green Bears web escuchando en :' + PORT));
