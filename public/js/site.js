// Site-wide behaviour: mobile navigation, header shadow on scroll, gentle reveal-on-scroll.
(function () {
  'use strict';
  var doc = document.documentElement;
  doc.classList.add('js');

  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.getElementById('main-nav');
  function setOpen(open) {
    document.body.classList.toggle('nav-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
  }
  if (toggle && nav) {
    toggle.addEventListener('click', function () { setOpen(!document.body.classList.contains('nav-open')); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { setOpen(false); toggle.focus(); }
    });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    window.matchMedia('(min-width: 1025px)').addEventListener('change', function (m) { if (m.matches) setOpen(false); });
  }

  var header = document.querySelector('[data-header]');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 4); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  var reveal = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && reveal.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    reveal.forEach(function (el) { io.observe(el); });
  } else {
    reveal.forEach(function (el) { el.classList.add('is-in'); });
  }
})();
