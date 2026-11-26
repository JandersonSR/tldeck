// Activity reminders. Every minute it looks at the open activities, sends what is due (dueAlert)
// and records the slot on the document, so a reminder never goes out twice (even after a restart).
// Delivery goes through the AlertHub (screen, native desktop toast, ntfy); /api/activities/alerts stays as an alias.
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { addDays, alertText, dueAlert, localParts, type Activity, type AlertKind } from '../domain/activities.js';
import { deckRoute, makeAlert, type AlertHub, type AlertKind as HubKind } from '../notify/alert-hub.js';
import { DocRepo } from '../store/doc-repo.js';
import type { DeckStore } from '../store/store.js';

export interface SentAlert {
  id: string;
  activityId: string;
  title: string;
  date: string;
  startTime?: string | undefined;
  kind: AlertKind;
  at: string;
}

const KEEP = 200;

export class ActivityNotifier {
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private running = false;
  private recent: SentAlert[] = [];
  readonly repo: DocRepo<Activity>;

  constructor(private readonly cfg: Config, private readonly store: DeckStore, private readonly log: FastifyBaseLogger, private readonly hub: AlertHub) {
    this.repo = new DocRepo<Activity>(store, 'deck_activities');
  }

  start(): void {
    if (!this.store.configured) return;
    const run = () => void this.tick().catch(e => this.log.warn({ err: (e as Error).message }, 'activity reminders failed'));
    this.first = setTimeout(run, 5_000);
    this.timer = setInterval(run, 60_000);
  }

  stop(): void { clearTimeout(this.first); clearInterval(this.timer); }

  /** Alerts sent after `sinceMs` (newest last). */
  since(sinceMs: number): SentAlert[] { return this.recent.filter(r => Date.parse(r.at) > sinceMs); }

  /** One pass: sends every reminder due at `now`. Returns what was sent. */
  async tick(now = Date.now()): Promise<SentAlert[]> {
    if (this.running || !this.store.configured) return [];
    this.running = true;
    try {
      await this.store.connect();
      const tz = this.cfg.team.tzOffsetMin;
      const tomorrow = addDays(localParts(now, tz).day, 1);
      const open = await this.repo.list({ status: { $ne: 'done' }, date: { $lte: tomorrow } } as never, { date: 1 }, 1000);
      const sent: SentAlert[] = [];
      for (const a of open) {
        const alert = dueAlert(a, now, tz, this.cfg.activities.rules);
        if (!alert) continue;
        await this.repo.col.updateOne(
          { _id: a._id },
          { $push: { notified: { $each: [alert.slot], $slice: -KEEP } }, $set: { lastNotifiedAt: new Date(now) } } as never,
        );
        const s: SentAlert = {
          id: `${String(a._id)}:${alert.slot}`, activityId: String(a._id), title: a.title, date: a.date,
          startTime: a.startTime, kind: alert.kind, at: new Date(now).toISOString(),
        };
        sent.push(s);
        await this.push(a, alert.kind, alert.slot, now);
      }
      this.recent = [...this.recent, ...sent].slice(-KEEP);
      return sent;
    } finally {
      this.running = false;
    }
  }

  /** Hands the reminder to the hub (screen, desktop toast, ntfy). Tag = activity + slot, so it never repeats. */
  private async push(a: Activity & { _id: unknown }, kind: AlertKind, slot: string, now: number): Promise<void> {
    const { title, body } = alertText(a, kind, this.cfg.contentLang === 'en' ? 'en' : 'pt-BR');
    await this.hub.send(makeAlert({
      kind: `activity_${kind}` as HubKind, title, body, tag: `${String(a._id)}:activity_${kind}:${slot}`,
      url: deckRoute('activities'), at: new Date(now).toISOString(),
    })).catch(() => this.log.warn('activity reminder delivery failed'));
  }
}
