const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { runPreviewSeed } = require('./lib/previewSeed');

async function main() {
  const config = loadConfig();
  const built = await createApp(config);
  const { app, store } = built;
  // The private preview's demo companies (PREVIEW_SEED=business), before the first request; off otherwise.
  await runPreviewSeed(config, built);
  const server = app.listen(config.port, () => {
    console.log(`Tripelyx (${config.appEnv}) listening on http://localhost:${config.port} — store: ${store.kind}, payments: ${config.payment.mode}`);
  });
  const shutdown = () => server.close(() => store.close().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('[boot] Tripelyx failed to start:', err.message);
  process.exit(1);
});
