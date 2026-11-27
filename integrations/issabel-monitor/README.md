# TLDeck Issabel monitor

Coletor **somente leitura** que roda no servidor Issabel/Asterisk e expõe a saúde do PABX para o TLDeck
(tela **Infra**, provedor `issabel`). Foi feito depois do incidente de 26/11/2026: das 08:02 às 13:38
todas as gravações falharam com `app_mixmonitor.c: Cannot open …`, e ninguém percebeu por mais de 5 horas.
Com o coletor, isso vira um alerta **crítico** e um **incidente SEV2** no TLDeck em 1 a 2 minutos.

- Python 3.6+ só com a biblioteca padrão: usa o `platform-python` do EL8, sem `pip`.
- Roda como o usuário `asterisk`, endurecido pelo systemd. Usa no máximo 10% de CPU e 64 MB de RAM, com prioridade de I/O ociosa.
- **Nunca** faz `chown`/`chmod`, restart, nem altera Asterisk, banco ou gravações. A única escrita é o teste de
  permissão: cria um arquivo vazio `.tldeck-probe-*` na pasta do dia e o apaga em seguida.

## O que é verificado

| Área | Item | Crítico | Atenção | Frequência |
|---|---|---|---|---|
| Serviço | Asterisk (systemd, PID, uptime, memória) | parado | reiniciado há < 10 min | 30 s |
| Gravações | `Cannot open` do app_mixmonitor (5/15/60 min) | ≥ 1 em 15 min | ≥ 1 em 60 min | 30 s |
| Gravações | CDR × disco: atendidas com `recordingfile`, arquivo ausente ou ≤ 44 bytes | taxa de perdidas > 0 na última hora | perdidas na janela (2 h) | 5 min |
| Permissões | Dono, grupo e modo da pasta do dia e das pais; teste de escrita como `asterisk` | sem escrita ou sem acesso | (rodando como root) | 60 s |
| Log | `database is locked`, `Address already in use`, falha de carga de módulo | | ≥ 1 em 60 min | 30 s |
| Disco | Espaço e inodes da partição das gravações | ≥ 90% | ≥ 80% | 60 s |
| Telefonia (AMI) | Chamadas ativas, registro dos troncos, ramais online/offline | tronco desregistrado | nenhum ramal online / AMI inacessível | 60 s |
| CLI | `/var/run/asterisk/asterisk.ctl` existe | | ausente | 60 s |
| Auditoria | `ausearch -k asterisk_perm`: quem mudou dono ou permissão | | qualquer alteração em 24 h | 5 min |

O log é lido **só pelo final**: a partir de onde parou na leitura anterior, no máximo 16 MB, percebendo a rotação.
O CDR é lido por janela de tempo, com `LIMIT` e índice em `calldate`.
Chamadas encerradas há menos de 2 min são ignoradas na comparação, porque o arquivo pode ainda estar sendo fechado.

## Arquitetura

```
 Issabel 10.10.0.235                                          TLDeck (desktop-vmuj97q)
 ┌──────────────────────────────────────────────┐             ┌───────────────────────────┐
 │ tldeck-issabel-monitor.service (asterisk)    │  GET /health│ provedor "issabel"        │
 │  systemd · /proc · tail do full · CDR (ro)   │◄────────────│  a cada INFRA_POLL_SEC    │
 │  stat + probe da pasta · statvfs · AMI (ro)  │ Bearer token│  → tela Infra, eventos,   │
 │  :9118 só na rede interna                    │             │    incidente SEV2         │
 │ tldeck-issabel-audit.timer (root, 5 min)     │             └───────────────────────────┘
 │  ausearch -k asterisk_perm → /var/lib/…      │
 └──────────────────────────────────────────────┘
```

No TLDeck, cada área vira um recurso `issabel-prod · <área>`:
- Um item **crítico** deixa a área *fora do ar*. O tracker dispara o alerta crítico e, como o nome tem `prod`, abre o incidente.
- Um item de **atenção** vira um alerta *warning*.
- O próprio coletor também é um recurso. Se ele não responder, ou se o relatório tiver mais de 3 min, fica *fora do ar*: silêncio nunca parece OK.

## Instalação

### 1. Copiar e instalar (root)

```sh
# da sua máquina
scp -r integrations/issabel-monitor root@10.10.0.235:/root/
# no servidor
cd /root/issabel-monitor && sh install.sh
```

O `install.sh` faz o seguinte:
- copia o coletor para `/opt/tldeck-monitor`;
- cria `/etc/tldeck-monitor/config.ini` e `mysql.cnf` (dono `asterisk`, permissão 600), com token e senhas **gerados**;
- cria `/var/lib/tldeck-monitor` (root:asterisk 750);
- instala e ativa `tldeck-issabel-monitor.service` e `tldeck-issabel-audit.timer`.

Ele não mexe em mais nada.

### 2. Usuário MySQL somente leitura (CDR)

Use a senha que o install gerou em `/etc/tldeck-monitor/mysql.cnf`:

```sql
CREATE USER 'tldeck_ro'@'localhost' IDENTIFIED BY '<senha do mysql.cnf>';
GRANT SELECT (calldate, disposition, recordingfile) ON asteriskcdrdb.cdr TO 'tldeck_ro'@'localhost';
```

É permissão de coluna: o usuário só lê essas 3 colunas da tabela `cdr`.

### 3. Usuário AMI de leitura

Acrescente em `/etc/asterisk/manager_custom.conf`, usando a senha `[ami] secret` do `config.ini`:

