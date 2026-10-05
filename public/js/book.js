// Search results: show a loading skeleton and swap in server-rendered results without a full reload.
// Offer page: loading state on "Continue". Booking page: confirm before cancelling.
(function () {
  'use strict';

  function setLoading(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle('is-loading', on);
    var label = btn.querySelector('.btn-label');
    var sp = btn.querySelector('.spinner');
    if (on && !sp) { sp = document.createElement('span'); sp.className = 'spinner'; sp.setAttribute('aria-hidden', 'true'); btn.insertBefore(sp, btn.firstChild); }
    if (!on && sp) sp.remove();
    if (label) label.setAttribute('aria-live', 'polite');
  }

  var form = document.querySelector('[data-search-form]');
  var results = document.querySelector('[data-results]');
  var inner = document.querySelector('[data-results-inner]');
  var skeleton = document.querySelector('[data-skeleton]');
  var controller = null;

  function load(url, push) {
    if (!inner) return;
    if (controller) controller.abort();
    controller = new AbortController();
    var btn = form && form.querySelector('button[type=submit]');
    setLoading(btn, true);
    results.setAttribute('aria-busy', 'true');
    inner.innerHTML = '';
    if (skeleton) inner.appendChild(skeleton.content.cloneNode(true));
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    fetch(url + sep + 'partial=1', { signal: controller.signal, headers: { Accept: 'text/html' } })
      .then(function (res) { return res.text(); })
      .then(function (htmlText) {
        inner.innerHTML = htmlText;
        if (push) history.pushState({ url: url }, '', url);
        syncErrors();
      })
      .catch(function (err) {
        if (err.name === 'AbortError') return;
        inner.innerHTML = '<div class="error-state" role="alert"><h3>We couldn’t load results</h3><p>Check your connection and try again.</p></div>';
      })
      .finally(function () { setLoading(btn, false); results.setAttribute('aria-busy', 'false'); });
  }

  // Field-level messages come back inside the fragment's alert; clear stale ones on the form.
  function syncErrors() {
    if (!form) return;
    form.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
    form.querySelectorAll('.field-error').forEach(function (el) { el.textContent = ''; });
  }

  if (form && inner) {
    form.addEventListener('submit', function (e) {
      // Let the browser show its own messages for empty required fields first.
      if (!form.checkValidity()) { form.reportValidity(); e.preventDefault(); return; }
      e.preventDefault();
      var params = new URLSearchParams(new FormData(form));
      load(form.getAttribute('action') + '?' + params.toString(), true);
    });
    window.addEventListener('popstate', function () { load(location.pathname + location.search, false); });
  }

  var quoteForm = document.querySelector('[data-quote-form]');
  if (quoteForm) {
    quoteForm.addEventListener('submit', function (e) {
      if (!quoteForm.checkValidity()) { e.preventDefault(); quoteForm.reportValidity(); return; }
      setLoading(quoteForm.querySelector('button[type=submit]'), true);
    });
    // Restore the button if the user comes back with the browser's back button.
    window.addEventListener('pageshow', function () { setLoading(quoteForm.querySelector('button[type=submit]'), false); });
  }

  var cancelForm = document.querySelector('[data-cancel-form]');
  if (cancelForm) {
    cancelForm.addEventListener('submit', function (e) {
      var btn = cancelForm.querySelector('button[type=submit]');
      if (!window.confirm(btn.getAttribute('data-confirm'))) { e.preventDefault(); return; }
      setLoading(btn, true);
    });
  }

  window.TxUI = { setLoading: setLoading };
})();
