#!/usr/libexec/platform-python
# -*- coding: utf-8 -*-
"""
TLDeck Issabel monitor: read-only health collector for Issabel/Asterisk.

Reads systemd, /proc, the tail of the Asterisk log, the CDR (MySQL, read-only user, time window),
the recordings folder (stat + a non-destructive write probe), disk/inodes, AMI (read-only actions)
and the auditd result written by the root helper. Serves the latest report as JSON on
GET /health (internal network, Bearer token). It never changes Asterisk, permissions, recordings or the DB.

Python 3.6+ standard library only (EL8 platform-python).

  tldeck_issabel_monitor.py --config /etc/tldeck-monitor/config.ini        # service
  tldeck_issabel_monitor.py --config ... --once                            # one report on stdout
  tldeck_issabel_monitor.py --simulate [--once] [--port 19118]             # reproduces the 26/11 failure in /tmp
"""
from __future__ import print_function

import argparse
import configparser
import grp
import hmac
import ipaddress
import json
import os
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

VERSION = 1
OK, WARN, CRIT, UNKNOWN = 'ok', 'warn', 'critical', 'unknown'
RANK = {OK: 0, UNKNOWN: 1, WARN: 2, CRIT: 3}

AREAS = [
    ('service', 'Serviço Asterisk'),
    ('recordings', 'Gravações'),
    ('permissions', 'Permissões das gravações'),
    ('log', 'Erros no log'),
    ('disk', 'Disco das gravações'),
    ('telephony', 'Telefonia'),
    ('cli', 'Socket do CLI'),
    ('audit', 'Auditoria de permissões'),
]

DEFAULTS = {
    'http': {'bind': '127.0.0.1', 'port': '9118', 'token': '', 'allow': ''},
    'paths': {
        'monitor_root': '/var/spool/asterisk/monitor',
        'log_file': '/var/log/asterisk/full',
        'cli_socket': '/var/run/asterisk/asterisk.ctl',
        'audit_file': '/var/lib/tldeck-monitor/audit.txt',
    },
    'service': {'unit': 'asterisk.service'},
    'cdr': {
        'enabled': 'true', 'mysql_bin': 'mysql', 'defaults_file': '/etc/tldeck-monitor/mysql.cnf',
        'database': 'asteriskcdrdb', 'hours': '2', 'max_rows': '20000', 'csv_file': '',
        # Calls answered in the last minutes may still be recording / not flushed yet.
        'grace_minutes': '2',
    },
    'ami': {'enabled': 'true', 'host': '127.0.0.1', 'port': '5038', 'user': 'tldeck', 'secret': '',
            'extension_re': r'^\d{2,6}$', 'timeout': '8'},
    'thresholds': {'disk_warn': '80', 'disk_crit': '90', 'empty_bytes': '44', 'audit_hours': '24'},
    'intervals': {'fast': '30', 'normal': '60', 'slow': '300'},
}

LOG_MAX_READ = 16 * 1024 * 1024
LOG_KEEP_SEC = 3600
MONTHS = {m: i + 1 for i, m in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])}
TS_ISO = re.compile(r'^\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})')
TS_DEFAULT = re.compile(r'^\[([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})')
LOG_PATTERNS = [
    ('cannot_open', re.compile(r'app_mixmonitor\.c.*Cannot open', re.I)),
    ('db_locked', re.compile(r'database is locked', re.I)),
    ('addr_in_use', re.compile(r'Address already in use', re.I)),
    ('module_load', re.compile(r'(Failed to load module|loader\.c:.*(failed|declined)|Module .* (failed|declined) to load)', re.I)),
]


def now_iso(ts=None):
    s = time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(ts if ts is not None else time.time()))
    return s[:-2] + ':' + s[-2:]  # -0300 -> -03:00 (ISO 8601, what Date.parse expects)


