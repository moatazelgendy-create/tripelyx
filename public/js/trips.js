// Travel by Budget enhancements. Every page works without this file; it only adds polish:
// budget formatting and sharing. Nothing here pretends to work: results are shown
// the moment they exist, never behind a timed "building" or "checking" animation.
(function () {
  'use strict';

  // Thousands separators while typing in a budget field; the server strips them.
  function formatBudget(input) {
    var digits = input.value.replace(/[^0-9]/g, '').slice(0, 7);
    input.value = digits ? Number(digits).toLocaleString('en-US') : '';
  }
  document.querySelectorAll('input[name="b"][inputmode="numeric"], input[name="k"][inputmode="numeric"]').forEach(function (input) {
    input.addEventListener('input', function () { formatBudget(input); });
    if (input.value) formatBudget(input);
  });

  // Share a trip: the Web Share sheet where it exists, otherwise copy the link.
  var toast;
  function say(text) {
    if (!toast) { toast = document.createElement('div'); toast.className = 'tb-toast'; toast.setAttribute('role', 'status'); document.body.appendChild(toast); }
    toast.textContent = text;
    toast.classList.add('is-on');
    clearTimeout(say.t);
    say.t = setTimeout(function () { toast.classList.remove('is-on'); }, 2400);
  }
  document.querySelectorAll('[data-share]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var url = location.origin + '/trip/' + btn.getAttribute('data-share');
      var title = btn.getAttribute('data-share-title') || document.title;
      if (navigator.share) {
        navigator.share({ title: title, text: title + ' — built with Tripelyx', url: url }).catch(function () { /* dismissed */ });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { say('Link copied. Prices are live, so they may differ when it’s opened.'); }, function () { say(url); });
      } else {
        window.prompt('Copy this link', url);
      }
    });
  });

  // Planner: focus the first control of each question.
  var step = document.querySelector('[data-plan-step]');
  if (step) {
    var first = step.querySelector('input:not([type="hidden"]):not([type="radio"]), select, button.tb-choice');
    if (first && first.tagName === 'INPUT' && !first.autofocus) first.focus({ preventScroll: true });
  }
})();
