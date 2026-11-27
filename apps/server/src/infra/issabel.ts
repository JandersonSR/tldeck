// Issabel/Asterisk via the read-only collector that runs on the PBX (integrations/issabel-monitor).
// GET <ISSABEL_URL>/health (Bearer token) returns checks with ok/warn/critical/unknown; each area
// (service, recordings, permissions, log, disk, telephony, CLI socket, audit) becomes a resource.
// A critical check takes its area "down": the tracker fires the critical alert and the automatic
// incident (the name carries "prod"). Warnings become warning alerts. A collector that stops answering,
// or answers with an old report, is itself a critical "down" resource: silence never looks like OK.
import { z } from 'zod';
import { getJson, InfraHttpError, type Fetcher } from './http.js';
import type { InfraAlert, InfraDetail, InfraProvider, InfraResource, InfraSnapshot, ResourceStatus } from './types.js';

const Status = z.enum(['ok', 'warn', 'critical', 'unknown']);
type CheckStatus = z.infer<typeof Status>;
const Check = z.object({
  id: z.string(), area: z.string(), label: z.string(), status: Status, summary: z.string(),
  since: z.string().nullable().optional(),
}).passthrough();
const Report = z.object({
  version: z.number(), host: z.string().optional(), generatedAt: z.string(), simulate: z.boolean().optional(),
  areas: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  checks: z.array(Check),
});
export type IssabelReport = z.infer<typeof Report>;

/** A report older than this means the collector is stuck (it refreshes every 30–60 s). */
export const STALE_MS = 3 * 60_000;
const RANK: Record<CheckStatus, number> = { ok: 0, unknown: 1, warn: 2, critical: 3 };
const TO_RESOURCE: Record<CheckStatus, ResourceStatus> = { ok: 'ok', unknown: 'unknown', warn: 'warn', critical: 'down' };

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** Report → resources (one per area) and warning alerts. */
export function issabelSnapshot(rep: IssabelReport, name: string, now: number): InfraSnapshot {
  const resources: InfraResource[] = [];
  const alerts: InfraAlert[] = [];
  const order = rep.areas.map(a => a.id);
  const areas = [...new Set(rep.checks.map(c => c.area))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  for (const area of areas) {
    const checks = rep.checks.filter(c => c.area === area).sort((a, b) => RANK[b.status] - RANK[a.status]);
    const worst = checks[0]!.status;
    const id = `issabel:${area}`;
    const label = rep.areas.find(a => a.id === area)?.label ?? area;
    const resourceName = `${name} · ${label}`;
    const problems = checks.filter(c => c.status === 'critical' || c.status === 'warn');
    const details: InfraDetail[] = checks.map(c => ({ label: c.label, status: TO_RESOURCE[c.status], text: c.summary }));
    resources.push({
      id, provider: 'issabel', kind: 'issabel', name: resourceName, status: TO_RESOURCE[worst],
      statusText: (problems.length ? problems : checks).slice(0, 3).map(c => c.summary).join(' · '), details,
    });
    for (const c of checks.filter(x => x.status === 'warn')) {
      const since = c.since ? Date.parse(c.since) : NaN;
      alerts.push({
        fingerprint: `issabel:${c.id}`, provider: 'issabel', resourceId: id, resourceName, severity: 'warning',
        title: `${resourceName}: ${c.label} (${c.summary})`, startedAt: new Date(Number.isFinite(since) ? since : now).toISOString(),
      });
    }
  }
  return { resources, alerts, deploys: [], ...(rep.simulate ? { warnings: ['collector in SIMULATION mode (/tmp/tldeck-sim)'] } : {}) };
}

export function issabelProvider(opts: { url: string; token: string; name: string; fetcher?: Fetcher }): InfraProvider {
  const fetcher = opts.fetcher ?? fetch;
  const base = opts.url.replace(/\/+$/, '');
  const collectorId = 'issabel:collector';
  const collector = (status: ResourceStatus, text: string): InfraResource => ({
    id: collectorId, provider: 'issabel', kind: 'collector', name: `${opts.name} · coletor`, status, statusText: text,
  });
  let last: InfraSnapshot | undefined;

  return {
    id: 'issabel', label: 'Issabel',
    async poll(now) {
      let rep: IssabelReport;
      try {
        rep = await getJson(fetcher, `${base}/health`, { Authorization: `Bearer ${opts.token}` }, Report, 10_000);
      } catch (e) {
        // The last known areas stay (their alerts keep firing); the collector itself goes down.
        const why = e instanceof InfraHttpError ? e.message : 'sem resposta';
        return { ...(last ?? { alerts: [], deploys: [] }), resources: [...(last?.resources ?? []), collector('down', `coletor sem resposta: ${why}`)] };
      }
      const snap = issabelSnapshot(rep, opts.name, now);
      const age = now - Date.parse(rep.generatedAt);
      if (Number.isFinite(age) && age > STALE_MS) {
        return { ...snap, resources: [...snap.resources, collector('down', `relatório parado há ${minutes(age)} (${rep.host ?? 'coletor'})`)] };
      }
      last = snap;
      return { ...snap, resources: [...snap.resources, collector('ok', `${rep.host ?? 'coletor'} · relatório de ${new Date(rep.generatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)] };
    },
  };
}
