'use strict';
// Sincroniza los resultados de la LBO oficial (lbo.greenbears.cl) hacia la tabla
// LBO local de Green Bears. DORMIDO salvo que se defina LBO_FEED_URL.
// Solo actualiza marcadores de partidos ya existentes (cruce por equipos+fecha);
// no crea, no borra, y si el feed no responde no cambia nada.
const { lboSaveResult, lboFindMatchByTeams, lboGet } = require('./db');

async function syncOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  let feed;
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, reason: 'http-' + r.status };
    feed = await r.json();
  } catch (e) { return { ok: false, reason: 'fetch' }; } finally { clearTimeout(t); }
  if (!feed || !Array.isArray(feed.matches)) return { ok: false, reason: 'no-matches' };
  let updated = 0;
  feed.matches.forEach(m => {
    if (m.status !== 'final' || m.home_pts == null || m.away_pts == null) return;
    const id = lboFindMatchByTeams(m.home, m.away, m.date);
    if (!id) return;
    const cur = lboGet(id);
    if (cur && cur.home_pts === m.home_pts && cur.away_pts === m.away_pts && cur.wo === 0) return; // sin cambios
    try { lboSaveResult(id, m.home_pts, m.away_pts, 0); updated++; } catch (e) {}
  });
  return { ok: true, updated };
}

function startLboSync() {
  const url = process.env.LBO_FEED_URL;
  if (!url) return;                       // dormido mientras no se configure
  const minutes = Math.max(1, parseInt(process.env.LBO_FEED_INTERVAL_MIN, 10) || 3);
  const run = () => syncOnce(url).then(r => {
    if (r && r.ok && r.updated) console.log('[lbo-sync] actualizados', r.updated, 'partido(s) desde', url);
  }).catch(() => {});
  setTimeout(run, 8000);                   // primer intento tras el arranque
  setInterval(run, minutes * 60 * 1000);
}

module.exports = { startLboSync, syncOnce };
