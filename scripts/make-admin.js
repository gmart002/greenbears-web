'use strict';
// Crea (o verifica) una cuenta del panel /admin del sitio, sin exponer credenciales
// en el repo: usuario y clave llegan por variables de entorno.
//
//   docker exec -e NU=usuario -e NP=clave [-e NR=super|editor] grap-greenbears node scripts/make-admin.js
//
// NR (rol) es opcional; por defecto "super" (acceso total). Idempotente: si el
// usuario ya existe no lo pisa (usa la ruta de "clave" del panel para cambiarla).
const db = require('../src/db');

const u = String(process.env.NU || '').trim().toLowerCase();
const p = String(process.env.NP || '');
const role = process.env.NR === 'editor' ? 'editor' : 'super';

if (!u || !p) {
  console.error('Falta NU (usuario) o NP (clave). Ej: -e NU=gustavo -e NP=clave');
  process.exit(1);
}

try {
  const ex = db.findUser(u);
  if (ex) {
    console.log('YA_EXISTE', u, 'rol=' + ex.role, '(no se modifica; cambia la clave desde /admin o borra y recrea)');
  } else {
    db.createUser(u, p, role);
    console.log('CREADA', u, 'rol=' + role);
  }
  console.log('LOGIN_OK', !!db.verifyLogin(u, p));
} catch (e) {
  console.error('ERROR', e.message);
  process.exit(1);
}
