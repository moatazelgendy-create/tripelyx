// Minimal auto-escaping HTML templates. Every interpolated value is escaped unless it is itself the
// result of `html` (or explicitly wrapped with `raw`, used only for trusted constants such as icons).
class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escape(v) {
  return String(v).replace(/[&<>"']/g, c => ESC[c]);
}

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escape(v);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

function raw(s) {
  return new SafeHtml(String(s));
}

// JSON safe to embed in a <script type="application/json"> block.
function jsonScript(obj) {
  return raw(JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'));
}

module.exports = { html, raw, escape, jsonScript, SafeHtml };
