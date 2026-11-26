// Requests the human sent to the agents ("Send to agents"): triage, queue and the run they became.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';

export type RequestSource = { kind: 'issue'; url: string } | { kind: 'activity'; id: string };
export type RequestStatus = 'triaging' | 'needs_input' | 'queued' | 'dispatched' | 'cancelled' | 'failed';
export interface Triage {
  executable: boolean; repo: string | null;
  flow: 'review' | 'bug' | 'feature' | 'docs' | 'investigation' | 'cherry-pick' | 'other';
  risk: 'low' | 'medium' | 'high'; priority: 1 | 2 | 3 | 4;
  acceptance: string[]; question: string | null;
}
export interface AgentRequest {
  _id: string; source: RequestSource; sourceKey: string; title: string; body: string; userPrompt: string; answers: string[];
  repoHint?: string; userPriority: boolean; dueDate?: string; autoApprovePlan: boolean;
  status: RequestStatus; triage?: Triage; question?: string; error?: string; runId?: string;
  createdAt: string; updatedAt: string;
  run: { id: string; phase: string; status: string; prUrl?: string } | null;
}
export interface RequestInput { source: RequestSource; prompt: string; repo?: string; autoApprovePlan?: boolean; priority?: boolean }
/** What `GET /api/activities` attaches to each post-it. */
export interface ActivityAgent { requestId: string; status: RequestStatus; phase?: string; runId?: string; prUrl?: string }

export const useAgentRequests = () => useQuery({
  queryKey: ['agent-requests'],
  queryFn: () => api.get<{ items: AgentRequest[] }>('/api/agent-requests?active=1'),
  refetchInterval: 10_000,
});

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['agent-requests', 'activities', 'runs']) void qc.invalidateQueries({ queryKey: [key] });
  };
}

export function useCreateRequest(onCreated?: (id: string) => void) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (b: RequestInput) => api.post<{ id: string }>('/api/agent-requests', b),
    onSuccess: r => { invalidate(); toast.success(t('Sent to the agents: triage started')); onCreated?.(r.id); },
    onError: (e: Error) => (e instanceof ApiError && e.status === 409
      ? toast.error(t('This item is already with the agents'))
      : toast.error(t('Could not send'), { description: e.message })),
  });
}

export function useAnswerRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; answer?: string; repo?: string }) => api.patch<{ ok?: boolean }>(`/api/agent-requests/${id}`, body),
    onSuccess: () => { invalidate(); toast.success(t('Answer sent')); },
    onError: (e: Error) => toast.error(t('Could not answer'), { description: e.message }),
  });
}

export function useCancelRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/agent-requests/${id}/cancel`),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(t('Could not cancel'), { description: e.message }),
  });
}
