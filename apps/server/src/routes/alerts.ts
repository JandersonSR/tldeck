// Alerts: the screen polls GET /api/alerts; POST /api/alerts/test fires a test alert on every channel.
// Writes are covered by the global guard (X-Agent-Board header + local Origin), see http/security.ts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { deckRoute, makeAlert, type AlertHub } from '../notify/alert-hub.js';

export async function alertsRoutes(app: FastifyInstance, opts: { config: Config; hub: AlertHub }): Promise<void> {
  const { config, hub } = opts;
  const pt = config.contentLang !== 'en';

  app.get('/api/alerts', async (req) => {
    const { since } = z.object({ since: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return { now: Date.now(), osToast: hub.osAvailable, ntfy: hub.ntfyConfigured, items: hub.since(since) };
  });

  app.post('/api/alerts/test', async () => {
    const now = Date.now();
    const sent = await hub.send(makeAlert({
      kind: 'test', title: pt ? 'Notificação de teste' : 'Test notification',
      body: pt ? 'Se você viu isto, o canal está funcionando.' : 'If you can see this, the channel works.',
      tag: `test:${now}`, url: deckRoute('settings'), at: new Date(now).toISOString(),
    }));
    return { ok: sent, osToast: hub.osAvailable, ntfy: hub.ntfyConfigured };
  });
}
