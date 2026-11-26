// Alerts the server raises (activity reminders and agent events). Each one shows once: an in-app toast
// and, only when the server did NOT show a native OS toast (osToast === false), a browser notification.
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

export type AlertKind = 'activity_day_before' | 'activity_due' | 'activity_overdue' | 'activity_deadline'
  | 'agent_needs_input' | 'agent_plan_ready' | 'agent_failed' | 'agent_ready' | 'agent_pr_opened' | 'test';
export interface Alert { id: string; kind: AlertKind; title: string; body: string; url?: string; urgency: 'high' | 'normal'; at: string; tag: string }
export interface AlertsResponse { now: number; osToast: boolean; items: Alert[] }

const SEEN_KEY = 'ab3.alertsSeen';
const MAX_BACKLOG = 2 * 3_600_000;

/** Whether the server shows a native OS toast (so the browser must not duplicate it). */
export const useAlertChannels = () => useQuery({
  queryKey: ['alert-channels'],
  queryFn: () => api.get<AlertsResponse>(`/api/alerts?since=${Date.now()}`),
  staleTime: 30_000,
});

export function useAlerts(notify: boolean, onOpen: (url: string) => void): void {
  const qc = useQueryClient();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    let since = Date.now() - MAX_BACKLOG;
    try { since = Math.max(since, Number(localStorage.getItem(SEEN_KEY)) || 0); } catch { /* sem storage */ }
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.get<AlertsResponse>(`/api/alerts?since=${since}`);
        if (stop) return;
        for (const a of r.items) {
          const open = () => { if (a.url) openRef.current(a.url); };
          const opts = {
            description: a.body, duration: 15_000,
            ...(a.url ? { action: { label: t('Open'), onClick: open } } : {}),
          };
          if (a.urgency === 'high') toast.warning(a.title, opts); else toast.info(a.title, opts);
          if (r.osToast === false && notifyRef.current && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(a.title, { body: a.body, tag: a.tag });
            n.onclick = () => { window.focus(); open(); n.close(); };
          }
        }
        if (r.items.length) {
          for (const key of ['activities', 'runs', 'run', 'agent-requests']) void qc.invalidateQueries({ queryKey: [key] });
        }
        since = r.items.reduce((m, a) => Math.max(m, Date.parse(a.at)), since);
        try { localStorage.setItem(SEEN_KEY, String(since)); } catch { /* sem storage */ }
      } catch { /* servidor fora: tenta de novo no próximo ciclo */ }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 30_000);
    return () => { stop = true; window.clearInterval(id); };
  }, [qc]);
}
