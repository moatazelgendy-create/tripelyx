# Trip demo inventory

Everything in this folder is **invented demo data** for the budget trip planner: destinations, the
fictional airlines, hotel names, ratings, nightly rates, activities, transfer prices and the "typical
price" baselines used by the Deal Score. None of it comes from a real supplier, and none of it is ever
used when `TRIP_PROVIDER` points at a real package supplier.

Prices are generated deterministically from these numbers (distance, season, weekday, lead time and a
small per-date variation), so the same search always returns the same trips in tests and previews.

Hotel ratings here are demo supplier ratings, not traveler reviews, and are labeled as such in the UI.
