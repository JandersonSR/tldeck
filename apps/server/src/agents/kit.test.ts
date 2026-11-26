import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKit, parseFrontmatter, parseKitAgent } from './kit.js';

const AGENT = `---
name: implementer
description: Executa um plano: edicao mecanica (ex.: arquivos e passos)
model: sonnet
effort: medium
tools: Read, Edit, Write, Grep, Glob, Bash
---

Voce executa um plano.
- Siga os passos.
`;

describe('kit frontmatter', () => {
  it('splits meta and body (CRLF too)', () => {
    const r = parseFrontmatter(AGENT.replace(/\n/g, '\r\n'));
    expect(r.meta.name).toBe('implementer');
    expect(r.meta.description).toBe('Executa um plano: edicao mecanica (ex.: arquivos e passos)');
    expect(r.body.startsWith('Voce executa um plano.')).toBe(true);
    expect(parseFrontmatter('so texto')).toEqual({ meta: {}, body: 'so texto' });
  });

  it('turns an agent file into the --agents shape', () => {
    expect(parseKitAgent(AGENT, 'x')).toEqual(['implementer', {
      description: 'Executa um plano: edicao mecanica (ex.: arquivos e passos)',
      prompt: 'Voce executa um plano.\n- Siga os passos.',
      tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'], model: 'sonnet',
    }]);
    expect(parseKitAgent('---\nname: a\n---\ncorpo', 'a')).toBeUndefined(); // no description
  });
});

describe('loadKit', () => {
  it('reads CLAUDE.md and agents, and reloads when a file changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
    fs.mkdirSync(path.join(dir, 'claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude', 'CLAUDE.md'), '# Playbook\n');
    fs.writeFileSync(path.join(dir, 'claude', 'agents', 'implementer.md'), AGENT);
    const kit = loadKit(dir)!;
    expect(kit.claudeMd).toBe('# Playbook');
    expect(Object.keys(kit.agents)).toEqual(['implementer']);
    expect(loadKit(dir)).toBe(kit); // cache hit

    const file = path.join(dir, 'claude', 'CLAUDE.md');
    fs.writeFileSync(file, '# Novo');
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(loadKit(dir)!.claudeMd).toBe('# Novo');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no kit path or empty kit gives undefined', () => {
    expect(loadKit(undefined)).toBeUndefined();
    expect(loadKit(path.join(os.tmpdir(), 'does-not-exist-kit'))).toBeUndefined();
  });
});
