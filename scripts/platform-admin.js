#!/usr/bin/env node
// Platform admins (plan §I1, D1): list, grant and revoke the platform_admin records that, together with
// ADMIN_EMAILS, let an account open /admin and /admin/business. It runs against the site's own database,
// configured exactly as the server reads it (DATABASE_URL, or DATABASE_HOST with its parts, plus APP_ENV
// and ADMIN_EMAILS):
//
//   node scripts/platform-admin.js list
//   node scripts/platform-admin.js grant --email ops@example.com
//   node scripts/platform-admin.js revoke --email ops@example.com [--sign-out]
//
// - list: every ADMIN_EMAILS address and where it stands (including an old account the next boot will
//   grandfather), then any record whose email is no longer listed (those give no access).
// - grant: refuses an address that is not in ADMIN_EMAILS (the allow-list is still the first half of the
//   check) and an address with no account yet (sign up first). Granting an active admin again changes nothing.
// - revoke: sets revokedAt on the record (the record stays, for the history). An account with no record gets
//   a revoked one, so the boot seed can never grant it. With --sign-out it also signs the account out
//   everywhere (sessionsValidAfter, I4). It works for any address, listed or not.
// Every command prints the account's name and creation date, so you can see it is the right account.
//
// It refuses to run on the in-memory store, where it would change nothing the site can see. On AWS, run it
// as a one-off task of the admin task definition (family tripelyx-<env>-admin, container "admin"), never
// the site's own task definition: the admin task gets the database secret and nothing else, so a mistaken
// command can never print a key the site holds. The image must contain this file (the Dockerfile copies it
// to /app/scripts). See "One-off admin tasks" in README.md for the network configuration:
//   aws ecs run-task --cluster tripelyx-<env> --task-definition tripelyx-<env>-admin --launch-type FARGATE \
//     --network-configuration '<the web service network configuration>' \
//     --overrides '{"containerOverrides":[{"name":"admin","command":["node","scripts/platform-admin.js","list"]}]}'
// and read its output in the log group /tripelyx/<env>, stream admin/admin/<task id>.
const { loadConfig } = require('../server/config');
const { createStore } = require('../server/booking');
const { Accounts, PLATFORM_ADMIN, ADMIN_SEED_BEFORE, seedPending } = require('../server/accounts');
const { str } = require('../server/lib/validate');

const USAGE = [
  'Usage:',
  '  node scripts/platform-admin.js list',
  '  node scripts/platform-admin.js grant --email <email>',
  '  node scripts/platform-admin.js revoke --email <email> [--sign-out]',
].join('\n');

/** Exit codes: 0 done, 1 refused or failed, 2 the command line was not understood. */
const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 });

const day = iso => (typeof iso === 'string' && iso ? iso.slice(0, 10) : 'unknown date');
const describe = user => `${user.name} <${user.email}>, account created ${day(user.createdAt)}`;

/**
 * Read the command line: a command, then --email <e> (or --email=<e>) and --sign-out.
 * @param {string[]} argv
 * @returns {{ command: string, email: string|null, signOut: boolean }|{ error: string }}
 */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['list', 'grant', 'revoke'].includes(command)) return { error: command ? `Unknown command "${command}".` : 'Name a command.' };
  let email = null, signOut = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--email') {
      if (i + 1 >= rest.length) return { error: '--email needs an address.' };
      email = rest[i += 1];
    } else if (a.startsWith('--email=')) {
      email = a.slice('--email='.length);
    } else if (a === '--sign-out') {
      signOut = true;
    } else {
      return { error: `Unknown option "${a}".` };
    }
  }
  if (command === 'list' && (email !== null || signOut)) return { error: 'list takes no options.' };
  if (command !== 'list' && !email) return { error: `${command} needs --email <email>.` };
  if (command === 'grant' && signOut) return { error: '--sign-out goes with revoke only.' };
  return { command, email: email === null ? null : str(email, 120).toLowerCase(), signOut };
}

// The account an email belongs to (the same lookup sign-in makes), or null.
async function userByEmail(store, email) {
  if (!email) return null;
  const link = await store.getRecord('user_email', email);
  const user = link && typeof link.userId === 'string' && link.userId ? await store.getRecord('user', link.userId) : null;
  return user && user.email === email ? user : null;
}

