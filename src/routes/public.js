'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { db, settings } = require('../db');

const router = express.Router();
const now = () => new Date().toISOString();
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

function renderBody(md) {
  const html = marked.parse(md || '', { breaks: true });
  return sanitizeHtml(html, {
    allowedTags: ['h2', 'h3', 'h4', 'p', 'a', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em',
      'br', 'hr', 'img', 'figure', 'figcaption', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt'] },
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) }
  });
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return iso;
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return iso;
  return d.toLocaleString('es-CL', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
router.use((req, res, next) => { res.locals.fmtDate = fmtDate; res.locals.fmtDateTime = fmtDateTime; next(); });

// ---------- Inicio ----------
router.get('/', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC LIMIT 3').all();
  const players = db.prepare('SELECT * FROM players WHERE active = 1 AND staff = 0 ORDER BY sort, CAST(number AS INTEGER), name LIMIT 8').all();
  const nextMatch = db.prepare("SELECT * FROM matches WHERE status = 'upcoming' ORDER BY date ASC LIMIT 1").get();
  const lastResults = db.prepare("SELECT * FROM matches WHERE status = 'played' ORDER BY date DESC LIMIT 3").all();
  res.render('home', { posts, players, nextMatch, lastResults });
});

// ---------- Actualidad (noticias) ----------
router.get('/noticias', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC').all();
  res.render('noticias', { posts });
});
router.get('/noticias/:slug', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!post) return next();
  res.render('noticia', { post, bodyHtml: renderBody(post.body) });
});

// ---------- Plantel (jugadores + cuerpo técnico) ----------
router.get('/jugadores', (req, res) => {
  const players = db.prepare('SELECT * FROM players WHERE active = 1 AND staff = 0 ORDER BY sort, CAST(number AS INTEGER), name').all();
  const staff = db.prepare('SELECT * FROM players WHERE active = 1 AND staff = 1 ORDER BY sort, name').all();
  res.render('jugadores', { players, staff });
});
router.get('/jugadores/:id', (req, res, next) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return next();
  res.render('jugador', { player, bioHtml: renderBody(player.bio) });
});

// ---------- Partidos (calendario) ----------
router.get('/calendario', (req, res) => {
  const upcoming = db.prepare("SELECT * FROM matches WHERE status = 'upcoming' ORDER BY date ASC").all();
  const played = db.prepare("SELECT * FROM matches WHERE status = 'played' ORDER BY date DESC").all();
  res.render('calendario', { upcoming, played });
});
// Añadir un partido al calendario (.ics)
router.get('/calendario/:id.ics', (req, res, next) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return next();
  const s = settings();
  const dt = String(m.date).replace(/[-:]/g, '').slice(0, 15).padEnd(15, '0'); // YYYYMMDDTHHmmss
  const start = dt.slice(0, 8) + 'T' + dt.slice(9, 15);
  const d = new Date(m.date); const endD = new Date(d.getTime() + 2 * 3600 * 1000);
  const p2 = n => String(n).padStart(2, '0');
  const end = `${endD.getFullYear()}${p2(endD.getMonth() + 1)}${p2(endD.getDate())}T${p2(endD.getHours())}${p2(endD.getMinutes())}00`;
  const esc = t => String(t || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const title = `${s.site_title} vs ${m.opponent}` + (m.tournament ? ` · ${m.tournament}` : '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Green Bears//ES', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:match-${m.id}@greenbears.cl`, `DTSTART:${start}`, `DTEND:${end}`,
    `SUMMARY:${esc(title)}`, `LOCATION:${esc(m.location)}`,
    `DESCRIPTION:${esc((m.home ? 'Local' : 'Visita') + (m.notes ? ' · ' + m.notes : ''))}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="partido-${m.id}.ics"`);
  res.send(ics);
});

// ---------- El club ----------
router.get('/el-club', (req, res) => {
  const s = settings();
  res.render('el-club', {
    historyHtml: renderBody(s.club_history),
    valuesHtml: renderBody(s.club_values),
    achievementsHtml: renderBody(s.club_achievements),
    tournamentsHtml: renderBody(s.club_tournaments)
  });
});

// ---------- Galería ----------
router.get('/galeria', (req, res) => {
  const items = db.prepare('SELECT * FROM gallery ORDER BY season DESC, sort, id DESC').all();
  const seasons = [...new Set(items.map(i => i.season).filter(Boolean))];
  res.render('galeria', { items, seasons });
});

// ---------- Únete / Contacto ----------
router.get('/contacto', (req, res) => {
  const sponsors = db.prepare('SELECT * FROM sponsors ORDER BY sort, name').all();
  res.render('contacto', { sponsors, ok: req.query.ok === '1', error: null, form: {} });
});
router.post('/contacto', contactLimiter, (req, res) => {
  const b = req.body || {};
  // CSRF
  if (!b._csrf || b._csrf !== req.session.csrf) return res.status(403).send('Sesión expirada. Vuelve a intentarlo.');
  // Honeypot anti-bots (campo oculto "website")
  if (b.website) return res.redirect('/contacto?ok=1');
  const name = String(b.name || '').trim().slice(0, 80);
  const body = String(b.body || '').trim().slice(0, 2000);
  if (!name || !body) {
    const sponsors = db.prepare('SELECT * FROM sponsors ORDER BY sort, name').all();
    return res.status(400).render('contacto', { sponsors, ok: false, error: 'Completa tu nombre y el mensaje.', form: b });
  }
  db.prepare('INSERT INTO messages (name, contact, reason, body, created_at) VALUES (?,?,?,?,?)')
    .run(name, String(b.contact || '').slice(0, 120), String(b.reason || '').slice(0, 40), body, now());
  res.redirect('/contacto?ok=1');
});

module.exports = router;
