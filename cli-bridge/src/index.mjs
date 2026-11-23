import { loadConfig } from './config.mjs';
import { createBridgeApp } from './server.mjs';

const config = loadConfig(process.env);
if (!config.apiKey) {
  console.error('[cli-bridge] CLI_BRIDGE_API_KEY is required and must be non-empty');
  process.exit(1);
}

const { server, registry, shutdown } = createBridgeApp(config);

server.listen(config.port, config.host, () => {
  const enabled = registry.listEnabledDrivers().map((d) => d.id);
  console.log(
    `[cli-bridge] listening on http://${config.host}:${config.port} (enabled drivers: ${enabled.length ? enabled.join(', ') : 'none'})`
  );
});

const handleSignal = async (sig) => {
  console.log(`[cli-bridge] received ${sig}, aborting active CLI turns and shutting down`);
  await shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => void handleSignal('SIGTERM'));
process.on('SIGINT', () => void handleSignal('SIGINT'));
