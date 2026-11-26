import { describe, expect, it } from 'vitest';
import { b64utf16le, buildWindowsToastScript, toastCommand, xmlEscape } from './os-toast.js';

const APP = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

describe('xmlEscape', () => {
  it('escapes the five XML entities and drops control characters', () => {
    expect(xmlEscape(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
    expect(xmlEscape('a\u0000b\u001fc\nd')).toBe('abc\nd');
  });
});

describe('buildWindowsToastScript', () => {
  it('builds the ToastGeneric XML with escaped text and the launch URL', () => {
    const s = buildWindowsToastScript({ title: 'Plan <ready>', body: 'Tom & Jerry', url: 'http://127.0.0.1:9999/#/runs?a=1&b=2' }, APP);
    expect(s).toContain('Windows.UI.Notifications.ToastNotificationManager');
    expect(s).toContain('Windows.Data.Xml.Dom.XmlDocument');
    expect(s).toContain('launch="http://127.0.0.1:9999/#/runs?a=1&amp;b=2"');
    expect(s).toContain('<text>Plan &lt;ready&gt;</text><text>Tom &amp; Jerry</text>');
    expect(s).toContain('template="ToastGeneric"');
    expect(s).toContain('CreateToastNotifier(');
  });

  it('never interpolates alert text as code: it lives inside one single-quoted literal', () => {
    const evil = `x'); Remove-Item C:\\ -Recurse; ('`;
    const s = buildWindowsToastScript({ title: evil, body: evil }, APP);
    const line = s.split('\n').find(l => l.startsWith('$doc.LoadXml('))!;
    const literal = line.slice('$doc.LoadXml('.length, -1);
    expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true);
    // Escaped as XML (&apos;) the quote never even reaches PowerShell.
    expect(literal.slice(1, -1)).not.toContain("'");
    expect(s).not.toContain(evil);
  });

  it('omits launch when there is no URL', () => {
    expect(buildWindowsToastScript({ title: 't', body: 'b' }, APP)).not.toContain('launch=');
  });
});

describe('toastCommand', () => {
  it('Windows: encoded command, no shell string', () => {
    const c = toastCommand('win32', { title: 't', body: 'b' }, APP)!;
    expect(c.bin).toBe('powershell.exe');
    expect(c.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    expect(Buffer.from(c.args[5]!, 'base64').toString('utf16le')).toContain('CreateToastNotifier');
    expect(b64utf16le('a')).toBe('YQA=');
  });

  it('macOS and Linux pass title/body as arguments', () => {
    expect(toastCommand('darwin', { title: 'T', body: 'B' }, APP)).toEqual({
      bin: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', 'T', 'B'],
    });
    expect(toastCommand('linux', { title: 'T', body: 'B' }, APP)).toEqual({ bin: 'notify-send', args: ['T', 'B'] });
    expect(toastCommand('freebsd', { title: 'T', body: 'B' }, APP)).toBeUndefined();
  });
});
