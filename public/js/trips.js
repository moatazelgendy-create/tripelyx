// Travel by Budget enhancements. Every page works without this file; it only adds polish:
// budget formatting, the "building your trip" moment, the budget slider, sharing, and the price check.
(function () {
  'use strict';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Thousands separators while typing in a budget field; the server strips them.
  function formatBudget(input) {
    var digits = input.value.replace(/[^0-9]/g, '').slice(0, 7);
    input.value = digits ? Number(digits).toLocaleString('en-US') : '';
  }
  document.querySelectorAll('input[name="b"][inputmode="numeric"], input[name="k"][inputmode="numeric"]').forEach(function (input) {
    input.addEventListener('input', function () { formatBudget(input); });
    if (input.value) formatBudget(input);
  });

  // "Finding destinations… Checking flights… Deciding what’s worth your money" before results appear.
  function build(box, done) {
    var list = box.querySelector('[data-building]');
    if (!list || reduceMotion) return done && done();
    var items = Array.prototype.slice.call(list.children);
    box.classList.add('is-building');
    var i = 0;
    function step() {
      if (i > 0) { items[i - 1].classList.remove('is-now'); items[i - 1].classList.add('is-done'); }
      if (i >= items.length) {
        setTimeout(function () { box.classList.remove('is-building'); if (done) done(); }, 250);
        return;
      }
      items[i].classList.add('is-now');
      i += 1;
      setTimeout(step, 320);
    }
    step();
  }
  var example = document.querySelector('[data-example]');
  if (example && 'IntersectionObserver' in window) {
    var seen = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting && !seen) { seen = true; io.disconnect(); build(example); } });
    }, { rootMargin: '0px 0px -20% 0px' });
    io.observe(example);
  }
  var results = document.querySelector('[data-results]');
  if (results) {
    // Only animate when arriving from the planner, not on every reload or back navigation.
    var fresh = document.referrer && /\/plan(\?|$)/.test(document.referrer) && !(window.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0] && performance.getEntriesByType('navigation')[0].type === 'back_forward');
    if (fresh) build(results);
  }

  // Budget slider on the homepage: show the matching level and carry its budget to the planner.
  var slider = document.querySelector('[data-budget-slider]');
  if (slider) {
    var range = slider.querySelector('[data-range]');
    var hidden = slider.querySelector('[data-range-budget]');
    var levels = slider.querySelectorAll('[data-level]');
    var data = document.getElementById('tb-home-data');
    var budgets = [];
    try { budgets = JSON.parse(data.textContent).levels; } catch (e) { /* ignore */ }
    function show() {
      var i = Number(range.value);
      levels.forEach(function (lv, k) { lv.hidden = k !== i; lv.classList.toggle('is-on', k === i); });
      if (budgets[i]) hidden.value = budgets[i];
    }
    range.addEventListener('input', show);
    show();
    // The range value itself isn't meaningful server-side.
    slider.addEventListener('submit', function () { range.removeAttribute('name'); });
  }

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

  // Review page: a short "checking your final price" moment before the verified result.
  var checking = document.querySelector('[data-checking]');
  var checked = document.querySelector('[data-checked]');
  if (checking && checked && !reduceMotion && !sessionStorage.getItem('tb-checked-' + location.pathname)) {
    checked.hidden = true;
    checking.classList.add('is-on');
    setTimeout(function () {
      checking.classList.remove('is-on');
      checked.hidden = false;
      try { sessionStorage.setItem('tb-checked-' + location.pathname, '1'); } catch (e) { /* ignore */ }
    }, 1100);
  }

  // Planner: focus the first control of each question.
  var step = document.querySelector('[data-plan-step]');
  if (step) {
    var first = step.querySelector('input:not([type="hidden"]):not([type="radio"]), select, button.tb-choice');
    if (first && first.tagName === 'INPUT' && !first.autofocus) first.focus({ preventScroll: true });
  }
})();
