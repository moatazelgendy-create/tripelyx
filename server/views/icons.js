// Original line/solid icons, drawn on a 24×24 grid. Used through an inline <svg><use></svg> sprite.
const { raw } = require('../lib/html');

const PATHS = {
  arrow: '<path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  'arrow-left': '<path d="M20 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/>',
  pin: '<path d="M12 2.5c-4 0-7 3-7 7 0 5.2 7 12 7 12s7-6.8 7-12c0-4-3-7-7-7z" fill="currentColor"/><circle cx="12" cy="9.5" r="2.6" fill="#fff"/>',
  bed: '<path d="M2.5 18.5V6.5M2.5 14h19v4.5M21.5 14v-2.5a3 3 0 0 0-3-3H11V14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="4.5" y="9" width="5" height="3.6" rx="1.2" fill="currentColor"/><path d="M3 14h18v3H3z" fill="currentColor" opacity=".25"/>',
  car: '<path d="M4 16.5v-4.2l1.9-5A2 2 0 0 1 7.8 6h8.4a2 2 0 0 1 1.9 1.3l1.9 5v4.2z" fill="currentColor"/><path d="M6.6 11.2 7.8 8h8.4l1.2 3.2z" fill="#fff"/><rect x="4.5" y="16" width="3" height="3" rx="1" fill="currentColor"/><rect x="16.5" y="16" width="3" height="3" rx="1" fill="currentColor"/><circle cx="7.5" cy="13.7" r="1.2" fill="#fff"/><circle cx="16.5" cy="13.7" r="1.2" fill="#fff"/>',
  bus: '<rect x="3.5" y="3.5" width="17" height="14" rx="2.5" fill="currentColor"/><rect x="5.5" y="6" width="5.6" height="4.6" rx=".8" fill="#fff"/><rect x="12.9" y="6" width="5.6" height="4.6" rx=".8" fill="#fff"/><circle cx="7.5" cy="14.2" r="1.2" fill="#fff"/><circle cx="16.5" cy="14.2" r="1.2" fill="#fff"/><rect x="5" y="17" width="3" height="3.5" rx="1" fill="currentColor"/><rect x="16" y="17" width="3" height="3.5" rx="1" fill="currentColor"/>',
  yacht: '<path d="M11 2.5v8.2H6.2z" fill="currentColor"/><path d="M12.5 4.5l5 6.2h-5z" fill="currentColor" opacity=".7"/><path d="M3 12.5h18l-2.6 4.3H5.4z" fill="currentColor"/><path d="M2.5 19.2c1.6 0 1.6 1.3 3.2 1.3s1.6-1.3 3.2-1.3 1.6 1.3 3.1 1.3 1.6-1.3 3.2-1.3 1.6 1.3 3.2 1.3 1.6-1.3 3.1-1.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ship: '<path d="M8 4h8v4H8z" fill="currentColor" opacity=".7"/><path d="M5.5 8h13v4h-13z" fill="currentColor"/><path d="M2.5 12h19l-2.5 5h-14z" fill="currentColor"/><path d="M2.5 19.6c1.6 0 1.6 1.2 3.2 1.2s1.6-1.2 3.2-1.2 1.6 1.2 3.1 1.2 1.6-1.2 3.2-1.2 1.6 1.2 3.2 1.2 1.6-1.2 3.1-1.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  palm: '<path d="M12.6 10.5c.4 3.4.2 7-1 10.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M12.5 10c-1.8-3.6-5.4-4.5-9-3.4 2.6.3 4.4 1.5 5.4 3.6-2.2-.6-4.5.2-6 2 3-.9 6-.6 9.6-2.2z" fill="currentColor"/><path d="M12.5 10c1.4-3.9 5-5.4 8.7-4.6-2.5.5-4.2 1.9-5 4.1 2.2-.8 4.6-.2 6.3 1.5-3.1-.7-6.1-.2-10-1z" fill="currentColor"/><path d="M12.4 10c.2-2.6-1-4.9-3-6.5 2.8.4 4.6 2.4 4.8 5z" fill="currentColor"/><path d="M6 21h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  plane: '<path d="M21.2 4.6c.8-.8.8-2 0-2.6-.7-.6-1.8-.5-2.6.3L15 5.9 5.8 3.5 3.9 5.4l7.4 4.4-3.6 3.6-2.6-.4-1.6 1.6 3.6 1.9 1.9 3.6 1.6-1.6-.4-2.6 3.6-3.6 4.4 7.4 1.9-1.9-2.4-9.2z" fill="currentColor"/>',
  flag: '<path d="M5 21V3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5.5 4h11.5l-2.4 4 2.4 4H5.5z" fill="currentColor"/>',
  rocket: '<path d="M14.5 3.5c2.7-.9 5-1 6-.0.9 1 .9 3.3 0 6-1 3-3.6 6-7.2 8.2l-3.4-3.4-3.4-3.4C8.6 7.2 11.6 4.5 14.5 3.5z" fill="currentColor"/><circle cx="15.3" cy="8.7" r="1.9" fill="#fff"/><path d="M6.8 11l-3.6.5L1.8 14l4.4.6zM13 17.2l-.5 3.6-2.5 1.4-.6-4.4z" fill="currentColor"/><path d="M5.8 15.3c-1.5.6-2.6 2.4-2.8 5.4 3-.2 4.8-1.3 5.4-2.8z" fill="currentColor" opacity=".7"/>',
  globe: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.8 12h18.4M12 2.8c2.6 2.7 3.8 5.8 3.8 9.2s-1.2 6.5-3.8 9.2c-2.6-2.7-3.8-5.8-3.8-9.2S9.4 5.5 12 2.8zM4.2 7.2h15.6M4.2 16.8h15.6" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  users: '<circle cx="12" cy="7.2" r="3.4" fill="currentColor"/><circle cx="5.2" cy="9" r="2.5" fill="currentColor"/><circle cx="18.8" cy="9" r="2.5" fill="currentColor"/><path d="M5.6 19.5c0-3.8 2.8-6.6 6.4-6.6s6.4 2.8 6.4 6.6z" fill="currentColor"/><path d="M1 18.5c0-3 1.8-5.2 4.3-5.2 1 0 1.8.3 2.5.8-1.3 1.3-2.1 3-2.4 4.4zM23 18.5c0-3-1.8-5.2-4.3-5.2-1 0-1.8.3-2.5.8 1.3 1.3 2.1 3 2.4 4.4z" fill="currentColor"/>',
  chart: '<rect x="3" y="13" width="4.4" height="8" rx="1" fill="currentColor"/><rect x="9.8" y="9" width="4.4" height="12" rx="1" fill="currentColor"/><rect x="16.6" y="4" width="4.4" height="17" rx="1" fill="currentColor"/>',
  star: '<path d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" fill="currentColor"/>',
  check: '<path d="M4.5 12.5l5 5 10-11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5.3l3.4 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  shield: '<path d="M12 2.5l8 3v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10v-6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5l5 5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  user: '<circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 20.5c0-4.3 3.6-7.3 8-7.3s8 3 8 7.3z" fill="currentColor"/>',
  menu: '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  close: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2" fill="currentColor"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" fill="none" stroke="currentColor" stroke-width="2"/>',
  info: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.3" fill="currentColor"/>',
  alert: '<path d="M12 3.2l9.5 16.6h-19z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 9.5v4.8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.9" r="1.2" fill="currentColor"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.8 6.5l8.2 6.3 8.2-6.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z" fill="currentColor"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
  plug: '<path d="M9 2.5v5M15 2.5v5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M6 7.5h12v3.5a6 6 0 0 1-12 0z" fill="currentColor"/><path d="M12 17v4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 9.5h19" stroke="currentColor" stroke-width="2.6"/><path d="M6 15h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  linkedin: '<rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="currentColor"/><path d="M7.2 10v7M7.2 7v.01M11 17v-7M11 13.2c0-2 1.3-3.4 3-3.4s2.8 1.2 2.8 3.4V17" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.8" r="1.25" fill="currentColor"/>',
  wallet: '<rect x="2.5" y="6" width="19" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 10h19" stroke="currentColor" stroke-width="2"/><circle cx="16.5" cy="15" r="1.6" fill="currentColor"/><path d="M6 6V4.8A1.8 1.8 0 0 1 7.8 3h8.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  sparkle: '<path d="M12 2.5l2.1 5.4 5.4 2.1-5.4 2.1L12 17.5l-2.1-5.4-5.4-2.1 5.4-2.1z" fill="currentColor"/><path d="M19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor"/>',
  heart: '<path d="M12 20.5s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.5c0 5.4-7.5 10-7.5 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  'heart-fill': '<path d="M12 20.5s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.5c0 5.4-7.5 10-7.5 10z" fill="currentColor"/>',
  share: '<circle cx="18" cy="5.5" r="2.5" fill="currentColor"/><circle cx="6" cy="12" r="2.5" fill="currentColor"/><circle cx="18" cy="18.5" r="2.5" fill="currentColor"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" stroke="currentColor" stroke-width="2"/>',
  bag: '<path d="M5 8.5h14l-1 11.5H6z" fill="currentColor"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  sun: '<circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  compass: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor"/>',
  trend: '<path d="M3.5 17.5l5.5-6 4 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 7h5.5v5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  minus: '<path d="M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  youtube: '<rect x="1.8" y="5" width="20.4" height="14" rx="4" fill="currentColor"/><path d="M10 9.2v5.6l4.8-2.8z" fill="#fff"/>',
};

