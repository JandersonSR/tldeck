// Issabel collector → infra resources (simulated collector responses).
import { describe, expect, it } from 'vitest';
import type { Fetcher } from './http.js';
import { issabelProvider, issabelSnapshot, type IssabelReport } from './issabel.js';
import { newTrackerState, step } from './tracker.js';

const NOW = Date.parse('2026-11-26T13:00:00-03:00');
const report = (over: Partial<IssabelReport> = {}): IssabelReport => ({
  version: 1, host: 'issabel', generatedAt: '2026-11-26T12:59:40-03:00',
  areas: [{ id: 'service', label: 'Serviço Asterisk' }, { id: 'recordings', label: 'Gravações' }, { id: 'log', label: 'Erros no log' }],
  checks: [
    { id: 'service.asterisk', area: 'service', label: 'Asterisk', status: 'ok', summary: 'ativo · PID 4321' },
    { id: 'recordings.cannot_open', area: 'recordings', label: 'MixMonitor "Cannot open"', status: 'critical', summary: 'Cannot open: 2 em 5 min · 12 em 15 min · 40 em 60 min', since: '2026-11-26T12:40:00-03:00' },
    { id: 'recordings.cdr_vs_disk', area: 'recordings', label: 'CDR × disco', status: 'critical', summary: 'perdidas 1 h: 34/34 (100%)' },
    { id: 'log.db_locked', area: 'log', label: 'database is locked', status: 'warn', summary: '0 em 5 min · 3 em 15 min · 9 em 60 min', since: '2026-11-26T12:30:00-03:00' },
  ],
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const RULES = { cpuWarn: 80, cpuCrit: 90, memCrit: 90, sustainMin: 5, lang: 'pt-BR' as const };

describe('issabelSnapshot', () => {
  it('one resource per area; critical takes the area down, warnings become alerts', () => {
    const s = issabelSnapshot(report(), 'issabel-prod', NOW);
    expect(s.resources.map(r => [r.name, r.status])).toEqual([
      ['issabel-prod · Serviço Asterisk', 'ok'], ['issabel-prod · Gravações', 'down'], ['issabel-prod · Erros no log', 'warn'],
    ]);
    const rec = s.resources[1]!;
    expect(rec.statusText).toBe('Cannot open: 2 em 5 min · 12 em 15 min · 40 em 60 min · perdidas 1 h: 34/34 (100%)');
    expect(rec.details).toHaveLength(2);
    expect(s.alerts).toEqual([expect.objectContaining({ fingerprint: 'issabel:log.db_locked', severity: 'warning', startedAt: '2026-11-26T15:30:00.000Z' })]);
  });

  it('the tracker turns the down area into a critical alert (incident rule) and the warning into a warning', () => {
    const { firing } = step(newTrackerState(), issabelSnapshot(report(), 'issabel-prod', NOW), NOW, RULES);
    expect(firing.map(f => [f.severity, f.fingerprint])).toEqual([['critical', 'status:issabel:recordings'], ['warning', 'issabel:log.db_locked']]);
    expect(firing[0]!.title).toMatch(/^issabel-prod · Gravações fora do ar \(Cannot open/);
  });
});

describe('issabelProvider', () => {
  it('sends the token; a collector that stops answering goes down and keeps the last areas', async () => {
    let up = true; const auth: string[] = [];
    const f: Fetcher = async (url, init) => {
      auth.push((init?.headers as Record<string, string>).Authorization!);
      expect(url).toBe('http://10.10.0.235:9118/health');
      return up ? json(report()) : json({ error: 'x' }, 502);
    };
    const p = issabelProvider({ url: 'http://10.10.0.235:9118/', token: 'tok', name: 'issabel-prod', fetcher: f });
    const ok = await p.poll(NOW);
    expect(ok.resources.find(r => r.kind === 'collector')).toMatchObject({ status: 'ok' });
    up = false;
    const down = await p.poll(NOW + 60_000);
    expect(down.resources.find(r => r.kind === 'collector')).toMatchObject({ status: 'down', statusText: expect.stringMatching(/sem resposta/) });
    expect(down.resources.find(r => r.id === 'issabel:recordings')?.status).toBe('down');
    expect(down.alerts).toHaveLength(1);
    expect(auth.every(a => a === 'Bearer tok')).toBe(true);
  });

  it('first read failing: only the collector, down', async () => {
    const p = issabelProvider({ url: 'http://x:9118', token: 't', name: 'issabel-prod', fetcher: async () => { throw new Error('ECONNREFUSED'); } });
    const s = await p.poll(NOW);
    expect(s.resources).toEqual([expect.objectContaining({ id: 'issabel:collector', status: 'down' })]);
  });

  it('an old report means a stuck collector', async () => {
    const p = issabelProvider({ url: 'http://x:9118', token: 't', name: 'issabel-prod', fetcher: async () => json(report({ generatedAt: '2026-11-26T12:50:00-03:00' })) });
    const s = await p.poll(NOW);
    expect(s.resources.find(r => r.kind === 'collector')).toMatchObject({ status: 'down', statusText: expect.stringMatching(/parado há 10 min/) });
  });

  it('simulation mode shows up as a provider warning', async () => {
    const p = issabelProvider({ url: 'http://x:9118', token: 't', name: 'issabel-prod', fetcher: async () => json(report({ simulate: true })) });
    expect((await p.poll(NOW)).warnings).toEqual(['collector in SIMULATION mode (/tmp/tldeck-sim)']);
  });
});
