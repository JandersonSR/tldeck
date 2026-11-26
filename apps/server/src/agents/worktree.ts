// Isolated worktree per task: the agent works in its own working copy, on a new branch,
// without touching the Tech Lead's main clone.
import fs from 'node:fs';
import path from 'node:path';
import { execCmd } from '../util/exec.js';

const git = (cwd: string, args: string[], timeoutMs = 30_000) => execCmd('git', args, { cwd, timeoutMs, shell: false }); // git is a real executable: no shell, so messages with spaces/quotes stay one argument

/** Remote base branch (e.g. origin/main), from origin/HEAD with fallbacks. */
export async function remoteBase(repoPath: string): Promise<string> {
  const head = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ['origin/main', 'origin/master', 'origin/develop']) {
    if ((await git(repoPath, ['rev-parse', '--verify', '--quiet', ref])).ok) return ref;
  }
  throw Object.assign(new Error('could not find the remote base branch (origin/HEAD, main, master or develop)'), { statusCode: 409 });
}

export async function createWorktree(repoPath: string, dir: string, branch: string, opts: { base?: string } = {}): Promise<{ base: string }> {
  if (fs.existsSync(dir)) throw Object.assign(new Error(`the task folder already exists: ${dir}`), { statusCode: 409 });
  let base = opts.base;
  if (!base) {
    await git(repoPath, ['fetch', '--quiet', 'origin'], 120_000); // no network: go on with what is there
    base = await remoteBase(repoPath);
  }
  if ((await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok) {
    throw Object.assign(new Error(`branch ${branch} already exists in the local clone`), { statusCode: 409 });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(repoPath, ['worktree', 'add', '-b', branch, dir, base], 120_000);
  if (!r.ok) throw Object.assign(new Error(`git worktree add falhou: ${r.stderr.split('\n')[0]}`), { statusCode: 500 });
  return { base };
}

export type Workspace = { workspace: 'git' | 'local' | 'scratch'; base?: string; targetPath?: string };

/** How a task can run: in a worktree of a repo with a remote (git), of a local-only repo (local) or in an isolated copy (scratch). */
export async function detectWorkspace(repoPath: string | undefined): Promise<Workspace> {
  if (!repoPath) return { workspace: 'scratch' };
  const isGit = fs.existsSync(path.join(repoPath, '.git')) && (await git(repoPath, ['rev-parse', '--git-dir'])).ok;
  if (!isGit || !(await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok) return { workspace: 'scratch', targetPath: repoPath };
  try {
    return { workspace: 'git', base: await remoteBase(repoPath) };
  } catch {
    const br = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = br.ok ? br.stdout.trim() : '';
    if (name && name !== 'HEAD') return { workspace: 'local', base: name };
    return { workspace: 'local', base: (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim() };
  }
}

const SCRATCH_IDENTITY = ['-c', 'user.name=tldeck', '-c', 'user.email=tldeck@localhost'];
const COPY_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'bin', 'obj']);
export const COPY_LIMITS = { fileBytes: 20 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, files: 5000 };

/** Files of a folder to copy into the scratch (relative paths), within the limits. Throws 409 when too large. */
export function listCopyFiles(root: string, limits = COPY_LIMITS): string[] {
  const out: string[] = [];
  let total = 0;
  const tooLarge = () => Object.assign(new Error('folder too large to copy without git: commit it or pick a repo'), { statusCode: 409 });
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!COPY_SKIP_DIRS.has(e.name)) walk(r); continue; }
      if (!e.isFile()) continue;
      const size = fs.statSync(path.join(root, r)).size;
      if (size > limits.fileBytes) continue;
      total += size;
      if (out.push(r) > limits.files || total > limits.totalBytes) throw tooLarge();
    }
  };
  walk('');
  return out;
}

