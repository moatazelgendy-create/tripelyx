// The travel agent page works without this file. With it: the two live regions are refreshed while a
// search job runs (instead of the whole page reloading), the composer keeps what you are typing,
// Enter sends, and the conversation stays scrolled to the newest message.
(function () {
  'use strict';
  var chat = document.getElementById('live-chat');
  var composer = document.querySelector('[data-composer]');
  if (!chat || !composer) return;
  var id = (composer.getAttribute('action').match(/\/agent\/([^/]+)$/) || [])[1];
  // The no-JS fallback reloads the page every few seconds; with polling that is not needed.
  var meta = document.querySelector('meta[http-equiv="refresh"]');
  if (meta) meta.parentNode.removeChild(meta);

  function scrollChat() {
    var list = document.querySelector('.ag-messages');
    if (!list) return;
    var last = list.lastElementChild;
    if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'nearest' });
  }

  function swap(htmlText) {
    var doc = new DOMParser().parseFromString(htmlText, 'text/html');
    ['live-chat', 'live-canvas'].forEach(function (key) {
      var next = doc.getElementById(key);
      var cur = document.getElementById(key);
      if (next && cur) cur.replaceWith(next);
    });
    chat = document.getElementById('live-chat');
  }

  var polling = false;
  function poll() {
    if (!id || polling) return;
    var live = document.getElementById('live-chat');
    if (!live || live.getAttribute('data-running') !== '1') return;
    polling = true;
    fetch('/agent/' + id + '/live', { headers: { Accept: 'text/html' }, credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error(String(res.status))); })
      .then(function (text) { swap(text); scrollChat(); })
      .catch(function () { /* keep trying; the next tick retries */ })
      .finally(function () {
        polling = false;
        var again = document.getElementById('live-chat');
        if (again && again.getAttribute('data-running') === '1') setTimeout(poll, 700);
      });
  }
  if (chat.getAttribute('data-running') === '1') setTimeout(poll, 400);
  scrollChat();

  // Enter sends; Shift+Enter makes a new line.
  var box = composer.querySelector('textarea');
  if (box) {
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (box.value.trim()) composer.requestSubmit ? composer.requestSubmit() : composer.submit();
      }
    });
  }
  composer.addEventListener('submit', function () {
    var btn = composer.querySelector('button[type=submit]:not([name])');
    if (btn) btn.disabled = true;
  });
})();