/**
 * Run one command against a store. The script's main() builds the store from the environment; tests pass
 * a MemoryStore.
 * @param {string[]} argv the arguments after the script name
 * @param {{ store: object, config: object, now?: () => Date, out?: (line: string) => void, err?: (line: string) => void }} deps
 * @returns {Promise<number>} the exit code (EXIT)
 */
async function run(argv, { store, config, now = () => new Date(), out = line => console.log(line), err = line => console.error(line) }) {
  const args = parseArgs(argv);
  if (args.error) { err(args.error); err(USAGE); return EXIT.usage; }
  const accounts = new Accounts({ store, config, now });
  const listed = config.trips.adminEmails;

  if (args.command === 'list') {
    out(`ADMIN_EMAILS lists ${listed.length} ${listed.length === 1 ? 'address' : 'addresses'}.`);
    for (const email of listed) {
      const user = await userByEmail(store, email);
      if (!user) { out(`  ${email}: no account with this email yet.`); continue; }
      const rec = await store.getRecord(PLATFORM_ADMIN, user.id);
      let state;
      if (await accounts.isPlatformAdmin(user)) state = `Platform admin since ${day(rec.grantedAt)} (${rec.grantedBy})`;
      else if (rec && rec.revokedAt) state = `Not an admin: revoked on ${day(rec.revokedAt)}`;
      else if (rec) state = `Not an admin: its record is for ${rec.email} (grant it again to give access)`;
      else if (await seedPending(store, user)) state = `Not an admin yet, but created before ${day(ADMIN_SEED_BEFORE)}, so the next boot grants it (revoke it to stop that)`;
      else state = 'Not an admin: no record (grant it to give access)';
      out(`  ${email}: ${describe(user)}. ${state}.`);
    }
    const records = await store.listRecords(PLATFORM_ADMIN, { limit: 1000 });
    const unlisted = records.filter(r => r && !listed.includes(r.email) && !r.revokedAt);
    if (unlisted.length) {
      out('Records for addresses no longer in ADMIN_EMAILS (they give no access):');
      for (const r of unlisted) {
        const user = typeof r.userId === 'string' && r.userId ? await store.getRecord('user', r.userId) : null;
        out(`  ${r.email}: ${user ? describe(user) : 'account not found'}. Granted on ${day(r.grantedAt)} (${r.grantedBy}).`);
      }
    }
    return EXIT.ok;
  }

  const user = await userByEmail(store, args.email);
  if (args.command === 'grant') {
    if (!listed.includes(args.email)) {
      err(`Refused: ${args.email} is not in ADMIN_EMAILS. Add it there first, then grant it.`);
      return EXIT.refused;
    }
    if (!user) { err(`Refused: no account uses ${args.email}. Sign up with it first, then grant it.`); return EXIT.refused; }
    if (await accounts.isPlatformAdmin(user)) { out(`Already a platform admin: ${describe(user)}. Nothing changed.`); return EXIT.ok; }
    await accounts.grantPlatformAdmin(user.id, { by: 'cli', note: 'scripts/platform-admin.js grant' });
    out(`Granted platform admin: ${describe(user)}.`);
    return EXIT.ok;
  }

  // revoke
  if (!user) { err(`Refused: no account uses ${args.email}.`); return EXIT.refused; }
  const before = await store.getRecord(PLATFORM_ADMIN, user.id);
  await accounts.revokePlatformAdmin(user.id);
  if (!before) out(`No platform admin record for ${describe(user)}. Recorded it as revoked, so no boot can grant it.`);
  else if (before.revokedAt) out(`Already revoked on ${day(before.revokedAt)}: ${describe(user)}.`);
  else out(`Revoked platform admin: ${describe(user)}.`);
  if (args.signOut) {
    const at = await accounts.endAllSessions(user.id);
    out(`Signed out everywhere: every session issued before ${at} has ended.`);
  }
  return EXIT.ok;
}

async function main() {
  const config = loadConfig(process.env);
  if (!config.databaseUrl || config.databaseUrl === 'memory') {
    console.error('Refused: set DATABASE_URL (or DATABASE_HOST and its parts) to the database the site uses. The in-memory store would change nothing the site can see.');
    return EXIT.refused;
  }
  const store = createStore(config);
  await store.init();
  try {
    return await run(process.argv.slice(2), { store, config });
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, e => { console.error(`platform-admin failed: ${e.message}`); process.exitCode = EXIT.refused; });
}

module.exports = { run, parseArgs, USAGE, EXIT };
