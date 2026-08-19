// Avisa al servidor que un navegador real cargó la página (contador de visitas).
// Los bots y las vistas previas de redes no ejecutan esto, así que no cuentan.
(function () {
  try {
    if (navigator.sendBeacon) navigator.sendBeacon('/api/hit');
    else fetch('/api/hit', { method: 'POST', keepalive: true });
  } catch (e) { /* silencioso */ }
})();
