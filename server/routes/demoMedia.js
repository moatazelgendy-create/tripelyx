// Original illustrated placeholder artwork for demo inventory (/media/demo/<scene>.svg?s=<seed>).
// Each scene is a flat illustration in the Tripelyx palette, varied by seed so listings don't all look
// identical. It is only mounted when demo inventory is allowed, and real suppliers' photos replace it
// automatically because offers carry their own media URLs.
const express = require('express');
const { hash32 } = require('../lib/ids');

function rng(seed) {
  let s = hash32(seed) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

const W = 800, H = 500;

function sky(r, top = '#5fa8ee', bottom = '#cfe6fb') {
  const clouds = Array.from({ length: 3 + Math.floor(r() * 3) }, () => {
    const x = r() * W, y = 40 + r() * 140, s = 0.6 + r() * 0.9;
    return `<g fill="#fff" opacity="${(0.65 + r() * 0.3).toFixed(2)}" transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) scale(${s.toFixed(2)})"><ellipse cx="0" cy="0" rx="60" ry="18"/><ellipse cx="-28" cy="-10" rx="30" ry="18"/><ellipse cx="22" cy="-16" rx="36" ry="24"/></g>`;
  }).join('');
  return `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
  <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f8fd6"/><stop offset=".55" stop-color="#2fb8d8"/><stop offset="1" stop-color="#7fe0e6"/></linearGradient>
  <linearGradient id="sand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3e3c3"/><stop offset="1" stop-color="#e6cfa3"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>${clouds}`;
}

function seaAndSand(r, horizon = 250, shore = 380) {
  const curve = shore + (r() - 0.5) * 40;
  return `<rect y="${horizon}" width="${W}" height="${H - horizon}" fill="url(#sea)"/>
  <path d="M0 ${curve} C ${W * 0.3} ${curve - 30}, ${W * 0.6} ${curve + 30}, ${W} ${curve - 10} L ${W} ${H} L 0 ${H} Z" fill="url(#sand)"/>
  <path d="M0 ${curve} C ${W * 0.3} ${curve - 30}, ${W * 0.6} ${curve + 30}, ${W} ${curve - 10}" fill="none" stroke="#fff" stroke-width="5" opacity=".7"/>`;
}

function towers(r, baseY, count = 4, x0 = 420) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const w = 46 + r() * 30, h = 150 + r() * 150, x = x0 + i * (w + 14 + r() * 20);
    out += `<rect x="${x.toFixed(0)}" y="${(baseY - h).toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" rx="8" fill="#dbe6f1"/>
    <rect x="${(x + w * 0.55).toFixed(0)}" y="${(baseY - h).toFixed(0)}" width="${(w * 0.45).toFixed(0)}" height="${h.toFixed(0)}" rx="6" fill="#9fb8d1"/>`;
    for (let y = baseY - h + 14; y < baseY - 10; y += 14) out += `<rect x="${(x + 6).toFixed(0)}" y="${y.toFixed(0)}" width="${(w - 12).toFixed(0)}" height="4" fill="#6f8fb0" opacity=".45"/>`;
  }
  return out;
}

