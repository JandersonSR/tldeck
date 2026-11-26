// Native desktop toast (works with the browser closed). No shell: the process gets an argument array;
// on Windows the script travels as -EncodedCommand (UTF-16LE base64) and every dynamic value is XML-escaped.
// Alert text is never logged.
import { spawn } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { absoluteUrl, type Alert } from './alert-hub.js';

/** AUMID of Windows PowerShell: a registered app id, so the toast shows up without installing anything. */
export const DEFAULT_TOAST_APPID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export interface OsToast { available: boolean; show(a: Alert): Promise<boolean> }

const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Escapes a text for an XML text node or attribute value (also drops characters XML 1.0 forbids). */
export function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, c => XML_ENTITIES[c]!);
}

/** PowerShell single-quoted literal: only the quote needs doubling. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Script that shows the toast. The toast XML is built in JS with escaped values and handed to PowerShell
 * as ONE single-quoted literal, so no alert text is ever interpolated as code.
 */
export function buildWindowsToastScript(a: Pick<Alert, 'title' | 'body' | 'url'>, appId: string): string {
  const launch = a.url ? ` launch="${xmlEscape(a.url)}"` : '';
  const xml = `<toast activationType="protocol"${launch}><visual><binding template="ToastGeneric"><text>${xmlEscape(a.title)}</text><text>${xmlEscape(a.body)}</text></binding></visual></toast>`;
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(${psQuote(xml)})`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(appId)}).Show($toast)`,
  ].join('\n');
}

export const b64utf16le = (s: string) => Buffer.from(s, 'utf16le').toString('base64');

/** Command (binary + arguments) for a platform, or undefined when it has no native toast. */
export function toastCommand(platform: NodeJS.Platform, a: Pick<Alert, 'title' | 'body' | 'url'>, appId: string): { bin: string; args: string[] } | undefined {
  if (platform === 'win32') {
    return {
      bin: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64utf16le(buildWindowsToastScript(a, appId))],
    };
  }
  if (platform === 'darwin') {
    return { bin: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', a.title, a.body] };
  }
  if (platform === 'linux') return { bin: 'notify-send', args: [a.title, a.body] };
  return undefined;
}

export function createOsToast(cfg: Config, log: FastifyBaseLogger, platform: NodeJS.Platform = process.platform): OsToast {
  const supported = platform === 'win32' || platform === 'darwin' || platform === 'linux';
  const available = supported && cfg.activities.desktop !== 'off';
  const appId = cfg.activities.toastAppId ?? DEFAULT_TOAST_APPID;
  return {
    available,
    show(alert) {
      const a = { ...alert, url: absoluteUrl(cfg.port, alert.url) };
      const cmd = available ? toastCommand(platform, a, appId) : undefined;
      if (!cmd) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const done = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
        const child = spawn(cmd.bin, cmd.args, { windowsHide: true, shell: false, stdio: 'ignore' });
        timer = setTimeout(() => { child.kill(); log.warn('desktop toast timed out'); done(false); }, 10_000);
        child.on('error', () => { log.warn('desktop toast could not start'); done(false); });
        child.on('close', (code) => { if (code !== 0) log.warn({ code }, 'desktop toast failed'); done(code === 0); });
      });
    },
  };
}
