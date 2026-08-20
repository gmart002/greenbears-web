'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const { settings, DATA_DIR, recordVisit, visitsTotal, dayKey } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Seguridad de cabeceras. CSP: recursos propios + Google Fonts + iframe de la pizarra.
// Hosts de widgets de Instagram permitidos (Behold, LightWidget, SnapWidget, Elfsight, IG nativo).
const IG = ['https://www.instagram.com', 'https://cdn.lightwidget.com', 'https://lightwidget.com',
  'https://snapwidget.com', 'https://widget.behold.so', 'https://behold.so', 'https://w.behold.so',
  'https://apps.elfsight.com', 'https://static.elfsight.com', 'https://core.service.elfsight.com'];
// Reproductores de video permitidos para los Highlights (YouTube, Vimeo).
const VID = ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'];
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...IG],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', ...IG],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      frameSrc: ["'self'", ...IG, ...VID],
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

// Contador de visitas por "beacon" de JavaScript: la página, ya cargada en un
// navegador real, avisa a /api/hit. Los bots y las vistas previas de redes
// (WhatsApp/Instagram/Facebook/buscadores) NO ejecutan JavaScript, así que no
// llaman a este endpoint y quedan fuera del conteo. "visita" = 1 por sesión y
// por día; "vista" = cada carga de página.
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|bingpreview|embedly|quora|reddit|twitter|discord|applebot|yandex|baidu|duckduck|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|headless|lighthouse|preview|monitor|uptime|pingdom|python-requests|curl|wget|axios|okhttp|go-http-client|libwww|scrapy|phantom/i;
app.post('/api/hit', (req, res) => {
  const ua = req.get('user-agent') || '';
  if (ua && !BOT_UA.test(ua)) {
    try {
      const today = dayKey();
      const unique = req.session.vday !== today;
      if (unique) req.session.vday = today;
      recordVisit(unique);
    } catch (e) { /* nunca romper por el contador */ }
  }
  res.status(204).end();
});

// Variables disponibles en todas las vistas.
app.use((req, res, next) => {
  res.locals.s = settings();
  res.locals.path = req.path;
  res.locals.isAdmin = !!(req.session && req.session.admin);
  res.locals.role = (req.session && req.session.role) || '';
  res.locals.uname = (req.session && req.session.uname) || '';
  res.locals.uid = (req.session && req.session.uid) || 0;
  res.locals.isSuper = !!(req.session && req.session.role === 'super');
  res.locals.year = new Date().getFullYear();
  res.locals.visitsTotal = visitsTotal();
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
