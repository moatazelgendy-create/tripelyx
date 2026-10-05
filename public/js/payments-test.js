// Payment widget for PAYMENT_MODE=test. Implements the small interface checkout.js expects:
//   TxPayments.mount(container, config) -> { collect(): { method } | { errors } }
// A live processor ships its own script with the same interface that mounts the processor's hosted
// card fields and returns { type: 'token', token } — checkout.js and the booking UI stay unchanged.
(function () {
  'use strict';
  function field(id, label, attrs) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" ' + attrs + '><p class="field-error" data-error-for="' + id + '"></p></div>';
  }
  window.TxPayments = {
    mount: function (el, config) {
      el.innerHTML =
        '<div class="alert alert-info">' +
        '<svg class="icon" aria-hidden="true"><use href="#i-info"/></svg><div><b>Test mode.</b> No real card is charged. Use a test card with any future expiry and any 3-digit CVC.' +
        '<div class="test-cards"><table><tbody>' +
        (config.testCards || []).map(function (c) {
          return '<tr><td><code>' + c.number + '</code></td><td>' + c.result + '</td><td><button type="button" class="copy-btn" data-fill="' + c.number + '">Use</button></td></tr>';
        }).join('') +
        '</tbody></table></div></div></div>' +
        '<div class="form test-widget">' +
        field('card-name', 'Name on card', 'autocomplete="cc-name" maxlength="80"') +
        field('card-number', 'Card number', 'inputmode="numeric" autocomplete="cc-number" maxlength="23" placeholder="4242 4242 4242 4242"') +
        '<div class="form-row">' +
        field('card-exp', 'Expiry (MM/YY)', 'inputmode="numeric" autocomplete="cc-exp" maxlength="7" placeholder="12/30"') +
        field('card-cvc', 'Security code', 'inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="123"') +
        '</div></div>';
      var num = el.querySelector('#card-number');
      var exp = el.querySelector('#card-exp');
      num.addEventListener('input', function () {
        var d = num.value.replace(/\D/g, '').slice(0, 19);
        num.value = d.replace(/(.{4})/g, '$1 ').trim();
      });
      exp.addEventListener('input', function () {
        var d = exp.value.replace(/\D/g, '').slice(0, 4);
        exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
      });
      el.querySelectorAll('[data-fill]').forEach(function (b) {
        b.addEventListener('click', function () {
          num.value = b.getAttribute('data-fill');
          if (!exp.value) exp.value = '12/' + String((new Date().getFullYear() + 3) % 100).padStart(2, '0');
          var cvc = el.querySelector('#card-cvc'); if (!cvc.value) cvc.value = '123';
          num.focus();
        });
      });
      return {
        collect: function () {
          var name = el.querySelector('#card-name').value.trim();
          var number = num.value.replace(/\s/g, '');
          var parts = exp.value.split('/');
          var cvc = el.querySelector('#card-cvc').value.trim();
          var errors = {};
          if (!name) errors['card-name'] = 'Enter the name on the card.';
          if (!/^\d{12,19}$/.test(number)) errors['card-number'] = 'Enter a valid card number.';
          if (parts.length !== 2 || !/^\d{2}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1])) errors['card-exp'] = 'Use MM/YY.';
          if (!/^\d{3,4}$/.test(cvc)) errors['card-cvc'] = 'Enter 3 or 4 digits.';
          if (Object.keys(errors).length) return { errors: errors };
          return { method: { type: 'test_card', name: name, number: number, expMonth: parts[0], expYear: parts[1], cvc: cvc } };
        },
        // Server field names → this widget's field ids.
        mapServerErrors: function (details) {
          var map = { number: 'card-number', exp: 'card-exp', cvc: 'card-cvc', name: 'card-name' };
          var out = {};
          Object.keys(details || {}).forEach(function (k) { out[map[k] || k] = details[k]; });
          return out;
        },
      };
    },
  };
})();
