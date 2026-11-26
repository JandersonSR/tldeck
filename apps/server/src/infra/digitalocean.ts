// DigitalOcean (read-scoped token): Droplets with CPU/memory from Monitoring, and App Platform with deploys.
// The monitoring API returns Prometheus-style series (data.result[].values = [[unix, "value"], …]).
// CPU comes as cumulative seconds per mode: usage = 1 − Δidle / Δtotal between the last two points.
// DigitalOcean alert policies do not say what is firing; threshold alerts come from the
// deck's own tracking (sustained CPU/memory), in tracker.ts.
import { z } from 'zod';
import { getJson, InfraHttpError as HttpError, isScopeError, type Fetcher } from './http.js';
import { pct, type InfraComponent, type InfraDeploy, type InfraProvider, type InfraResource, type InfraSnapshot, type ResourceStatus } from './types.js';

const API = 'https://api.digitalocean.com';
const Series = z.object({
  data: z.object({ result: z.array(z.object({ metric: z.record(z.string(), z.string()).default({}), values: z.array(z.tuple([z.number(), z.string()])).default([]) })) }),
});
type SeriesT = z.infer<typeof Series>;

const Droplets = z.object({
  droplets: z.array(z.object({
    id: z.number(), name: z.string(), status: z.string(),
    region: z.object({ slug: z.string() }).partial().optional(), tags: z.array(z.string()).default([]),
  })),
  links: z.object({ pages: z.object({ next: z.string().optional() }).partial().optional() }).partial().optional(),
});

const Deployment = z.object({ id: z.string(), phase: z.string().optional(), cause: z.string().optional(), created_at: z.string().optional(), updated_at: z.string().optional() }).passthrough();
const Apps = z.object({
  apps: z.array(z.object({
    id: z.string(), spec: z.object({ name: z.string() }).passthrough(), live_url: z.string().optional(), region: z.object({ slug: z.string() }).partial().optional(),
    active_deployment: Deployment.optional(), in_progress_deployment: Deployment.optional(), last_deployment_active_at: z.string().optional(),
  }).passthrough()).default([]),
});
const Deployments = z.object({ deployments: z.array(Deployment).default([]) });
// GET /v2/apps/{id}/health (app:read): per-component state as App Platform "Insights" shows it.
const HealthComponent = z.object({
  name: z.string(), state: z.string().optional(),
  cpu_usage_percent: z.number().optional(), memory_usage_percent: z.number().optional(),
  replicas_desired: z.number().optional(), replicas_ready: z.number().optional(),
}).passthrough();
const AppHealth = z.object({ app_health: z.object({ components: z.array(HealthComponent).default([]) }).passthrough().optional() });
export type AppHealthComponent = z.infer<typeof HealthComponent>;

/** CPU or memory at or above this (%) means the app is saturated, even if DigitalOcean still calls it healthy. */
export const SATURATED_PCT = 95;

/**
 * App status from the component health (and CPU/memory saturation), on top of the deploy status.
 * No ready replica in any component → down; an unhealthy component, missing replicas or saturation → warn.
 */
export function appHealthStatus(base: { status: ResourceStatus; text: string }, comps: AppHealthComponent[], metrics: InfraResource['metrics']): { status: ResourceStatus; text: string } {
  const problems: string[] = [];
  let anyUp = false; let anyDesired = false;
  for (const c of comps) {
    const desired = c.replicas_desired; const ready = c.replicas_ready;
    if (desired !== undefined && desired > 0) anyDesired = true;
    if (ready !== undefined && ready > 0) anyUp = true;
    const short = desired !== undefined && ready !== undefined && ready < desired;
    const unhealthy = c.state !== undefined && c.state !== 'HEALTHY' && c.state !== 'UNKNOWN';
    if (unhealthy || short) problems.push(`${c.name}${short ? ` ${ready}/${desired}` : ''}${unhealthy ? ` ${c.state!.toLowerCase()}` : ''}`);
  }
  if (base.status === 'down' || base.status === 'unknown') return base;
  if (anyDesired && !anyUp) return { status: 'down', text: `no ready instance${problems.length ? ` (${problems.join(', ')})` : ''}` };
  const hot = [['CPU', metrics?.cpu], ['memory', metrics?.memory]].filter(([, v]) => typeof v === 'number' && v >= SATURATED_PCT).map(([k, v]) => `${k} ${Math.round(v as number)}%`);
  if (problems.length || hot.length) return { status: 'warn', text: ['degraded', ...problems, ...hot].join(' · ') };
  return base;
}

