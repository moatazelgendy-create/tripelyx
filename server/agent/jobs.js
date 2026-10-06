// Search jobs: the agent answers at once and keeps searching in the background, one real phase at a
// time. Each phase records what it actually did (how many destinations, how many packages priced,
// when), so the page shows real progress and never a fake one. A newer request for the same
// conversation cancels the job still running for it.
class JobRunner {
  constructor({ log = console } = {}) {
    this.running = new Map();
    this.log = log;
  }

  start(key, run) {
    this.cancel(key);
    const job = { key, cancelled: false, startedAt: Date.now() };
    job.promise = Promise.resolve()
      .then(() => run(job))
      .catch(err => { this.log.error('[agent job]', err); })
      .finally(() => { if (this.running.get(key) === job) this.running.delete(key); });
    this.running.set(key, job);
    return job;
  }

  cancel(key) {
    const j = this.running.get(key);
    if (j) j.cancelled = true;
    return !!j;
  }

  isRunning(key) { return this.running.has(key); }

  // Tests and shutdown: wait for every job in flight.
  async drain() { await Promise.all([...this.running.values()].map(j => j.promise)); }
}

// Let the server answer a poll between two phases of a CPU-bound search. Two immediates, not one:
// an immediate queued from the check phase runs on the next loop iteration, so one alone can skip
// the poll phase (and the waiting request) when the phase before it ran inside a request handler.
const breathe = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

const STEP_LABEL = { understand: 'Reading what you asked for', fast: 'Searching the likeliest destinations first', deep: 'Checking every destination', expand: 'Widening the search', verify: 'Refreshing the live price' };

function newJob(id, keys, now = new Date()) {
  return {
    id, status: 'running', startedAt: now.toISOString(), finishedAt: null,
    steps: keys.map(key => ({ key, label: STEP_LABEL[key], status: 'pending', detail: null, at: null, ms: null })),
    first: null, best: null, improved: false, firstAtMs: null, bestAtMs: null, considered: 0, destinations: 0, relax: null, note: null,
  };
}

function setStep(job, key, status, detail = null, now = new Date()) {
  const s = job.steps.find(x => x.key === key);
  if (!s) return;
  s.status = status;
  if (detail !== null) s.detail = detail;
  s.at = now.toISOString();
  s.ms = Date.parse(now.toISOString()) - Date.parse(job.startedAt);
}

module.exports = { JobRunner, breathe, newJob, setStep, STEP_LABEL };
