// End-to-end task: read-only plan → approval → implementation in an isolated worktree →
// independent verification → draft PR only on click.
import fs from 'node:fs';
import path from 'node:path';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { v2 } from '../legacy/v2.js';
import { execCmd } from '../util/exec.js';
import { ALWAYS_DENIED, type AgentContext } from './context.js';
import { loadKit } from './kit.js';
import type { AgentRequest, RequestSource } from './requests-repo.js';
import type { RunDoc, TaskPhase, TaskState } from './runs-repo.js';
import {
  buildImplementPrompt, buildPlanPrompt, buildPrBody, composeInstruction, implementationTools, parseImplementation, parseIssueUrl, parsePlan,
  PLAN_TOOLS, requestBranch, resolveOwnerRepo, splitCommand, TASK_PROMPT_VERSION, taskBranch, workspaceNote, type IssueInput,
} from './task.js';
import {
  commitLeftovers, commitsAhead, createScratch, createWorktree, detectWorkspace, diffNameStatus, planApply, pushBranch, removeWorktree, repoInstructions,
  type Workspace,
} from './worktree.js';

/** What the planning step needs to know about the thing to do (an issue or an activity). */
interface PlanInput {
  title: string; body: string; url?: string | undefined; owner: string; repo: string; number?: number | undefined;
  userPrompt?: string | undefined; requestId?: string | undefined; source?: RequestSource | undefined;
}

export class TaskService {
  constructor(private readonly ctx: AgentContext) {}

