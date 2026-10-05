// Tiny cookie helpers (no dependency). Booking access cookies are HttpOnly, SameSite=Strict and Secure
// whenever the site is HTTPS-only (see HTTPS_ONLY in config), one per booking reference.
function readCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

function bookingCookieName(ref) {
  return `txbk_${String(ref || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20)}`;
}

function setBookingCookie(res, ref, token, config) {
  const attrs = [
    `${bookingCookieName(ref)}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${60 * 60 * 24 * 90}`,
  ];
  if (config.httpsOnly) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

module.exports = { readCookies, bookingCookieName, setBookingCookie };