```ini
[tldeck]
secret = <senha do config.ini>
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = reporting
write = reporting
displayconnects = no
```

- A classe `reporting` libera só as ações de consulta: `CoreShowChannels`, `SIPpeers`, `SIPshowregistry` e `PJSIPShow*`.
- `Originate`, `Command`, `Redirect` e as demais ficam negadas.
- `displayconnects = no` evita uma linha de login no `full` a cada minuto.

Para aplicar, recarregue o módulo manager. O socket do CLI está ausente hoje, então `asterisk -rx` não funciona. Há duas saídas:
- reload pela interface do Issabel;
- ação AMI `Action: Reload` / `Module: manager` com o usuário admin.

### 4. Firewall

Libere a porta 9118 **só** para a rede interna, por exemplo em *Segurança → Firewall* no Issabel, ou com uma regra iptables de origem `10.10.0.0/24`.
O coletor também filtra por conta própria:
- `[http] allow`: IPs, redes e nomes; o nome `desktop-vmuj97q` é resolvido de novo a cada 5 min;
- o token é exigido sempre;
- ele escuta só em `10.10.0.235`.

> Se o Issabel não resolver `desktop-vmuj97q` (nome NetBIOS do Windows), a rede `10.10.0.0/24` em `allow` continua valendo.

### 5. TLDeck

No `.env` do TLDeck:

```env
ISSABEL_URL=http://10.10.0.235:9118
ISSABEL_TOKEN=<[http] token do config.ini>
ISSABEL_NAME=issabel-prod
```

Reinicie o TLDeck. Os cards aparecem na tela **Infra**, filtro *Issabel*.

### Conferir

```sh
systemctl status tldeck-issabel-monitor tldeck-issabel-audit.timer
sudo -u asterisk /usr/libexec/platform-python /opt/tldeck-monitor/tldeck_issabel_monitor.py --config /etc/tldeck-monitor/config.ini --once | less
curl -s -H "Authorization: Bearer <token>" http://10.10.0.235:9118/health | python3 -m json.tool | head -40
journalctl -u tldeck-issabel-monitor -n 50
```

`--once` imprime o relatório e sai com código **2** se houver item crítico.

## Teste: simular a falha de 26/11

A simulação **não toca** na pasta real de gravações, no MySQL nem no AMI. Tudo fica em `/tmp/tldeck-sim`:
- a pasta do dia com permissão `555`, como no incidente, em que o MixMonitor não conseguia criar arquivos;
- um `full` com `Cannot open` e `database is locked` com horário de agora;
- um CDR (CSV) com gravações ausentes e uma de 44 bytes;
- um evento do auditd com um `chmod` feito por root.

Rode como **usuário comum**, não root, para que a falta de permissão realmente bloqueie. Pode ser em qualquer Linux, inclusive no WSL:

```sh
python3 tldeck_issabel_monitor.py --simulate --once; echo "código: $?"   # 2 = crítico
```

Resultado esperado:

```
critical recordings.cannot_open   Cannot open: 2 em 5 min · 2 em 15 min · 3 em 60 min
critical recordings.cdr_vs_disk   perdidas 1 h: 3/3 (100%) · 2 h: 3/3 (2 ausentes, 1 vazias)
critical permissions.day_folder   <usuário> NÃO grava em /tmp/tldeck-sim/monitor/AAAA/MM/DD … 0555 (Permission denied)
warn     log.db_locked            0 em 5 min · 0 em 15 min · 1 em 60 min
warn     audit.perm_changes       1 alteração(ões) em 24 h · última: chmod por root
```

Para ver o alerta e o incidente no TLDeck:

```sh
python3 tldeck_issabel_monitor.py --simulate --port 19118     # escuta em 127.0.0.1
```

Depois, no `.env` do TLDeck, aponte `ISSABEL_URL=http://127.0.0.1:19118` e `ISSABEL_TOKEN=simulate-token-0123456789abcdef`.
O provedor mostra o aviso "SIMULATION mode".

## Remoção

```sh
sh uninstall.sh            # para e remove serviços e /opt/tldeck-monitor (mantém a config)
sh uninstall.sh --purge    # também apaga /etc/tldeck-monitor e /var/lib/tldeck-monitor
```

Depois, à mão:
- `DROP USER 'tldeck_ro'@'localhost';`
- remover o bloco `[tldeck]` do `manager_custom.conf` e recarregar o manager;
- remover a regra de firewall da porta 9118.

## Configuração

Veja `config.ini.example`. Os segredos também podem vir do ambiente: `TLDECK_MONITOR_TOKEN` e `TLDECK_MONITOR_AMI_SECRET`.
O coletor avisa no journal se o `config.ini` não estiver com permissão 600.

## Notas

- **Formato do log:** aceita `[Nov 26 08:02:11]` (padrão) e `[2026-11-26 08:02:11]` (`dateformat` ISO no `logger.conf`).
- **Caminho da gravação:** `recordingfile` relativo é procurado em `monitor/AAAA/MM/DD/` (data do `calldate`) e na raiz `monitor/`. Caminho absoluto é usado como está.
- **Ramais × troncos:** peers ou endpoints cujo nome casa com `extension_re` (padrão `^\d{2,6}$`) são ramais. O registro dos troncos vem de `SIPshowregistry` e `PJSIPShowRegistrationsOutbound`; o que não estiver carregado é ignorado.
- **Socket do CLI:** a ausência de `asterisk.ctl` aparece como atenção. Vale investigar a causa (dono de `/var/run/asterisk` ou `astctlpermissions` no `asterisk.conf`): é o mesmo tipo de problema de permissão do incidente.