// Solid pictograms only the company pages use (the homepage's booking tiles), in their own sprite.
const COMPANY_PATHS = {
  'bed-solid': '<path d="M1.8 5.6a1.3 1.3 0 0 1 2.6 0v6.2h17.8v7.4a1.2 1.2 0 0 1-2.4 0v-1.7H4.4v1.7a1.3 1.3 0 0 1-2.6 0z" fill="currentColor"/><rect x="5.6" y="7.9" width="4.6" height="3.1" rx="1.3" fill="currentColor"/><path d="M11.2 7.9h7.4a3.6 3.6 0 0 1 3.6 3.6v.3h-11z" fill="currentColor"/>',
  'yacht-solid': '<path d="M9.4 4.6h4.4l2 2.9H7.6z" fill="currentColor"/><path d="M5.8 8.6h12.6l2.2 3.2H3.4z" fill="currentColor"/><path d="M1.6 13h20.8l-2.9 5.6a1.4 1.4 0 0 1-1.2.7H5.6a1.4 1.4 0 0 1-1.2-.7z" fill="currentColor"/><path d="M8.6 9.7h1.8M11.2 9.7h1.8M13.8 9.7h1.8" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><path d="M3.4 15.4h17.2" stroke="#fff" stroke-width="1.2"/>',
  island: '<path d="M12.3 9.6c.9 2.9 1 6.2.2 9.6h-2.2c.9-3.2.9-6.3.2-9.3z" fill="currentColor"/><path d="M11.9 9.8C10.6 6.4 7.4 5 3.6 5.8c2.5.5 4.3 1.8 5 3.6-2.3-.9-4.8-.3-6.6 1.6 3.3-.7 6.4-.3 9.9-1.2z" fill="currentColor"/><path d="M12.2 9.8c1.2-3.6 4.6-5.2 8.4-4.4-2.4.5-4.1 1.9-4.8 3.8 2.3-.9 4.8-.3 6.5 1.6-3.2-.8-6.4-.3-10.1-1z" fill="currentColor"/><path d="M12 9.6c-.1-2.6-1.4-4.6-3.4-5.9 2.9.2 4.8 2.2 5 4.9z" fill="currentColor"/><path d="M15.6 18.3l2.9-5.3v5.3z" fill="currentColor"/><path d="M2.5 21.5c2.3-2.2 5.5-3.3 9.5-3.3s7.2 1.1 9.5 3.3z" fill="currentColor"/>',
};

const symbols = paths => Object.entries(paths).map(([k, p]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${p}</symbol>`).join('');
const sprite = raw(`<svg xmlns="http://www.w3.org/2000/svg" class="sprite" width="0" height="0" aria-hidden="true">${symbols(PATHS)}</svg>`);
const companySprite = raw(`<svg xmlns="http://www.w3.org/2000/svg" class="sprite" width="0" height="0" aria-hidden="true">${symbols(COMPANY_PATHS)}</svg>`);

function icon(name, cls = '') {
  return raw(`<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`);
}

module.exports = { sprite, companySprite, icon, ICON_NAMES: Object.keys(PATHS) };
