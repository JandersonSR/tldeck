// ntfy (optional phone/desktop push). The topic URL is a secret of its own: never logged.
import type { FastifyBaseLogger } from 'fastify';
import { absoluteUrl, type Alert } from './alert-hub.js';

export interface Ntfy { configured: boolean; send(a: Alert): Promise<boolean> }

/** "https://ntfy.sh/topic" -> { base: "https://ntfy.sh", topic: "topic" } (a server under a path keeps the path). */
export function splitNtfyUrl(url: string): { base: string; topic: string } | undefined {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic) return undefined;
  return { base: `${u.origin}/${parts.join('/')}`.replace(/\/$/, ''), topic };
}

export function createNtfy(url: string | undefined, log: FastifyBaseLogger, port = 0): Ntfy {
  return {
    configured: !!url,
    async send(a) {
      if (!url) return false;
      try {
        const target = splitNtfyUrl(url);
        if (!target) return false;
        // JSON publishing: accepts accents in the title (HTTP headers do not).
        await fetch(`${target.base}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: target.topic, title: a.title, message: a.body, priority: a.urgency === 'high' ? 4 : 3,
            tags: [a.kind.startsWith('agent_') ? 'robot' : 'memo'], ...(a.url ? { click: absoluteUrl(port, a.url) } : {}),
          }),
          signal: AbortSignal.timeout(5_000),
        });
        return true;
      } catch {
        log.warn('ntfy unreachable');
        return false;
      }
    },
  };
}
