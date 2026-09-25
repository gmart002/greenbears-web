/* Asistencia — helpers sin JS inline (el CSP bloquea inline). Delegación + data-*. */
(function () {
  // "Todos presentes / ausentes": botón con data-all="present|absent".
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-all]') : null;
    if (!b) return;
    var v = b.getAttribute('data-all');
    var rs = document.querySelectorAll('input[type=radio][value="' + v + '"]');
    [].forEach.call(rs, function (r) { r.checked = true; });
  });

  // Confirmación de formularios (reemplaza onsubmit inline): form con data-confirm="...".
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Botón "Imprimir / PDF": elemento con data-print.
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-print]') : null;
    if (b) { e.preventDefault(); window.print(); }
  });

  // Aviso "guardado" tras ?ok=1, y limpia la URL.
  try {
    if (location.search.indexOf('ok=1') >= 0) {
      var m = document.getElementById('okMsg');
      if (m) m.style.display = 'block';
      history.replaceState(null, '', location.pathname);
    }
  } catch (e) {}
})();
