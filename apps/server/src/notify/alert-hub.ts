// One place for every alert (activity reminders, agent events). Three channels:
// - os: native desktop toast (works with the browser closed);
// - ntfy: phone push (agent_ready / agent_pr_opened stay off the phone);
// - screen: in-memory buffer (last 200) that the browser polls on /api/alerts.
// Quiet hours (outside the activities window) let only `high` alerts reach os/ntfy; the screen always gets them.
// The same tag is not sent again within 10 minutes.
import { localParts, type NotifyRules } from '../domain/activities.js';

export type AlertKind = 'activity_day_before' | 'activity_due' | 'activity_overdue' | 'activity_deadline'
  | 'agent_needs_input' | 'agent_plan_ready' | 'agent_failed' | 'agent_ready' | 'agent_pr_opened' | 'test';

export interface Alert {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  url?: string | undefined;
  urgency: 'high' | 'normal';
  at: string;
  /** Dedupe key: `<runId|requestId|activityId>:<kind>[:slot]`. */
  tag: string;
}

const HIGH: ReadonlySet<AlertKind> = new Set(['agent_needs_input', 'agent_plan_ready', 'agent_failed', 'activity_due', 'activity_overdue', 'activity_deadline', 'test']);
const NOT_ON_PHONE: ReadonlySet<AlertKind> = new Set(['agent_ready', 'agent_pr_opened']);

export const urgencyOf = (kind: AlertKind): Alert['urgency'] => (HIGH.has(kind) ? 'high' : 'normal');
export const goesToPhone = (kind: AlertKind): boolean => !NOT_ON_PHONE.has(kind);

/** Link into the deck, relative (the screen reads the hash): deckRoute('runs?run=ab') -> /#/runs?run=ab. The native toast and ntfy get absoluteUrl(). */
export const deckRoute = (route: string): string => `/#/${route}`;

/** Makes a deck-relative link absolute for channels that open it outside the page (toast, phone). */
export const absoluteUrl = (port: number, url: string | undefined): string | undefined => (url && url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url);

let seq = 0;
/** Builds an alert with the default urgency of its kind. */
export function makeAlert(a: { kind: AlertKind; title: string; body: string; tag: string; url?: string | undefined; urgency?: Alert['urgency']; at?: string }): Alert {
  const at = a.at ?? new Date().toISOString();
  return { id: `${Date.parse(at)}-${++seq}`, kind: a.kind, title: a.title, body: a.body, url: a.url, urgency: a.urgency ?? urgencyOf(a.kind), at, tag: a.tag };
}

/** True when the local hour is inside [dueFrom, dueTo] (the activities window). */
export function inActiveHours(nowMs: number, tzOffsetMin: number, rules: Pick<NotifyRules, 'dueFrom' | 'dueTo'>): boolean {
  const { hour } = localParts(nowMs, tzOffsetMin);
  return hour >= rules.dueFrom && hour <= rules.dueTo;
}

export interface HubChannels {
  os?: { available: boolean; show(a: Alert): Promise<boolean> } | undefined;
  ntfy?: { configured: boolean; send(a: Alert): Promise<boolean> } | undefined;
}

export interface HubOptions {
  rules: Pick<NotifyRules, 'dueFrom' | 'dueTo'>;
  tzOffsetMin: number;
  channels?: HubChannels;
  now?: () => number;
  keep?: number;
  dedupeMs?: number;
}

export class AlertHub {
  private buffer: Alert[] = [];
  private seen = new Map<string, number>();
  private readonly channels: HubChannels;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly dedupeMs: number;

  constructor(private readonly opts: HubOptions) {
    this.channels = opts.channels ?? {};
    this.now = opts.now ?? Date.now;
    this.keep = opts.keep ?? 200;
    this.dedupeMs = opts.dedupeMs ?? 10 * 60_000;
  }

  get osAvailable(): boolean { return !!this.channels.os?.available; }
  get ntfyConfigured(): boolean { return !!this.channels.ntfy?.configured; }

  /** Sends to the channels. Returns false when the tag was already sent in the last 10 minutes. */
  async send(a: Alert): Promise<boolean> {
    const now = this.now();
    for (const [tag, at] of this.seen) if (now - at >= this.dedupeMs) this.seen.delete(tag);
    if (this.seen.has(a.tag)) return false;
    this.seen.set(a.tag, now);

    this.buffer = [...this.buffer, a].slice(-this.keep);
    const quiet = !inActiveHours(now, this.opts.tzOffsetMin, this.opts.rules);
    if (quiet && a.urgency !== 'high') return true;
    const { os, ntfy } = this.channels;
    await Promise.all([
      os?.available ? os.show(a).catch(() => false) : undefined,
      ntfy?.configured && goesToPhone(a.kind) ? ntfy.send(a).catch(() => false) : undefined,
    ]);
    return true;
  }

  /** Alerts sent after `sinceMs` (oldest first). */
  since(sinceMs: number): Alert[] { return this.buffer.filter(a => Date.parse(a.at) > sinceMs); }
}
