// Partner / contact form: client-side checks, JSON submit, inline errors and a success message (the form's own
// data-success text when it has one, as the Business enquiry form does).
(function () {
  'use strict';
  document.querySelectorAll('[data-lead-form]').forEach(function (form) {
    var status = form.querySelector('[data-form-status]');
    var btn = form.querySelector('button[type=submit]');
    function showErrors(details) {
      form.querySelectorAll('[data-error-for]').forEach(function (el) {
        var name = el.getAttribute('data-error-for');
        var input = form.elements[name];
        var msg = details && details[name];
        el.textContent = msg || '';
        if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
      });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = Object.fromEntries(new FormData(form).entries());
      var errs = {};
      if (!data.name.trim()) errs.name = 'Enter your name.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim())) errs.email = 'Enter a valid email address.';
      if (data.message.trim().length < 10) errs.message = 'Tell us a little more (at least 10 characters).';
      showErrors(errs);
      if (Object.keys(errs).length) { form.querySelector('[aria-invalid="true"]').focus(); return; }
      btn.disabled = true;
      status.innerHTML = '';
      fetch('/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
        .then(function (r) {
          if (!r.ok) { showErrors(r.body.error && r.body.error.details); throw new Error(r.body.error ? r.body.error.message : 'Something went wrong.'); }
          form.reset();
          var success = form.getAttribute('data-success');
          if (success) {
            var ok = document.createElement('div'); ok.className = 'alert alert-success'; ok.textContent = success;
            status.appendChild(ok);
          } else {
            status.innerHTML = '<div class="alert alert-success">Thanks — your message is in. We’ll be in touch soon.</div>';
          }
        })
        .catch(function (err) {
          var d = document.createElement('div'); d.className = 'alert alert-error'; d.textContent = err.message || 'We couldn’t send your message. Please try again.';
          status.appendChild(d);
        })
        .finally(function () { btn.disabled = false; });
    });
  });
})();
