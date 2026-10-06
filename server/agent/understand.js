// The agent's understanding layer, rule-based: turns what a traveler types into structured updates
// to the trip object and a list of intents the tool router acts on. It never produces a travel fact;
// every price, availability and rule the agent speaks comes from the deterministic engines.
//
// A model-backed provider can replace `understand` behind the same contract (see providers.js): it
// must return the same updates and intents, and the engines still do the searching and pricing.
const { addDays, today, isIsoDate, daysBetween } = require('../lib/dates');
const { STYLES, PRIORITIES } = require('../trips/optimizer');

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, another: 1, single: 1 };
const num = s => (s === undefined || s === null ? null : WORDS[String(s).toLowerCase()] !== undefined ? WORDS[String(s).toLowerCase()] : Number(String(s).replace(/[,$\s]/g, '')));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = s => MONTHS.findIndex(m => m.startsWith(String(s).toLowerCase().slice(0, 3)));

// Destination aliases beyond the names themselves (names are matched from the maps).
const DEST_ALIASES = {
  cabo: 'los-cabos', 'cabo san lucas': 'los-cabos', vegas: 'las-vegas', 'puerto rico': 'san-juan', 'costa rica': 'guanacaste', iceland: 'reykjavik', reykjavik: 'reykjavik',
  jamaica: 'montego-bay', 'dominican republic': 'punta-cana', 'the dominican': 'punta-cana', hawaii: 'honolulu', oahu: 'honolulu', egypt: 'new-alamein', alamein: 'new-alamein', 'el alamein': 'new-alamein',
  japan: 'tokyo', thailand: 'bangkok', italy: 'rome', france: 'paris', spain: 'barcelona', portugal: 'lisbon', indonesia: 'bali', nola: 'new-orleans', 'new york': 'new-york', nyc: 'new-york', manhattan: 'new-york',
};
const ORIGIN_ALIASES = { 'new york': 'NYC', nyc: 'NYC', 'san francisco': 'SFO', 'bay area': 'SFO', 'los angeles': 'LAX', chicago: 'CHI', miami: 'MIA', dallas: 'DFW', houston: 'HOU', atlanta: 'ATL', boston: 'BOS', seattle: 'SEA', denver: 'DEN' };

const money = (text, re) => { const m = text.match(re); if (!m) return null; const raw = m.slice(1).find(g => g && /\d/.test(g)); if (!raw) return null; let v = num(raw); if (/\d\s*k\b/i.test(m[0])) v *= 1000; return Number.isFinite(v) && v > 0 ? v : null; };
const has = (text, re) => re.test(text);

