const { AppError } = require('./errors');

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

function str(v, max = 200) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// The lead traveler the booking is made for. Every field is length-capped and control characters are
// stripped; output is always escaped at render time as well.
function validateTraveler(input) {
  const t = {
    firstName: str(input && input.firstName, 60),
    lastName: str(input && input.lastName, 60),
    email: str(input && input.email, 120).toLowerCase(),
    phone: str(input && input.phone, 30),
    country: str(input && input.country, 60),
    notes: str(input && input.notes, 500),
  };
  const errors = {};
  if (!t.firstName) errors.firstName = 'Enter a first name.';
  if (!t.lastName) errors.lastName = 'Enter a last name.';
  if (!EMAIL.test(t.email)) errors.email = 'Enter a valid email address.';
  if (t.phone && !/^[+\d][\d\s().-]{5,}$/.test(t.phone)) errors.phone = 'Enter a valid phone number.';
  if (Object.keys(errors).length) throw new AppError('invalid_traveler', 'Check the highlighted fields.', 422, errors);
  return t;
}

function validatePartnerLead(input) {
  const lead = {
    name: str(input && input.name, 100),
    company: str(input && input.company, 120),
    email: str(input && input.email, 120).toLowerCase(),
    type: str(input && input.type, 40),
    message: str(input && input.message, 2000),
  };
  const errors = {};
  if (!lead.name) errors.name = 'Enter your name.';
  if (!EMAIL.test(lead.email)) errors.email = 'Enter a valid email address.';
  if (!lead.message || lead.message.length < 10) errors.message = 'Tell us a little more (at least 10 characters).';
  if (Object.keys(errors).length) throw new AppError('invalid_lead', 'Check the highlighted fields.', 422, errors);
  return lead;
}

module.exports = { str, validateTraveler, validatePartnerLead, EMAIL };
