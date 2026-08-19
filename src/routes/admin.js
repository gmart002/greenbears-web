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
    const players = db.prepare('SELECT * FROM players ORDER BY staff, sort, name').all();
    const matches = db.prepare('SELECT * FROM matches ORDER BY date DESC').all();
    const gallery = db.prepare('SELECT * FROM gallery ORDER BY season DESC, sort, id DESC').all();
    const sponsors = db.prepare('SELECT * FROM sponsors ORDER BY sort, name').all();
    const messages = db.prepare('SELECT * FROM messages ORDER BY created_at DESC').all();
    res.render('admin/panel', { posts, players, matches, gallery, sponsors, messages });
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
    const staff = b.staff ? 1 : 0;
    const sort = parseInt(b.sort, 10) || 0;
    const id = req.params.id ? Number(req.params.id) : 0;
    if (!String(b.name || '').trim()) return res.status(400).send('Falta el nombre');
    if (id) {
      db.prepare('UPDATE players SET name=?, number=?, position=?, height=?, birthdate=?, photo=?, bio=?, sort=?, active=?, staff=?, staff_role=? WHERE id=?')
        .run(b.name.trim(), b.number || '', b.position || '', b.height || '', b.birthdate || '', photo, b.bio || '', sort, active, staff, b.staff_role || '', id);
    } else {
      db.prepare('INSERT INTO players (name, number, position, height, birthdate, photo, bio, sort, active, staff, staff_role) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(b.name.trim(), b.number || '', b.position || '', b.height || '', b.birthdate || '', photo, b.bio || '', sort, active, staff, b.staff_role || '');
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
    const confirmed = b.confirmed ? 1 : 0;
    const status = b.status === 'played' ? 'played' : 'upcoming';
    const our = status === 'played' && b.our_score !== '' ? parseInt(b.our_score, 10) : null;
    const opp = status === 'played' && b.opp_score !== '' ? parseInt(b.opp_score, 10) : null;
    const id = req.params.id ? Number(req.params.id) : 0;
    if (!String(b.opponent || '').trim() || !b.date) return res.status(400).send('Falta rival o fecha');
    if (id) {
      db.prepare('UPDATE matches SET opponent=?, date=?, location=?, home=?, tournament=?, confirmed=?, our_score=?, opp_score=?, status=?, notes=? WHERE id=?')
        .run(b.opponent.trim(), b.date, b.location || '', home, b.tournament || '', confirmed, our, opp, status, b.notes || '', id);
    } else {
      db.prepare('INSERT INTO matches (opponent, date, location, home, tournament, confirmed, our_score, opp_score, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(b.opponent.trim(), b.date, b.location || '', home, b.tournament || '', confirmed, our, opp, status, b.notes || '');
    }
    res.redirect('/admin/panel');
  });
  router.post('/partidos/:id/eliminar', checkCsrf, (req, res) => {
    db.prepare('DELETE FROM matches WHERE id = ?').run(req.params.id);
    res.redirect('/admin/panel');
  });

  // ---- Galería ----
  router.get('/galeria/nueva', (req, res) => res.render('admin/galeria-form', { item: null }));
  router.get('/galeria/:id/editar', (req, res, next) => {
    const item = db.prepare('SELECT * FROM gallery WHERE id = ?').get(req.params.id);
    if (!item) return next();
    res.render('admin/galeria-form', { item });
  });
  router.post('/galeria/:id?', upload.single('image'), checkCsrf, (req, res) => {
    const b = req.body;
    const image = uploadedUrl(req.file) || b.image || '';
    const sort = parseInt(b.sort, 10) || 0;
    const id = req.params.id ? Number(req.params.id) : 0;
    if (!image && !b.video_url) return res.status(400).send('Sube una imagen o pega un enlace de video');
    if (id) {
      db.prepare('UPDATE gallery SET title=?, image=?, video_url=?, season=?, sort=? WHERE id=?')
        .run(b.title || '', image, b.video_url || '', b.season || '', sort, id);
    } else {
      db.prepare('INSERT INTO gallery (title, image, video_url, season, sort, created_at) VALUES (?,?,?,?,?,?)')
        .run(b.title || '', image, b.video_url || '', b.season || '', sort, now());
    }
    res.redirect('/admin/panel#galeria');
  });
  router.post('/galeria/:id/eliminar', checkCsrf, (req, res) => {
    db.prepare('DELETE FROM gallery WHERE id = ?').run(req.params.id); res.redirect('/admin/panel#galeria');
  });

  // ---- Patrocinadores ----
  router.post('/patrocinadores/:id?', upload.single('logo'), checkCsrf, (req, res) => {
    const b = req.body;
    const logo = uploadedUrl(req.file) || b.logo || '';
    const id = req.params.id ? Number(req.params.id) : 0;
    if (!String(b.name || '').trim()) return res.status(400).send('Falta el nombre');
    if (id) db.prepare('UPDATE sponsors SET name=?, logo=?, url=?, sort=? WHERE id=?').run(b.name.trim(), logo, b.url || '', parseInt(b.sort, 10) || 0, id);
    else db.prepare('INSERT INTO sponsors (name, logo, url, sort) VALUES (?,?,?,?)').run(b.name.trim(), logo, b.url || '', parseInt(b.sort, 10) || 0);
    res.redirect('/admin/panel#patrocinadores');
  });
  router.post('/patrocinadores/:id/eliminar', checkCsrf, (req, res) => {
    db.prepare('DELETE FROM sponsors WHERE id = ?').run(req.params.id); res.redirect('/admin/panel#patrocinadores');
  });

  // ---- El club ----
  router.get('/club', (req, res) => res.render('admin/club'));
  router.post('/club', upload.single('club_photo'), checkCsrf, (req, res) => {
    ['club_history', 'club_values', 'club_achievements', 'club_tournaments'].forEach(k => { if (k in req.body) setSetting(k, req.body[k]); });
    if (req.file) setSetting('club_photo', uploadedUrl(req.file));
    else if (req.body.club_photo !== undefined) setSetting('club_photo', req.body.club_photo);
    res.redirect('/admin/club');
  });

  // ---- Mensajes (contacto) ----
  router.post('/mensajes/:id/leido', checkCsrf, (req, res) => {
    db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(req.params.id); res.redirect('/admin/panel#mensajes');
  });
  router.post('/mensajes/:id/eliminar', checkCsrf, (req, res) => {
    db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id); res.redirect('/admin/panel#mensajes');
  });

  // ---- Ajustes del sitio ----
  router.get('/ajustes', (req, res) => res.render('admin/ajustes'));
  const ajustesUpload = upload.fields([{ name: 'hero', maxCount: 1 }, { name: 'logo', maxCount: 1 }]);
  router.post('/ajustes', ajustesUpload, checkCsrf, (req, res) => {
    const keys = ['site_title', 'tagline', 'about', 'email', 'instagram', 'facebook', 'whatsapp', 'primary', 'actualidad_label', 'instagram_embed'];
    for (const k of keys) if (k in req.body) setSetting(k, req.body[k]);
    const f = req.files || {};
    if (f.hero && f.hero[0]) setSetting('hero_image', uploadedUrl(f.hero[0]));
    else if (req.body.hero_image !== undefined) setSetting('hero_image', req.body.hero_image);
    if (f.logo && f.logo[0]) setSetting('logo_image', uploadedUrl(f.logo[0]));
    else if (req.body.logo_image !== undefined) setSetting('logo_image', req.body.logo_image);
    res.redirect('/admin/ajustes');
  });

  return router;
};
