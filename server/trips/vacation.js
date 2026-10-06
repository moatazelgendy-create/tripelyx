// The whole-vacation picture: the booking next to the money the traveler protects for the
// destination. Everything here is either the traveler's own number, the booking's complete price,
// or arithmetic on the two. Nothing is estimated: we have no reliable number for how a traveler
// eats, moves or shops, so food, local transport and shopping are never guessed, and the traveler
// puts them in the reserve if they want them in the picture. The reserve is theirs: the booking
// never takes from it quietly, and we never say whether it is "enough".

// `cx.budget` is the booking budget the trip is read against, `cx.keep` the money protected for
// the destination; the whole vacation budget is the two together.
function vacationPlan(t, cx, options = null) {
  if (!cx || !cx.budget) return null;
  const keep = cx.keep || 0;
  const vacation = cx.budget + keep;
  const unassigned = Math.max(0, cx.budget - t.total);       // left of the booking budget, assigned to nothing
  const raid = Math.max(0, Math.min(keep, t.total - cx.budget)); // what this booking would take from the reserve
  const over = Math.max(0, t.total - vacation);              // beyond even the reserve
  const reserveLeft = keep - raid;
  const arrive = Math.max(0, vacation - t.total);            // money not spent at checkout
  const days = t.spec.nights + 1;                            // arrival day to departure day
  const perDay = Math.round(arrive / days / 100) * 100;                // whole dollars: a planning figure, not a forecast

  // Real prices of things not in this booking that the traveler could add; never an estimate.
  const optional = [];
  if (options) {
    if (options.transfer && !t.spec.transfer) optional.push({ key: 'transfer', label: 'Private airport transfer, both ways', amount: options.transfer.delta });
    if (options.bags && !t.spec.bags && !t.flight.checkedBagIncluded) optional.push({ key: 'bags', label: 'A checked bag for each traveler, both ways', amount: options.bags.delta });
    const acts = (options.activities || []).filter(a => !a.selected);
    if (acts.length) optional.push({ key: 'experiences', label: acts.length === 1 ? acts[0].activity.name : `${acts.length} experiences you could add`, amount: Math.min(...acts.map(a => a.cost)), from: acts.length > 1 });
  }

  // What the reserve does not need to cover, from the booking's own facts.
  const covered = [];
  if (t.hotel.features.allInclusive) covered.push('all meals and drinks at the resort');
  else if (t.hotel.features.breakfast) covered.push('daily breakfast');
  if (t.transfer) covered.push('the airport transfer both ways');
  if (t.flight.checkedBagIncluded || t.spec.bags) covered.push('checked bags');
  if (t.activities.length) covered.push(t.activities.length === 1 ? t.activities[0].name : `${t.activities.length} experiences`);

  // What we do not price for the traveler, and say so.
  const unknown = [
    ...(t.hotel.features.allInclusive ? ['meals away from the resort'] : t.hotel.features.breakfast ? ['meals other than breakfast'] : ['meals and drinks']),
    'getting around once there',
    'tips and shopping',
    ...(t.internationalTrip ? ['visas or entry fees'] : []),
  ];

  return {
    keep, vacation, booking: t.total, unassigned, raid, over, reserveLeft, arrive, days, perDay,
    fits: t.total <= cx.budget, planned: t.total + reserveLeft, optional, covered, unknown,
  };
}

module.exports = { vacationPlan };
