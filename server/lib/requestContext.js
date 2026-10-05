// Per-request context (the signed-in user, the anonymous visitor id) that the layout reads without
// every view having to pass it along.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

function current() {
  return als.getStore() || {};
}

module.exports = { runWithContext, current };
