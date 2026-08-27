/**
 * The Pub/Sub push endpoint that receives budget notifications.
 *
 * Deliberately tiny. It has one job — turn an HTTP body into a
 * `handleNotification` call and a status code — and it holds no state, no
 * vault, no model and no request context.
 *
 * Why it imports `@privacy-gateway/common/config` and `/logging` rather than
 * the package root: the root re-exports the token vault and the tokenizer.
 * This service has no business being able to reach either, and the same
 * subpath discipline that keeps the Core Agent structurally clear of the vault
 * applies here for the same reason.
 *
 * Authentication is Cloud Run's, not this process's. The push subscription
 * carries an OIDC token for a dedicated service account, and only that account
 * holds `run.invoker` on this service (infra/terraform/killswitch.tf), so an
 * unauthenticated request is rejected before it reaches Node. Re-verifying the
 * token here would be a second, weaker copy of a check that already passed.
 */

import { loadConfig, type Config } from '@privacy-gateway/common/config';
import { createLogger, type Logger } from '@privacy-gateway/common/logging';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { cloudRunActions, type KillActions } from './actions.ts';
import { handleNotification, type KillTargets } from './handler.ts';

/** Cloud Run injects PORT. Locally 8084 follows synthesis (8083). */
const DEFAULT_PORT = 8084;

/** Budget messages are small; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export interface CreateAppOptions {
  readonly config: Config;
  readonly logger: Logger;
  /** Injected by tests; real callers get the Cloud Run Admin API. */
  readonly actions?: KillActions | undefined;
  readonly targets?: KillTargets | undefined;
}

/**
 * Service names the switch acts on.
 *
 * Overridable through the environment so a staging deployment can point at
 * differently-named services, but defaulted to the fleet's real names because
 * the deployment that matters is the one in docs/DEPLOY.md.
 */
function resolveTargets(env: NodeJS.ProcessEnv): KillTargets {
  return {
    gatewayService: env['KILL_SWITCH_GATEWAY_SERVICE'] ?? 'gateway-agent',
    gemmaService: env['KILL_SWITCH_GEMMA_SERVICE'] ?? 'gemma-serving',
  };
}

/** Builds the Express app. Importing this module must not start a listener. */
export function createApp(options: CreateAppOptions): express.Application {
  const { config, logger } = options;
  const targets = options.targets ?? resolveTargets(process.env);
  const actions =
    options.actions ??
    cloudRunActions({
      project: config.GOOGLE_CLOUD_PROJECT ?? '',
      region: config.GOOGLE_CLOUD_LOCATION ?? 'us-central1',
    });

  const app = express();
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/pubsub/push', (req, res) => {
    void (async () => {
      const outcome = await handleNotification(req.body, { actions, logger, targets });

      switch (outcome.kind) {
        case 'rejected':
          // 400, not 500: the message will never become valid, so Pub/Sub
          // should drop it rather than redeliver it until the retention window
          // expires. The ERROR log is how an operator learns it happened.
          res.status(400).json({ ok: false, error: outcome.error });
          return;
        case 'failed':
          // 500 asks Pub/Sub to redeliver. The mutations are idempotent, so a
          // retry finishes the half that failed and no-ops the half that did not.
          res.status(500).json({ ok: false, error: outcome.error });
          return;
        default:
          res.status(204).end();
      }
    })();
  });

  return app;
}

/** Boot the service. Only runs when this file is the process entry point. */
async function main(): Promise<void> {
  const config = loadConfig({ agent: 'kill-switch' });
  const logger = createLogger({
    agent: 'kill-switch',
    level: config.LOG_LEVEL,
    project: config.GOOGLE_CLOUD_PROJECT,
  });

  const port = config.PORT ?? DEFAULT_PORT;
  const app = createApp({ config, logger });

  app.listen(port, () => {
    logger.event('killswitch.listening', { port });
  });
}

// Why the URL comparison rather than `require.main === module`: this is an ES
// module, and the tests import `createApp` from here without wanting a listener.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