/** Isolated copy for tasks without a branch: copies the target (if any), commits it as the base and returns the base sha. */
export async function createScratch(dir: string, targetPath?: string): Promise<{ base: string }> {
  if (fs.existsSync(dir)) throw Object.assign(new Error(`the task folder already exists: ${dir}`), { statusCode: 409 });
  const files = targetPath ? listCopyFiles(targetPath) : [];
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const to = path.join(dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(targetPath!, f), to);
  }
  const init = await git(dir, ['init', '-q']);
  if (!init.ok) throw Object.assign(new Error(`git init falhou: ${init.stderr.split('\n')[0]}`), { statusCode: 500 });
  await git(dir, ['config', 'user.name', 'tldeck']);
  await git(dir, ['config', 'user.email', 'tldeck@localhost']);
  await git(dir, ['add', '-A']);
  const c = await git(dir, [...SCRATCH_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'tldeck scratch base'], 120_000);
  if (!c.ok) throw Object.assign(new Error(`git commit falhou: ${c.stderr.split('\n')[0]}`), { statusCode: 500 });
  return { base: (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim() };
}

/** `git diff --name-status` lines → files to copy to the target (A/M/R destination) and deletions that are only listed. Pure. */
export function planApply(nameStatus: string, targetPath: string): { copy: { rel: string; dest: string }[]; skippedDeletes: string[] } {
  const copy: { rel: string; dest: string }[] = [];
  const skippedDeletes: string[] = [];
  const root = path.resolve(targetPath);
  const inside = (rel: string) => {
    const dest = path.resolve(root, rel);
    if (path.isAbsolute(rel) || (dest !== root && !dest.startsWith(root + path.sep))) {
      throw Object.assign(new Error(`path outside the target folder: ${rel}`), { statusCode: 400 });
    }
    return dest;
  };
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split('	');
    const code = status![0];
    if (code === 'D') { skippedDeletes.push(paths[0]!); continue; }
    if (code === 'A' || code === 'M' || code === 'R' || code === 'C' || code === 'T') {
      const rel = paths[paths.length - 1]!;
      copy.push({ rel, dest: inside(rel) });
    }
  }
  return { copy, skippedDeletes };
}

export async function diffNameStatus(dir: string, base: string): Promise<string> {
  const r = await git(dir, ['-c', 'core.quotepath=off', 'diff', '--name-status', `${base}..HEAD`]);
  if (!r.ok) throw Object.assign(new Error(`git diff falhou: ${r.stderr.split('\n')[0]}`), { statusCode: 500 });
  return r.stdout;
}

export async function removeWorktree(repoPath: string, dir: string, branch: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', dir]);
  await git(repoPath, ['branch', '-D', branch]);
}

/** If the agent left uncommitted changes, the deck commits them so the PR carries everything. */
export async function commitLeftovers(dir: string, message: string, identity = false): Promise<boolean> {
  const st = await git(dir, ['status', '--porcelain']);
  if (!st.ok || !st.stdout.trim()) return false;
  await git(dir, ['add', '-A']);
  return (await git(dir, [...(identity ? SCRATCH_IDENTITY : []), 'commit', '-m', message])).ok;
}

export async function commitsAhead(dir: string, base: string): Promise<number> {
  const r = await git(dir, ['rev-list', '--count', `${base}..HEAD`]);
  return r.ok ? Number(r.stdout.trim()) || 0 : 0;
}

export async function pushBranch(dir: string, branch: string): Promise<void> {
  const r = await git(dir, ['push', '-u', 'origin', branch], 120_000);
  if (!r.ok) throw Object.assign(new Error(`git push falhou: ${r.stderr.split('\n').filter(Boolean).pop() ?? ''}`), { statusCode: 502 });
}

/** Repository instructions for the agent (isolated mode does not load CLAUDE.md by itself). */
export function repoInstructions(dir: string, max = 8000): string | undefined {
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/README.md']) {
    try { return fs.readFileSync(path.join(dir, name), 'utf8').slice(0, max); } catch { /* próximo */ }
  }
  return undefined;
}
