// main.ts — the forge's lifecycle: bind an ephemeral port, register it with
// the harness, serve until the harness says it is done, then close and exit
// cleanly. Without MAKEFUN_ENV_URL there is nothing to register with, so
// the process exits at once. The token the API expects comes from
// MAKEFUN_SHOP_TOKEN; the forge itself never prints it.

import { buildForge } from './forge.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

if (envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set; nothing to register with.');
  process.exit(1);
}

const { server } = buildForge(shopToken);

let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// A handler bug must never take the whole forge down mid-trial: log it and
// keep serving. The request that threw already got its 500 from forge.ts.
process.on('uncaughtException', (err: Error) => {
  console.error(`uncaught: ${err.message}`);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  let delay = 100;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) return;
      console.error(`register answered ${response.status}; retrying.`);
    } catch (err) {
      console.error(`register failed (${(err as Error).message}); retrying.`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitUntilDone(): Promise<void> {
  let delay = 100;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const payload: unknown = await response.json();
        if (payload !== null && typeof payload === 'object' && (payload as Record<string, unknown>).done === true) {
          return;
        }
      }
    } catch {
      // The env is briefly unreachable; keep polling.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

server.listen(0, '0.0.0.0', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  void register(port)
    .then(() => waitUntilDone())
    .then(() => shutdown(0))
    .catch((err: unknown) => {
      console.error(`lifecycle failed: ${(err as Error).message}`);
      shutdown(1);
    });
});
