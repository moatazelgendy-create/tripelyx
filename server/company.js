// Who runs Tripelyx, in one place. Every page that names the company, its legal entity, how to reach
// support or the copyright line reads it from here (ctx.company); nothing else hard-codes company facts.
//
// The defaults are only the facts the owner has confirmed. A fact that has not been confirmed stays
// null, and every page that would show it leaves it out rather than guess. Each value can be set or
// replaced from the environment (see .env.example) without a code change.
const CONFIRMED = {
  brandName: 'Tripelyx',
  // Confirmed by the owner on 2026-10-07.
  legalName: 'Tripelyx Inc',
  supportEmail: 'go@tripelyx.com',
};

// The customer-facing promise (the foundation reset's wording).
const BRAND = {
  promise: 'Tell us your budget. We’ll build the trip.',
  line: 'Your money. Your trip. Optimized.',
  footerLine: 'AI-powered travel planning and booking.',
  description: 'Tripelyx is an AI travel agent. Tell us your budget and it builds the whole trip, with every required tax and fee in one total, then you decide.',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value, fallback = null) {
  const v = value === undefined ? '' : String(value).trim();
  return v || fallback;
}

function loadCompany(env = process.env) {
  const supportEmail = text(env.SUPPORT_EMAIL, CONFIRMED.supportEmail);
  if (!EMAIL.test(supportEmail)) throw new Error(`SUPPORT_EMAIL must be an email address (got "${supportEmail}")`);
  const year = text(env.COPYRIGHT_YEAR);
  if (year && !/^\d{4}$/.test(year)) throw new Error(`COPYRIGHT_YEAR must be a four-digit year (got "${year}")`);
  return Object.freeze({
    brandName: text(env.BRAND_NAME, CONFIRMED.brandName),
    legalName: text(env.LEGAL_COMPANY_NAME, CONFIRMED.legalName),
    supportEmail,
    // Not confirmed yet: shown nowhere until set.
    businessAddress: text(env.BUSINESS_ADDRESS),
    supportPhone: text(env.SUPPORT_PHONE),
    supportHours: text(env.SUPPORT_HOURS),
    jurisdiction: text(env.LEGAL_JURISDICTION),
    // Set only once a qualified professional has reviewed the policy pages. Until then they say the
    // service is in preview, and live payments are refused (server/config.js).
    policiesReviewed: ['1', 'true', 'yes', 'on'].includes(String(env.POLICIES_REVIEWED || '').toLowerCase()),
    // A fixed year when set; otherwise pages print the current year.
    copyrightYear: year ? Number(year) : null,
    ...BRAND,
  });
}

module.exports = { loadCompany, CONFIRMED, BRAND };
