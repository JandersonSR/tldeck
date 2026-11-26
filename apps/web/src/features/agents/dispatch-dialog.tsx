// "Send to agents": the human writes the instruction (trusted), the server triages it with a small model
// and queues it. Nothing runs unless this button is clicked.
import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCreateRequest, type RequestSource } from '@/hooks/use-agent-requests';
import { t } from '@/lib/i18n';

export function DispatchButton({ source, title, defaultPriority = false, variant = 'icon' }: {
  source: RequestSource; title: string; defaultPriority?: boolean; variant?: 'icon' | 'text';
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [repo, setRepo] = useState('');
  const [priority, setPriority] = useState(defaultPriority);
  const [auto, setAuto] = useState(false);
  const create = useCreateRequest(() => setOpen(false));

  const openDialog = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPrompt(''); setRepo(''); setPriority(defaultPriority); setAuto(false);
    setOpen(true);
  };
  const submit = () => create.mutate({
    source, prompt: prompt.trim(), autoApprovePlan: auto, priority,
    ...(repo.trim() ? { repo: repo.trim() } : {}),
  });

  return (
    <>
      {variant === 'icon' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={t('Send to agents: {title}', { title })} onClick={openDialog}><Send /></Button>
          </TooltipTrigger>
          <TooltipContent>{t('Send to agents')}</TooltipContent>
        </Tooltip>
      ) : (
        <Button size="xs" variant="ghost" className="h-6 px-1.5" aria-label={t('Send to agents: {title}', { title })} onClick={openDialog}><Send /> {t('Send to agents')}</Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl" onClick={e => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Send className="size-4" /> {t('Send to agents')}</DialogTitle>
            <DialogDescription>
              {t('A small model triages it, then it waits in the queue. The agents plan first; merge, push and production never happen on their own.')}
            </DialogDescription>
          </DialogHeader>
          <p className="truncate text-xs text-muted-foreground">{title}</p>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('What should the agents do?')}</Label>
              <Textarea value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} rows={6} autoFocus
                aria-label={t('Instruction for the agents')} placeholder={t('e.g. Fix the bug described here and add a regression test.')} />
              <p className="text-right text-[11px] text-muted-foreground tabular-nums">{prompt.length}/4000</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('Repository (optional)')}</Label>
              <Input value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/name" aria-label={t('Repository (optional)')} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={priority} onCheckedChange={setPriority} aria-label={t('Priority')} />
              <span className="text-xs">{t('Priority')}</span>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={auto} onCheckedChange={setAuto} aria-label={t('Approve the plan automatically (low risk only, never production*)')} />
              <span className="text-xs">{t('Approve the plan automatically (low risk only, never production*)')}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('Cancel')}</Button>
            <Button disabled={!prompt.trim() || create.isPending} onClick={submit}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <Send />} {t('Send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
