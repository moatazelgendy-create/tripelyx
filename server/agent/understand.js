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

// Experience Max: the memory chips in the traveler's words, each with the chip's own label first.
// Only read when the agent asked WHAT DO YOU WANT TO REMEMBER?, or in experience mode when the message
// is a chip or says it is about what to remember: "beach" in any other sentence stays a style.
const GOAL_WORDS = [
  ['beach', /\b(?:amazing beach|beach(?:es)?|the sea|ocean|sand)\b/],
  ['food', /\b(?:incredible food|food(?:ie)?|eat(?:ing)?|cuisine|culinary|restaurants?)\b/],
  ['adventure', /\badventur(?:e|es|ous)\b|\b(?:thrills?|adrenaline)\b/],
  ['nightlife', /\b(?:nightlife|night life|party|parties|partying|clubbing|clubs|bars)\b/],
  ['romantic', /\b(?:romantic|romance|honeymoon|anniversary)\b/],
  ['nature', /\b(?:nature|wildlife|outdoors|national parks?|landscapes?)\b/],
  ['culture', /\b(?:culture|cultural|history|historic(?:al)?|museums?|art)\b/],
  ['family', /\b(?:family memories|family|kids?|children)\b/],
  ['new', /\b(?:something (?:i|we)(?:'ve| have) never done|never done|something new|something different|new experiences?)\b/],
  ['surprise', /\b(?:surprise me|surprise|you choose|you pick|anything)\b/],
];
// Up to three, in the order the words come.
function goalsIn(lower) {
  return GOAL_WORDS.map(([k, re]) => { const m = lower.match(re); return m ? { k, at: m.index } : null; }).filter(Boolean).sort((a, b) => a.at - b.at).map(x => x.k).slice(0, 3);
}
// What was actually worth it after a trip: the chips the booking home offers, in words.
const WORTH_WORDS = [['Hotel', /\b(?:hotel|room|resort)\b/], ['Food', /\b(?:food|meals?|restaurants?|eating)\b/], ['Main experience', /\b(?:main experience|the experience|excursion|tour|activit(?:y|ies))\b/], ['Free time', /\b(?:free time|downtime|open days?|time off)\b/], ['Nightlife', /\b(?:nightlife|night life|bars|clubs)\b/], ['Location', /\b(?:location|area|neighbou?rhood)\b/], ['Other', /\bother\b/]];
function worthFrom(lower) {
  const out = { worth: [], notWorth: [] };
  const chip = lower.match(/^\s*(not )?worth it\s*:\s*(.+?)[.!]?\s*$/);
  const clauses = chip ? [{ text: chip[2], not: !!chip[1] }] : lower.split(/[,.;]|\bbut\b/).map(t => ({ text: t, not: /\b(?:not|wasn'?t|weren'?t|isn'?t|didn'?t|never|waste[d]?)\b|n't\b/.test(t) }));
  for (const c of clauses) for (const [label, re] of WORTH_WORDS) if (re.test(c.text)) { const list = c.not ? out.notWorth : out.worth; if (!list.includes(label)) list.push(label); }
  return out;
}

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
  const lower = ` ${text.toLowerCase().replace(/[\u2018\u2019]/g, "'")} `;
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
  const lower = ` ${text.toLowerCase().replace(/[\u2018\u2019]/g, "'")} `;
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
  const lower = text.toLowerCase().replace(/[\u2018\u2019]/g, "'");

  // Money: a reserve, an amount to cut or add, a competitor's price, and only then the budget.
  const reserve = money(lower, /(?:keep|save|leave|hold|protect|set aside|reserve)\s+(?:at least\s+)?\$?([\d,]+k?)\s*(?:dollars\s+)?(?:for|to|after|aside|spending|in my pocket|on hand|available|back|untouched)\b/) || money(lower, /\$?([\d,]+k?)\s*(?:for spending|to spend|spending money|pocket money|after (?:i|we) (?:arrive|land|get there)|available after|for (?:food|meals|shopping|fun|activities|extras|emergencies|expenses|the trip itself))\b/);
  if (reserve) { u.protectedMoney = reserve * 100; u.budgetType = 'vacation'; ack.push(`keep $${reserve.toLocaleString('en-US')} for after you arrive`); }
  const cheaperBy = money(lower, /(?:cheaper|less|lower|down|cut|save me|reduce(?: it)?)\s+(?:it\s+)?(?:by\s+)?\$?([\d,]+k?)\b/) || money(lower, /\$?([\d,]+k?)\s*(?:cheaper|less|lower|off)\b/) || money(lower, /(?:take|give me|want)\s+\$?([\d,]+k?)\s+back/) || money(lower, /\bfind\s+(?:me\s+)?\$?([\d,]+k?)\b/) || money(lower, /\bsave\s+(?:me\s+)?(?:another|an extra|a further)\s+\$?([\d,]+k?)\b/);
  if (cheaperBy) u.cheaperBy = cheaperBy * 100;
  const moreBy = money(lower, /(?:spend|add|use|put in|invest)\s+(?:another|an extra|an additional|up to)?\s*\$?([\d,]+k?)\s*(?:more|extra|if|only|on)?/) || money(lower, /\$?([\d,]+k?)\s+more\b(?!\s+(?:nights?|days?|experiences?|activities|things|people|travell?ers|hours?|stops?))/) || money(lower, /(?:gave|give) you\s+\$?([\d,]+k?)/);
  if (moreBy && !cheaperBy) u.moreBy = moreBy * 100;
  const competitor = money(lower, /(?:found|have|got|seen|saw|quoted|offered|booked|looking at|considering)\b[^$\d]{0,60}?(?:for|at|is|costs?|priced at)\s+\$?([\d,]+k?)\b/) || (has(lower, /\b(beat|quote|deal|competitor|other site|expedia|booking\.com|their)\b/) ? money(lower, /\$?([\d,]{3,}k?)\b/) : null);
  if (competitor && has(lower, /\b(beat|found|quote|quoted|deal|their|other|competitor|offered)\b/)) { u.competitorTotal = competitor * 100; }
  const budget = money(lower, /(?:budget|have|spend|max(?:imum)?|limit|under|up to|around|about|total|got|cap|ceiling|no more than|at most|more than)\s+(?:of\s+|is\s+|about\s+|around\s+)?\$?([\d,]+k?)\b/) || money(lower, /\$\s?([\d,]+k?)\b(?!\s*(?:cheaper|less|lower|off|more|back|for spending))/);
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
  if (has(lower, /\b(abroad|international|overseas|outside the (?:us|usa|country))\b/)) { u.region = 'international'; ack.push('somewhere international'); }

  // How long. "5 nights is not enough, make it 7 nights" names two lengths: the one asked for follows
  // the asking words; otherwise the first length named is the one meant.
  // "One night less" and "a night longer" are a change of one night (the extend and shorten asks), not a length.
  const NIGHTS = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a)\s*-?\s*nights?\b(?!\s+(?:less|fewer|shorter|longer|more|earlier|later)\b)/;
  const nightsM = lower.match(new RegExp(`\\b(?:make (?:it|that|this)|change (?:it |that |this )?to|switch to|rather|instead)\\s+${NIGHTS.source}`)) || lower.match(new RegExp(`\\b${NIGHTS.source}`));
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
  if (has(lower, /\b(flexible|any dates|anytime|whenever|move them|you can move|dates are open|dates don'?t matter|no fixed dates|not fixed|open dates)\b/)) {
    // "Anytime in June" is flexible inside June; "anytime" alone opens the dates.
    if (when && when.month && !when.depart) ack.push('dates flexible within the month');
    else { u.dateMode = 'anytime'; u.depart = null; u.month = null; ack.push('dates flexible'); }
  }
  else if (has(lower, /\b(fixed|exact dates|those dates|can'?t move|cannot move|must be those|have to be there)\b/) && !u.depart) { u.dateMode = 'exact'; }

  // Style and priorities.
  if (has(lower, /\ball[- ]inclusive\b/)) { u.style = 'all-inclusive'; u.hotelAllInclusive = true; ack.push('all-inclusive'); }
  else if (has(lower, /\b(beach|beaches|sand|sea|ocean|coast|island|tropical|caribbean)\b/)) { u.style = 'beach'; ack.push('beach'); }
  else if (has(lower, /\b(romantic|honeymoon|anniversary)\b/)) { u.style = 'romantic'; ack.push('romantic'); }
  else if (has(lower, /\b(adventure|hiking|hike|outdoors|surf(?:ing)?|climbing|diving)\b/)) { u.style = 'adventure'; ack.push('adventure'); }
  else if (has(lower, /\b(city break|city trip|cities|museums?|culture|food scene|nightlife|urban|big city)\b/)) { u.style = 'city'; ack.push('a city break'); }
  else if (has(lower, /\bfamily\b|\bkids?\b/) && !u.style) { u.style = 'family'; }
  if (has(lower, /\b(warm|warmer|sunny|sunnier|sun|hot|hotter|heat|tropical|somewhere warm)\b/)) { u.warm = true; if (!u.style) u.style = 'beach'; if (!ack.includes('beach')) ack.push('somewhere warm'); }
  // "The hotel matters most", never its negation ("I don't think the hotel matters", "the hotel matters less").
  const hotelFirst = lower.match(/\b(hotel (?:matters(?! (?:less|little|not))|is (?:the )?most important|first|quality)|nice hotel|great hotel|best hotel|good hotel|hotel is everything)\b/);
  if (hotelFirst && !NEG_BEFORE.test(lower.slice(0, hotelFirst.index))) { u.priority = 'hotel'; ack.push('the hotel matters most'); }
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
  // "No transfer" (or "without a transfer", "skip the transfer") is a rule too: it turns the transfer
  // off, never on, and the easy mission's "a transfer when priced" is dropped by it.
  const noTransfer = /\bno (?:airport )?transfers?\b|\bwithout (?:a |an |the )?(?:airport )?transfers?\b|\bskip (?:the )?transfers?\b|\bdon'?t (?:need|want) (?:a |an |the )?(?:airport )?transfers?\b/;
  if (has(lower, noTransfer)) { u.transfer = false; ack.push('no airport transfer'); }
  else if (has(lower, /\b(transfer|pick[- ]?up from the airport|airport (?:shuttle|ride))\b/)) { u.transfer = true; ack.push('airport transfers'); }
  if (has(lower, /\b(refundable|free cancellation|can cancel|cancellable)\b/) && !has(lower, /\bnon-?refundable\b/)) { u.refundable = true; ack.push('refundable'); }
  if (has(lower, /\b(carry[- ]?on only|only (?:a )?carry[- ]?on|no checked bags?|carry[- ]?on bag only|i (?:travel|pack|fly) (?:with )?(?:a )?carry[- ]?on)\b/)) { u.bags = 'carry-on'; ack.push('carry-on only'); }
  else if (has(lower, /\b(personal item only|only (?:a )?personal item|no bags?( at all)?|travel light, no bags?)\b/)) { u.bags = 'personal'; ack.push('personal item only'); }
  else if (has(lower, /\b(check(?:ed)? (?:a |one |two |\d )?bags?|checked bags? (?:each|included)|i check a bag|with (?:a )?checked bags?|need (?:a )?checked bags?)\b/)) { u.bags = 'checked'; ack.push('a checked bag'); }
  if (has(lower, /\baggressive\b/)) { u.savingsLevel = 'aggressive'; ack.push('aggressive savings: every trade-off said'); }
  else if (has(lower, /\bbalanced\b/)) { u.savingsLevel = 'balanced'; ack.push('balanced savings'); }

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

// What the data cannot compare, by the engine's own keys (leaks.notAvailable, plus its seat and parking
// lines): the agent answers each with that line, never with a checkout or a cheaper version, since no
// saving can be claimed or denied from what nothing prices. The intent is the union; the router reads
// the keys asked.
const NOT_COMPARED = [
  ['channel', /\bbook(?:ing|ed)?\b[^.?!]{0,40}\b(?:separately|directly|elsewhere|myself|ourselves|on (?:my|our) own|on (?:another|a different|some other) (?:site|website|app)|somewhere else|straight with the (?:hotel|airline))|\bdirect(?:ly)? (?:with|from|through) the (?:hotel|airline)\b|\b(?:another|a different|some other) (?:site|website|booking site)\b|\bbooking channels?\b/],
  ['package', /\bpackage\b[^.?!]{0,30}\bseparate(?:ly)?\b|\bseparate(?:ly)?\b[^.?!]{0,30}\bpackage\b|\bas a package or\b|\bbundl(?:e|ed|ing) (?:vs\.?|versus|or|instead of)\b/],
  ['oneway', /\bone[- ]way (?:fares?|tickets?|flights?)\b|\btwo one[- ]ways?\b/],
  ['split', /\bsplit (?:the |my |our )?stay\b|\btwo (?:different )?hotels\b/],
  ['credit', /\b(?:airline|loyalty|rewards?|credit[- ]card|hotel|my|our) (?:points|miles)\b|\bpoints or miles\b|\bfrequent[- ]flyer\b|\bloyalty (?:program|credits?|points|number)\b/],
  ['promo', /\bpromo codes?\b|\bcoupons?\b|\bdiscount codes?\b|\bvouchers?\b/],
  ['currency', /\bin (?:euros?|pounds|yen|pesos|cad|gbp|eur|canadian dollars|mexican pesos)\b|\bexchange rates?\b|\bcurrenc(?:y|ies)\b/],
  ['seat', /\bseat (?:selection )?fees?\b|\bseat selection\b|\bpay(?:ing)? (?:for|extra for) (?:a |our |my )?seats?\b|\bchoose (?:my|our|a) seats?\b/],
  ['parking', /\bparking\b/],
];
const NOT_COMPARED_RE = new RegExp(NOT_COMPARED.map(([, re]) => re.source).join('|'));

// What the traveler wants done. Several can apply; the router handles them in a sensible order.
const INTENTS = [
  ['restart', /\b(start over|start again|reset|from scratch|new trip|clear everything)\b/],
  ['stop', /\b(stop (?:the )?search(?:ing)?|that'?s enough|enough searching|stop looking|i'?m happy|i like this one|this is the one|i like this\b)/],
  ['keepLooking', /\b(keep (?:looking|searching|building|going)|challenge it again|look again|try harder|another round|search more|can you do better)\b/],
  ['whyPick', /\bwhy (?:[a-z' ]+\?|(?:did you )?(?:pick|choose) (?:that|this|it))/],
  // Saving the trip's defaults to the account is asked for in its own words ("remember these as my
  // defaults", "remember this for next time"), never read out of a sentence about a memory ("I want to
  // remember this trip forever"): nothing is retained without the customer's permission.
  ['remember', /\b(remember (?:these|this|my|those|them)(?: as (?:my|our))? (?:defaults|preferences|settings|travel defaults)|remember (?:these|this|that|them|my (?:details|settings|preferences))(?: settings| details)? for next time|save (?:these|my|our) (?:defaults|preferences|settings)|use (?:these|this) next time)\b/],
  ['forget', /\b(forget (?:my|these|those|the) (?:defaults|preferences|settings)|not this time|don'?t use (?:my|the) (?:saved )?defaults|ignore (?:my|the) defaults)\b/],
  ['challenge', /\b(can you beat|beat (?:it|this|that|their|the price|my (?:quote|deal))|found (?:this|a|the) trip|i was quoted|i have a quote|other site|competitor|their price|better than (?:this|what i found))\b/],
  ['howLow', /\b(how low can (?:you|we|it) (?:go|get(?: it)?)|how cheap can (?:you|it|this) (?:get|go|be)|lowest (?:you|we) (?:can|could)(?: get| go)?|what'?s the lowest|how low can you get it)\b/],
  ['cutMore', /\b(can (?:you|it|this) (?:go|be|get) (?:any )?(?:lower|cheaper)|anything cheaper|is there (?:anything|something) cheaper|any cheaper|can i (?:responsibly )?(?:make|get) (?:it|this) cheaper|go lower)\b/],
  ['sameTripLess', /\b(same trip for less|same trip,? (?:but )?cheaper|this trip for less|keep (?:the|this) trip,? (?:but )?(?:cheaper|for less)|same trip,? less money)\b/],
  ['breakpoints', /\b(upgrades? worth (?:considering|it|the money)|where does (?:the )?money (?:start|begin)|what (?:does|would) (?:more|extra) money (?:buy|get)|price breakpoints?|breakpoints?|what (?:can|could) i get for (?:a bit|a little) more)\b/],
  ['whenLess', /\b(when can i go for less|when (?:is|would) it (?:be )?cheaper|cheaper (?:time|month|week|date|dates) to go|when should i (?:go|book) (?:to pay less|for less|to save)|cheapest (?:strong )?week|which week is cheapest|when is it cheapest|other weeks)\b/],
  ['receipt', /\b(how (?:did|have) you (?:keep|kept) (?:my|the) (?:cost|price) down|savings receipt|show (?:me )?(?:the |my )?savings|what did (?:you|we) save|how much (?:did|have) (?:i|we) save[d]?|where did the savings come from)\b/],
  // What the data cannot compare: booking each part elsewhere or direct, a package against separate
  // rates, one-way fares, a split stay, points and miles, promo codes, another currency, seat fees,
  // parking. Each gets the engine's own "not in our data" line (leaks.notAvailable, seatFees,
  // hotelFees), never the checkout a bare "book" would start and never a cheaper version a bare
  // "cheaper" would chase, since no saving is claimed or denied from what nothing prices.
  ['notCompared', NOT_COMPARED_RE],
  ['book', /\b(book (?:it|this|that|the trip|now)?|buy|purchase|reserve it|check ?out|pay(?: now)?|let'?s go with (?:it|this)|i'?ll take (?:it|this|the trip)|take (?:this|that|your) (?:trip|pick)|verify (?:&|and) book)\b/],
  // The last group names a version (the lean version, a removal of "it" or of $N, the free savings,
  // the trade-off version, the cut): the agent applies such words only to a pending proposal of that
  // kind (agent.js namedApproval), never to whatever happens to be on the table.
  // A letter ("B", "option C") is never a plain approval: it names a version on a lettered menu, and is
  // read only against the menu or proposal that carries that letter (LETTER below, agent.js).
  ['approve', /^(?:yes|yep|yeah|yup|ok(?:ay)?|sure|fine|do it|do it anyway|anyway|go ahead|go over|take it|take it anyway|accept|agreed|please do|sounds good|switch|switch to (?:the )?better(?: option)?|take (?:the )?(?:upgrade|cheaper|cheapest|challenger|better|new|proposal|one stop|one-stop|our pick|save more|first|lowest|recommended)(?: \w+)*|use (?:it|that)|remove it|remove \$?[\d,]+(?:\.\d{1,2})?|take it out|strip it|take the lean(?: version)?|take the free savings|take the trade-?off version|take the cut(?: version)?)[.!]?$/i],
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
  ['extend', /\b(extend|stay (?:a|one) (?:day|night) longer|add (?:a|one|1) (?:more )?night|(?:one|1|an extra|another) more night|give me (?:one|1|a) more night|(?:[23]|two|three) (?:more|extra) nights)\b/],
  ['shorten', /\b((?:one|1|a) (?:less|fewer) night|(?:one|1|a) night (?:less|fewer|shorter)|shorter|cut (?:a|one) night|drop (?:a|one) night|reduce to \d+ nights)\b/],
  ['watch', /\b(watch (?:for|this|the price|it|my trip|this trip|the trip)|set (?:up )?a watch|price watch|alert me|notify me|tell me when|let me know when)\b/],
  // Hunt mode: "I can wait. Only come back when my money can do something better." The chip on the
  // saver canvas says "Hunt for a better deal"; "hunt for it" restarts a stopped hunt. A hunt is a
  // standing instruction on the account, so it is asked for in the hunt's own words: "I can wait" is
  // one only as the whole message or followed by the canvas line's words, never inside a sentence
  // about dates ("I can wait until December"), which is about the trip.
  ['hunt', /\b(hunt for (?:a |the |something|a better|it)|hunt mode|find me something worth booking|keep looking for me|watch my money|let (?:the )?ai watch my money|wait for the right trip)\b|^\s*i can wait[.!]*\s*$|\bi can wait\b[^a-z]{0,8}(?:only come back|for the right trip)\b/],
  // The answer to a hunt's find, and only that: "not enough" inside a sentence that changes the trip
  // ("5 nights is not enough, make it 7") is that change, not this.
  ['notGoodEnough', /^\s*(?:no[,.]?\s+)?(?:that'?s |this is |it'?s |it is |still )?(?:not good enough|not enough|that'?s not it)[.!]*\s*$/],
  ['stopHunt', /\b(stop (?:the )?hunt(?:ing)?|cancel (?:the )?hunt)\b/],
  // Experience Max (the canvas chips, in their words): each sits before cheaper/better/build, so "make
  // it better for $0 more" is never a dearer version and "plan my days" never a rebuild. They are read
  // only in experience mode (or once goals were given); the router answers each from experience.js.
  ['xHotelOrExp', /\bhotel or (?:the )?experiences?\b|\bexperiences? or (?:the )?hotel\b/],
  ['xMemorable', /\bmake \$?\s*[\d,]+\s*(?:dollars\s+)?memorable\b/],
  ['xOneBig', /\bone amazing thing\b/],
  ['xPack', /\bpack (?:the|my|this) trip\b/],
  ['xFree', /\bfree things\b|\bthings worth doing for free\b|\bfree (?:stuff|options|activities) (?:to do|worth doing)\b/],
  ['xSurpriseOne', /\bsurprise me with (?:one|an?) (?:thing|experience)\b/],
  ['xSurpriseAll', /\bsurprise me completely\b/],
  ['xFreeTime', /\bmore free time\b|\bopen up a day\b|\b(?:too|very) (?:busy|scheduled|packed)\b/],
  ['xSameFeeling', /\bsame feeling\b/],
  ['xAlternative', /\balternative experience\b|\b(?:find |an? )?alternative (?:to|for)\b/],
  ['xLadder', /\bexperience ladder\b|\bwhere should (?:i|we) stop\b|\b(?:memory )?sweet spot\b/],
  ['xReceipt', /\bwhy (?:is )?this trip (?:is )?built this way\b|\bexperience receipt\b/],
  ['xMore', /\b(?:make it )?more memorable\b/],
  ['xZero', /\bbetter for \$?0 more\b|\bfor \$0 more\b|\bfor (?:no|zero) (?:extra )?money\b/],
  ['xTrade', /\btrade (?:something|anything) for\b|^\s*make the trade[.!]?\s*$/],
  ['xBigVsMany', /\bone big memory\b|\bmore things to do\b/],
  ['xRhythm', /\bplan (?:my|our|the) days\b|\bwhat does each day look like\b|\bday by day\b|\b(?:the|my|our) rhythm\b/],
  ['xProtect', /^\s*protect\s+(?![$\d])\S/],
  ['xUnprotect', /\bunprotect\b/],
  ['xDrop', /^\s*drop\s+(?!(?:a|one|1)\s+nights?\b)\S/],
  ['xEvent', /\b(?:i|we)\s+(?:already\s+)?(?:have|booked|bought|got|reserved|hold)\b[^.?!]{0,50}?\b(?:tickets?|reservation|restaurant|concert|show|game|match|wedding|table|dinner)\b/],
  ['xBudget', /\bexperience budget\b|\bhow (?:did|do) you (?:split|allocate) (?:the |my )?(?:money|budget)\b/],
  // The downsell's own words: the amount in them is the hotel money to move, never a new budget.
  ['xDownsell', /\bmove \$?[\d,]+(?:\.\d{1,2})? to the experiences?\b/],
  ['xLocation', /\blocation check\b|\bcheck the location\b|\bis the (?:hotel'?s? )?location right\b|\buse the better location\b/],
  ['xConflicts', /\bschedule conflicts?\b|\bany conflicts?\b/],
  ['xProtection', /\bexperience protection\b|\bis (?:the main experience|it) verified\b/],
  ['xBackup', /\bwhat if it rains\b|\bbad weather\b|\bbackup plan\b|\bplan b\b|\bweather backup\b/],
  ['xWhyDest', /\bwhy this destination\b/],
  ['xUpgrade', /\b(?:better|nicer|fancier|bigger|upgraded?) (?:hotel|room)\b|\bupgrade (?:the |my |our )?(?:hotel|room)\b|\bview room\b|\b(?:room|hotel) upgrade\b/],
  // The money leak hunter: not "is there a cheaper trip" but "what am I paying for that I may not
  // need". These sit before cheaper/better/build so a leak question is never read as a price cut or a
  // rebuild; the router answers each from leaks.js, and nothing is removed until the traveler says so.
  // "Every dollar" is the breakdown only when it is the dollars of this price ("every dollar of it",
  // "where every dollar goes"); "make it cheaper, every dollar counts" asks for a cheaper version.
  ['paying', /what am i paying for|break (?:it|the price|this) down|where (?:does|is) (?:my|the) money go(?:ing)?|every dollar of (?:this|it|the price|the trip)|where (?:does )?every dollar go(?:es)?\b/],
  ['strip', /strip it down|lean version|take the lean\b|bare[- ]bones|strip (?:this|it|the trip)/],
  ['addBack', /add back what(?:'s| is) worth it|what(?:'s| is) worth adding back|add back/],
  ['removeOne', /remove one thing|take one thing (?:out|off)/],
  ['biggestLeak', /biggest (?:money )?leak|where am i wasting|what am i wasting|biggest waste/],
  // The chip under the biggest-leak card, in the card's own words only (leaks.showWords): "show me
  // the version without it", "the like-for-like version", "the version leaving <date>"; a label the
  // card itself carries ("show me the Basic fare: checked bag version") is matched in understand()
  // against the card on the canvas. Every other "show me the <X> version" keeps its meaning (cheaper,
  // nonstop, 4-star, all-inclusive, a length), so a rule in it is never dropped on the floor.
  ['leakVersion', /^\s*show me the (?:version without it|like-for-like version|version leaving \d{4}-\d{2}-\d{2})[.!]?\s*$/],
  ['leakScan', /money leak (?:check|scan)|leak (?:check|scan)|am i paying for (?:anything|something) i don'?t need|anything i don'?t need|what don'?t i need/],
  ['cutInOrder', /cut \$?[\d,]+ in order|trim \$?[\d,]+|cut (?:it )?in order|without touching the vacation/],
  ['freeSavings', /free savings|savings without sacrifice|no[- ]compromise savings|take the free savings|take the trade-?off version/],
  ['scorecard', /savings (?:scorecard|check)|my savings check|scorecard/],
  ['elsewhere', /\b(another country|somewhere else|different (?:place|destination|country|city)|try (?:another|a different|somewhere)|change the destination|not (?:cancun|there|that place)|anywhere else)\b/],
  ['easier', /\b(easier|simpler|less hassle|less travel|shorter travel|more convenient|easy trip|make this easier)\b/],
  ['cheaper', /\b(cheaper|too expensive|too much|less money|lower(?: the)? price|bring (?:it|the price) down|save me|save (?:another|an extra|a further) \$?[\d,]+|cut the price|reduce the price|take \$?[\d,]+ back|find \$?[\d,]+|under budget|spend less|more affordable)\b/],
  ['better', /\b(make it better|better|upgrade|improve|nicer|spend (?:the )?(?:rest|full|remaining|whole|entire)|spend (?:another|an extra|up to)?\s*\$?[\d,]+|if it (?:actually |really )?helps|what (?:can|would|does) \$?[\d,]+ (?:more )?(?:get|buy|do)|use the rest|what'?s the best i can get|get me more for (?:this|the|my|the same) money|more (?:vacation )?for (?:this|the same) money)\b/],
  ['lock', /\b(don'?t (?:change|touch|move)|do not (?:change|touch|move)|never change|lock|keep everything except|keep the hotel|keep the flights?|keep the dates|keep my hotel)\b/],
  ['nonstopRule', /\b(only nonstop|nonstop only|never (?:show|give) me a (?:connection|stop|layover)|no connections?|no layovers?|hate connections|must be nonstop)\b/],
  ['build', /\b(build|rebuild|plan|find (?:me|us)|get (?:me|us)|best trip|show me trips|show me (?:some|a few) (?:options|trips)|i want (?:to go|a trip)|i'?d like (?:to go|a trip)|take (?:me|us)|let'?s go|trip for|vacation|holiday|getaway|escape|somewhere|search again|try again)\b/],
];

// What the traveler says about the trip they found, when the agent asked about it. Only what the
// words state; an attribute nobody mentioned stays unknown, and "don't know" is an answer.
function theirsFrom(lower, { now = new Date() } = {}) {
  const t = {};
  const stars = lower.match(/\b([345])[- ]?stars?\b/);
  if (stars) t.stars = Number(stars[1]);
  if (/\ball[- ]inclusive\b/.test(lower)) t.meals = 'all-inclusive';
  else if (/\bbreakfast\b/.test(lower) && !/\bno breakfast\b/.test(lower)) t.meals = 'breakfast';
  else if (/\b(no meals|room only|no breakfast|meals? (?:not included|extra)|nothing included|no food)\b/.test(lower)) t.meals = 'none';
  if (/\b(personal item only|just a personal item|no carry[- ]?on)\b/.test(lower)) t.bags = 'personal';
  else if (/\b(carry[- ]?on only|carry[- ]?on(?: bag)? (?:included|only)|cabin bag|hand luggage only|no checked bags?|checked bags? (?:not included|extra|cost extra))\b/.test(lower)) t.bags = 'carry-on';
  else if (/\b(checked bags?|a checked bag|bags? (?:are |is )?included|luggage included|with bags?|suitcases? included)\b/.test(lower)) t.bags = 'checked';
  if (/\b(no (?:airport )?transfers?|transfers? (?:not included|extra)|without (?:a |the )?transfer|no shuttle|no pickup)\b/.test(lower)) t.transfer = 'no';
  else if (/\b(transfers? (?:is |are )?included|includes? (?:a |the )?(?:airport )?transfers?|with (?:a |the )?(?:airport )?transfer|shuttle included|pickup included|transfer(?:s)? in the price)\b/.test(lower)) t.transfer = 'yes';
  if (/\b(non[- ]?refundable|no refunds?|can'?t cancel|cannot cancel|no cancellation|no free cancellation|not refundable)\b/.test(lower)) t.cancel = 'nonrefundable';
  else if (/\b(refundable|free cancellation|can cancel|cancel(?:lation)? (?:is )?free|fully flexible)\b/.test(lower)) t.cancel = 'refundable';
  if (/\b(plus tax(?:es)?|before tax(?:es)?|tax(?:es)? (?:and fees )?(?:are |is )?(?:extra|not included|on top|excluded|separate)|excluding tax|without tax|pre-?tax|fees? (?:extra|not included|on top))\b/.test(lower)) t.taxes = 'excluded';
  else if (/\b(tax(?:es)? (?:and fees )?(?:are |is )?(?:included|in|inside|in the price)|includ(?:es|ing) (?:all )?tax|all[- ]in|final price|total price|everything included|incl\.? tax|with tax(?:es)?)\b/.test(lower)) t.taxes = 'included';
  if (/\b(not (?:nonstop|non-stop|direct)|one stop|1 stop|two stops|a stop|with stops|stops|connection|connecting|layover)\b/.test(lower)) t.flight = 'stops';
  else if (/\b(nonstop|non-stop|direct)\b/.test(lower)) t.flight = 'nonstop';
  const d = parseDate(lower, now);
  if (d && d.depart) t.depart = d.depart;
  const nights = lower.match(/\b(\d+)\s*nights?\b/);
  if (nights && Number(nights[1]) >= 1 && Number(nights[1]) <= 14) t.nights = Number(nights[1]);
  return t;
}

const THEIRS_SKIP = /\b(don'?t know|do not know|not sure|no idea|unsure|skip|dunno|can'?t remember|no clue|not listed|doesn'?t say)\b/;
const THEIRS_DONE = /\b(that'?s all|that is all|that'?s everything|all i know|compare now|run it|just compare|go ahead|enough|with what you have|say who wins|what you have)\b/;

// Words that ask for the stay itself ("the hotel matters most", "we care about the room"), never their
// negation ("the hotel doesn't matter"): with them, the upgrade challenge does not argue that the
// customer said the opposite (experience.challengeUpgrade, o.statedStay).
// A noun followed by its price, cost, rate, service, tax, fee or bill names that, not the stay ("the hotel
// price matters", "the room service doesn't matter").
const NOT_STAY = String.raw`(?!'?s?\s+(?:price|cost|rate|service|tax|fee|bill)s?\b)`;
const STAY_SAID = new RegExp(String.raw`\b(?:hotel|room|stay|resort)\b${NOT_STAY}[^.?!,;]{0,24}?\b(?:matters?|is (?:really |very |so )?important|counts|is (?:a|the|our) (?:priority|point))\b|\bcares? (?:a lot |most )?about (?:the|our|a (?:nice|good|great)) (?:hotel|room|stay)\b${NOT_STAY}`);
// A negation earlier in the same clause counts too, and "less" just after: "we don't care about the
// hotel", "I don't think the hotel matters" and "the hotel matters less to us" never ask for the stay.
// The window never crosses a "but": "the room doesn't matter but the hotel matters most" asks for the hotel.
const NEG_BEFORE = /\b(?:doesn'?t|does not|don'?t|do not|never|not|didn'?t|did not)\b(?:(?!\b(?:but|though|although|however|yet|while)\b)[^.?!,;]){0,24}$/;
const STAY_SAID_ALL = new RegExp(STAY_SAID.source, 'g');
// Nor from a question ("does the hotel matter?"), a hypothetical ("if the hotel matters, ...") or the length
// ("how long we stay matters"): only the customer's own statement that the stay matters to them.
const stayAsked = (lower, u) => u.priority === 'hotel' || [...lower.matchAll(STAY_SAID_ALL)].some(m => {
  const before = lower.slice(0, m.index), rest = lower.slice(m.index).match(/^[^.?!]*([.?!])?/);
  return !/\b(?:doesn'?t|does not|don'?t|do not|not|never|less|isn'?t)\b|n't\b/.test(m[0]) && !NEG_BEFORE.test(before) && !/^\s+(?:less|little|not)\b/.test(lower.slice(m.index + m[0].length))
    && !(rest && rest[1] === '?') && !/\b(?:if|whether|unless)\b[^.?!]*$/.test(before) && !/\bhow long (?:we |i |you |they )?$/.test(before);
});
// The customer's own words that the stay does not matter to them ("the hotel doesn't matter", "we don't
// care about the room", "just a place to sleep", "any hotel is fine"): only then may the engine say "an
// upgrade you told me you don't care about" (o.stayLow); otherwise it is "an upgrade you didn't ask for".
// Never from the opposite ("the hotel matters"), from not caring about something else ("I don't care
// about the price", "the hotel price doesn't matter"), from words disowned or hypothetical ("I never
// said the hotel doesn't matter", "if the hotel doesn't matter ...") or from a question.
// (NOT_STAY, the hotel's price, cost, rate, service, tax, fee or bill rather than the stay, is defined above STAY_SAID.)
const STAY_LOW = new RegExp([
  String.raw`\b(?:hotel|room|resort|accommodations?)\b${NOT_STAY}[^.?!,;]{0,20}?\b(?:doesn'?t|does not|don'?t|do not)\s+(?:really\s+|much\s+|that much\s+)?matter\b`,
  String.raw`\b(?:hotel|room|resort)\b${NOT_STAY}[^.?!,;]{0,20}?\b(?:isn'?t|is not)\s+(?:that\s+|very\s+|really\s+|so\s+)?important\b`,
  String.raw`\b(?:hotel|room)\s+matters?\s+(?:less|little)\b`,
  String.raw`\b(?:doesn'?t|does not)\s+matter\s+(?:which|what)\s+(?:hotel|room)\b`,
  String.raw`\bwhere we stay (?:doesn'?t|does not|don'?t|do not) (?:really )?matter\b`,
  String.raw`\b(?:don'?t|do not)\s+(?:really\s+|much\s+)?care\s+(?:much\s+)?(?:about\s+(?:the\s+|our\s+|a\s+)?|which\s+|what\s+)(?:hotel|room|resort|accommodations?)\b${NOT_STAY}`,
  String.raw`\b(?:just|only) (?:a |some )?(?:place|somewhere|bed) to sleep\b`,
  String.raw`\bany (?:hotel|room)(?:'s| is| will do| works)\b`,
  String.raw`\b(?:don'?t|do not) (?:really )?think (?:that )?(?:the |our )?(?:hotel|room)${NOT_STAY}[^.?!,;]{0,12}?\bmatters?\b`,
  String.raw`\b(?:don'?t|do not) need (?:a |an )?(?:nice|fancy|good|great|luxury|luxurious|big|expensive) (?:hotel|room)\b`,
].join('|'));
function stayLowSaid(lower) {
  const m = lower.match(STAY_LOW);
  if (!m) return false;
  const before = lower.slice(0, m.index), rest = lower.slice(m.index).match(/^[^.?!]*([.?!])?/);
  if (/\b(?:never said|didn'?t say|did not say|not saying|wouldn'?t say|not true|if|whether|unless)\b[^.?!]*$/.test(before)) return false;
  return !(rest && rest[1] === '?');
}

// A lettered menu answer, and only as the whole message: the letter alone ("B", "b."), "option B",
// "pick B", "B please", or a card button's own words ("Option B: Nonstop Flex flights"), which carry the
// version's label so an old card's button is checked against the menu now on the table (agent.js). A
// sentence that starts with "a" ("A stop is fine", "a cheaper flight would be nice") is never option A.
const LETTER = /^\s*(?:(?:option|pick)\s+)?([a-e])(?:\s+please)?\s*[.!]?\s*$|^\s*option\s+([a-e])\s*:\s*(.+?)\s*$/i;
function letterOf(text) { const m = String(text || '').trim().match(LETTER); return m ? { letter: (m[1] || m[2]).toUpperCase(), label: m[3] ? m[3].trim() : null } : null; }

function understand(text, state, { maps, now = new Date() } = {}) {
  const clean = String(text || '').trim().slice(0, 600);
  const lower = clean.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const { updates, ack } = extractUpdates(clean, { maps, now });
  const intents = INTENTS.filter(([, re]) => re.test(lower)).map(([k]) => k);
  // A sentence that changes the trip (a date, a month, open dates, the limit, the length) is about
  // the trip on the canvas, whatever else it says: nothing standing is created on the account from
  // it, so the hunt intent is dropped and the change is built as before. ("Not good enough" without
  // a hunt stays an intent: the agent says there is no hunt, rather than that it did not understand.)
  if (intents.includes('hunt') && ['depart', 'month', 'dateMode', 'budget', 'nights'].some(k => k in updates)) intents.splice(intents.indexOf('hunt'), 1);
  const drop = k => { const i = intents.indexOf(k); if (i >= 0) intents.splice(i, 1); };
  // "2 more nights" is that many nights onto the trip on the canvas, never "$2 more" or a card's number.
  const more = lower.match(/\b([23]|two|three) (?:more|extra) nights\b/);
  if (more && intents.includes('extend')) updates.addNights = num(more[1]);
  // A question about what the data cannot compare carries "book", "cheaper" or "somewhere else" in
  // it; none of those is what it asks, so they go, and only the honest answer is routed. A quote
  // from another site to beat is a challenge, not this question.
  if (intents.includes('notCompared')) { if (intents.includes('challenge')) drop('notCompared'); else for (const k of ['book', 'cheaper', 'better', 'elsewhere', 'build']) drop(k); }
  // "Show me the <alternative> version" is the biggest-leak card's chip when the words carry the
  // alternative that card shows; the card is the one on the canvas, so the label is read from it,
  // never guessed from the words.
  const leakCard = state && Array.isArray(state.messages) ? [...state.messages].reverse().map(m => m && m.card).find(c => c && c.kind === 'leak') : null;
  if (!intents.includes('leakVersion') && leakCard && leakCard.alternativeLabel && /^\s*show me the .+ version[.!]?\s*$/.test(lower) && lower.includes(String(leakCard.alternativeLabel).toLowerCase())) intents.push('leakVersion');
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
  const lt = letterOf(clean);
  if (pending === 'challenge' && !updates.competitorTotal) { const m = lower.match(/\$?\s*([\d,]{3,}k?)\b/); if (m && num(m[1]) >= 100) { updates.competitorTotal = num(m[1]) * (/k$/i.test(m[1]) ? 1000 : 1) * 100; delete updates.budget; } if (!intents.includes('challenge')) intents.push('challenge'); }
  // The three ways: which one feels like the traveler, or none; one-tap feedback under a way; a way
  // referred to by number with a change ("number 2 but somewhere warmer"); the pushed variants.
  const REF = '(?:number |option |#|like |want |take |pick |choose |go with |give me |prefer )';
  const WAY_WORDS = [['more', new RegExp(`\\b(more vacation|the first(?: one)?)\\b|\\b${REF}1\\b|^\\s*1\\b`)], ['keep', new RegExp(`\\b(keep more|the second(?: one)?)\\b|\\b${REF}2\\b|^\\s*2\\b`)], ['special', new RegExp(`\\b(make it special|special|the third(?: one)?)\\b|\\b${REF}3\\b|^\\s*3\\b`)]];
  const fb = lower.match(/^\s*([123])\s*:\s*(love this|too expensive|too short|too far|wrong vibe)\s*$/);
  if (fb) {
    updates.way = ['more', 'keep', 'special'][Number(fb[1]) - 1];
    if (fb[2] !== 'love this') { updates.wrong = { 'too expensive': 'expensive', 'too short': 'short', 'too far': 'travel', 'wrong vibe': 'exciting' }[fb[2]]; delete updates.way; }
    intents.length = 0; intents.push('ways'); ack.length = 0;
  } else if (state && state.mission && (pending === 'ways' || new RegExp(`\\b${REF}[123]\\b|\\b(more vacation|keep more|make it special)\\b`).test(lower))) {
    if (/\b(none|none of (?:these|those|them)|try again|something else|not these|neither)\b/.test(lower) && pending === 'ways') { updates.way = 'none'; intents.length = 0; intents.push('ways'); ack.length = 0; }
    else { const w = WAY_WORDS.find(([, re]) => re.test(lower)); if (w) { updates.way = w[0]; if (!intents.includes('ways')) intents.push('ways'); } }
  }
  if (pending === 'wrong') {
    const wrong = /\bdestination/.test(lower) ? 'destinations' : /\b(expensive|price|cost|money)\b/.test(lower) ? 'expensive' : /\b(short|longer|nights)\b/.test(lower) ? 'short' : /\b(travel|far|flight|connection|long)\b/.test(lower) ? 'travel' : /\bhotel/.test(lower) ? 'hotels' : /\b(exciting|boring|vibe|dull|fun)\b/.test(lower) ? 'exciting' : null;
    if (wrong) { updates.wrong = wrong; intents.length = 0; intents.push('ways'); ack.length = 0; }
  }
  const mixH = lower.match(/\bhotel from (?:option |variant )?([abc])\b/), mixF = lower.match(/\bflights? from (?:option |variant )?([abc])\b/);
  if (mixH || mixF) { updates.mix = { hotelFrom: mixH ? mixH[1].toUpperCase() : null, flightFrom: mixF ? mixF[1].toUpperCase() : null }; intents.length = 0; intents.push('ways'); ack.length = 0; }
  else if (/\bmix (?:them|those|these)\b/.test(lower)) { updates.mix = { hotelFrom: null, flightFrom: null }; intents.length = 0; intents.push('ways'); }
  if (pending === 'origin' && !updates.origin) { const o = originIn(clean, maps); if (o) updates.origin = o.origin; }

  // Facts about the trip they found: the answer to the agent's question about it, or a sentence
  // about "their" trip while a challenge is on the table. These never touch the traveler's own rules.
  if (pending === 'theirs' || (state && state.challenger && /\b(their|theirs|they|the other (?:trip|deal|site))\b/.test(lower) && !/\bbeat\b/.test(lower))) {
    const t = theirsFrom(lower, { now });
    const skip = THEIRS_SKIP.test(lower);
    const done = THEIRS_DONE.test(lower);
    if (Object.keys(t).length || skip || done) {
      for (const k of ['minStars', 'clearStars', 'breakfast', 'hotelAllInclusive', 'flightStops', 'flightRule', 'refundable', 'transfer', 'beachfront', 'depart', 'dateMode', 'month', 'nights', 'budget', 'budgetPer', 'competitorTotal', 'locks', 'unlocks', 'destination', 'anywhere']) delete updates[k];
      updates.theirs = { ...t, skip: skip && !Object.keys(t).length, done };
      const keep = intents.filter(k => k === 'restart' || k === 'stop');
      intents.length = 0; intents.push(...keep, 'challenge');
      ack.length = 0;
    }
  }
  // The rule a watch is asked with, from the words only: a drop of at least $N, any drop, or a total
  // at or under $N. No rule in the words means the agent states its default; nothing is inferred.
  if (intents.includes('watch')) {
    // "drops below $1,200", "falls to $1,200", "cheaper than $1,200" name a total, not a drop of that size.
    const under = lower.match(/\b(?:at or under|under|below|at or below|reaches|hits|less than|cheaper than|(?:drops?|falls?|goes down|gets? down|comes down|is|gets?)\s+(?:to|under|below))\s*\$?\s*([\d,]{3,})\b/);
    const drop = under ? null : (lower.match(/\b(?:drops?|falls?|goes down|cheaper)\b(?:\s+by)?\s*\$?\s*([\d,]+)/) || lower.match(/\$\s*([\d,]+)\s*(?:drop|less|cheaper|off)\b/));
    if (under) updates.watchRule = { kind: 'under', amount: num(under[1]) * 100 };
    else if (drop && num(drop[1]) >= 1) updates.watchRule = { kind: 'drop', amount: num(drop[1]) * 100 };
    else if (/\b(any (?:drop|change|time it(?:'s| is) cheaper)|gets? cheaper|becomes cheaper|goes down at all|same trip (?:gets|becomes|is) cheaper)\b/.test(lower)) updates.watchRule = { kind: 'any-drop' };
    delete updates.budget; delete updates.competitorTotal;
  }
  // The money leak chips carry an item's name ("Add back Sunset sail", "Show me the Palm Resort
  // version"): the words name a priced item, never a fact about the trip, so nothing in them may
  // become a style, a rule or a destination, and the message is that one ask and nothing else.
  if ((intents.includes('addBack') && /^\s*add back\b/.test(lower)) || intents.includes('leakVersion')) {
    const only = /^\s*add back\b/.test(lower) ? 'addBack' : 'leakVersion';
    for (const k of Object.keys(updates)) delete updates[k];
    ack.length = 0; intents.length = 0; intents.push(only);
  }
  // "Remove $148" names the saving of a removal on the table, never a budget.
  if (intents.includes('approve') && /^\s*remove \$?[\d,]/.test(lower)) { delete updates.budget; delete updates.budgetPer; ack.length = 0; }
  // "Cut $200 in order" names an amount to take out, in dollars; it is never a budget or a price cut
  // the decision layer should chase. No amount in the words means the flow asks for one or cuts to
  // the ceiling; nothing is inferred.
  // The amount is the number after "cut" or "trim", never the first number in the sentence ("I have
  // 2 people, cut $200 in order" cuts $200).
  if (intents.includes('cutInOrder')) {
    const m = lower.match(/\b(?:cut|trim)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)(k\b)?/);
    updates.cutBy = m && num(m[1]) > 0 ? Math.round(num(m[1]) * (m[2] ? 1000 : 1) * 100) : null;
    delete updates.budget; delete updates.budgetPer; delete updates.cheaperBy; delete updates.moreBy;
    ack.length = 0;
  }
  // The answer to "how much do you want to cut?" is an amount to cut, in cents, and nothing else: it
  // never becomes the budget, and the cut flow is what it answers.
  if (pending === 'cutBy') {
    const m = lower.match(/^\s*(?:cut |trim |take (?:out |off )?)?\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b)?\s*(?:dollars|bucks|off|out)?\s*[.!]?\s*$/);
    if (m && num(m[1]) > 0) {
      updates.cutBy = Math.round(num(m[1]) * (m[2] ? 1000 : 1) * 100);
      delete updates.budget; delete updates.budgetPer; delete updates.cheaperBy; delete updates.moreBy;
      if (!intents.includes('cutInOrder')) intents.push('cutInOrder');
      ack.length = 0;
    }
  }
  // A bare number answers whatever was asked.
  if (/^\s*\$?\s*[\d,]+k?\s*$/.test(lower) && !pending && !updates.budget) { const v = num(lower.match(/([\d,]+)/)[1]) * (/k/i.test(lower) ? 1000 : 1); if (v >= 100) { updates.budget = v * 100; updates.budgetPer = 'total'; } }

  // ---- Experience Max ----------------------------------------------------------------------------
  // The chips and their words are read only in experience mode (or once goals were given): anywhere
  // else "plan my days" stays a build and "a better hotel" stays a better version.
  const xmode = !!(state && ((state.mission && state.mission.mode === 'experience') || (Array.isArray(state.goals) && state.goals.length)));
  const X_KEYS = INTENTS.filter(([k]) => /^x[A-Z]/.test(k)).map(([k]) => k);
  if (!xmode) for (const k of X_KEYS) drop(k);
  // WHAT DO YOU WANT TO REMEMBER? answered by a chip or in words, up to three in the order said. The
  // chip words are memories, not trip facts: "Amazing beach" is no beach style, "Family memories" no
  // family of four, "Surprise me" no "anywhere" (a destination already named stays). Asked for, or
  // said as what to remember ("I want to remember the food"), never read out of any other sentence.
  const goalAsk = pending === 'goals' || (xmode && /\b(?:want to remember|to remember is|my goals? (?:is|are)|change (?:my|the) goals? to|goals?:)\b/.test(lower));
  if (goalAsk) {
    let gl = goalsIn(lower);
    if (!gl.length && pending === 'goals' && /\b(?:skip|don'?t know|not sure|no idea|whatever|dunno)\b/.test(lower)) gl = ['surprise'];
    if (gl.length) {
      updates.goals = gl;
      for (const k of ['style', 'anywhere', 'warm']) delete updates[k];
      if (updates.destination === null) delete updates.destination;
      if (updates.who === 'family' && !/\b\d+\b|\bfamily of\b|\b(?:two|three|four|five|six)\b/.test(lower)) { delete updates.who; delete updates.travelers; }
      ack.length = 0;
      for (const k of ['build', 'better', 'remember']) drop(k);
    }
    // An answer to WHAT DO YOU WANT TO REMEMBER? ("I want to remember this trip with my partner") is
    // about the trip's memories, never "remember my defaults" or "forget my defaults": nothing goes to
    // or leaves the account from it. Without a goal in it, the question is asked again.
    if (pending === 'goals') for (const k of ['remember', 'forget']) drop(k);
  }
  // MORE MEMORIES / OUR PICK / MORE COMFORT, by name or by its number on the card (the card's own
  // order, whichever of the three were built), never the save-max or mission ways' keys.
  if (xmode && state.mission && state.mission.mode === 'experience') {
    const shown = (state.mission.strategies || []).map(w => w.key);
    const named = [['memories', /\bmore memories\b/], ['pick', /\bour pick\b/], ['comfort', /\bmore comfort\b/]].find(([, re]) => re.test(lower));
    // A card is picked by its name, or by its number as the whole message ("2", "number 2", "#2", the
    // card's own "2: love this"). The plain mission's way words ("keep more", "make it special", "want
    // 2", "give me 3") are not these cards: "keep more money" or "we want 2 experiences" never applies
    // MORE COMFORT, and the words keep their own meaning (a night, a cheaper version) or none.
    const cardNo = lower.match(/^\s*(?:number\s*|#\s*)?([123])\s*[.!]?\s*$/) || (fb && fb[2] === 'love this' ? [null, fb[1]] : null);
    if (named) { updates.way = named[0]; drop('approve'); drop('better'); if (!intents.includes('ways')) intents.push('ways'); }
    else if (cardNo && shown[Number(cardNo[1]) - 1]) { updates.way = shown[Number(cardNo[1]) - 1]; if (!intents.includes('ways')) intents.push('ways'); }
    else if (updates.way && updates.way !== 'none') { delete updates.way; drop('ways'); }
    delete updates.wrong;
  }
  // What they said about the stay, for this conversation only: asking for it wins over a "doesn't
  // matter" in the same breath, so a word they did not say is never put in their mouth.
  if (xmode && stayAsked(lower, updates)) { updates.statedStay = true; if (updates.priority !== 'hotel') ack.push('where you stay matters to you'); }
  else if (xmode && stayLowSaid(lower)) { updates.stayLow = true; ack.push('where you stay doesn\'t matter much to you'); }
  const xs = intents.filter(k => X_KEYS.includes(k));
  if (xs.length) {
    const x = xs[0];
    const keep = {};
    // MAKE $100 MEMORABLE: the amount is the one in the chip's words, never a budget.
    if (x === 'xMemorable') { const m = lower.match(/\bmake \$?\s*([\d,]+)/); if (m && num(m[1]) > 0) keep.memAmount = Math.round(num(m[1]) * 100); }
    // The experience the words name, as words; the agent matches them against the trip's own list.
    const target = re => { const m = lower.match(re); const w = m ? m[1].trim().replace(/[.!?]+$/, '').trim() : ''; return w && !/^(?:this|it|that|one|something)$/.test(w) ? w : null; };
    if (x === 'xTrade') keep.target = target(/\btrade (?:something|anything) for (.+)$/);
    if (x === 'xAlternative') keep.target = target(/\balternative (?:experience )?(?:to|for) (.+)$/);
    if (x === 'xProtect') keep.target = target(/^\s*protect (.+)$/);
    if (x === 'xDrop') keep.target = target(/^\s*drop (.+)$/);
    // A reservation the traveler already holds: its date is the one in the words; the slot only when
    // the words say it (a concert time is not assumed); no date means the agent asks for it.
    if (x === 'xEvent') {
      const when = parseDate(clean, now);
      const w = (lower.match(/\b(concert|show|game|match|wedding|dinner|restaurant|table|reservation|tickets?)\b/) || [])[1] || '';
      const name = /concert/.test(w) ? 'your concert' : /show/.test(w) ? 'your show' : /game|match/.test(w) ? 'your game' : /wedding/.test(w) ? 'the wedding' : /dinner|restaurant|table|reservation/.test(w) ? 'your restaurant reservation' : 'your tickets';
      const slot = /\b(?:evening|night|dinner|tonight|\d{1,2}\s*pm)\b/.test(lower) ? 'evening' : /\b(?:morning|breakfast|\d{1,2}\s*am)\b/.test(lower) ? 'morning' : null;
      keep.event = { name, date: when && when.depart ? when.depart : null, slot };
    }
    // "The hotel matters most, upgrade the hotel": the stay was asked for in the same breath, so the
    // challenge never answers that the customer said the opposite.
    if (x === 'xUpgrade' && stayAsked(lower, updates)) keep.statedStay = true;
    // "The hotel doesn't matter, make $100 memorable": what they said about the stay rides with the chip.
    if (updates.statedStay) keep.statedStay = true;
    else if (updates.stayLow) keep.stayLow = true;
    for (const k of Object.keys(updates)) delete updates[k];
    Object.assign(updates, keep);
    ack.length = 0; intents.length = 0; intents.push(x);
  }
  // The date of a reservation the agent asked for.
  if (pending === 'eventDate' && !xs.length) { const when = parseDate(clean, now); if (when && when.depart) { for (const k of Object.keys(updates)) delete updates[k]; updates.event = { date: when.depart }; ack.length = 0; intents.length = 0; intents.push('xEvent'); } }
  // "Keep the hotel" while MOVE $X TO THE EXPERIENCE is on the table answers it: the hotel stays and
  // nothing is locked by it (a lock is a rule the traveler sets on its own).
  if (state && state.proposal && state.proposal.kind === 'downsell' && /^\s*keep (?:the|my) hotel[.!]?\s*$/.test(lower)) { delete updates.locks; ack.length = 0; intents.length = 0; intents.push('decline'); }
  // "Take the upgrade" while the hotel upgrade (or the challenge that kept it one phrase away) is on
  // the table takes that version; it is not a new "make it better" search.
  if (xmode && state.proposal && (state.proposal.alternative || state.proposal.kind === 'upgrade') && /^\s*take the upgrade[.!]?\s*$/.test(lower)) { for (const k of Object.keys(updates)) delete updates[k]; ack.length = 0; intents.length = 0; intents.push('approve'); }
  // WHAT WAS ACTUALLY WORTH IT? after the trip: the chip ("Worth it: Food", "Not worth it: Hotel") or
  // the traveler's words about it; nothing else in the message is read as a trip change.
  if (state && state.booking && (pending === 'worthIt' || /^\s*(?:not )?worth it\s*:/.test(lower) || /\b(?:was|were|wasn'?t|weren'?t)(?: (?:really|totally|not))? worth it\b/.test(lower))) {
    const wi = worthFrom(lower);
    if (wi.worth.length || wi.notWorth.length) { for (const k of Object.keys(updates)) delete updates[k]; updates.worthIt = wi; ack.length = 0; intents.length = 0; intents.push('worthIt'); }
  }

  // A letter is that and nothing else: the words of a card's label ("Option A: Better location: …",
  // "Option B: Hotel upgrade: …") are never read as a chip, a rule or a trip change. With a lettered
  // menu pending it answers it; with pushed variants pending, "pick A" picks one; otherwise it names a
  // version from an earlier card (`staleOption`), and the agent applies nothing unless the proposal on
  // the table carries that letter and label.
  if (lt && !(pending === 'variants' && lt.letter > 'C')) {
    for (const k of Object.keys(updates)) delete updates[k];
    ack.length = 0; intents.length = 0;
    if (pending === 'options') { updates.option = lt.letter; if (lt.label) updates.optionLabel = lt.label; }
    else if (pending === 'variants') { updates.variant = lt.letter; intents.push('ways'); }
    else updates.staleOption = lt;
  }
  // "Why Cancun?" asks about a choice; it never sends the trip there.
  if (intents.includes('whyPick')) { if (updates.destination) { updates.destinationAsked = updates.destination; delete updates.destination; } delete updates.anywhere; }
  const unknown = !intents.length && !Object.keys(updates).length;
  return { text: clean, updates, intents, ack, unknown };
}

module.exports = { understand, letterOf, extractUpdates, theirsFrom, parseDate, destinationIn, originIn, goalsIn, worthFrom, INTENTS, NOT_COMPARED, DEST_ALIASES, GOAL_WORDS };
