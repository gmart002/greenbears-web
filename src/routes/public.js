'use strict';
const express = require('express');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { db } = require('../db');

const router = express.Router();

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
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('es-CL', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

router.use((req, res, next) => { res.locals.fmtDate = fmtDate; res.locals.fmtDateTime = fmtDateTime; next(); });

router.get('/', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC LIMIT 3').all();
  const players = db.prepare('SELECT * FROM players WHERE active = 1 ORDER BY sort, CAST(number AS INTEGER), name LIMIT 8').all();
  const nextMatch = db.prepare("SELECT * FROM matches WHERE status = 'upcoming' ORDER BY date ASC LIMIT 1").get();
  const lastResults = db.prepare("SELECT * FROM matches WHERE status = 'played' ORDER BY date DESC LIMIT 3").all();
  res.render('home', { posts, players, nextMatch, lastResults });
});

router.get('/noticias', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC').all();
  res.render('noticias', { posts });
});
router.get('/noticias/:slug', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!post) return next();
  res.render('noticia', { post, bodyHtml: renderBody(post.body) });
});

router.get('/jugadores', (req, res) => {
  const players = db.prepare('SELECT * FROM players WHERE active = 1 ORDER BY sort, CAST(number AS INTEGER), name').all();
  res.render('jugadores', { players });
});
router.get('/jugadores/:id', (req, res, next) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return next();
  res.render('jugador', { player, bioHtml: renderBody(player.bio) });
});

router.get('/calendario', (req, res) => {
  const upcoming = db.prepare("SELECT * FROM matches WHERE status = 'upcoming' ORDER BY date ASC").all();
  const played = db.prepare("SELECT * FROM matches WHERE status = 'played' ORDER BY date DESC").all();
  res.render('calendario', { upcoming, played });
});

router.get('/pizarra', (req, res) => res.render('pizarra'));

router.get('/nosotros', (req, res) => res.render('nosotros'));

module.exports = router;