function palm(x, y, s = 1) {
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="#1f5a3c"><path d="M0 0 C 6 -60, 4 -100, -4 -140" stroke="#7a5a3a" stroke-width="9" fill="none" stroke-linecap="round"/>
  <path d="M-4 -140 c -30 -20 -70 -16 -96 8 30 -10 60 -6 96 -8z"/><path d="M-4 -140 c 30 -24 70 -20 96 4 -30 -8 -62 -6 -96 -4z"/><path d="M-4 -140 c -10 -30 -36 -48 -64 -50 26 12 44 30 64 50z"/><path d="M-4 -140 c 14 -30 40 -44 66 -44 -24 10 -44 26 -66 44z"/></g>`;
}

function boat(x, y, s, kind) {
  const hull = `<path d="M-120 0 L 120 0 L 96 34 L -100 34 Z" fill="#fff"/><path d="M-100 34 L 96 34 L 90 42 L -94 42 Z" fill="#0b2545"/>`;
  const extra = {
    sail: `<path d="M-6 -4 L -6 -200 L -110 -6 Z" fill="#fff"/><path d="M4 -4 L 4 -170 L 80 -6 Z" fill="#e8f1fb"/><rect x="-8" y="-206" width="6" height="206" fill="#c7d3e0"/>`,
    motor: `<path d="M-70 0 L -40 -46 L 70 -46 L 96 0 Z" fill="#f4f8fc"/><path d="M-30 -40 L 60 -40 L 76 -8 L -48 -8 Z" fill="#20354f"/><path d="M-20 -46 L 0 -78 L 56 -78 L 60 -46 Z" fill="#fff"/>`,
    cat: `<path d="M-90 -6 L 90 -6 L 70 -50 L -60 -50 Z" fill="#f4f8fc"/><path d="M-50 -46 L 60 -46 L 66 -16 L -56 -16 Z" fill="#20354f"/><rect x="-4" y="-220" width="6" height="170" fill="#c7d3e0"/><path d="M2 -214 L 2 -56 L 96 -56 Z" fill="#fff"/>`,
    speed: `<path d="M-60 0 L -20 -30 L 60 -30 L 100 0 Z" fill="#fff"/><path d="M-10 -28 L 40 -28 L 50 -10 L -24 -10 Z" fill="#20354f"/>`,
    ship: `<rect x="-90" y="-50" width="190" height="52" rx="4" fill="#fff"/><rect x="-60" y="-92" width="140" height="44" rx="4" fill="#f4f8fc"/><rect x="-24" y="-124" width="70" height="34" rx="4" fill="#fff"/><rect x="10" y="-150" width="22" height="28" rx="3" fill="#1f78db"/>${
      Array.from({ length: 9 }, (_, i) => `<rect x="${-80 + i * 20}" y="-34" width="12" height="8" rx="2" fill="#20354f"/>`).join('')}${
      Array.from({ length: 6 }, (_, i) => `<rect x="${-50 + i * 22}" y="-78" width="14" height="10" rx="2" fill="#20354f"/>`).join('')}`,
  }[kind] || '';
  return `<g transform="translate(${x} ${y}) scale(${s})">${extra}${hull}</g>`;
}

function car(x, y, s, kind, color) {
  const body = {
    compact: 'M-150 0 L -150 -40 Q -140 -60 -110 -66 L -70 -110 Q -60 -118 -40 -118 L 50 -118 Q 70 -118 84 -104 L 120 -66 Q 150 -60 154 -36 L 154 0 Z',
    sedan: 'M-180 0 L -180 -40 Q -170 -62 -130 -66 L -80 -112 Q -70 -120 -50 -120 L 60 -120 Q 80 -120 96 -106 L 140 -66 Q 180 -62 184 -36 L 184 0 Z',
    suv: 'M-180 0 L -180 -60 Q -176 -80 -150 -84 L -110 -136 Q -100 -144 -80 -144 L 110 -144 Q 130 -144 140 -130 L 170 -84 Q 186 -80 186 -56 L 186 0 Z',
    van: 'M-190 0 L -190 -150 Q -190 -168 -170 -168 L 120 -168 Q 140 -168 152 -150 L 186 -90 Q 192 -80 192 -60 L 192 0 Z',
  }[kind];
  const windows = {
    compact: '<path d="M-60 -70 L -36 -104 L 0 -104 L 0 -70 Z M 12 -70 L 12 -104 L 50 -104 L 78 -70 Z" fill="#cfe3f6"/>',
    sedan: '<path d="M-70 -70 L -44 -106 L 0 -106 L 0 -70 Z M 12 -70 L 12 -106 L 60 -106 L 96 -70 Z" fill="#cfe3f6"/>',
    suv: '<path d="M-100 -88 L -74 -128 L -10 -128 L -10 -88 Z M 2 -88 L 2 -128 L 100 -128 L 128 -88 Z" fill="#cfe3f6"/>',
    van: '<path d="M-170 -100 L -170 -150 L -90 -150 L -90 -100 Z M -78 -100 L -78 -150 L 10 -150 L 10 -100 Z M 22 -100 L 22 -150 L 118 -150 L 160 -100 Z" fill="#cfe3f6"/>',
  }[kind];
  return `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="6" rx="200" ry="14" fill="#000" opacity=".12"/><path d="${body}" fill="${color}"/>${windows}
  <circle cx="-100" cy="0" r="34" fill="#1d2430"/><circle cx="-100" cy="0" r="14" fill="#aab4c0"/><circle cx="110" cy="0" r="34" fill="#1d2430"/><circle cx="110" cy="0" r="14" fill="#aab4c0"/></g>`;
}

const SCENES = {
  towers: r => sky(r) + seaAndSand(r, 260, 400) + towers(r, 360, 4, 380 + r() * 60),
  beach: r => sky(r) + seaAndSand(r, 230, 330) + palm(110 + r() * 60, 470, 1.2) + palm(660, 480, 0.9)
    + `<g transform="translate(${380 + r() * 120} 420)"><path d="M0 0 L 0 -90" stroke="#8a6a44" stroke-width="6"/><path d="M-70 -80 Q 0 -130 70 -80 Z" fill="#d7b98a"/></g>`,
  lagoon: r => sky(r) + `<rect y="250" width="${W}" height="250" fill="url(#sand)"/><path d="M80 330 Q 400 250 720 330 Q 760 420 400 440 Q 40 430 80 330 Z" fill="url(#sea)"/>` + palm(60, 460, 1) + palm(740, 470, 1.1),
  sunset: r => sky(r, '#f39a5b', '#fbd9a5') + `<circle cx="${300 + r() * 200}" cy="250" r="70" fill="#ffe1a3"/><rect y="250" width="${W}" height="250" fill="#2c6aa3"/><rect y="250" width="${W}" height="250" fill="#f39a5b" opacity=".25"/>` + towers(r, 300, 3, 560),
  pool: r => sky(r) + `<rect y="230" width="${W}" height="270" fill="#eef2f5"/><path d="M60 300 L 740 300 L 780 470 L 20 470 Z" fill="#43c3e0"/><path d="M60 300 L 740 300 L 780 470 L 20 470 Z" fill="none" stroke="#fff" stroke-width="10"/>`
    + `<path d="M120 380 q 40 -14 80 0 t 80 0 t 80 0 M 360 420 q 40 -14 80 0 t 80 0" stroke="#fff" stroke-width="5" fill="none" opacity=".6"/>` + palm(40, 300, 0.9) + palm(770, 300, 0.8),
  room: r => `<rect width="${W}" height="${H}" fill="#f4efe7"/><rect x="460" y="60" width="280" height="220" rx="6" fill="#cfe6fb"/><rect x="460" y="190" width="280" height="90" fill="#2fb8d8"/><rect x="460" y="60" width="280" height="220" rx="6" fill="none" stroke="#fff" stroke-width="12"/>
    <rect x="60" y="300" width="420" height="110" rx="14" fill="#fff"/><rect x="60" y="250" width="420" height="70" rx="14" fill="#e5ddd0"/><rect x="90" y="270" width="110" height="46" rx="12" fill="#fff"/><rect x="220" y="270" width="110" height="46" rx="12" fill="#fff"/><rect x="60" y="380" width="420" height="40" rx="8" fill="#${['1f78db', '0b2545', 'c9a46c'][Math.floor(r() * 3)]}"/><rect y="440" width="${W}" height="60" fill="#d8cdbd"/>`,
  villa: r => sky(r) + `<rect y="300" width="${W}" height="200" fill="#e9efe7"/><rect x="180" y="190" width="440" height="150" rx="6" fill="#fff"/><rect x="140" y="180" width="520" height="22" rx="4" fill="#f1f1f1"/><rect x="220" y="230" width="90" height="110" fill="#9fc6e6"/><rect x="340" y="230" width="230" height="70" fill="#9fc6e6"/><rect x="120" y="360" width="560" height="90" rx="6" fill="#43c3e0"/>` + palm(90, 360, 1) + palm(720, 370, 0.9),
  marina: r => sky(r) + `<rect y="260" width="${W}" height="240" fill="url(#sea)"/><rect y="400" width="${W}" height="100" fill="#d9d2c4"/>` + boat(220, 360, 0.5, 'sail') + boat(470, 350, 0.55, 'motor') + boat(670, 370, 0.4, 'sail') + towers(r, 260, 3, 80),
  city: r => sky(r, '#86b7e6', '#e7f1fb') + `<rect y="380" width="${W}" height="120" fill="#cbd5df"/>` + towers(r, 400, 6, 30 + r() * 40),
  plane: r => sky(r, '#4f9be8', '#d7ebfc') + `<g transform="translate(${360 + r() * 80} ${220 + r() * 40}) rotate(-8) scale(1.4)"><path d="M-170 0 Q -150 -18 -60 -16 L 140 -14 Q 180 -10 186 0 Q 180 10 140 14 L -60 16 Q -150 18 -170 0 Z" fill="#fff"/><path d="M-10 -14 L 50 -110 L 80 -110 L 50 -14 Z M -10 14 L 50 110 L 80 110 L 50 14 Z" fill="#e6eef6"/><path d="M-160 -4 L -170 -64 L -146 -64 L -120 -10 Z" fill="#1f78db"/><path d="M110 -8 Q 140 -10 160 -4 L 150 2 L 112 2 Z" fill="#20354f"/>${
      Array.from({ length: 10 }, (_, i) => `<circle cx="${-90 + i * 18}" cy="-4" r="3.5" fill="#20354f"/>`).join('')}</g>`,
  'car-compact': r => sky(r) + `<rect y="330" width="${W}" height="170" fill="#c9cfd6"/><rect y="400" width="${W}" height="8" fill="#fff" opacity=".7"/>` + car(400, 400, 1.2, 'compact', ['#e24b4b', '#1f78db', '#f5f5f5'][Math.floor(r() * 3)]),
  'car-sedan': r => sky(r) + `<rect y="330" width="${W}" height="170" fill="#c9cfd6"/><rect y="400" width="${W}" height="8" fill="#fff" opacity=".7"/>` + car(400, 400, 1.15, 'sedan', ['#0b2545', '#9aa5b1', '#f5f5f5'][Math.floor(r() * 3)]),
  'car-suv': r => sky(r) + `<rect y="330" width="${W}" height="170" fill="#d8c8a8"/>` + car(400, 410, 1.1, 'suv', ['#2a3b4f', '#f5f5f5', '#7a8b6a'][Math.floor(r() * 3)]),
  'car-van': r => sky(r) + `<rect y="330" width="${W}" height="170" fill="#c9cfd6"/>` + car(400, 410, 1.05, 'van', '#f5f5f5'),
  bus: r => sky(r) + `<rect y="330" width="${W}" height="170" fill="#c9cfd6"/>` + `<g transform="translate(400 410)"><ellipse cx="0" cy="6" rx="260" ry="14" fill="#000" opacity=".12"/><rect x="-250" y="-200" width="500" height="200" rx="26" fill="#fff"/><rect x="-250" y="-60" width="500" height="20" fill="#1f78db"/>${
      Array.from({ length: 6 }, (_, i) => `<rect x="${-230 + i * 78}" y="-176" width="64" height="76" rx="8" fill="#cfe3f6"/>`).join('')}<circle cx="-150" cy="0" r="34" fill="#1d2430"/><circle cx="150" cy="0" r="34" fill="#1d2430"/></g>`,
  'ship-large': r => sky(r) + `<rect y="270" width="${W}" height="230" fill="url(#sea)"/>` + boat(400, 330, 1.7, 'ship'),
  'ship-small': r => sky(r, '#6fb0ee', '#e0f0fd') + `<rect y="270" width="${W}" height="230" fill="url(#sea)"/>` + boat(420, 330, 1.3, 'ship'),
  islands: r => sky(r) + `<rect y="270" width="${W}" height="230" fill="url(#sea)"/><path d="M80 290 Q 220 150 380 290 Z" fill="#c9b48e"/><path d="M80 290 Q 220 160 380 290" fill="none"/>${
      Array.from({ length: 12 }, () => `<rect x="${(140 + r() * 180).toFixed(0)}" y="${(220 + r() * 50).toFixed(0)}" width="18" height="14" fill="#fff"/>`).join('')}<path d="M480 285 Q 600 210 740 285 Z" fill="#b8a27a"/>` + boat(560, 400, 0.4, 'sail'),
  'yacht-sail': r => sky(r) + `<rect y="280" width="${W}" height="220" fill="url(#sea)"/>` + boat(400, 380, 1.3, 'sail'),
  'yacht-motor': r => sky(r) + `<rect y="280" width="${W}" height="220" fill="url(#sea)"/>` + boat(400, 380, 1.5, 'motor'),
  'yacht-cat': r => sky(r) + `<rect y="280" width="${W}" height="220" fill="url(#sea)"/>` + boat(400, 380, 1.2, 'cat'),
  'yacht-speed': r => sky(r) + `<rect y="280" width="${W}" height="220" fill="url(#sea)"/><path d="M80 400 Q 260 380 300 396" stroke="#fff" stroke-width="10" fill="none" opacity=".7"/>` + boat(440, 390, 1.5, 'speed'),
  sea: r => sky(r) + `<rect y="${240 + r() * 40}" width="${W}" height="260" fill="url(#sea)"/>` + `<path d="M0 360 q 50 -14 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0" stroke="#fff" stroke-width="4" fill="none" opacity=".45"/>`,
  snorkel: r => `<rect width="${W}" height="${H}" fill="#1aa3cf"/><rect width="${W}" height="80" fill="#7fe0e6" opacity=".6"/>${
      Array.from({ length: 7 }, (_, i) => `<path d="M${60 + i * 110} 500 q -20 -${60 + r() * 80} 10 -${100 + r() * 90} q 30 60 10 ${160}" fill="#f28b6b" opacity=".85"/>`).join('')}${
      Array.from({ length: 6 }, () => { const x = 100 + r() * 600, y = 140 + r() * 200; return `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)})"><ellipse rx="26" ry="12" fill="#ffd34d"/><path d="M22 0 L 40 -12 L 40 12 Z" fill="#ffd34d"/><circle cx="-14" cy="-3" r="3" fill="#0b2545"/></g>`; }).join('')}`,
  desert: r => sky(r, '#77b3ea', '#f6e7cc') + `<path d="M0 300 Q 200 220 400 300 T 800 280 L 800 500 L 0 500 Z" fill="#e8c48c"/><path d="M0 380 Q 250 300 520 380 T 800 360 L 800 500 L 0 500 Z" fill="#d9a865"/>`
    + `<g transform="translate(${360 + r() * 100} 420)"><rect x="-70" y="-50" width="140" height="40" rx="12" fill="#e24b4b"/><circle cx="-56" cy="-6" r="24" fill="#1d2430"/><circle cx="56" cy="-6" r="24" fill="#1d2430"/><rect x="-16" y="-80" width="20" height="34" fill="#20354f"/></g>`,
  museum: r => sky(r, '#77b3ea', '#f3e7d2') + `<rect y="380" width="${W}" height="120" fill="#e3cfa6"/><path d="M200 200 L 400 120 L 600 200 Z" fill="#e9e1d1"/><rect x="200" y="200" width="400" height="20" fill="#d9cdb6"/>${
      Array.from({ length: 6 }, (_, i) => `<rect x="${220 + i * 66}" y="220" width="26" height="150" fill="#f1ebdf"/>`).join('')}<rect x="190" y="370" width="420" height="16" fill="#d9cdb6"/>`,
  kite: r => sky(r) + seaAndSand(r, 260, 420) + `<path d="M${380 + r() * 100} 110 q 120 -40 220 20" stroke="#ff6a3d" stroke-width="26" fill="none" stroke-linecap="round"/><path d="M500 130 L 460 320 M 600 150 L 470 320" stroke="#20354f" stroke-width="2"/><circle cx="465" cy="330" r="10" fill="#20354f"/><path d="M430 352 L 500 346" stroke="#fff" stroke-width="7" stroke-linecap="round"/>`,
  night: r => `<rect width="${W}" height="${H}" fill="#0b1a33"/>${
      Array.from({ length: 70 }, () => `<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * 300).toFixed(0)}" r="${(r() * 1.8 + 0.4).toFixed(1)}" fill="#fff" opacity="${(0.4 + r() * 0.6).toFixed(2)}"/>`).join('')}<path d="M0 360 Q 200 300 400 360 T 800 340 L 800 500 L 0 500 Z" fill="#2a2440"/><path d="M340 420 L 400 360 L 460 420 Z" fill="#e2a64b"/><circle cx="400" cy="440" r="18" fill="#ffb347" opacity=".9"/>`,
  kitchen: r => `<rect width="${W}" height="${H}" fill="#f7efe3"/><rect y="300" width="${W}" height="200" fill="#c8a27a"/><rect y="290" width="${W}" height="20" fill="#e7d8c3"/><ellipse cx="280" cy="300" rx="110" ry="26" fill="#fff"/><ellipse cx="280" cy="292" rx="80" ry="16" fill="#e8a33c"/><ellipse cx="560" cy="296" rx="90" ry="22" fill="#fff"/><ellipse cx="560" cy="288" rx="64" ry="12" fill="#3f8a3a"/>${
      Array.from({ length: 5 }, (_, i) => `<rect x="${80 + i * 140}" y="80" width="60" height="90" rx="10" fill="#${['1f78db', 'e24b4b', 'f5a524', '3f8a3a', '0b2545'][i]}" opacity=".85"/>`).join('')}`,
  spa: r => `<rect width="${W}" height="${H}" fill="#eef3ef"/><rect y="320" width="${W}" height="180" fill="#d8e3da"/><ellipse cx="400" cy="330" rx="260" ry="30" fill="#bfd2c2"/>${
      [0, 1, 2].map(i => `<ellipse cx="${340 + i * 60}" cy="${300 - i * 2}" rx="${46 - i * 8}" ry="${20 - i * 3}" fill="#6b7c6e"/>`).join('')}<path d="M180 320 C 170 220 210 160 250 120 C 240 200 230 260 200 320 Z" fill="#5b8f62"/><circle cx="600" cy="230" r="12" fill="#f5c26b"/><rect x="594" y="240" width="12" height="70" fill="#fff"/>`,
};

function renderScene(scene, seed) {
  const r = rng(`${scene}:${seed}`);
  const draw = SCENES[scene] || SCENES.sea;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><title>Demo artwork</title>${draw(r)}<g opacity=".9"><rect x="${W - 132}" y="${H - 38}" width="118" height="26" rx="13" fill="#0b2545" opacity=".72"/><text x="${W - 73}" y="${H - 20}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="600" fill="#fff" letter-spacing="1.5">DEMO</text></g></svg>`;
}

function demoMediaRouter() {
  const router = express.Router();
  router.get('/:scene.svg', (req, res) => {
    const scene = String(req.params.scene).slice(0, 40);
    if (!SCENES[scene]) return res.status(404).end();
    res.type('image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(renderScene(scene, String(req.query.s || '').slice(0, 80)));
  });
  return router;
}

module.exports = { demoMediaRouter, renderScene, SCENES };
