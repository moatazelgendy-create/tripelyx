const { loadConfig } = require('./config');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const { app, store } = await createApp(config);
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
