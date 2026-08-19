'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, setSetting, uniqueSlug, DATA_DIR } = require('../db');

const now = () => new Date().toISOString();

// ---- Subida de imágenes ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(DATA_DIR, 'uploads')),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif|avif)$/.test(file.mimetype))
});
const uploadedUrl = (file) => file ? '/uploads/' + file.filename : '';

// ---- Autenticación ----
function passwordOk(input) {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (hash) { try { return bcrypt.compareSync(input, hash); } catch (e) { return false; } }
  const plain = process.env.ADMIN_PASSWORD || 'greenbears';
  const a = Buffer.from(String(input)); const b = Buffer.from(String(plain));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin/login');
}

module.exports = function (checkCsrf) {
  const router = express.Router();
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: 'Demasiados intentos. Espera unos minutos.' });

  router.get('/', (req, res) => res.redirect(req.session.admin ? '/admin/panel' : '/admin/login'));

  router.get('/login', (req, res) => {
    if (req.session.admin) return res.redirect('/admin/panel');
    res.render('admin/login', { error: null });
  });
  router.post('/login', loginLimiter, checkCsrf, (req, res) => {
    if (passwordOk(req.body.password || '')) {
      req.session.admin = true;
      return res.redirect('/admin/panel');
    }
    res.status(401).render('admin/login', { error: 'Clave incorrecta.' });
  });
  router.post('/logout', checkCsrf, (req, res) => { req.session = null; res.redirect('/admin/login'); });

  router.use(requireAdmin);

  // ---- Panel ----
  router.get('/panel', (req, res) => {
    const posts = db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all();
    const players = db.prepare('SELECT * FROM players ORDER BY sort, name').all();
    const matches = db.prepare('SELECT * FROM matches ORDER BY date DESC').all();
    res.render('admin/panel', { posts, players, matches });
  });

  // ---- Noticias ----
  router.get('/noticias/nueva', (req, res) => res.render('admin/noticia-form', { post: null }));
  router.get('/noticias/:id/editar', (req, res, next) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return next();
    res.render('admin/noticia-form', { post });
  });
  router.post('/noticias/:id?', upload.single('image'), checkCsrf, (req, res) => {
    const { title = '', excerpt = '', body = '' } = req.body;
    const published = req.body.published ? 1 : 0;
    const cover = uploadedUrl(req.file) || req.body.cover || '';
    const id = req.params.id ? Number(req.params.id) : 0;
    if (!title.trim()) return res.status(400).send('Falta el título');
    if (id) {
      const slug = uniqueSlug(title, id);
      db.prepare('UPDATE posts SET title=?, slug=?, excerpt=?, body=?, cover=?, published=?, updated_at=? WHERE id=?')
        .run(title.trim(), slug, excerpt, body, cover, published, now(), id);
    } else {
      db.prepare('INSERT INTO posts (title, slug, excerpt, body, cover, published, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(title.trim(), uniqueSlug(title), excerpt, body, cover, published, now(), now());
    }
    res.redirect('/admin/panel');
  });
  router.post('/noticias/:id/eliminar', checkCsrf, (req, res) => {
    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    res.redirect('/admin/panel');
  });

  // ---- Jugadores ----
  router.get('/jugadores/nuevo', (req, res) => res.render('admin/jugador-form', { player: null }));
  router.get('/jugadores/:id/editar', (req, res, next) => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
    if (!player) return next();
    res.render('admin/jugador-form', { player });
  });
  router.post('/jugadores/:id?', upload.single('image'), checkCsrf, (req, res) => {
    const b = req.body;
    const photo = uploadedUrl(req.file) || b.photo || '';
    const active = b.active ? 1 : 0;
    const sort = parseInt(b.sort, 10) || 0;
    const id = req.params.id ? Number(req.params.id) : 0;
    if (!String(b.name || '').trim()) return res.status(400).send('Falta el nombre');
    if (id) {
      db.prepare('UPDATE players SET name=?, number=?, position=?, height=?, birthdate=?, photo=?, bio=?, sort=?, active=? WHERE id=?')
        .run(b.name.trim(), b.number || '', b.position || '', b.height || '', b.birthdate || '', photo, b.bio || '', sort, active, id);
    } else {
      db.prepare('INSERT INTO players (name, number, position, height, birthdate, photo, bio, sort, active) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(b.name.trim(), b.number || '', b.position || '', b.height || '', b.birthdate || '', photo, b.bio || '', sort, active);
    }
    res.redirect('/admin/panel');
  });
  router.post('/jugadores/:id/eliminar', checkCsrf, (req, res) => {
    db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
    res.redirect('/admin/panel');
  });

  // ---- Partidos ----
  router.get('/partidos/nuevo', (req, res) => res.render('admin/partido-form', { match: null }));
  router.get('/partidos/:id/editar', (req, res, next) => {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
    if (!match) return next();
    res.render('admin/partido-form', { match });
  });
  router.post('/partidos/:id?', checkCsrf, (req, res) => {
    const b = req.body;
    const home = b.home ? 1 : 0;
    const status = b.status === 'played' ? 'played' : 'upcoming';
    const our = status === 'played' && b.our_score !== '' ? parseInt(b.our_score, 10) : null;
    const opp = status === 'played' && b.opp_score !== '' ? parseInt(b.opp_score, 10) : null;
    const id = req.params.id ? Number(req.params.id) : 0;
    if (!String(b.opponent || '').trim() || !b.date) return res.status(400).send('Falta rival o fecha');
    if (id) {
      db.prepare('UPDATE matches SET opponent=?, date=?, location=?, home=?, our_score=?, opp_score=?, status=?, notes=? WHERE id=?')
        .run(b.opponent.trim(), b.date, b.location || '', home, our, opp, status, b.notes || '', id);
    } else {
      db.prepare('INSERT INTO matches (opponent, date, location, home, our_score, opp_score, status, notes) VALUES (?,?,?,?,?,?,?,?)')
        .run(b.opponent.trim(), b.date, b.location || '', home, our, opp, status, b.notes || '');
    }
    res.redirect('/admin/panel');
  });
  router.post('/partidos/:id/eliminar', checkCsrf, (req, res) => {
    db.prepare('DELETE FROM matches WHERE id = ?').run(req.params.id);
    res.redirect('/admin/panel');
  });

  // ---- Ajustes del sitio ----
  router.get('/ajustes', (req, res) => res.render('admin/ajustes'));
  router.post('/ajustes', upload.single('hero'), checkCsrf, (req, res) => {
    const keys = ['site_title', 'tagline', 'about', 'email', 'instagram', 'facebook', 'whatsapp', 'primary'];
    for (const k of keys) if (k in req.body) setSetting(k, req.body[k]);
    if (req.file) setSetting('hero_image', uploadedUrl(req.file));
    else if (req.body.hero_image !== undefined) setSetting('hero_image', req.body.hero_image);
    res.redirect('/admin/ajustes');
  });

  return router;
};
