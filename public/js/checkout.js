// Checkout: lead traveler + payment. Creates the booking once (kept per quote in sessionStorage so a
// declined card can be retried without creating a second booking), then asks the payment widget for a
// payment method and submits it. The widget is whatever TxPayments the page loaded (test or live).
(function () {
  'use strict';
  var dataEl = document.getElementById('checkout-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var travelerForm = document.querySelector('[data-traveler-form]');
  var payForm = document.querySelector('[data-payment-form]');
  if (!travelerForm || !payForm) return;
  var status = payForm.querySelector('[data-form-status]');
  var payBtn = payForm.querySelector('[data-pay-button]');
  var widget = window.TxPayments ? window.TxPayments.mount(payForm.querySelector('[data-payment-widget]'), data.payment) : null;
  var storeKey = 'tx_booking_' + data.quoteId;

  function getStored() { try { return sessionStorage.getItem(storeKey); } catch (e) { return null; } }
  function setStored(v) { try { sessionStorage.setItem(storeKey, v); } catch (e) { /* private mode */ } }

  function setErrors(form, errors) {
    form.querySelectorAll('[data-error-for]').forEach(function (el) {
      var name = el.getAttribute('data-error-for');
      var input = form.querySelector('[name="' + name + '"]') || form.querySelector('#' + name);
      var msg = errors && errors[name];
      el.textContent = msg || '';
      if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
    });
  }

  function showStatus(msg, kind) {
    status.innerHTML = '';
    if (!msg) return;
    var d = document.createElement('div');
    d.className = 'alert alert-' + (kind || 'error');
    d.textContent = msg;
    status.appendChild(d);
  }

  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (!res.ok) { var e = new Error((json.error && json.error.message) || 'Something went wrong. Please try again.'); e.code = json.error && json.error.code; e.details = json.error && json.error.details; e.status = res.status; throw e; }
          return json;
        });
      });
  }

  function traveler() {
    var f = travelerForm;
    var t = { firstName: f.firstName.value.trim(), lastName: f.lastName.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(), notes: f.notes.value.trim() };
    var errs = {};
    if (!t.firstName) errs.firstName = 'Enter a first name.';
    if (!t.lastName) errs.lastName = 'Enter a last name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t.email)) errs.email = 'Enter a valid email address.';
    setErrors(travelerForm, errs);
    return Object.keys(errs).length ? null : t;
  }

  function focusFirstInvalid() {
    var el = document.querySelector('[aria-invalid="true"]');
    if (el) el.focus();
  }

  payForm.addEventListener('submit', function (e) {
    e.preventDefault();
    showStatus('');
    var t = traveler();
    if (!widget) { showStatus('Payment is unavailable right now. Please try again later.'); return; }
    var collected = widget.collect();
    setErrors(payForm, collected.errors || {});
    if (!t || collected.errors) { focusFirstInvalid(); return; }

    window.TxUI && window.TxUI.setLoading(payBtn, true);
    var ref = getStored();
    var ensureBooking = ref ? Promise.resolve(ref) : api('/api/bookings', { quoteId: data.quoteId, traveler: t }).then(function (r) { setStored(r.booking.ref); return r.booking.ref; });
    ensureBooking
      .then(function (bookingRef) {
        ref = bookingRef;
        return api('/api/bookings/' + encodeURIComponent(ref) + '/pay', { method: collected.method });
      })
      .then(function (r) {
        showStatus('Payment successful — confirming your booking…', 'success');
        window.location.assign('/booking/' + encodeURIComponent(r.booking.ref));
      })
      .catch(function (err) {
        window.TxUI && window.TxUI.setLoading(payBtn, false);
        if (err.code === 'invalid_traveler') { setErrors(travelerForm, err.details); focusFirstInvalid(); }
        if (err.code === 'invalid_card' || err.code === 'not_a_test_card') { setErrors(payForm, widget.mapServerErrors ? widget.mapServerErrors(err.details) : err.details); }
        // A booking that can no longer be paid (expired, already closed) starts fresh next time.
        if (['payment_window_expired', 'not_awaiting_payment', 'booking_not_found'].indexOf(err.code) >= 0) { try { sessionStorage.removeItem(storeKey); } catch (x) { /* ignore */ } }
        if (err.code === 'not_awaiting_payment' && ref) { window.location.assign('/booking/' + encodeURIComponent(ref)); return; }
        // The live price moved between the quote and payment: nothing was charged. Back to the review
        // page, where the new price is shown and the traveler decides.
        if (err.code === 'price_changed' && err.details && err.details.url) { try { sessionStorage.removeItem(storeKey); } catch (x) { /* ignore */ } window.location.assign(err.details.url); return; }
        showStatus(err.message);
        status.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
  });

  // Countdown for the held price.
  var timerWrap = document.querySelector('[data-quote-timer]');
  var timer = document.querySelector('[data-timer]');
  if (timerWrap && timer) {
    var expires = new Date(timerWrap.getAttribute('data-expires')).getTime();
    var tick = function () {
      var left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      timer.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      if (!left) {
        timerWrap.className = 'alert alert-warning';
        timerWrap.lastElementChild.textContent = 'This price has expired. Reload the page to get a fresh price.';
        payBtn.disabled = true;
        clearInterval(iv);
      }
    };
    var iv = setInterval(tick, 1000);
    tick();
  }
})();
