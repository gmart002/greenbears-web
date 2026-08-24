/* Tema claro/oscuro del sitio. Externo (el CSP bloquea inline). */
(function () {
  var root = document.documentElement;
  function pref() {
    try { var t = localStorage.getItem('gb-theme'); if (t === 'light' || t === 'dark') return t; } catch (e) {}
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  root.setAttribute('data-theme', pref());               // sin parpadeo (corre en <head>)
  // Delegación: funciona aunque el botón se procese después de este script.
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.theme-toggle') : null;
    if (!b) return;
    var n = (root.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
    root.setAttribute('data-theme', n);
    try { localStorage.setItem('gb-theme', n); } catch (e2) {}
  });
})();
