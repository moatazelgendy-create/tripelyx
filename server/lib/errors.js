// Errors that are safe to show the traveler carry a stable `code` and HTTP `status`; anything else
// is treated as an internal failure and answered with a generic message plus a reference id.
class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

// Raised by provider adapters when the supplier misbehaves (timeout, malformed response, outage).
// The engine turns it into a 502 for the traveler and never leaks the supplier's own error text.
class ProviderError extends Error {
  constructor(provider, message, { retryable = true, cause } = {}) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

module.exports = { AppError, ProviderError };
