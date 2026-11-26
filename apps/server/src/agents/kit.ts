// Kit mode: the team kit (SKILLS_KIT_PATH) gives the task agents its playbook (claude/CLAUDE.md, appended to the
// system prompt) and its subagents (claude/agents/*.md, passed with --agents). Cached by modification time.
import fs from 'node:fs';
import path from 'node:path';

export interface KitAgent { description: string; prompt: string; tools?: string[]; model?: string }
export interface Kit { claudeMd: string; agents: Record<string, KitAgent> }

/** Splits "---\nkey: value\n---\nbody" (keys on one line each). No frontmatter = empty meta. */
export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const text = src.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2]!.trim() };
}

/** One agent file -> [name, agent]; undefined when it has no name/description or no prompt. */
export function parseKitAgent(src: string, fallbackName: string): [string, KitAgent] | undefined {
  const { meta, body } = parseFrontmatter(src);
  const name = (meta.name || fallbackName).trim();
  if (!name || !meta.description || !body) return undefined;
  const tools = meta.tools ? meta.tools.split(',').map(t => t.trim()).filter(Boolean) : undefined;
  return [name, { description: meta.description, prompt: body, ...(tools?.length ? { tools } : {}), ...(meta.model ? { model: meta.model } : {}) }];
}

const cache = new Map<string, { sig: string; kit: Kit | undefined }>();

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Reads the kit; undefined when there is no <kit>/claude/CLAUDE.md nor agents. */
export function loadKit(skillsKitPath: string | undefined): Kit | undefined {
  if (!skillsKitPath) return undefined;
  const dir = path.join(skillsKitPath, 'claude');
  const agentsDir = path.join(dir, 'agents');
  let files: string[] = [];
  try { files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).sort(); } catch { /* no agents */ }
  const claudeMd = path.join(dir, 'CLAUDE.md');
  const sig = [mtime(claudeMd), ...files.map(f => `${f}:${mtime(path.join(agentsDir, f))}`)].join('|');
  const hit = cache.get(skillsKitPath);
  if (hit && hit.sig === sig) return hit.kit;

  let text = '';
  try { text = fs.readFileSync(claudeMd, 'utf8'); } catch { /* optional */ }
  const agents: Record<string, KitAgent> = {};
  for (const f of files) {
    try {
      const parsed = parseKitAgent(fs.readFileSync(path.join(agentsDir, f), 'utf8'), f.replace(/\.md$/, ''));
      if (parsed) agents[parsed[0]] = parsed[1];
    } catch { /* skip an unreadable file */ }
  }
  const kit = text.trim() || Object.keys(agents).length ? { claudeMd: text.trim(), agents } : undefined;
  cache.set(skillsKitPath, { sig, kit });
  return kit;
}
