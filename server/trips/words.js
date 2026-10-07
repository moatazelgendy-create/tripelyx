// Customer text, written one way everywhere. A date reads as the pages write it ("Tue, 5 Jan 2027"),
// whether a page, a card or the agent says it: the pages (views/trips/common) and the engines' own
// sentences use this one formatter, so an engine sentence the agent prints raw never carries an ISO
// date. Only the words change: a field that carries a date as data (a landing date, a range's ends,
// a checked date) stays ISO for the code that reads it.
const LONG = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
function longDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso.length === 7 ? `${iso}-01T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : LONG.format(d);
}
// Sentences joined into one text never stop twice: a sentence that already ends keeps its own stop
// and one that does not gets one ("A. B."), and a sentence used as a clause of another loses its stop
// first ("A; B.", never "A.; B.."), so no join can print ".." or ". .".
const ENDS = /[.!?…]["'”’)\]]*$/;
const clause = s => String(s ?? '').trim().replace(/[\s.;:,]+$/, '');
const sentence = s => { const t = String(s ?? '').trim(); return !t ? '' : ENDS.test(t) ? t : `${t}.`; };
const sentences = (...parts) => parts.flat().map(sentence).filter(Boolean).join(' ');
module.exports = { longDate, clause, sentence, sentences };