def human_age(sec):
    sec = int(sec)
    if sec < 90:
        return '%d s' % sec
    if sec < 5400:
        return '%d min' % (sec // 60)
    if sec < 172800:
        return '%d h' % (sec // 3600)
    return '%d d' % (sec // 86400)


def run(cmd, timeout=20):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def check(cid, area, label, status, summary, data=None):
    return {'id': cid, 'area': area, 'label': label, 'status': status, 'summary': summary, 'data': data or {}}


# ---------------------------------------------------------------- service

def service_check(cfg):
    unit = cfg.get('service', 'unit')
    if not unit:
        return [check('service.asterisk', 'service', 'Asterisk', UNKNOWN, 'não verificado (simulação)')]
    try:
        code, out, err = run(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID'], timeout=10)
    except Exception as e:  # noqa
        return [check('service.asterisk', 'service', 'Asterisk', UNKNOWN, 'systemctl indisponível: %s' % e)]
    props = dict(line.split('=', 1) for line in out.splitlines() if '=' in line)
    active = props.get('ActiveState') == 'active'
    pid = int(props.get('MainPID') or 0)
    data = {'active': active, 'state': '%s/%s' % (props.get('ActiveState'), props.get('SubState')), 'pid': pid or None}
    if not active or not pid:
        return [check('service.asterisk', 'service', 'Asterisk', CRIT, 'Asterisk parado (%s)' % data['state'], data)]
    uptime = proc_uptime(pid)
    rss = proc_rss_mb(pid)
    data.update({'uptimeSec': uptime, 'rssMb': rss})
    summary = 'ativo · PID %d' % pid
    if uptime is not None:
        summary += ' · no ar há %s' % human_age(uptime)
    if rss is not None:
        summary += ' · %d MB' % rss
    status = WARN if uptime is not None and uptime < 600 else OK
    if status == WARN:
        summary = 'reiniciado há %s · %s' % (human_age(uptime), summary)
    return [check('service.asterisk', 'service', 'Asterisk', status, summary, data)]


def proc_uptime(pid):
    try:
        with open('/proc/%d/stat' % pid) as f:
            start_ticks = int(f.read().rsplit(')', 1)[1].split()[19])
        with open('/proc/uptime') as f:
            up = float(f.read().split()[0])
        return max(0, int(up - start_ticks / os.sysconf('SC_CLK_TCK')))
    except Exception:  # noqa
        return None


def proc_rss_mb(pid):
    try:
        with open('/proc/%d/status' % pid) as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    return int(line.split()[1]) // 1024
    except Exception:  # noqa
        return None
    return None


# ---------------------------------------------------------------- log tail

class LogTail(object):
    """Reads only what was appended since the last read (at most 16 MB), survives rotation."""

    def __init__(self, path):
        self.path = path
        self.inode = None
        self.offset = None
        self.events = {k: deque() for k, _ in LOG_PATTERNS}
        self.last = {}
        self.error = None

    def parse_ts(self, line, now):
        m = TS_ISO.match(line)
        if m:
            y, mo, d, h, mi, s = (int(x) for x in m.groups())
            return time.mktime((y, mo, d, h, mi, s, 0, 0, -1))
        m = TS_DEFAULT.match(line)
        if m and m.group(1) in MONTHS:
            year = time.localtime(now).tm_year
            t = time.mktime((year, MONTHS[m.group(1)], int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), 0, 0, -1))
            return t - 365 * 86400 if t > now + 86400 else t
        return None

    def poll(self, now):
        try:
            st = os.stat(self.path)
        except OSError as e:
            self.error = 'log ilegível: %s' % e.strerror
            return
        if self.inode != st.st_ino or self.offset is None or st.st_size < self.offset:
            self.offset = max(0, st.st_size - LOG_MAX_READ) if self.inode is None else 0
            self.inode = st.st_ino
        start = max(self.offset, st.st_size - LOG_MAX_READ)
        try:
            with open(self.path, 'rb') as f:
                f.seek(start)
                chunk = f.read(st.st_size - start)
        except OSError as e:
            self.error = 'log ilegível: %s' % e.strerror
            return
        self.error = None
        # Only complete lines; the rest is read next time.
        end = chunk.rfind(b'\n')
        if end < 0:
            return
        self.offset = start + end + 1
        for raw in chunk[:end].split(b'\n'):
            line = raw.decode('utf-8', 'replace')
            for kind, rx in LOG_PATTERNS:
                if rx.search(line):
                    ts = self.parse_ts(line, now) or now
                    self.events[kind].append(ts)
                    self.last[kind] = {'at': now_iso(ts), 'line': line[:300]}
        for q in self.events.values():
            while q and q[0] < now - LOG_KEEP_SEC:
                q.popleft()

    def count(self, kind, window, now):
        return sum(1 for t in self.events[kind] if t >= now - window)


def log_checks(tail, now):
    if tail.error:
        msg = tail.error
        return [check('recordings.cannot_open', 'recordings', 'MixMonitor "Cannot open"', UNKNOWN, msg),
                check('log.errors', 'log', 'Erros no log', UNKNOWN, msg)]
    c = {w: tail.count('cannot_open', w * 60, now) for w in (5, 15, 60)}
    data = {'last5m': c[5], 'last15m': c[15], 'last60m': c[60], 'lastLine': tail.last.get('cannot_open')}
    status = CRIT if c[15] else WARN if c[60] else OK
    summary = 'Cannot open: %d em 5 min · %d em 15 min · %d em 60 min' % (c[5], c[15], c[60]) if c[60] else 'nenhum "Cannot open" na última hora'
    out = [check('recordings.cannot_open', 'recordings', 'MixMonitor "Cannot open"', status, summary, data)]
    labels = {'db_locked': 'database is locked', 'addr_in_use': 'Address already in use', 'module_load': 'falha ao carregar módulo'}
    for kind in ('db_locked', 'addr_in_use', 'module_load'):
        n = {w: tail.count(kind, w * 60, now) for w in (5, 15, 60)}
        st = WARN if n[60] else OK
        sm = '%d em 5 min · %d em 15 min · %d em 60 min' % (n[5], n[15], n[60]) if n[60] else 'nenhuma ocorrência na última hora'
        out.append(check('log.' + kind, 'log', labels[kind], st, sm,
                         {'last5m': n[5], 'last15m': n[15], 'last60m': n[60], 'lastLine': tail.last.get(kind)}))
    return out


# ---------------------------------------------------------------- CDR x disk

def cdr_rows(cfg, hours, now):
    """[(calldate_epoch, recordingfile)] for answered calls with a recording in the window."""
    csv_file = cfg.get('cdr', 'csv_file')
    since = now - hours * 3600
    rows = []
    if csv_file:  # simulation: calldate;disposition;recordingfile
        with open(csv_file) as f:
            for line in f:
                parts = line.rstrip('\n').split(';')
                if len(parts) < 3 or parts[1] != 'ANSWERED' or not parts[2]:
                    continue
                t = time.mktime(time.strptime(parts[0], '%Y-%m-%d %H:%M:%S'))
                if t >= since:
                    rows.append((t, parts[2]))
        return rows
    hours = int(hours)
    q = ("SELECT DATE_FORMAT(calldate, '%%Y-%%m-%%d %%H:%%i:%%s'), recordingfile FROM cdr "
         "WHERE calldate >= NOW() - INTERVAL %d HOUR AND disposition = 'ANSWERED' AND recordingfile <> '' "
         "ORDER BY calldate DESC LIMIT %d" % (hours, cfg.getint('cdr', 'max_rows')))
    cmd = [cfg.get('cdr', 'mysql_bin'), '--defaults-extra-file=' + cfg.get('cdr', 'defaults_file'),
           '-N', '-B', '-e', q, cfg.get('cdr', 'database')]
    code, out, err = run(cmd, timeout=30)
    if code != 0:
        raise RuntimeError('mysql: %s' % (err.strip().splitlines() or ['erro %d' % code])[-1][:200])
    for line in out.splitlines():
        parts = line.split('\t')
        if len(parts) == 2 and parts[1] and parts[1] != 'NULL':
            rows.append((time.mktime(time.strptime(parts[0], '%Y-%m-%d %H:%M:%S')), parts[1]))
    return rows


def recording_path(root, calldate, name):
    if name.startswith('/'):
        return name
    day = time.strftime('%Y/%m/%d', time.localtime(calldate))
    return os.path.join(root, day, name)


def cdr_check(cfg, now):
    if not cfg.getboolean('cdr', 'enabled'):
        return [check('recordings.cdr_vs_disk', 'recordings', 'CDR × disco', UNKNOWN, 'desativado na configuração')]
    hours = cfg.getint('cdr', 'hours')
    grace = cfg.getint('cdr', 'grace_minutes') * 60
    empty_max = cfg.getint('thresholds', 'empty_bytes')
    root = cfg.get('paths', 'monitor_root')
    try:
        rows = cdr_rows(cfg, hours, now)
    except Exception as e:  # noqa
        return [check('recordings.cdr_vs_disk', 'recordings', 'CDR × disco', UNKNOWN, 'CDR indisponível: %s' % e)]
    tot = {'all': 0, 'hour': 0}
    present = missing = empty = 0
    lost_hour = 0
    samples = []
    for calldate, name in rows:
        if calldate > now - grace:
            continue
        path = recording_path(root, calldate, name)
        alt = os.path.join(root, os.path.basename(name))
        size = None
        for p in (path, alt):
            try:
                size = os.stat(p).st_size
                break
            except OSError:
                continue
        in_hour = calldate >= now - 3600
        tot['all'] += 1
        tot['hour'] += 1 if in_hour else 0
        if size is None:
            missing += 1
        elif size <= empty_max:
            empty += 1
        else:
            present += 1
            continue
        lost_hour += 1 if in_hour else 0
        if len(samples) < 10:
            samples.append({'at': now_iso(calldate), 'file': os.path.basename(name), 'problem': 'ausente' if size is None else 'vazia (%d bytes)' % size})
    lost = missing + empty
    rate_hour = round(100.0 * lost_hour / tot['hour'], 1) if tot['hour'] else 0.0
    rate_all = round(100.0 * lost / tot['all'], 1) if tot['all'] else 0.0
    data = {'hours': hours, 'total': tot['all'], 'present': present, 'missing': missing, 'empty': empty,
            'lostRate': rate_all, 'totalLastHour': tot['hour'], 'lostLastHour': lost_hour, 'lostRateLastHour': rate_hour,
            'samples': samples}
    status = CRIT if lost_hour else WARN if lost else OK
    summary = 'perdidas 1 h: %d/%d (%.0f%%) · %d h: %d/%d (%d ausentes, %d vazias)' % (
        lost_hour, tot['hour'], rate_hour, hours, lost, tot['all'], missing, empty) if tot['all'] else 'sem chamadas gravadas nas últimas %d h' % hours
    return [check('recordings.cdr_vs_disk', 'recordings', 'CDR × disco', status, summary, data)]


# ---------------------------------------------------------------- permissions

def owner(st):
    try:
        u = pwd.getpwuid(st.st_uid).pw_name
    except KeyError:
        u = str(st.st_uid)
    try:
        g = grp.getgrgid(st.st_gid).gr_name
    except KeyError:
        g = str(st.st_gid)
    return u, g


def probe_write(directory):
    """Creates and deletes an empty file: the only write the collector does, and only in this folder."""
    name = os.path.join(directory, '.tldeck-probe-%d-%d' % (os.getpid(), int(time.time() * 1000)))
    try:
        fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except OSError as e:
        return False, e.strerror
    os.close(fd)
    try:
        os.unlink(name)
    except OSError:
        pass
    return True, None


def permissions_check(cfg, now):
    root = cfg.get('paths', 'monitor_root')
    y, m, d = time.strftime('%Y %m %d', time.localtime(now)).split()
    chain = [os.path.dirname(root.rstrip('/')), root, os.path.join(root, y), os.path.join(root, y, m), os.path.join(root, y, m, d)]
    me = pwd.getpwuid(os.geteuid()).pw_name
    folders = []
    target = None
    blocked = None
    for p in chain:
        try:
            st = os.stat(p)
        except OSError:
            folders.append({'path': p, 'exists': False})
            continue
        u, g = owner(st)
        traversable = os.access(p, os.X_OK)
        folders.append({'path': p, 'exists': True, 'owner': u, 'group': g, 'mode': oct(stat.S_IMODE(st.st_mode))[-4:].replace('o', '0'),
                        'traversable': traversable})
        if not traversable and blocked is None:
            blocked = p
        target = p
    day = chain[-1]
    data = {'user': me, 'folders': folders, 'dayFolder': day, 'dayExists': folders[-1]['exists']}
    if me == 'root':
        data['note'] = 'rodando como root: o teste de escrita não representa o usuário asterisk'
    if target is None:
        return [check('permissions.day_folder', 'permissions', 'Pasta do dia', CRIT, 'pasta de gravações não existe: %s' % root, data)]
    if blocked:
        return [check('permissions.day_folder', 'permissions', 'Pasta do dia', CRIT, '%s não pode ser atravessada por %s' % (blocked, me), data)]
    ok, err = probe_write(target)
    data.update({'probed': target, 'writable': ok, 'error': err})
    last = [f for f in folders if f.get('exists')][-1]
    desc = '%s %s:%s %s' % (target, last['owner'], last['group'], last['mode'])
    if not ok:
        return [check('permissions.day_folder', 'permissions', 'Pasta do dia', CRIT, '%s NÃO grava em %s (%s)' % (me, desc, err), data)]
    suffix = '' if data['dayExists'] else ' (pasta do dia ainda não criada; testada a pai)'
    return [check('permissions.day_folder', 'permissions', 'Pasta do dia', WARN if me == 'root' else OK, '%s grava em %s%s' % (me, desc, suffix), data)]


# ---------------------------------------------------------------- disk / cli

def disk_checks(cfg):
    root = cfg.get('paths', 'monitor_root')
    warn, crit = cfg.getint('thresholds', 'disk_warn'), cfg.getint('thresholds', 'disk_crit')
    try:
        v = os.statvfs(root)
    except OSError as e:
        return [check('disk.space', 'disk', 'Espaço', UNKNOWN, str(e.strerror))]
    used = v.f_blocks - v.f_bfree
    space = round(100.0 * used / (used + v.f_bavail), 1) if used + v.f_bavail else 0.0
    inodes = round(100.0 * (v.f_files - v.f_ffree) / v.f_files, 1) if v.f_files else 0.0
    free_gb = round(v.f_bavail * v.f_frsize / 1024.0 ** 3, 1)
    lvl = lambda p: CRIT if p >= crit else WARN if p >= warn else OK  # noqa
    return [
        check('disk.space', 'disk', 'Espaço', lvl(space), '%.0f%% usado · %.1f GB livres' % (space, free_gb), {'usedPct': space, 'freeGb': free_gb}),
        check('disk.inodes', 'disk', 'Inodes', lvl(inodes), '%.0f%% dos inodes usados' % inodes, {'usedPct': inodes}),
    ]


def cli_check(cfg):
    p = cfg.get('paths', 'cli_socket')
    try:
        is_sock = stat.S_ISSOCK(os.stat(p).st_mode)
    except OSError:
        return [check('cli.socket', 'cli', 'asterisk.ctl', WARN, '%s não existe: "asterisk -rx" não funciona' % p, {'exists': False})]
    return [check('cli.socket', 'cli', 'asterisk.ctl', OK if is_sock else WARN, 'presente' if is_sock else 'existe mas não é socket', {'exists': True})]


# ---------------------------------------------------------------- AMI (read-only)

class Ami(object):
    def __init__(self, host, port, timeout):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.buf = b''
        self.n = 0
        self.readline()  # banner

    def readline(self):
        while b'\r\n' not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise IOError('AMI fechou a conexão')
            self.buf += chunk
        line, self.buf = self.buf.split(b'\r\n', 1)
        return line.decode('utf-8', 'replace')

    def message(self):
        msg = {}
        while True:
            line = self.readline()
            if line == '':
                if msg:
                    return msg
                continue
            if ':' in line:
                k, v = line.split(':', 1)
                msg[k.strip()] = v.strip()

    def action(self, name, **params):
        self.n += 1
        aid = 'tldeck-%d' % self.n
        lines = ['Action: %s' % name, 'ActionID: %s' % aid] + ['%s: %s' % kv for kv in params.items()]
        self.sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
        first = None
        events = []
        while True:
            msg = self.message()
            if msg.get('ActionID') != aid:
                continue
            if first is None:
                first = msg
                if msg.get('Response') == 'Error':
                    raise RuntimeError(msg.get('Message', 'erro'))
                if msg.get('EventList', '').lower() != 'start' and 'will follow' not in msg.get('Message', ''):
                    return first, events
                continue
            if msg.get('EventList', '').lower() == 'complete' or msg.get('Event', '').endswith('Complete'):
                return first, events
            events.append(msg)

    def close(self):
        try:
            self.action('Logoff')
        except Exception:  # noqa
            pass
        self.sock.close()


def telephony_checks(cfg):
    if not cfg.getboolean('ami', 'enabled'):
        return [check('telephony.ami', 'telephony', 'AMI', UNKNOWN, 'AMI desativado na configuração')]
    try:
        ami = Ami(cfg.get('ami', 'host'), cfg.getint('ami', 'port'), cfg.getint('ami', 'timeout'))
    except Exception as e:  # noqa
        return [check('telephony.ami', 'telephony', 'AMI', WARN, 'AMI inacessível: %s' % e)]
    out = []
    try:
        try:
            ami.action('Login', Username=cfg.get('ami', 'user'), Secret=cfg.get('ami', 'secret'), Events='off')
        except Exception as e:  # noqa
            return [check('telephony.ami', 'telephony', 'AMI', WARN, 'login AMI recusado: %s' % e)]

        # Active calls
        try:
            _, chans = ami.action('CoreShowChannels')
            calls = len({c.get('Linkedid') or c.get('Uniqueid') for c in chans})
            out.append(check('telephony.calls', 'telephony', 'Chamadas ativas', OK, '%d chamadas · %d canais' % (calls, len(chans)),
                             {'calls': calls, 'channels': len(chans)}))
        except Exception as e:  # noqa
            out.append(check('telephony.calls', 'telephony', 'Chamadas ativas', UNKNOWN, str(e)))

        # Trunk registrations (chan_sip and/or PJSIP)
        regs = []
        for action, ev, name_k, state_k, ok_state in (
                ('SIPshowregistry', 'RegistryEntry', 'Host', 'State', 'Registered'),
                ('PJSIPShowRegistrationsOutbound', 'OutboundRegistrationDetail', 'ObjectName', 'Status', 'Registered')):
            try:
                _, evs = ami.action(action)
            except Exception:  # noqa  (module not loaded)
                continue
            for e in evs:
                if e.get('Event') == ev:
                    name = e.get(name_k) or e.get('Username') or '?'
                    if e.get('Username') and action == 'SIPshowregistry':
                        name = '%s@%s' % (e.get('Username'), name)
                    regs.append({'name': name, 'state': e.get(state_k, '?'), 'ok': e.get(state_k) == ok_state})
        bad = [r for r in regs if not r['ok']]
        if regs:
            out.append(check('telephony.trunks', 'telephony', 'Registro dos troncos', CRIT if bad else OK,
                             ('desregistrado: ' + ', '.join('%s (%s)' % (r['name'], r['state']) for r in bad[:5])) if bad
                             else '%d tronco(s) registrado(s)' % len(regs), {'trunks': regs}))
        else:
            out.append(check('telephony.trunks', 'telephony', 'Registro dos troncos', OK, 'nenhum tronco com registro configurado', {'trunks': []}))

        # Extensions
        ext_re = re.compile(cfg.get('ami', 'extension_re'))
        exts = []
        try:
            _, peers = ami.action('SIPpeers')
            for p in peers:
                if p.get('Event') == 'PeerEntry' and ext_re.match(p.get('ObjectName', '')):
                    st = p.get('Status', '')
                    online = p.get('IPaddress', '-none-') not in ('-none-', '', '(null)') and not st.startswith(('UNREACHABLE', 'UNKNOWN'))
                    exts.append({'name': p.get('ObjectName'), 'online': online, 'tech': 'SIP'})
        except Exception:  # noqa
            pass
        try:
            _, eps = ami.action('PJSIPShowEndpoints')
            for p in eps:
                if p.get('Event') == 'EndpointList' and ext_re.match(p.get('ObjectName', '')):
                    exts.append({'name': p.get('ObjectName'), 'online': p.get('DeviceState', 'Unavailable') not in ('Unavailable', 'Invalid'), 'tech': 'PJSIP'})
        except Exception:  # noqa
            pass
        online = sum(1 for e in exts if e['online'])
        offline = sorted(e['name'] for e in exts if not e['online'])
        st = WARN if exts and online == 0 else OK
        out.append(check('telephony.extensions', 'telephony', 'Ramais', st, '%d online · %d offline' % (online, len(offline)),
                         {'online': online, 'offline': len(offline), 'offlineList': offline[:50]}))
    finally:
        ami.close()
    return out


# ---------------------------------------------------------------- audit (written by the root helper)

AUDIT_TIME = re.compile(r'msg=audit\(([^)]+?)(?:\.\d+)?:\d+\)')
AUDIT_FIELD = lambda k: re.compile(r'\b%s=("[^"]*"|\S+)' % k)  # noqa


def parse_audit_time(s):
    for fmt in ('%m/%d/%Y %H:%M:%S', '%d/%m/%Y %H:%M:%S', '%m/%d/%y %H:%M:%S', '%d/%m/%y %H:%M:%S'):
        try:
            return time.mktime(time.strptime(s, fmt))
        except ValueError:
            continue
    return None


def audit_check(cfg, now):
    path = cfg.get('paths', 'audit_file')
    hours = cfg.getint('thresholds', 'audit_hours')
    try:
        st = os.stat(path)
        with open(path) as f:
            text = f.read(2 * 1024 * 1024)
    except OSError as e:
        return [check('audit.perm_changes', 'audit', 'ausearch -k asterisk_perm', UNKNOWN, 'sem resultado do auditd (%s): instale o timer tldeck-issabel-audit' % e.strerror)]
    age = now - st.st_mtime
    events = []
    for block in text.split('----'):
        if 'type=SYSCALL' not in block:
            continue
        sysline = [l for l in block.splitlines() if 'type=SYSCALL' in l][0]
        tm = AUDIT_TIME.search(sysline)
        t = parse_audit_time(tm.group(1)) if tm else None
        if t is not None and t < now - hours * 3600:
            continue
        fields = {}
        for k in ('auid', 'uid', 'comm', 'exe', 'syscall'):
            m = AUDIT_FIELD(k).search(sysline)
            fields[k] = m.group(1).strip('"') if m else None
        paths = [AUDIT_FIELD('name').search(l).group(1).strip('"') for l in block.splitlines() if 'type=PATH' in l and AUDIT_FIELD('name').search(l)]
        proctitle = [l for l in block.splitlines() if 'type=PROCTITLE' in l]
        pt = AUDIT_FIELD('proctitle').search(proctitle[0]) if proctitle else None
        events.append({'at': now_iso(t) if t else (tm.group(1) if tm else None), 'user': fields['auid'], 'as': fields['uid'],
                       'command': (pt.group(1) if pt else fields['comm']), 'syscall': fields['syscall'], 'paths': paths[:3]})
    events = events[-20:]
    data = {'events': events, 'resultAgeSec': int(age)}
    if age > 3 * 3600:
        return [check('audit.perm_changes', 'audit', 'ausearch -k asterisk_perm', UNKNOWN, 'resultado do auditd desatualizado (%s)' % human_age(age), data)]
    if not events:
        return [check('audit.perm_changes', 'audit', 'ausearch -k asterisk_perm', OK, 'nenhuma alteração de dono/permissão em %d h' % hours, data)]
    last = events[-1]
    return [check('audit.perm_changes', 'audit', 'ausearch -k asterisk_perm', WARN,
                  '%d alteração(ões) em %d h · última: %s por %s (%s)' % (len(events), hours, last['command'], last['user'], last['at']), data)]


# ---------------------------------------------------------------- scheduler / report

class Collector(object):
    def __init__(self, cfg, simulate=False):
        self.cfg = cfg
        self.simulate = simulate
        self.tail = LogTail(cfg.get('paths', 'log_file'))
        self.lock = threading.Lock()
        self.results = {}
        self.since = {}
        self.next = {}
        iv = cfg['intervals']
        fast, normal, slow = int(iv['fast']), int(iv['normal']), int(iv['slow'])
        self.jobs = [
            ('service', fast, lambda now: service_check(self.cfg)),
            ('log', fast, lambda now: (self.tail.poll(now), log_checks(self.tail, now))[1]),
            ('permissions', normal, lambda now: permissions_check(self.cfg, now)),
            ('disk', normal, lambda now: disk_checks(self.cfg)),
            ('cli', normal, lambda now: cli_check(self.cfg)),
            ('telephony', normal, lambda now: telephony_checks(self.cfg)),
            ('cdr', slow, lambda now: cdr_check(self.cfg, now)),
            ('audit', slow, lambda now: audit_check(self.cfg, now)),
        ]

    def run_due(self, now=None, force=False):
        now = now or time.time()
        for name, every, fn in self.jobs:
            if not force and self.next.get(name, 0) > now:
                continue
            self.next[name] = now + every
            try:
                checks = fn(now)
            except Exception as e:  # noqa  (one broken check never stops the others)
                checks = [check('%s.error' % name, name if name != 'cdr' else 'recordings', name, UNKNOWN, 'falha na verificação: %s' % e)]
            with self.lock:
                for k in [k for k, v in self.results.items() if v.get('job') == name]:
                    del self.results[k]
                for c in checks:
                    c['job'] = name
                    c['checkedAt'] = now_iso(now)
                    prev = self.since.get(c['id'])
                    if c['status'] == OK:
                        self.since.pop(c['id'], None)
                    elif not prev or prev[0] != c['status']:
                        self.since[c['id']] = (c['status'], now_iso(now))
                    c['since'] = self.since.get(c['id'], (None, None))[1]
                    self.results[c['id']] = c

    def report(self):
        with self.lock:
            checks = [dict(c) for c in self.results.values()]
        for c in checks:
            c.pop('job', None)
        order = {a: i for i, (a, _) in enumerate(AREAS)}
        checks.sort(key=lambda c: (order.get(c['area'], 99), c['id']))
        overall = max((c['status'] for c in checks), key=lambda s: RANK[s], default=UNKNOWN)
        return {'version': VERSION, 'host': socket.gethostname(), 'generatedAt': now_iso(), 'simulate': self.simulate,
                'overall': overall, 'areas': [{'id': a, 'label': l} for a, l in AREAS], 'checks': checks}

    def loop(self):
        while True:
            self.run_due()
            time.sleep(5)


# ---------------------------------------------------------------- HTTP

class Allow(object):
    """IPs / CIDRs / host names. Names are resolved again every 5 min (the TLDeck machine's IP changes)."""

    def __init__(self, spec):
        self.nets, self.names = [], []
        for item in [x.strip() for x in spec.split(',') if x.strip()]:
            try:
                self.nets.append(ipaddress.ip_network(item, strict=False))
            except ValueError:
                self.names.append(item)
        self.resolved, self.at = set(), 0

    def ok(self, ip):
        if not self.nets and not self.names:
            return True
        addr = ipaddress.ip_address(ip)
        if any(addr in n for n in self.nets):
            return True
        if self.names and (time.time() - self.at > 300 or ip not in self.resolved):
            found = set()
            for n in self.names:
                try:
                    found.update(a[4][0] for a in socket.getaddrinfo(n, None))
                except socket.gaierror:
                    pass
            self.resolved, self.at = found, time.time()
        return ip in self.resolved


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def make_handler(collector, token, allow):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'tldeck-issabel-monitor'
        sys_version = ''

        def log_message(self, fmt, *args):  # quiet: journald only gets refusals
            pass

        def send(self, code, body):
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            ip = self.client_address[0]
            if not allow.ok(ip):
                sys.stderr.write('refused %s (not in allow)\n' % ip)
                return self.send(403, {'error': 'forbidden'})
            got = self.headers.get('Authorization', '')
            if not token or not hmac.compare_digest(got.encode(), ('Bearer ' + token).encode()):
                sys.stderr.write('refused %s (token)\n' % ip)
                return self.send(401, {'error': 'unauthorized'})
            if self.path.split('?')[0] != '/health':
                return self.send(404, {'error': 'not found'})
            return self.send(200, collector.report())

    return Handler


# ---------------------------------------------------------------- simulation (26/11 failure)

def build_simulation(base='/tmp/tldeck-sim'):
    """Recordings folder without write permission, a log with 'Cannot open', CDR rows whose files are missing/empty."""
    now = time.time()
    y, m, d = time.strftime('%Y %m %d', time.localtime(now)).split()
    root = os.path.join(base, 'monitor')
    day = os.path.join(root, y, m, d)
    if os.path.isdir(day):
        os.chmod(day, 0o755)
    shutil.rmtree(base, ignore_errors=True)  # only the simulation folder in /tmp
    os.makedirs(day)
    empty_file = 'in-2001-1001-%s%s%s-%s.wav' % (y, m, d, time.strftime('%H%M%S', time.localtime(now - 1200)))
    with open(os.path.join(day, empty_file), 'wb') as f:
        f.write(b'\0' * 44)
    os.chmod(day, 0o555)  # the failure of 26/11: MixMonitor cannot create files in the day folder
    stamp = lambda t: time.strftime('[%b %d %H:%M:%S]', time.localtime(t))  # noqa  (Asterisk default dateformat)
    log = os.path.join(base, 'full')
    lines = []
    for ago, text in ((3000, 'WARNING[2211] db.c: Error executing SQL (COMMIT): database is locked'),
                      (900, 'WARNING[3101][C-00000002] app_mixmonitor.c: Cannot open %s/out-1001-2002.wav' % day),
                      (240, 'WARNING[3190][C-00000005] app_mixmonitor.c: Cannot open %s/in-2003-1002.wav' % day),
                      (60, 'WARNING[3201][C-00000006] app_mixmonitor.c: Cannot open %s/in-2004-1003.wav' % day)):
        lines.append('%s %s\n' % (stamp(now - ago), text))
    with open(log, 'w') as f:
        f.writelines(lines)
    cdr = os.path.join(base, 'cdr.csv')
    fmt = lambda t: time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t))  # noqa
    with open(cdr, 'w') as f:
        f.write('%s;ANSWERED;out-1001-2002.wav\n' % fmt(now - 900))
        f.write('%s;ANSWERED;%s\n' % (fmt(now - 1200), empty_file))
        f.write('%s;ANSWERED;in-2003-1002.wav\n' % fmt(now - 600))
        f.write('%s;NO ANSWER;\n' % fmt(now - 500))
    audit = os.path.join(base, 'audit.txt')
    with open(audit, 'w') as f:
        f.write('----\ntype=PROCTITLE msg=audit(%s.101:900) : proctitle=chmod 555 %s\n'
                'type=PATH msg=audit(%s.101:900) : item=0 name=%s inode=1 mode=dir,555 ouid=asterisk ogid=asterisk\n'
                'type=SYSCALL msg=audit(%s.101:900) : arch=x86_64 syscall=fchmodat success=yes exit=0 auid=root uid=root comm=chmod exe=/usr/bin/chmod key=asterisk_perm\n'
                % ((time.strftime('%m/%d/%Y %H:%M:%S', time.localtime(now - 1800)), day) * 2 + (time.strftime('%m/%d/%Y %H:%M:%S', time.localtime(now - 1800)),)))
    cfg = load_config(None)
    cfg['paths'].update({'monitor_root': root, 'log_file': log, 'cli_socket': os.path.join(base, 'asterisk.ctl'), 'audit_file': audit})
    cfg['cdr'].update({'csv_file': cdr, 'grace_minutes': '0'})
    cfg['ami']['enabled'] = 'false'
    cfg['service']['unit'] = ''  # the simulation does not look at the real Asterisk
    return cfg


# ---------------------------------------------------------------- main

def load_config(path):
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.read_dict(DEFAULTS)
    if path:
        st = os.stat(path)
        if st.st_mode & 0o077:
            sys.stderr.write('aviso: %s deveria ter permissão 600 (tem %s)\n' % (path, oct(stat.S_IMODE(st.st_mode))))
        if not cfg.read(path):
            raise SystemExit('não foi possível ler %s' % path)
    if os.environ.get('TLDECK_MONITOR_TOKEN'):
        cfg['http']['token'] = os.environ['TLDECK_MONITOR_TOKEN']
    if os.environ.get('TLDECK_MONITOR_AMI_SECRET'):
        cfg['ami']['secret'] = os.environ['TLDECK_MONITOR_AMI_SECRET']
    return cfg


def main(argv=None):
    ap = argparse.ArgumentParser(description='TLDeck Issabel monitor (read-only)')
    ap.add_argument('--config', default='/etc/tldeck-monitor/config.ini')
    ap.add_argument('--once', action='store_true', help='one report on stdout (exit 2 if critical)')
    ap.add_argument('--simulate', action='store_true', help='reproduce the 26/11 failure in /tmp/tldeck-sim (never touches the real folder)')
    ap.add_argument('--port', type=int, help='HTTP port (default: config; simulate: 19118)')
    a = ap.parse_args(argv)

    if a.simulate:
        cfg = build_simulation()
        cfg['http'].update({'bind': '127.0.0.1', 'port': str(a.port or 19118), 'allow': '127.0.0.1',
                            'token': os.environ.get('TLDECK_MONITOR_TOKEN', 'simulate-token-0123456789abcdef')})
        if os.geteuid() == 0:
            sys.stderr.write('aviso: como root a pasta sem permissão não bloqueia; rode a simulação como usuário comum\n')
    else:
        cfg = load_config(a.config)
    if a.port:
        cfg['http']['port'] = str(a.port)

    col = Collector(cfg, simulate=a.simulate)
    col.run_due(force=True)
    if a.once:
        rep = col.report()
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        return 2 if rep['overall'] == CRIT else 0

    if not cfg.get('http', 'token') or len(cfg.get('http', 'token')) < 24:
        raise SystemExit('defina [http] token com pelo menos 24 caracteres (ou TLDECK_MONITOR_TOKEN)')
    threading.Thread(target=col.loop, daemon=True).start()
    srv = Server((cfg.get('http', 'bind'), cfg.getint('http', 'port')),
                 make_handler(col, cfg.get('http', 'token'), Allow(cfg.get('http', 'allow'))))
    sys.stderr.write('tldeck-issabel-monitor em http://%s:%s/health%s\n' % (cfg.get('http', 'bind'), cfg.get('http', 'port'), ' (SIMULAÇÃO)' if a.simulate else ''))
    srv.serve_forever()


if __name__ == '__main__':
    sys.exit(main())
