'use strict';
// Sincroniza el fixture y los resultados de la LBO oficial (lbo.greenbears.cl)
// hacia la tabla LBO local de Green Bears, para que el sitio muestre lo mismo.
// Cruza por equipos (+fecha): alinea fecha/hora/jornada y marcadores de los
// partidos ya existentes; no crea ni borra, y si el feed no responde no cambia nada.
const DEFAULT_FEED = 'https://lbo.greenbears.cl/api/feed.json';
const { lboSaveResult, lboUpdateSchedule, lboFindMatchByTeams, lboGet } = require('./db');

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
  let updated = 0, scheduled = 0;
  feed.matches.forEach(m => {
    const id = lboFindMatchByTeams(m.home, m.away, m.date);
    if (!id) return;
    const cur = lboGet(id);
    // 1) alinear fecha/hora/jornada del fixture con la LBO oficial
    const nd = String(m.date || ''), nt = String(m.time || ''), nr = parseInt(m.rnd, 10);
    if (cur && (cur.mdate !== nd || cur.mtime !== nt || (Number.isFinite(nr) && cur.rnd !== nr))) {
      try { lboUpdateSchedule(id, m.rnd, m.date, m.time); scheduled++; } catch (e) {}
    }
    // 2) resultados (solo partidos finalizados con marcador)
    if (m.status !== 'final' || m.home_pts == null || m.away_pts == null) return;
    if (cur && cur.home_pts === m.home_pts && cur.away_pts === m.away_pts && cur.wo === 0) return; // sin cambios
    try { lboSaveResult(id, m.home_pts, m.away_pts, 0); updated++; } catch (e) {}
  });
  return { ok: true, updated, scheduled };
}

function startLboSync() {
  // Por defecto apunta al feed oficial; se puede sobreescribir con LBO_FEED_URL,
  // o apagar con LBO_FEED_URL=off.
  const env = process.env.LBO_FEED_URL;
  if (env && /^(off|0|false|no)$/i.test(env.trim())) return;   // apagado explícito
  const url = (env && env.trim()) || DEFAULT_FEED;
  const minutes = Math.max(1, parseInt(process.env.LBO_FEED_INTERVAL_MIN, 10) || 3);
  const run = () => syncOnce(url).then(r => {
    if (r && r.ok && (r.updated || r.scheduled)) console.log('[lbo-sync] fixture:', r.scheduled, '· resultados:', r.updated, 'desde', url);
  }).catch(() => {});
  setTimeout(run, 8000);                   // primer intento tras el arranque
  setInterval(run, minutes * 60 * 1000);
}

module.exports = { startLboSync, syncOnce };