  /** Reads an issue from GitHub (title/body masked). */
  async fetchIssue(url: string): Promise<IssueInput & { owner: string; repo: string; number: number }> {
    const ref = parseIssueUrl(url);
    if (!ref) throw Object.assign(new Error('invalid issue URL'), { statusCode: 400 });
    const data = await this.ctx.requireGh().rest('GET', `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      z.object({ title: z.string(), body: z.string().nullable().optional(), pull_request: z.unknown().optional() }));
    if (data.pull_request) throw Object.assign(new Error('this is a PR, not an issue'), { statusCode: 400 });
    return { ...ref, url, title: this.ctx.mask(data.title).text, body: this.ctx.mask((data.body ?? '').slice(0, 20_000)).text };
  }

  private repoPathOf(repo: string): string {
    const p = this.ctx.resolveRepoPath(repo);
    if (!p) throw Object.assign(new Error(`local clone of ${repo} not found (REPOS or REPOS_ROOT)`), { statusCode: 404 });
    return p;
  }

  /** Planning prompt preview (the Tech Lead can edit it before starting). */
  async previewTask(issueUrl: string) {
    return this.taskPreviewFor(await this.fetchIssue(issueUrl));
  }

  private async taskPreviewFor(issue: Awaited<ReturnType<TaskService['fetchIssue']>>) {
    const repoPath = this.repoPathOf(issue.repo);
    return this.planPreview(issue, repoPath, await detectWorkspace(repoPath));
  }

  /** repoPath is absent for requests with no repository (research, drafts): the featContext is then searched without a repo. */
  private async planPreview(i: PlanInput, repoPath: string | undefined, ws: Workspace) {
    const scope = repoPath ? i.repo : '';
    // No repo (research, drafts, a docs folder): a feat-map search by title only brings unrelated packs.
    const hits = scope ? (await this.ctx.featMaps.search(`${i.title} ${scope}`, { repo: scope, limit: 3 })).hits : [];
    const ctx = scope ? await this.ctx.featContext(`${i.title} ${scope}`, scope) : undefined;
    const raw = buildPlanPrompt({
      issue: { url: i.url, title: i.title, body: i.body }, userPrompt: i.userPrompt, featContext: ctx,
      repoInstructions: (ws.workspace === 'scratch' ? ws.targetPath : repoPath) ? repoInstructions((ws.workspace === 'scratch' ? ws.targetPath : repoPath)!) : undefined,
      workspaceNote: workspaceNote(ws.workspace, ws.targetPath), lang: this.ctx.cfg.contentLang,
    });
    const m = this.ctx.mask(raw);
    return {
      prompt: m.text, masked: m.total, features: hits.map(h => `${h.pack.map}:${h.pack.id}`),
      repo: `${i.owner}/${i.repo}`, repoPath: repoPath ?? '', workspace: ws.workspace, ...(ws.base ? { base: ws.base } : {}),
      ...(ws.targetPath ? { targetPath: ws.targetPath } : {}),
      branch: i.number !== undefined ? taskBranch(i.number, i.title) : requestBranch(i.requestId ?? 'task', i.title),
      verify: (ws.workspace === 'scratch' ? undefined : this.verifyCommand(i.repo)) ?? null, title: i.title,
    };
  }

  /** Kit mode: the team playbook and subagents for the plan and implementation runs (with the Agent tool). */
  private kitSpec(): { appendSystemPrompt?: string; agents?: NonNullable<ReturnType<typeof loadKit>>['agents'] } {
    if (!this.ctx.cfg.agentKitMode) return {};
    const kit = loadKit(this.ctx.cfg.paths.skillsKit);
    if (!kit) return {};
    return { ...(kit.claudeMd ? { appendSystemPrompt: kit.claudeMd } : {}), ...(Object.keys(kit.agents).length ? { agents: kit.agents } : {}) };
  }

  private withAgentTool(tools: string[], allowed: string[], kit: ReturnType<TaskService['kitSpec']>): { tools: string[]; allowed: string[] } {
    return kit.agents ? { tools: [...tools, 'Agent'], allowed: [...allowed, 'Agent'] } : { tools, allowed };
  }

  /** Writes a phase change and tells the listeners (dispatcher, alerts). Returns the new task snapshot. */
  private async setPhase(id: string, t: TaskState, patch: Partial<TaskState> & { phase: TaskPhase }, extra: Partial<RunDoc> = {}): Promise<TaskState> {
    await this.ctx.runs.patchTask(id, patch, extra);
    const next: TaskState = { ...t, ...patch };
    this.ctx.phaseChanged(id, patch.phase, next);
    return next;
  }

  /** Issue number to reference (commit, "Closes #n"): only when the issue lives in the repo the PR goes to. */
  private issueNumberFor(t: TaskState): number | undefined {
    const ref = t.issueUrl ? parseIssueUrl(t.issueUrl) : undefined;
    return ref && `${ref.owner}/${ref.repo}`.toLowerCase() === t.repo.toLowerCase() ? ref.number : undefined;
  }

  private verifyCommand(repo: string): string | undefined {
    const name = repo.split('/').pop()!.toLowerCase();
    return this.ctx.cfg.tasks.verify.find(v => v.repo.toLowerCase() === name || v.repo.toLowerCase() === repo.toLowerCase())?.command;
  }

  /** Stage 1: creates the worktree and runs the agent read-only to propose a plan. */
  async startTask(input: { issueUrl: string; prompt?: string | undefined }): Promise<{ id: string }> {
    await this.ctx.checkLimits();
    const issue = await this.fetchIssue(input.issueUrl);
    const preview = await this.taskPreviewFor(issue);
    return this.beginPlanning({
      ...issue, url: input.issueUrl, itemKey: `gh:${issue.owner}/${issue.repo}#${issue.number}`, model: this.ctx.cfg.agentModels.task,
      promptOverride: input.prompt, preview,
    });
  }

  /** Starts a task from a request the human sent to the agents (the dispatcher calls it). */
  async startFromRequest(req: AgentRequest & { _id: ObjectId }, opts: { model: string }): Promise<{ id: string }> {
    await this.ctx.checkLimits();
    const requestId = String(req._id);
    const issueRef = req.source.kind === 'issue' ? parseIssueUrl(req.source.url) : undefined;
    const repoName = req.triage?.repo ?? req.repoHint ?? issueRef?.repo;
    const repoPath = repoName ? this.repoPathOf(repoName) : undefined; // no name = a task with no repository (scratch)
    const ws = await detectWorkspace(repoPath);
    let target: { owner: string; repo: string };
    if (ws.workspace === 'git') {
      const origin = await execCmd('git', ['remote', 'get-url', 'origin'], { cwd: repoPath! });
      const resolved = resolveOwnerRepo(repoName!, origin.ok ? origin.stdout : undefined, this.ctx.cfg.github.org);
      if (!resolved) throw Object.assign(new Error(`could not tell the GitHub owner of ${repoName} (no origin remote, no GITHUB_ORG)`), { statusCode: 409 });
      target = resolved;
    } else {
      target = { owner: 'local', repo: path.basename(ws.targetPath ?? repoPath ?? '') || 'scratch' };
    }
    const sameRepo = !!issueRef && `${issueRef.owner}/${issueRef.repo}`.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase();
    const base: PlanInput = {
      title: req.title, body: req.body, url: req.source.kind === 'issue' ? req.source.url : undefined,
      owner: target.owner, repo: target.repo, number: sameRepo ? issueRef!.number : undefined,
      userPrompt: composeInstruction({ userPrompt: req.userPrompt, answers: req.answers, acceptance: req.triage?.acceptance }),
      requestId, source: req.source,
    };
    const preview = await this.planPreview(base, repoPath, ws);
    return this.beginPlanning({ ...base, itemKey: req.sourceKey, model: opts.model, preview });
  }

  /** Shared start: worktree + run document + read-only planning agent. */
  private async beginPlanning(input: PlanInput & {
    itemKey: string; model: string; promptOverride?: string | undefined; preview: Awaited<ReturnType<TaskService['planPreview']>>;
  }): Promise<{ id: string }> {
    const { preview, model } = input;
    const masked = this.ctx.mask(input.promptOverride ?? preview.prompt);
    const label = input.number ?? (input.requestId ?? 'task').slice(-6);
    const worktree = path.join(this.ctx.cfg.paths.worktrees, `${input.repo}-${label}-${Date.now().toString(36)}`);
    const { workspace, targetPath } = preview;
    const { base } = workspace === 'scratch' ? await createScratch(worktree, targetPath)
      : await createWorktree(preview.repoPath, worktree, preview.branch, workspace === 'local' ? { base: preview.base! } : {});
    const task: TaskState = {
      phase: 'planning', issueTitle: input.title, issueBody: input.body,
      ...(input.url ? { issueUrl: input.url } : {}),
      ...(input.source ? { source: input.source } : {}), ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.userPrompt ? { userPrompt: input.userPrompt } : {}),
      repo: preview.repo, repoPath: preview.repoPath, worktree, branch: preview.branch, base, workspace,
      ...(targetPath ? { targetPath } : {}),
    };
    const id = await this.ctx.runs.create({
      kind: 'task', engine: 'claude', itemKey: input.itemKey,
      title: input.number !== undefined ? `#${input.number} ${input.title}` : input.title,
      target: { ...(input.url ? { issueUrl: input.url } : {}), repo: preview.repo },
      status: 'running', model, promptMasked: masked.text, maskedCount: masked.total, cwd: worktree, startedAt: new Date(),
      log: [], actions: [], promptVersion: `${TASK_PROMPT_VERSION} · ${model}`,
      promptEdited: !!input.promptOverride && input.promptOverride.trim() !== preview.prompt.trim(), task,
    });
    this.ctx.phaseChanged(id, 'planning', task);
    const kit = this.kitSpec();
    const tools = this.withAgentTool(PLAN_TOOLS.tools, PLAN_TOOLS.allowed, kit);
    this.ctx.launch(id, {
      prompt: masked.text, cwd: worktree, model, tools: tools.tools, allowedTools: tools.allowed,
      disallowedTools: [...ALWAYS_DENIED, ...PLAN_TOOLS.denied], mcpConfig: this.ctx.mcpConfig(), timeoutMs: this.ctx.cfg.limits.timeoutMin * 60_000,
      ...kit,
    }, async (r) => {
      const plan = r.ok ? parsePlan(r.resultText) : undefined;
      if (plan?.ok) {
        await this.setPhase(id, task, { phase: 'awaiting_approval', plan: plan.value }, { status: 'done', endedAt: new Date(), ...(r.usage ? { usage: r.usage } : {}) });
      } else {
        const error = this.ctx.mask(r.error ?? (plan && !plan.ok ? plan.error : 'failed')).text;
        await this.setPhase(id, task, { phase: 'failed', error }, { status: r.timedOut ? 'timeout' : r.cancelled ? 'cancelled' : 'failed', endedAt: new Date(), result: { error, text: this.ctx.mask(r.resultText).text.slice(0, 20_000) }, ...(r.usage ? { usage: r.usage } : {}) });
      }
    });
    return { id };
  }

  private async getTask(id: string, phases: TaskState['phase'][]): Promise<RunDoc & { task: TaskState }> {
    const run = await this.ctx.runs.get(id);
    if (!run || run.kind !== 'task' || !run.task) throw Object.assign(new Error('task not found'), { statusCode: 404 });
    if (!phases.includes(run.task.phase)) throw Object.assign(new Error(`the task is in "${run.task.phase}"`), { statusCode: 409 });
    return run as RunDoc & { task: TaskState };
  }

  /** Stage 2: plan approved → implementation in the worktree, then independent verification. */
  async approveTask(id: string, notes?: string): Promise<void> {
    const run = await this.getTask(id, ['awaiting_approval']);
    if (this.ctx.active.size >= this.ctx.cfg.limits.maxConcurrent) throw Object.assign(new Error('concurrent run limit reached'), { statusCode: 429 });
    const t = run.task;
    const cleanNotes = notes?.trim() ? this.ctx.mask(notes.trim().slice(0, 4000)).text : undefined;
    const prompt = this.ctx.mask(buildImplementPrompt({
      issue: { url: t.issueUrl, title: t.issueTitle, body: t.issueBody ?? '' }, userPrompt: t.userPrompt, plan: t.plan!, notes: cleanNotes, testCommands: this.ctx.cfg.tasks.testCommands, workspaceNote: workspaceNote(t.workspace, t.targetPath), lang: this.ctx.cfg.contentLang,
    })).text;
    let cur = await this.setPhase(id, t, { phase: 'implementing', approvedAt: new Date(), ...(cleanNotes ? { notes: cleanNotes } : {}) }, { status: 'running' });
    await this.ctx.runs.appendLog(id, [{ at: new Date(), type: 'start', text: 'plan approved — implementation' }]);
    const impl0 = implementationTools(this.ctx.cfg.tasks.testCommands);
    const kit = this.kitSpec();
    const tools = this.withAgentTool(impl0.tools, impl0.allowed, kit);
    this.ctx.launch(id, {
      prompt, cwd: t.worktree, model: run.model, tools: tools.tools, allowedTools: tools.allowed,
      disallowedTools: [...ALWAYS_DENIED, ...impl0.denied], timeoutMs: this.ctx.cfg.limits.timeoutMin * 60_000,
      ...kit,
    }, async (r) => {
      const impl = r.ok ? parseImplementation(r.resultText) : undefined;
      const number = this.issueNumberFor(t);
      await commitLeftovers(t.worktree, `${t.issueTitle} (${number !== undefined ? `#${number}` : (t.requestId ?? 'task').slice(-6)})`, t.workspace === 'scratch');
      const ahead = await commitsAhead(t.worktree, t.base);
      const usage = r.usage ? { usage: this.sumUsage(run.usage, r.usage) } : {};
      if (!impl?.ok || ahead === 0) {
        const error = this.ctx.mask(ahead === 0 && r.ok ? 'the agent made no changes' : r.error ?? (impl && !impl.ok ? impl.error : 'failed')).text;
        await this.setPhase(id, cur, { phase: 'failed', error }, { status: r.timedOut ? 'timeout' : r.cancelled ? 'cancelled' : 'failed', endedAt: new Date(), ...usage });
        return;
      }
      const verify = t.workspace === 'scratch' ? undefined : this.verifyCommand(t.repo);
      cur = await this.setPhase(id, cur, { implementation: impl.value, phase: verify ? 'verifying' : 'ready' }, usage);
      if (verify) {
        const started = Date.now();
        const [cmd, args] = splitCommand(verify);
        const v = await execCmd(cmd, args, { cwd: t.worktree, timeoutMs: this.ctx.cfg.limits.timeoutMin * 60_000 });
        const output = this.ctx.mask(`${v.stdout}
${v.stderr}`.trim().slice(-6000)).text;
        await this.ctx.runs.patchTask(id, { verify: { command: verify, ok: v.ok, code: v.code, output, durationMs: Date.now() - started } });
        await this.ctx.runs.finish(id, { status: 'done' });
        await this.setPhase(id, { ...cur, verify: { command: verify, ok: v.ok, code: v.code, output, durationMs: Date.now() - started } }, { phase: 'ready' });
        return;
      }
      await this.ctx.runs.finish(id, { status: 'done' });
    });
  }

  private sumUsage(a: RunDoc['usage'], b: NonNullable<RunDoc['usage']>): NonNullable<RunDoc['usage']> {
    if (!a) return b;
    return {
      inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      costUsd: a.costUsd + b.costUsd, durationMs: a.durationMs + b.durationMs, turns: a.turns + b.turns,
    };
  }

  /** Stage 3 (only on click): push the branch and open a draft PR on GitHub. */
  async openTaskPr(id: string): Promise<{ url: string }> {
    const run = await this.getTask(id, ['ready']);
    const t = run.task;
    if (t.workspace && t.workspace !== 'git') {
      throw Object.assign(new Error(`this task has no remote: the changes are in ${t.workspace === 'local' ? `local branch ${t.branch}` : `the folder ${t.worktree}`}`), { statusCode: 409 });
    }
    const gh = this.ctx.requireGh();
    await pushBranch(t.worktree, t.branch);
    const pr = await gh.rest('POST', `/repos/${t.repo}/pulls`, z.object({ html_url: z.string() }), {
      title: t.issueTitle, head: t.branch, base: t.base.replace(/^origin\//, ''), draft: true,
      body: buildPrBody({ issueNumber: this.issueNumberFor(t), plan: t.plan, impl: t.implementation, verify: t.verify, lang: this.ctx.cfg.contentLang }),
    });
    await this.setPhase(id, t, { phase: 'pr_opened', prUrl: pr.html_url });
    await this.ctx.runs.addAction(id, { type: 'draft_pr', at: new Date(), ok: true, detail: pr.html_url });
    return { url: pr.html_url };
  }

  /** Descarta a tarefa: para o agente, remove a worktree e a branch local. */
  async discardTask(id: string): Promise<void> {
    const run = await this.getTask(id, ['planning', 'awaiting_approval', 'implementing', 'verifying', 'ready', 'applied', 'failed']);
    this.ctx.cancel(id);
    if (run.task.workspace === 'scratch') fs.rmSync(run.task.worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    else await removeWorktree(run.task.repoPath, run.task.worktree, run.task.branch);
    await this.setPhase(id, run.task, { phase: 'discarded' }, run.status === 'running' ? { status: 'cancelled', endedAt: new Date() } : {});
    await this.ctx.runs.addAction(id, { type: 'discard', at: new Date(), ok: true });
  }

  async taskDiff(id: string) {
    const run = await this.getTask(id, ['implementing', 'verifying', 'ready', 'pr_opened', 'applied', 'failed']);
    if (!fs.existsSync(run.task.worktree)) throw Object.assign(new Error('the task worktree no longer exists'), { statusCode: 410 });
    return (await v2.git.diffSummary(run.task.worktree, run.task.base)) ?? { error: 'not a git repository' };
  }

  async taskPatch(id: string, file?: string): Promise<string> {
    const run = await this.getTask(id, ['implementing', 'verifying', 'ready', 'pr_opened', 'applied', 'failed']);
    return v2.git.diffPatch(run.task.worktree, file, run.task.base);
  }

  /** Scratch with a target: copies the files the agent added/changed to the target folder. Deletions are only listed. */
  async applyToFolder(id: string): Promise<{ applied: string[]; skippedDeletes: string[] }> {
    const run = await this.getTask(id, ['ready']);
    const t = run.task;
    if (t.workspace !== 'scratch' || !t.targetPath) throw Object.assign(new Error('this task has no folder to apply to'), { statusCode: 409 });
    const plan = planApply(await diffNameStatus(t.worktree, t.base), t.targetPath);
    for (const f of plan.copy) {
      fs.mkdirSync(path.dirname(f.dest), { recursive: true });
      fs.copyFileSync(path.join(t.worktree, f.rel), f.dest);
    }
    const applied = plan.copy.map(f => f.rel);
    await this.setPhase(id, t, { phase: 'applied', appliedCount: applied.length });
    await this.ctx.runs.addAction(id, { type: 'apply_to_folder', at: new Date(), ok: true, detail: `${applied.length} files` });
    return { applied, skippedDeletes: plan.skippedDeletes };
  }
}
