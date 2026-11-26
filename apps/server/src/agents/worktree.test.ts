import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitLeftovers, commitsAhead, createScratch, detectWorkspace, diffNameStatus, listCopyFiles, planApply } from './worktree.js';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tldeck-wt-')); dirs.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (root: string, rel: string, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('detectWorkspace', () => {
  it('no repo: scratch without a target', async () => {
    expect(await detectWorkspace(undefined)).toEqual({ workspace: 'scratch' });
  });

  it('a non-git folder and a git folder with no commits: scratch with the folder as target', async () => {
    const plain = tmp();
    expect(await detectWorkspace(plain)).toEqual({ workspace: 'scratch', targetPath: plain });
    const empty = tmp();
    git(empty, 'init', '-q');
    expect(await detectWorkspace(empty)).toEqual({ workspace: 'scratch', targetPath: empty });
  });

  it('commits but no remote: local, based on the current branch', async () => {
    const repo = tmp();
    git(repo, 'init', '-q');
    write(repo, 'a.txt');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first');
    const ws = await detectWorkspace(repo);
    expect(ws.workspace).toBe('local');
    expect(ws.base).toBe(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'));
  });

  it('commits and a remote base: git', async () => {
    const remote = tmp();
    git(remote, 'init', '-q', '--bare');
    const repo = tmp();
    git(repo, 'init', '-q');
    write(repo, 'a.txt');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(repo, 'fetch', '-q', 'origin');
    expect(await detectWorkspace(repo)).toEqual({ workspace: 'git', base: 'origin/main' });
  });
});

describe('createScratch', () => {
  it('copies the target ignoring .git, node_modules and build folders, and commits the base', async () => {
    const target = tmp();
    write(target, 'docs/a.md', 'hello');
    write(target, 'node_modules/x/index.js');
    write(target, 'dist/out.js');
    write(target, '.git/config');
    const dir = path.join(tmp(), 'scratch');
    const { base } = await createScratch(dir, target);
    expect(fs.readFileSync(path.join(dir, 'docs', 'a.md'), 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
    expect(base).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('tldeck scratch base');
    expect(git(dir, 'ls-files')).toBe('docs/a.md');
    expect(await commitsAhead(dir, base)).toBe(0);
  });

  it('without a target: an empty folder with the base commit; leftovers are committed with the tldeck identity', async () => {
    const dir = path.join(tmp(), 'scratch');
    const { base } = await createScratch(dir);
    write(dir, 'notes.md', 'draft');
    expect(await commitLeftovers(dir, 'add notes', true)).toBe(true);
    expect(await commitsAhead(dir, base)).toBe(1);
    expect((await diffNameStatus(dir, base)).trim()).toBe('A\tnotes.md');
  });

  it('refuses a folder over the limits and skips big files', () => {
    const target = tmp();
    write(target, 'a.txt'); write(target, 'b.txt'); write(target, 'big.bin', '0123456789');
    expect(listCopyFiles(target, { fileBytes: 5, totalBytes: 100, files: 10 }).sort()).toEqual(['a.txt', 'b.txt']);
    expect(() => listCopyFiles(target, { fileBytes: 100, totalBytes: 100, files: 2 })).toThrow('folder too large to copy without git');
    expect(() => listCopyFiles(target, { fileBytes: 100, totalBytes: 5, files: 10 })).toThrow(/too large/);
  });

  it('fails when the task folder already exists', async () => {
    await expect(createScratch(tmp())).rejects.toThrow('already exists');
  });
});

describe('planApply', () => {
  const target = path.join(os.tmpdir(), 'target');
  it('copies A/M and the destination of R; deletions are only listed', () => {
    const r = planApply('A\tdocs/new.md\nM\tsrc/a.ts\nR100\told.md\tren/new.md\nD\tgone.md\n', target);
    expect(r.copy.map(c => c.rel)).toEqual(['docs/new.md', 'src/a.ts', 'ren/new.md']);
    expect(r.copy[0]!.dest).toBe(path.resolve(target, 'docs/new.md'));
    expect(r.skippedDeletes).toEqual(['gone.md']);
  });

  it('rejects paths that leave the target folder', () => {
    expect(() => planApply('A\t../evil.txt\n', target)).toThrow('outside the target');
    expect(() => planApply('M\tdocs/../../evil.txt\n', target)).toThrow('outside the target');
    expect(() => planApply(`A\t${path.resolve(os.tmpdir(), 'abs.txt')}\n`, target)).toThrow('outside the target');
  });

  it('an empty diff plans nothing', () => {
    expect(planApply('', target)).toEqual({ copy: [], skippedDeletes: [] });
  });
});