/** CPU usage (%) from the per-mode counters of the last interval. */
export function cpuUsage(s: SeriesT): number | undefined {
  let idle = 0; let total = 0; let ok = false;
  for (const r of s.data.result) {
    const v = r.values;
    if (v.length < 2) continue;
    const d = Number(v[v.length - 1]![1]) - Number(v[v.length - 2]![1]);
    if (!Number.isFinite(d) || d < 0) continue;
    total += d; ok = true;
    if (r.metric.mode === 'idle') idle += d;
  }
  return ok && total > 0 ? pct((1 - idle / total) * 100) : undefined;
}

const lastValue = (s: SeriesT) => {
  const v = s.data.result[0]?.values;
  const n = v?.length ? Number(v[v.length - 1]![1]) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Memory used (%) = 1 − available / total. */
export function memoryUsage(available: SeriesT, totalS: SeriesT): number | undefined {
  const a = lastValue(available); const t = lastValue(totalS);
  return a !== undefined && t ? pct((1 - a / t) * 100) : undefined;
}

export function dropletStatus(s: string): { status: ResourceStatus; text: string } {
  return s === 'active' ? { status: 'ok', text: 'active' } : s === 'new' ? { status: 'warn', text: 'starting' } : s === 'off' ? { status: 'down', text: 'off' } : { status: 'unknown', text: s };
}

/** App Platform deploy phases → deploy state. */
export function deployPhase(phase: string | undefined): InfraDeploy['status'] {
  if (!phase) return 'in_progress';
  if (phase === 'ACTIVE' || phase === 'SUPERSEDED') return 'succeeded';
  if (phase === 'ERROR' || phase === 'CANCELED') return 'failed';
  return 'in_progress';
}

/** App Platform components (services, workers, jobs, static sites) with instance size and count, from the app spec. */
export function appComponents(spec: Record<string, unknown>): InfraComponent[] {
  const out: InfraComponent[] = [];
  const kinds = [['services', 'service'], ['workers', 'worker'], ['jobs', 'job'], ['static_sites', 'static']] as const;
  for (const [key, type] of kinds) {
    const list = Array.isArray(spec[key]) ? (spec[key] as Array<Record<string, unknown>>) : [];
    for (const c of list) {
      const size = typeof c.instance_size_slug === 'string' ? c.instance_size_slug : undefined;
      const count = typeof c.instance_count === 'number' ? c.instance_count : 1;
      out.push({ type: typeof c.name === 'string' ? `${type} ${c.name}` : type, ...(size ? { size } : {}), count });
    }
  }
  return out;
}

/** Highest last value across the series (the busiest instance), as a percentage. */
export function peakPercent(s: SeriesT): number | undefined {
  let best: number | undefined;
  for (const r of s.data.result) {
    const n = r.values.length ? Number(r.values[r.values.length - 1]![1]) : NaN;
    if (Number.isFinite(n)) best = best === undefined ? n : Math.max(best, n);
  }
  return best === undefined ? undefined : pct(best);
}

/**
 * DigitalOcean allows 5,000 requests/hour (and 250/minute) per token, shared by everything that uses the token.
 * Base intervals for each kind of read; with many droplets/apps they stretch so the deck stays within HOURLY_BUDGET.
 */
const LIST_EVERY_MS = 60_000;
const DROPLET_METRICS_EVERY_MS = 5 * 60_000;
/** App health is the main status signal for apps. */
const APP_HEALTH_EVERY_MS = 2 * 60_000;
/** App CPU/memory (monitoring); without monitoring:read, re-checked every 30 min. */
const APP_METRICS_EVERY_MS = 5 * 60_000;
const APP_METRICS_RECHECK_MS = 30 * 60_000;
/** Requests per hour the deck may spend, leaving the rest of the 5,000 to other users of the token. */
export const HOURLY_BUDGET = 1_500;
/** Few requests left in the hour (another user of the token is spending them): read 4× less often. */
const LOW_REMAINING = 1_000;
/** Almost none left: stop until the hour resets, so other users of the token are not blocked by the deck. */
const RESERVE = 150;
const DEFAULT_PAUSE_MS = 60_000;

/** Expected requests/hour with the base intervals → factor (≥ 1) that stretches every interval. */
export function stretchFactor(droplets: number, apps: number, lowRemaining = false): number {
  const perHour = (2 * 3_600_000) / LIST_EVERY_MS + (3 * droplets * 3_600_000) / DROPLET_METRICS_EVERY_MS
    + (apps * 3_600_000) / APP_HEALTH_EVERY_MS + (2 * apps * 3_600_000) / APP_METRICS_EVERY_MS;
  return Math.max(1, perHour / HOURLY_BUDGET) * (lowRemaining ? 4 : 1);
}

/**
 * Wraps the fetcher with DigitalOcean's rate-limit headers: after a 429 (or with almost no requests left)
 * nothing goes out until the reset, and calls fail locally with 429 instead of spending more of the quota.
 */
export function rateGate(fetcher: Fetcher, clock: () => number = Date.now) {
  const state = { remaining: undefined as number | undefined, resetAt: 0, pausedUntil: 0 };
  const header = (res: Response, name: string) => { const v = Number(res.headers.get(name)); return res.headers.has(name) && Number.isFinite(v) ? v : undefined; };
  const fetchGated: Fetcher = async (url, init) => {
    if (clock() < state.pausedUntil) return new Response('{}', { status: 429 });
    const res = await fetcher(url, init);
    const remaining = header(res, 'ratelimit-remaining');
    const reset = header(res, 'ratelimit-reset'); // unix seconds
    const retryAfter = header(res, 'retry-after'); // seconds
    if (remaining !== undefined) state.remaining = remaining;
    if (reset !== undefined) state.resetAt = reset * 1000;
    const resumeAt = () => Math.max(state.resetAt > clock() ? state.resetAt : 0, retryAfter !== undefined ? clock() + retryAfter * 1000 : 0) || clock() + DEFAULT_PAUSE_MS;
    if (res.status === 429 || (remaining !== undefined && remaining <= RESERVE)) state.pausedUntil = Math.max(state.pausedUntil, resumeAt());
    return res;
  };
  return {
    fetch: fetchGated,
    pausedUntil: () => (clock() < state.pausedUntil ? state.pausedUntil : undefined),
    low: () => state.remaining !== undefined && state.remaining <= LOW_REMAINING && state.resetAt > clock(),
  };
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const pausedText = (until: number) => `rate limit: paused until ${hhmm(until)}, showing the last reading`;

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export function digitalOceanProvider(opts: { token: string; tag?: string | undefined; fetcher?: Fetcher; clock?: () => number }): InfraProvider {
  const gate = rateGate(opts.fetcher ?? fetch, opts.clock);
  const fetcher = gate.fetch;
  const h = { Authorization: `Bearer ${opts.token}` };
  const range = (now: number) => `start=${Math.floor(now / 1000) - 600}&end=${Math.floor(now / 1000)}`;
  const metric = (name: string, id: number, now: number) =>
    getJson(fetcher, `${API}/v2/monitoring/metrics/droplet/${name}?host_id=${id}&${range(now)}`, h, Series);
  const appMetric = (name: string, id: string, now: number) =>
    getJson(fetcher, `${API}/v2/monitoring/metrics/apps/${name}?app_id=${encodeURIComponent(id)}&${range(now)}`, h, Series);

  // State across polls: app metrics (throttled) and each app's deployments (refetched only when its deploy changes).
  const appMetrics = new Map<string, InfraResource['metrics']>();
  let appMetricsAt = Number.NEGATIVE_INFINITY;
  let appMetricsScope: boolean | null = null;
  const deploysCache = new Map<string, { sig: string; list: z.infer<typeof Deployments>['deployments'] }>();
  const healthCache = new Map<string, { at: number; comps: AppHealthComponent[] }>();
  const dropletMetrics = new Map<number, { at: number; metrics: InfraResource['metrics'] }>();
  type Lists = { at: number; d: z.infer<typeof Droplets>; apps: z.infer<typeof Apps>; warnings: string[] };
  let lists: Lists | undefined;
  let last: InfraSnapshot | undefined;

  const read = async (now: number): Promise<InfraSnapshot> => {
      const resources: InfraResource[] = [];
      const deploys: InfraDeploy[] = [];
      const dropletsUrl = `${API}/v2/droplets?per_page=200${opts.tag ? `&tag_name=${encodeURIComponent(opts.tag)}` : ''}`;
      // Tokens with a custom scope (e.g. only app:read, like an App Platform watcher's) get 403 on part of the API.
      // Each part without scope becomes a warning and an empty list; it only really fails if no part can be read.
      // With many resources (or few requests left in the hour) every interval stretches by the same factor.
      const k = stretchFactor(lists?.d.droplets.length ?? 0, lists?.apps.apps.length ?? 0, gate.low());
      if (!lists || now - lists.at >= LIST_EVERY_MS * k) {
        const listWarnings: string[] = [];
        const scopeErrors: unknown[] = [];
        const part = <T>(p: Promise<T>, what: string, scope: string, empty: T): Promise<T> => p.catch((e: unknown) => {
          if (!isScopeError(e)) throw e;
          scopeErrors.push(e);
          listWarnings.push(`${what}: token missing scope ${scope}`);
          return empty;
        });
        const [d, apps] = await Promise.all([
          part(getJson(fetcher, dropletsUrl, h, Droplets), 'droplets', 'droplet:read', { droplets: [] }),
          part(getJson(fetcher, `${API}/v2/apps?per_page=100`, h, Apps), 'apps', 'app:read', { apps: [] }),
        ]);
        if (scopeErrors.length === 2) throw scopeErrors[0];
        lists = { at: now, d, apps, warnings: listWarnings };
      }
      const { d, apps } = lists;
      const warnings: string[] = [...lists.warnings];

      await Promise.all(d.droplets.map(async drop => {
        const st = dropletStatus(drop.status);
        let metrics: InfraResource['metrics'];
        if (drop.status === 'active') {
          const cached = dropletMetrics.get(drop.id);
          if (cached && now - cached.at < DROPLET_METRICS_EVERY_MS * k) metrics = cached.metrics;
          else {
            // Without the metrics agent the series come back empty: the resource shows up without numbers.
            // A failed read (429, network) keeps the last values.
            const got = await Promise.all([metric('cpu', drop.id, now), metric('memory_available', drop.id, now), metric('memory_total', drop.id, now)]).catch(() => null);
            if (got) {
              const [cpu, avail, total] = got;
              metrics = { cpu: cpuUsage(cpu), memory: memoryUsage(avail, total) };
              dropletMetrics.set(drop.id, { at: now, metrics });
            } else metrics = cached?.metrics;
          }
        }
        resources.push({ id: `digitalocean:droplet:${drop.id}`, provider: 'digitalocean', kind: 'droplet', name: drop.name, status: st.status, statusText: st.text, metrics, region: drop.region?.slug });
      }));

      // App CPU/memory need monitoring:read. One probe decides; a 403 turns them off (with a warning) until the next re-check.
      const live = apps.apps.filter(a => a.active_deployment);
      const due = now - appMetricsAt >= (appMetricsScope === false ? APP_METRICS_RECHECK_MS : APP_METRICS_EVERY_MS * k);
      if (live.length && due) {
        appMetricsAt = now;
        const read = async (app: (typeof live)[number]) => {
          const [cpu, mem] = await Promise.all([appMetric('cpu_percentage', app.id, now), appMetric('memory_percentage', app.id, now)]);
          appMetrics.set(app.id, { cpu: peakPercent(cpu), memory: peakPercent(mem) });
        };
        try {
          await read(live[0]!);
          appMetricsScope = true;
          await inBatches(live.slice(1), 5, app => read(app).catch(() => { appMetrics.delete(app.id); }));
        } catch (e) {
          // Any other failure on the probe (network, 429): keep the last values and try again next time.
          if (isScopeError(e)) { appMetricsScope = false; appMetrics.clear(); } else appMetricsAt = Number.NEGATIVE_INFINITY;
        }
      }
      if (appMetricsScope === false && live.length) warnings.push('app CPU/memory: token missing scope monitoring:read');

      await inBatches(apps.apps, 10, async app => {
        const active = app.active_deployment;
        const inProgress = app.in_progress_deployment;
        const deployStatus: ResourceStatus = active ? (deployPhase(inProgress?.phase) === 'failed' ? 'warn' : 'ok') : inProgress ? 'warn' : 'unknown';
        const id = `digitalocean:app:${app.id}`;
        const components = appComponents(app.spec);
        // Component health (Insights): a deploy can be ACTIVE while the instances are degraded or pegged at 100% CPU.
        let comps: AppHealthComponent[] = [];
        if (active) {
          const hc = healthCache.get(app.id);
          if (hc && now - hc.at < APP_HEALTH_EVERY_MS * k) comps = hc.comps;
          else {
            const read = await getJson(fetcher, `${API}/v2/apps/${app.id}/health`, h, AppHealth).then(r => r.app_health?.components ?? []).catch(() => null);
            if (read) { comps = read; healthCache.set(app.id, { at: now, comps }); } else comps = hc?.comps ?? [];
          }
        }
        // Health carries fresh CPU/memory per component; the busiest one wins over the throttled monitoring values.
        const peak = (k: 'cpu_usage_percent' | 'memory_usage_percent') => {
          const v = comps.map(c => c[k]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
          return v.length ? pct(Math.max(...v)) : undefined;
        };
        const monitored = active ? appMetrics.get(app.id) : undefined;
        const hCpu = peak('cpu_usage_percent'); const hMem = peak('memory_usage_percent');
        const metrics = active && (monitored || hCpu !== undefined || hMem !== undefined)
          ? { cpu: hCpu ?? monitored?.cpu, memory: hMem ?? monitored?.memory } : undefined;
        for (const comp of components) {
          const hit = comps.find(c => comp.type.endsWith(` ${c.name}`));
          if (hit?.replicas_ready !== undefined) comp.up = hit.replicas_ready;
        }
        const base = { status: deployStatus, text: inProgress ? `deploy ${inProgress.phase?.toLowerCase() ?? ''}`.trim() : active ? 'active' : 'no active deploy' };
        const st = appHealthStatus(base, comps, metrics);
        resources.push({
          id, provider: 'digitalocean', kind: 'app', name: app.spec.name, status: st.status, statusText: st.text,
          region: app.region?.slug, url: app.live_url, metrics,
          ...(components.length ? { components } : {}),
        });
        // Deployments only change with a new deploy: refetch when the active/in-progress deploy changes.
        const sig = `${active?.id ?? ''}|${inProgress?.id ?? ''}|${inProgress?.phase ?? ''}`;
        let cached = deploysCache.get(app.id);
        if (!cached || cached.sig !== sig) {
          const list = await getJson(fetcher, `${API}/v2/apps/${app.id}/deployments?per_page=10`, h, Deployments).then(r => r.deployments).catch(() => null);
          if (list) { cached = { sig, list }; deploysCache.set(app.id, cached); }
        }
        for (const dep of cached?.list ?? []) {
          deploys.push({ key: `digitalocean:${app.id}:${dep.id}`, provider: 'digitalocean', resourceId: id, resourceName: app.spec.name, version: dep.id.slice(0, 8), status: deployPhase(dep.phase), at: dep.created_at ?? dep.updated_at ?? new Date(now).toISOString(), description: dep.cause });
        }
      });
      return { resources, alerts: [], deploys, ...(warnings.length ? { warnings } : {}) };
  };

  return {
    id: 'digitalocean', label: 'DigitalOcean',
    async poll(now) {
      // Rate limited: no request goes out until the reset; the screen keeps the last reading with a warning.
      const stale = (until: number): InfraSnapshot => {
        if (!last) throw new HttpError(`api.digitalocean.com: rate limit, next try at ${hhmm(until)}`, 429);
        return { ...last, warnings: [...(last.warnings ?? []), pausedText(until)] };
      };
      const paused = gate.pausedUntil();
      if (paused) return stale(paused);
      try {
        const snap = await read(now);
        last = snap;
        const hit = gate.pausedUntil(); // 429 halfway: what was read stays (failed parts kept their last values)
        return hit ? { ...snap, warnings: [...(snap.warnings ?? []), pausedText(hit)] } : snap;
      } catch (e) {
        const until = e instanceof HttpError && e.status === 429 ? gate.pausedUntil() : undefined;
        if (until) return stale(until);
        throw e;
      }
    },
  };
}
