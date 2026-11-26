// "Agent requests" on top of Runs: what the human sent and is still in flight. A request that needs
// input shows the triage question with a text box and an optional repo.
import { useState } from 'react';
import { Loader2, MessageCircleQuestion, RotateCcw, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Pill } from '@/components/common';
import { TaskPhasePill } from '@/features/runs/task-detail';
import { useAgentRequests, useAnswerRequest, useCancelRequest, useRecentRequests, useRetryRequest, type AgentRequest, type RequestStatus } from '@/hooks/use-agent-requests';
import type { TaskPhase } from '@/hooks/use-runs';
import { k, t } from '@/lib/i18n';

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  triaging: k('Triage'), needs_input: k('Needs you'), queued: k('Queued'), dispatched: k('Dispatched'), cancelled: k('Cancelled'), failed: k('Failed'),
};

export function RequestStatusPill({ status, phase }: { status: RequestStatus; phase?: string }) {
  if (status === 'dispatched' && phase) return <TaskPhasePill phase={phase as TaskPhase} />;
  const tone = status === 'needs_input' || status === 'failed' ? 'danger' : status === 'triaging' ? 'info' : 'neutral';
  return <Pill tone={tone}>{status === 'triaging' && <Loader2 className="size-3 animate-spin" />}{t(REQUEST_STATUS_LABEL[status])}</Pill>;
}

function RequestRow({ r, onOpenRun }: { r: AgentRequest; onOpenRun: (id: string) => void }) {
  const answer = useAnswerRequest();
  const cancel = useCancelRequest();
  const retry = useRetryRequest();
  const ended = r.status === 'failed' || r.status === 'cancelled';
  const [text, setText] = useState('');
  const [repo, setRepo] = useState('');
  const question = r.question ?? r.triage?.question ?? '';
  const runId = r.run?.id ?? r.runId;
  const send = () => answer.mutate(
    { id: r._id, ...(text.trim() ? { answer: text.trim() } : {}), ...(repo.trim() ? { repo: repo.trim() } : {}) },
    { onSuccess: () => { setText(''); setRepo(''); } },
  );
  return (
    <li className="space-y-2 px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px]">{r.title}</span>
        <RequestStatusPill status={r.status} phase={r.run?.phase} />
        {runId && <Button size="xs" variant="ghost" onClick={() => onOpenRun(runId)}>{t('Open run')}</Button>}
        {ended
          ? <Button size="xs" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(r._id)}>{retry.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} {t('Try again')}</Button>
          : <Button size="icon-xs" variant="ghost" aria-label={t('Cancel request: {title}', { title: r.title })} disabled={cancel.isPending} onClick={() => cancel.mutate(r._id)}><X /></Button>}
      </div>
      {r.status === 'needs_input' && (
        <div className="space-y-2 rounded-lg bg-warning-soft/40 p-2.5">
          <p className="flex items-start gap-1.5 text-xs"><MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-warning" />{question || t('The agents need more information.')}</p>
          <Textarea value={text} onChange={e => setText(e.target.value)} maxLength={4000} rows={2} aria-label={t('Your answer')} placeholder={t('Your answer')} />
          <div className="flex gap-2">
            <Input value={repo} onChange={e => setRepo(e.target.value)} placeholder={t('Repository (optional)')} aria-label={t('Repository (optional)')} className="h-8 text-xs" />
            <Button size="sm" disabled={(!text.trim() && !repo.trim()) || answer.isPending} onClick={send}>
              {answer.isPending ? <Loader2 className="animate-spin" /> : <Send />} {t('Reply')}
            </Button>
          </div>
        </div>
      )}
      {ended && r.error && <p className="text-xs text-danger">{r.error}</p>}
    </li>
  );
}

const ENDED_WINDOW_MS = 24 * 3600_000;

/** Failed/cancelled requests of the last 24 h that are the latest for their item (the ones worth retrying). `recent` is newest first. */
export function endedRequests(recent: AgentRequest[], active: AgentRequest[], now = Date.now()): AgentRequest[] {
  const seen = new Set(active.map(a => a.sourceKey));
  const out: AgentRequest[] = [];
  for (const r of recent) {
    if (seen.has(r.sourceKey)) continue;
    seen.add(r.sourceKey);
    if ((r.status === 'failed' || r.status === 'cancelled') && now - Date.parse(r.updatedAt) < ENDED_WINDOW_MS) out.push(r);
  }
  return out;
}

export function RequestsSection({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const active = useAgentRequests().data?.items ?? [];
  const recent = useRecentRequests().data?.items ?? [];
  const items = [...active, ...endedRequests(recent, active)];
  if (!items.length) return null;
  return (
    <section className="max-h-72 shrink-0 overflow-auto rounded-xl border bg-card shadow-xs">
      <header className="flex items-center gap-2 border-b px-3.5 py-2.5 text-[13px] font-semibold">
        <Send className="size-4 text-muted-foreground" /> {t('Requests to the agents')}
        <Pill className="ml-auto">{items.length}</Pill>
      </header>
      <ul className="divide-y">{items.map(r => <RequestRow key={r._id} r={r} onOpenRun={onOpenRun} />)}</ul>
    </section>
  );
}
