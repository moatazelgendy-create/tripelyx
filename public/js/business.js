// Tripelyx Business workspace: progressive enhancement only (plan §B3). Every page works without it.
//   - Copy link (parts.copyLink): <button type="button" data-copy="ID" hidden>Copy link</button> copies the
//     value of the field with that id; the button shows only when this script runs. Status goes to the
//     [data-copy-status] in the same .bz-copy block (else the page's first one).
//   - Character counter (parts.charCount): <textarea data-count="ID" minlength maxlength> writes "12 of 500
//     characters" (or how many more are needed) into the element with that id.
//   - Out-of-policy toggles (parts.outsideToggle): <details data-outside> keeps ?all=1 in the address while any
//     is open, so a reload or Back shows the same rows (the server opens them for ?all=1).
//   - Menus: opening the company switcher or the account menu closes the other; Escape or a click outside closes
//     them and the phone menu.
(function () {
  'use strict';

  // ---- Copy link ----
  function copyText(field) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(field.value);
    return new Promise(function (resolve, reject) {
      field.focus();
      field.select();
      try { if (document.execCommand('copy')) resolve(); else reject(new Error('copy')); } catch (e) { reject(e); }
    });
  }
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var field = document.getElementById(btn.getAttribute('data-copy'));
    if (!field) return;
    var box = btn.closest ? btn.closest('.bz-copy') : null;
    var status = (box || document).querySelector('[data-copy-status]');
    btn.hidden = false;
    btn.addEventListener('click', function () {
      copyText(field).then(function () {
        if (status) status.textContent = 'Link copied. Paste it into a message to send it.';
      }, function () {
        field.focus();
        field.select();
        if (status) status.textContent = 'Select the link and copy it yourself.';
      });
    });
    field.addEventListener('focus', function () { field.select(); });
  });

  // ---- Character counter ----
  document.querySelectorAll('textarea[data-count], input[data-count]').forEach(function (input) {
    var out = document.getElementById(input.getAttribute('data-count'));
    if (!out) return;
    var min = Number(input.getAttribute('minlength')) || 0;
    var max = Number(input.getAttribute('maxlength')) || 0;
    if (!out.hasAttribute('aria-live')) out.setAttribute('aria-live', 'polite');
    function update() {
      var n = input.value.trim().length;
      if (min && n < min) out.textContent = 'Write at least ' + min + ' characters (' + (min - n) + ' more).';
      else out.textContent = max ? n + ' of ' + max + ' characters' : n + ' characters';
    }
    input.addEventListener('input', update);
    update();
  });

  // ---- Out-of-policy toggles ----
  var outside = document.querySelectorAll('details[data-outside]');
  if (outside.length && window.history && window.history.replaceState) {
    outside.forEach(function (d) {
      d.addEventListener('toggle', function () {
        var any = Array.prototype.some.call(outside, function (x) { return x.open; });
        var url = new URL(window.location.href);
        if (any) url.searchParams.set('all', '1'); else url.searchParams.delete('all');
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      });
    });
  }

  // ---- Menus ----
  var pops = document.querySelectorAll('details.bz-pop-wrap, details.bz-menu');
  pops.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open || !d.classList.contains('bz-pop-wrap')) return;
      pops.forEach(function (o) { if (o !== d && o.classList.contains('bz-pop-wrap')) o.open = false; });
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    pops.forEach(function (d) {
      if (!d.open) return;
      var inside = d.contains(document.activeElement);
      d.open = false;
      var s = d.querySelector('summary');
      if (s && inside) s.focus();
    });
  });
  document.addEventListener('click', function (e) {
    pops.forEach(function (d) {
      if (d.open && d.classList.contains('bz-pop-wrap') && !d.contains(e.target)) d.open = false;
    });
  });
})();
