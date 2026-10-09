// Airlines a company can name in its travel policy (blocked carriers) while flights come from the supplier
// (real-suppliers design §1.2, §1.4): real IATA codes and names of airlines that fly to and from the 14 airports
// in the airport table. inventory.carriers() in sandbox is this list plus Duffel's test airline ZZ ("Test
// airline"); never the fictional demo carriers. Frozen: the opt-in contract test
// (test/business-suppliers-contract.test.js) checks every code against Duffel's GET /air/airlines and reports
// any name that reads differently there (counts only).

const AIRLINES = Object.freeze([
  ['A3', 'Aegean Airlines'],
  ['AF', 'Air France'],
  ['AZ', 'ITA Airways'],
  ['BA', 'British Airways'],
  ['EK', 'Emirates'],
  ['EY', 'Etihad Airways'],
  ['F3', 'flyadeal'],
  ['FR', 'Ryanair'],
  ['FZ', 'flydubai'],
  ['G9', 'Air Arabia'],
  ['GF', 'Gulf Air'],
  ['KL', 'KLM'],
  ['LH', 'Lufthansa'],
  ['MS', 'EgyptAir'],
  ['NP', 'Nile Air'],
  ['PC', 'Pegasus Airlines'],
  ['QR', 'Qatar Airways'],
  ['RJ', 'Royal Jordanian'],
  ['SM', 'Air Cairo'],
  ['SV', 'Saudia'],
  ['TK', 'Turkish Airlines'],
  ['U2', 'easyJet'],
  ['VS', 'Virgin Atlantic'],
  ['W6', 'Wizz Air'],
  ['XY', 'flynas'],
].map(([code, name]) => Object.freeze({ code, name })));

/** Duffel's own test airline (D-TEST: "Duffel Airways", IATA ZZ), named for travelers in sandbox. */
const TEST_AIRLINE = Object.freeze({ code: 'ZZ', name: 'Test airline' });

module.exports = { AIRLINES, TEST_AIRLINE };