function parseDate(text, now) {
  const t = today(now);
  const inWindow = d => isIsoDate(d) && d >= addDays(t, 3) && daysBetween(t, d) <= 330;
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso && inWindow(iso[1])) return { depart: iso[1] };
  // "June 10", "Jun 10th", "10 June", "June 10-15", "June 10 to June 15"
  const m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:-|–|to|through|until)\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?)?/i)
    || text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i);
  if (m) {
    const monthFirst = isNaN(Number(m[1]));
    const mi = monthIndex(monthFirst ? m[1] : m[2]);
    const day = Number(monthFirst ? m[2] : m[1]);
    const end = monthFirst && m[3] ? Number(m[3]) : null;
    if (mi >= 0 && day >= 1 && day <= 31) {
      const y0 = Number(t.slice(0, 4));
      for (const y of [y0, y0 + 1]) {
        const d = `${y}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (inWindow(d)) return { depart: d, nights: end && end > day ? end - day : null };
      }
    }
  }
  const only = text.match(/\b(?:in|during|for)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i) || text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
  if (only) {
    const mi = monthIndex(only[1]);
    const y0 = Number(t.slice(0, 4));
    for (const y of [y0, y0 + 1]) { const mth = `${y}-${String(mi + 1).padStart(2, '0')}`; if (mth > t.slice(0, 7)) return { month: mth }; }
  }
  return null;
}

function destinationIn(text, maps) {
  const lower = ` ${text.toLowerCase()} `;
  // Longest alias or name first so "new york" beats "york" and "miami beach" beats "miami".
  const names = [...maps.listDestinations().map(d => [d.name.toLowerCase(), d.id]), ...Object.entries(DEST_ALIASES)].sort((a, b) => b[0].length - a[0].length);
  for (const [name, id] of names) {
    const re = new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    const m = lower.match(re);
    if (!m || !maps.getDestination(id)) continue;
    const before = lower.slice(0, m.index + m[1].length).slice(-24);
    // "from Miami" is an origin, not Miami Beach; "to Miami Beach" is a destination.
    if (/\b(from|leaving|departing|out of|depart|flying from)\s*$/.test(before) && !/beach/.test(name)) continue;
    return id;
  }
  return null;
}

function originIn(text, maps) {
  const upper = text.toUpperCase();
  for (const o of maps.listOrigins()) for (const a of o.airports) {
    if (new RegExp(`(^|[^A-Z])${a.code}([^A-Z]|$)`).test(upper)) return { origin: o.id, airport: a.code };
  }
  const lower = ` ${text.toLowerCase()} `;
  const aliases = [...maps.listOrigins().map(o => [o.city.toLowerCase(), o.id]), ...Object.entries(ORIGIN_ALIASES)].sort((a, b) => b[0].length - a[0].length);
  for (const [name, id] of aliases) {
    const re = new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    const m = lower.match(re);
    if (!m) continue;
    const before = lower.slice(0, m.index + m[1].length).slice(-24);
    const after = lower.slice(m.index + m[0].length).slice(0, 16);
    const originCue = /\b(from|leaving|departing|out of|depart(?:ing)?|flying from|fly from|based in|live in|home is)\s*$/.test(before) || /^\s*(departure|departing|airport)\b/.test(after);
    const destCue = /\b(to|in|visit|go to|going to|trip to)\s*$/.test(before);
    if (originCue && !destCue) return { origin: id };
    // A city that is only an origin (never a destination) counts without a cue.
    if (!destCue && !maps.listDestinations().some(d => d.name.toLowerCase() === name || DEST_ALIASES[name])) return { origin: id };
  }
  return null;
}

// What the message changes on the trip object. Only what the text says; nothing is inferred into a fact.
function extractUpdates(text, { maps, now = new Date() }) {
  const u = {};
  const ack = [];
  const lower = text.toLowerCase();

  // Money: a reserve, an amount to cut or add, a competitor's price, and only then the budget.
  const reserve = money(lower, /(?:keep|save|leave|hold|protect|set aside|reserve)\s+(?:at least\s+)?\$?([\d,]+k?)\s*(?:dollars\s+)?(?:for|to|after|aside|spending|in my pocket|on hand|available|back|untouched)\b/) || money(lower, /\$?([\d,]+k?)\s*(?:for spending|to spend|spending money|pocket money|after (?:i|we) (?:arrive|land|get there)|available after|for (?:food|meals|shopping|fun|activities|extras|emergencies|expenses|the trip itself))\b/);
  if (reserve) { u.protectedMoney = reserve * 100; u.budgetType = 'vacation'; ack.push(`keep $${reserve.toLocaleString('en-US')} for after you arrive`); }
  const cheaperBy = money(lower, /(?:cheaper|less|lower|down|cut|save me|reduce(?: it)?)\s+(?:it\s+)?(?:by\s+)?\$?([\d,]+k?)\b/) || money(lower, /\$?([\d,]+k?)\s*(?:cheaper|less|lower|off)\b/) || money(lower, /(?:take|give me|want)\s+\$?([\d,]+k?)\s+back/) || money(lower, /\bfind\s+(?:me\s+)?\$?([\d,]+k?)\b/);
  if (cheaperBy) u.cheaperBy = cheaperBy * 100;
  const moreBy = money(lower, /(?:spend|add|use|put in|invest)\s+(?:another|an extra|an additional|up to)?\s*\$?([\d,]+k?)\s*(?:more|extra|if|only|on)?/) || money(lower, /\$?([\d,]+k?)\s+more\b/) || money(lower, /(?:gave|give) you\s+\$?([\d,]+k?)/);
  if (moreBy && !cheaperBy) u.moreBy = moreBy * 100;
  const competitor = money(lower, /(?:found|have|got|seen|saw|quoted|offered|booked|looking at|considering)\b[^$\d]{0,60}?(?:for|at|is|costs?|priced at)\s+\$?([\d,]+k?)\b/) || (has(lower, /\b(beat|quote|deal|competitor|other site|expedia|booking\.com|their)\b/) ? money(lower, /\$?([\d,]{3,}k?)\b/) : null);
  if (competitor && has(lower, /\b(beat|found|quote|quoted|deal|their|other|competitor|offered)\b/)) { u.competitorTotal = competitor * 100; }
  const budget = money(lower, /(?:budget|have|spend|max(?:imum)?|limit|under|up to|around|about|total|got|cap|ceiling|no more than|at most)\s+(?:of\s+|is\s+|about\s+|around\s+)?\$?([\d,]+k?)\b/) || money(lower, /\$\s?([\d,]+k?)\b(?!\s*(?:cheaper|less|lower|off|more|back|for spending))/);
  if (budget && budget !== cheaperBy && budget !== moreBy && budget !== reserve && budget !== competitor && budget >= 100) {
    u.budget = budget * 100;
    u.budgetPer = has(lower, /\b(per person|pp|each|a head|per head)\b/) ? 'pp' : 'total';
    ack.push(`$${budget.toLocaleString('en-US')} max${u.budgetPer === 'pp' ? ' per person' : ''}`);
  }
  if (has(lower, /\b(just|only) the booking\b|\bbooking (budget|only)\b|\bnot counting spending\b/)) { u.budgetType = 'booking'; ack.push('that is the booking budget'); }
  else if (has(lower, /\b(whole|entire|total|all-in|all in) (vacation|trip|budget|thing)\b|\bincluding spending\b|\beverything included\b/)) { u.budgetType = 'vacation'; }

  // Who is going.
  const n = lower.match(/\b(\d+|two|three|four|five|six|seven|eight|nine)\s*(?:people|persons|adults|travelers|travellers|of us|pax|guests|friends)\b/);
  const plusFriends = lower.match(/\b(?:me|myself) (?:and|\+|with) (?:my )?(\d+|two|three|four|five|six)\s*(?:friends|buddies|mates|cousins)\b/);
  if (has(lower, /\b(just me|solo|alone|by myself|on my own|single traveler|myself only|one person|1 person)\b/)) { u.who = 'solo'; u.travelers = 1; ack.push('just you'); }
  else if (has(lower, /\b(girlfriend|boyfriend|wife|husband|partner|fianc[ée]e?|spouse|honeymoon|anniversary|couple|two of us|the 2 of us|us two|my (?:gf|bf|so))\b/)) { u.who = 'couple'; u.travelers = 2; ack.push('two travelers'); }
  else if (plusFriends) { u.who = 'friends'; u.travelers = Math.min(9, num(plusFriends[1]) + 1); ack.push(`${u.travelers} travelers`); }
  else if (has(lower, /\b(family|kids?|children|child|toddler|teen(?:ager)?s?|my (?:son|daughter|parents|mom|dad))\b/)) { u.who = 'family'; u.travelers = n ? Math.min(9, num(n[1])) : (lower.match(/family of (\d+)/) ? Math.min(9, Number(lower.match(/family of (\d+)/)[1])) : 4); ack.push(`a family of ${u.travelers}`); }
  else if (n && has(lower, /\bfriends\b/)) { u.who = 'friends'; u.travelers = Math.min(9, num(n[1])); ack.push(`${u.travelers} friends`); }
  else if (n) { u.travelers = Math.min(9, num(n[1])); u.who = u.travelers === 1 ? 'solo' : u.travelers === 2 ? 'couple' : 'friends'; ack.push(`${u.travelers} travelers`); }
  else if (has(lower, /\bmy friends\b|\bwith friends\b|\bfriends trip\b|\bguys trip\b|\bgirls trip\b/)) { u.who = 'friends'; }

  // Where from, where to.
  const o = originIn(text, maps);
  if (o) { u.origin = o.origin; ack.push(`from ${maps.getOrigin(o.origin).city}`); }
  const d = destinationIn(text, maps);
  if (d) { u.destination = d; ack.push(`to ${maps.getDestination(d).name}`); }
  if (has(lower, /\b(don'?t care where|anywhere|wherever|surprise me|pick (?:the|a) (?:best|place|destination)|somewhere new|you choose|up to you|no preference on (?:the )?destination)\b/)) { u.destination = null; u.anywhere = true; u.style = u.style || 'surprise'; ack.push('anywhere'); }
  if (has(lower, /\b(another country|different country|abroad|international|overseas|outside the (?:us|usa|country))\b/)) { u.region = 'international'; ack.push('somewhere international'); }

  // How long.
  const nightsM = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a)\s*-?\s*nights?\b/);
  const daysM = lower.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s*-?\s*days?\b/);
  if (nightsM) { u.nights = Math.max(2, Math.min(14, num(nightsM[1]))); ack.push(`${u.nights} nights`); }
  else if (has(lower, /\b(a|one|1) week\b/)) { u.nights = 7; ack.push('7 nights'); }
  else if (has(lower, /\b(two|2) weeks\b/)) { u.nights = 14; ack.push('14 nights'); }
  else if (has(lower, /\blong weekend\b/)) { u.nights = 3; ack.push('3 nights (a long weekend)'); }
  else if (has(lower, /\bweekend\b/)) { u.nights = 2; ack.push('2 nights (a weekend)'); }
  else if (daysM && !has(lower, /\bday later\b|\bdays? (?:earlier|before|after)\b/)) { u.nights = Math.max(2, Math.min(14, num(daysM[1]) - 1)); ack.push(`${num(daysM[1])} days, so ${u.nights} nights`); }

  // When.
  const when = parseDate(text, now);
  if (when && when.depart) { u.depart = when.depart; u.dateMode = 'exact'; if (when.nights && !u.nights) { u.nights = Math.max(2, Math.min(14, when.nights)); ack.push(`${u.nights} nights`); } ack.push(`leaving ${when.depart}`); }
  else if (when && when.month) { u.month = when.month; u.dateMode = 'flexible'; ack.push(`in ${MONTHS[Number(when.month.slice(5)) - 1]}`); }
  if (has(lower, /\b(flexible|any dates|anytime|whenever|move them|you can move|dates are open|dates don'?t matter|no fixed dates|not fixed|open dates)\b/)) { u.dateMode = 'anytime'; u.depart = null; u.month = null; ack.push('dates flexible'); }
  else if (has(lower, /\b(fixed|exact dates|those dates|can'?t move|cannot move|must be those|have to be there)\b/) && !u.depart) { u.dateMode = 'exact'; }

  // Style and priorities.
  if (has(lower, /\ball[- ]inclusive\b/)) { u.style = 'all-inclusive'; u.hotelAllInclusive = true; ack.push('all-inclusive'); }
  else if (has(lower, /\b(beach|beaches|sand|sea|ocean|coast|island|tropical|caribbean)\b/)) { u.style = 'beach'; ack.push('beach'); }
  else if (has(lower, /\b(romantic|honeymoon|anniversary)\b/)) { u.style = 'romantic'; ack.push('romantic'); }
  else if (has(lower, /\b(adventure|hiking|hike|outdoors|surf(?:ing)?|climbing|diving)\b/)) { u.style = 'adventure'; ack.push('adventure'); }
  else if (has(lower, /\b(city break|city trip|cities|museums?|culture|food scene|nightlife|urban|big city)\b/)) { u.style = 'city'; ack.push('a city break'); }
  else if (has(lower, /\bfamily\b|\bkids?\b/) && !u.style) { u.style = 'family'; }
  if (has(lower, /\b(warm|sunny|sun|hot|heat|tropical|somewhere warm)\b/)) { u.warm = true; if (!u.style) u.style = 'beach'; if (!ack.includes('beach')) ack.push('somewhere warm'); }
  if (has(lower, /\b(hotel (?:matters|is (?:the )?most important|first|quality)|nice hotel|great hotel|best hotel|good hotel|hotel is everything)\b/)) { u.priority = 'hotel'; ack.push('the hotel matters most'); }
  else if (has(lower, /\b(cheapest|as cheap as possible|price matters(?: most)?|lowest price|save (?:as much )?money|price first|budget first)\b/)) { u.priority = 'price'; ack.push('lowest price first'); }
  else if (has(lower, /\b(as long as possible|more nights matter|longer (?:is better|trip)|max(?:imum)? nights)\b/)) { u.priority = 'longer'; ack.push('a longer trip first'); }
  else if (has(lower, /\b(experiences?|activities|things to do|tours?) (?:matter|first|are (?:the )?most important)\b/)) { u.priority = 'activities'; ack.push('experiences first'); }
  else if (has(lower, /\b(flights? (?:matter|first|are (?:the )?most important)|short flights?|easy flights?)\b/)) { u.priority = 'flights'; ack.push('the flights matter most'); }

  // Rules: hard, soft, and relaxations. A hard rule is never silently violated.
  if (has(lower, /\b(allow|accept|fine with|ok with|okay with|take|i'?ll take|can do|don'?t mind) (?:a |one |the )?(?:stop|connection|layover)s?\b|\bconnections? (?:are|is) (?:fine|ok|okay)\b|\bprice matters more\b|\bone stop is fine\b/)) { u.flightStops = 'any'; u.flightRule = null; ack.push('a stop is fine'); }
  else if (has(lower, /\b(prefer(?:ably)?|ideally|if possible|would like|would love)\b[^.]{0,20}\b(nonstop|non-stop|non stop|direct)\b|\b(nonstop|direct)\b[^.]{0,12}\b(if possible|if (?:it|you) can|preferably|ideally)\b/)) { u.flightStops = 'nonstop'; u.flightRule = 'soft'; ack.push('nonstop if possible'); }
  else if (has(lower, /\b(nonstop|non-stop|non stop|direct flights?|no connections?|no layovers?|hate connections|hate layovers|no stops|never (?:show|give) me a (?:connection|stop|layover)|only nonstop|nonstop only)\b/)) { u.flightStops = 'nonstop'; u.flightRule = 'hard'; ack.push('nonstop only'); }
  const stars = lower.match(/\b([345])[- ]?stars?\b/);
  if (stars) { u.minStars = Number(stars[1]); ack.push(`${stars[1]}-star or better`); }
  if (has(lower, /\b(beachfront|on the beach|beach front|oceanfront)\b/)) { u.beachfront = true; ack.push('beachfront'); }
  if (has(lower, /\bbreakfast\b/) && !has(lower, /\bno breakfast\b/)) { u.breakfast = true; ack.push('breakfast included'); }
  if (has(lower, /\b(transfer|pick[- ]?up from the airport|airport (?:shuttle|ride))\b/) && !has(lower, /\bno transfer\b/)) { u.transfer = true; ack.push('airport transfers'); }
  if (has(lower, /\b(refundable|free cancellation|can cancel|cancellable)\b/) && !has(lower, /\bnon-?refundable\b/)) { u.refundable = true; ack.push('refundable'); }

  // Relaxations offered when nothing fits, and the words that accept them.
  if (has(lower, /\bany style\b|\bdon'?t care about (?:the )?style\b|\bstyle doesn'?t matter\b/)) { u.style = 'surprise'; ack.push('any style'); }
  if (has(lower, /\bany star class\b|\bany stars\b|\bstars don'?t matter\b|\bdrop the star/)) { u.clearStars = true; ack.push('any star class'); }
  if (has(lower, /\b(allow|ok with|fine with|accept|go) (?:up to )?(?:10 ?%|ten percent) over\b|\bgo over\b|\bover budget is (?:fine|ok|okay)\b/)) { u.allowOver = true; ack.push('up to 10% over is allowed'); }
  const useReserve = money(lower, /\buse\s+\$?([\d,]+k?)\s+(?:of|from)\s+(?:my|the)\s+(?:reserve|spending money|protected money)/);
  if (useReserve) { u.useReserve = useReserve * 100; ack.push(`use $${useReserve.toLocaleString('en-US')} of your reserve`); }

  // Locks and unlocks, in the traveler's words.
  const lockWord = /\b(hotel|flights?|dates?|nights|destination|place|everything|this|it|budget)\b/;
  const lockM = lower.match(new RegExp(`\\b(?:don'?t (?:change|touch|move)|do not (?:change|touch|move)|never change|keep|lock|hold|leave)\\s+(?:the |my |that |those )?${lockWord.source}`));
  if (lockM && !has(lower, /\bkeep (?:the )?\$|\bkeep my (?:deal|money)|\bkeep (?:it|current)\b.*\b(cheaper|flight)\b/)) {
    const w = lockM[1];
    const locks = {};
    if (/hotel/.test(w)) locks.hotel = true;
    if (/flight/.test(w)) locks.flight = true;
    if (/date/.test(w)) locks.dates = true;
    if (/night/.test(w)) locks.nights = true;
    if (/destination|place/.test(w)) locks.dest = true;
    if (/budget/.test(w)) locks.budget = true;
    if (/everything|this|it/.test(w)) { locks.hotel = true; locks.flight = true; locks.dates = true; locks.nights = true; locks.dest = true; }
    const except = lower.match(/\bexcept (?:for )?(?:the )?(hotel|flights?|dates?|nights|destination)\b/);
    if (except) { const e = except[1]; if (/hotel/.test(e)) locks.hotel = false; if (/flight/.test(e)) locks.flight = false; if (/date/.test(e)) locks.dates = false; if (/night/.test(e)) locks.nights = false; if (/destination/.test(e)) locks.dest = false; }
    u.locks = locks;
    const kept = Object.entries(locks).filter(([, v]) => v).map(([k]) => ({ hotel: 'the hotel', flight: 'the flights', dates: 'the dates', nights: 'the length', dest: 'the destination', budget: 'the budget' })[k]);
    if (kept.length) ack.push(`${kept.join(', ')} locked`);
  }
  const unlockM = lower.match(/\b(?:unlock|you can change|feel free to change|free to change|ok to change)\s+(?:the |my )?(hotel|flights?|dates?|nights|destination|everything)\b/);
  if (unlockM) { const w = unlockM[1]; u.unlocks = { hotel: /hotel|everything/.test(w), flight: /flight|everything/.test(w), dates: /date|everything/.test(w), nights: /night|everything/.test(w), dest: /destination|everything/.test(w), budget: /everything/.test(w) }; ack.push(/everything/.test(w) ? 'everything unlocked' : `${w} unlocked`); }

  return { updates: u, ack };
}

// What the traveler wants done. Several can apply; the router handles them in a sensible order.
const INTENTS = [
  ['restart', /\b(start over|start again|reset|from scratch|new trip|clear everything)\b/],
  ['stop', /\b(stop (?:the )?search(?:ing)?|that'?s enough|enough searching|stop looking)\b/],
  ['challenge', /\b(can you beat|beat (?:it|this|that|their|the price|my (?:quote|deal))|found (?:this|a|the) trip|i was quoted|i have a quote|other site|competitor|their price|better than (?:this|what i found))\b/],
  ['book', /\b(book (?:it|this|that|the trip|now)?|buy|purchase|reserve it|check ?out|pay(?: now)?|let'?s go with (?:it|this)|i'?ll take (?:it|this|the trip))\b/],
  ['approve', /^(?:yes|yep|yeah|yup|ok(?:ay)?|sure|fine|do it|do it anyway|anyway|go ahead|go over|take it|take it anyway|accept|agreed|please do|sounds good|switch|switch to (?:the )?better(?: option)?|take (?:the )?(?:upgrade|cheaper|challenger|better|new|proposal|one stop|one-stop|our pick|save more|first)(?: \w+)*|use (?:it|that)|a|b|c|option a|option b|option c)[.!]?$/i],
  ['decline', /^(?:no|nope|nah|keep (?:current|it|mine|everything|what i have|my (?:trip|deal|hotel|money)|the (?:current|old|first)(?: one)?)|don'?t|leave it|stay|never mind|no thanks|keep the \$?[\d,]+)[.!]?$/i],
  ['stopSaves', /\b(what (?:does|would) (?:one|a) (?:stop|connection|layover) save|show me what (?:one|a) (?:stop|connection) saves|how much (?:does|would|do) (?:a|one) (?:stop|connection|layover) save|one stop saves?)\b/],
  ['catch', /\b(what'?s the catch|what is the catch|downside|trade-?offs?|what am i giving up|anything wrong|what'?s wrong with)\b/],
  ['recommend', /\b(which (?:one )?(?:would|should) (?:you|i) (?:pick|choose|book|take)|your pick|what would you (?:book|pick|choose|do)|recommend|which is best|best one)\b/],
  ['why', /\b(why (?:this|that|not the cheap|did you pick|did you choose|this one))\b/],
  ['compare', /\b(compare|side by side)\b/],
  ['next', /\b(what (?:do i|should i|do we) (?:need to )?do next|next steps?|what now|what happens now|to-?do)\b/],
  ['cancelInfo', /\b(if i cancel|what if (?:i|we) cancel|cancel(?:lation)? (?:policy|terms)|refund|can i cancel)\b/],
  ['afford', /\b(afford|can i (?:still )?(?:pay for|do|add)|enough (?:money|left) for)\b/],
  ['car', /\b(need a car|rent(?:al)? car|hire a car|car rental|should i rent)\b/],
  ['flightChange', /\b(flight (?:changes?|is changed|gets? (?:cancell?ed|changed|moved)|schedule change)|airline changes?|if (?:my|the) flight)\b/],
  ['extend', /\b(extend|stay (?:a|one) (?:day|night) longer|add (?:a|one|1) (?:more )?night|(?:one|1|an extra|another) more night|give me (?:one|1|a) more night)\b/],
  ['shorten', /\b((?:one|1|a) (?:less|fewer) night|(?:one|1|a) night (?:less|fewer|shorter)|shorter|cut (?:a|one) night|drop (?:a|one) night|reduce to \d+ nights)\b/],
  ['watch', /\b(watch for|set (?:up )?a watch|alert me|notify me|tell me when|let me know when)\b/],
  ['elsewhere', /\b(another country|somewhere else|different (?:place|destination|country|city)|try (?:another|a different|somewhere)|change the destination|not (?:cancun|there|that place)|anywhere else)\b/],
  ['easier', /\b(easier|simpler|less hassle|less travel|shorter travel|more convenient|easy trip|make this easier)\b/],
  ['cheaper', /\b(cheaper|too expensive|too much|less money|lower(?: the)? price|bring (?:it|the price) down|save me|cut the price|reduce the price|take \$?[\d,]+ back|find \$?[\d,]+|under budget|spend less|more affordable)\b/],
  ['better', /\b(make it better|better|upgrade|improve|nicer|spend (?:the )?(?:rest|full|remaining|whole|entire)|spend (?:another|an extra|up to)?\s*\$?[\d,]+|if it (?:actually |really )?helps|what (?:can|would|does) \$?[\d,]+ (?:more )?(?:get|buy|do)|use the rest|what'?s the best i can get)\b/],
  ['lock', /\b(don'?t (?:change|touch|move)|do not (?:change|touch|move)|never change|lock|keep everything except|keep the hotel|keep the flights?|keep the dates|keep my hotel)\b/],
  ['nonstopRule', /\b(only nonstop|nonstop only|never (?:show|give) me a (?:connection|stop|layover)|no connections?|no layovers?|hate connections|must be nonstop)\b/],
  ['build', /\b(build|rebuild|plan|find (?:me|us)|get (?:me|us)|best trip|show me trips|show me (?:some|a few) (?:options|trips)|i want (?:to go|a trip)|i'?d like (?:to go|a trip)|take (?:me|us)|let'?s go|trip for|vacation|holiday|getaway|escape|somewhere|search again|try again)\b/],
];

function understand(text, state, { maps, now = new Date() } = {}) {
  const clean = String(text || '').trim().slice(0, 600);
  const lower = clean.toLowerCase();
  const { updates, ack } = extractUpdates(clean, { maps, now });
  const intents = INTENTS.filter(([, re]) => re.test(lower)).map(([k]) => k);
  // An answer to the question the agent just asked, read in that light.
  const pending = state && state.pending;
  if (pending === 'budgetType') {
    if (/\b(booking|just the booking|only the booking|booking only|first)\b/.test(lower)) updates.budgetType = 'booking';
    else if (/\b(whole|entire|everything|total|vacation|all of it|second)\b/.test(lower)) updates.budgetType = 'vacation';
  }
  if (pending === 'reserve' && updates.budget && !updates.protectedMoney) { updates.protectedMoney = updates.budget; delete updates.budget; updates.budgetType = 'vacation'; }
  if (pending === 'reserve' && /^\s*\$?\s*([\d,]+)\s*$/.test(lower)) { updates.protectedMoney = num(lower.match(/([\d,]+)/)[1]) * 100; delete updates.budget; updates.budgetType = 'vacation'; }
  if (pending === 'dates') {
    if (/\b(fixed|exact|those|can'?t move|cannot move|no)\b/.test(lower) && !updates.depart) updates.dateMode = 'exact';
    if (/\b(move|flexible|yes|whenever|anytime|open|go ahead|you can)\b/.test(lower) && !updates.depart) { updates.dateMode = 'anytime'; updates.depart = null; }
  }
  if (pending === 'origin' && !updates.origin) { const o = originIn(clean, maps); if (o) updates.origin = o.origin; }
  if (pending === 'nights' && !updates.nights) { const m = lower.match(/\b(\d+)\b/); if (m) updates.nights = Math.max(2, Math.min(14, Number(m[1]))); }
  if (pending === 'budget' && !updates.budget) { const m = lower.match(/([\d,]+k?)/); if (m && num(m[1]) >= 100) { updates.budget = num(m[1]) * (/k$/i.test(m[1]) ? 1000 : 1) * 100; updates.budgetPer = 'total'; } }
  if (pending === 'options' && /^\s*(?:option\s*)?([abc])\b/i.test(lower)) updates.option = lower.match(/^\s*(?:option\s*)?([abc])\b/i)[1].toUpperCase();
  if (pending === 'challenge' && !updates.competitorTotal) { const m = lower.match(/\$?\s*([\d,]{3,}k?)\b/); if (m && num(m[1]) >= 100) { updates.competitorTotal = num(m[1]) * (/k$/i.test(m[1]) ? 1000 : 1) * 100; delete updates.budget; } if (!intents.includes('challenge')) intents.push('challenge'); }
  // A bare number answers whatever was asked.
  if (/^\s*\$?\s*[\d,]+k?\s*$/.test(lower) && !pending && !updates.budget) { const v = num(lower.match(/([\d,]+)/)[1]) * (/k/i.test(lower) ? 1000 : 1); if (v >= 100) { updates.budget = v * 100; updates.budgetPer = 'total'; } }

  const unknown = !intents.length && !Object.keys(updates).length;
  return { text: clean, updates, intents, ack, unknown };
}

module.exports = { understand, extractUpdates, parseDate, destinationIn, originIn, INTENTS, DEST_ALIASES };
