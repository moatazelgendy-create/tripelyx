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

// A message from the Contact support or For travel businesses form.
function validateMessage(input) {
  const msg = {
    kind: input && input.kind === 'partner' ? 'partner' : 'support',
    name: str(input && input.name, 100),
    company: str(input && input.company, 120),
    email: str(input && input.email, 120).toLowerCase(),
    type: str(input && input.type, 60),
    message: str(input && input.message, 2000),
    trip: /^[A-Za-z0-9~._-]{3,400}$/.test(String((input && input.trip) || '')) ? String(input.trip) : null,
  };
  const errors = {};
  if (!msg.name) errors.name = 'Enter your name.';
  if (!EMAIL.test(msg.email)) errors.email = 'Enter a valid email address.';
  if (!msg.message || msg.message.length < 10) errors.message = 'Tell us a little more (at least 10 characters).';
  if (Object.keys(errors).length) throw new AppError('invalid_message', 'Check the highlighted fields.', 422, errors);
  return msg;
}

module.exports = { str, validateTraveler, validateMessage, EMAIL };
