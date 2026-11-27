#!/bin/sh
# Instala o TLDeck Issabel monitor. Rodar como root, a partir desta pasta.
# Não altera Asterisk, MySQL, firewall nem permissões das gravações: só cria os próprios arquivos e serviços.
set -eu

APP=/opt/tldeck-monitor
ETC=/etc/tldeck-monitor
STATE=/var/lib/tldeck-monitor
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" -eq 0 ] || { echo "rode como root"; exit 1; }
id asterisk >/dev/null 2>&1 || { echo "usuário asterisk não existe"; exit 1; }
PY=/usr/libexec/platform-python
[ -x "$PY" ] || PY=$(command -v python3)
"$PY" -c 'import sys; assert sys.version_info >= (3, 6)' || { echo "precisa de Python 3.6+"; exit 1; }

install -d -m 755 -o root -g root "$APP"
install -m 755 -o root -g root "$HERE/tldeck_issabel_monitor.py" "$APP/"
install -m 644 -o root -g root "$HERE/README.md" "$APP/"

install -d -m 750 -o root -g asterisk "$ETC"
if [ ! -f "$ETC/config.ini" ]; then
  TOKEN=$("$PY" -c 'import secrets; print(secrets.token_hex(32))')
  AMI=$("$PY" -c 'import secrets; print(secrets.token_urlsafe(24))')
  sed -e "s/__TOKEN__/$TOKEN/" -e "s/__AMI_SECRET__/$AMI/" "$HERE/config.ini.example" > "$ETC/config.ini"
  echo "config criada: $ETC/config.ini (token e senha AMI gerados; veja com: sudo cat $ETC/config.ini)"
else
  echo "config existente mantida: $ETC/config.ini"
fi
if [ ! -f "$ETC/mysql.cnf" ]; then
  MYSQLPW=$("$PY" -c 'import secrets; print(secrets.token_urlsafe(24))')
  sed -e "s/__MYSQL_PASSWORD__/$MYSQLPW/" "$HERE/mysql.cnf.example" > "$ETC/mysql.cnf"
  echo "mysql.cnf criado com senha gerada (use-a no CREATE USER do README)"
fi
chown asterisk:asterisk "$ETC/config.ini" "$ETC/mysql.cnf"
chmod 600 "$ETC/config.ini" "$ETC/mysql.cnf"

install -d -m 750 -o root -g asterisk "$STATE"

if [ "$PY" != /usr/libexec/platform-python ]; then
  sed "s#/usr/libexec/platform-python#$PY#" "$HERE/systemd/tldeck-issabel-monitor.service" > /etc/systemd/system/tldeck-issabel-monitor.service
else
  install -m 644 "$HERE/systemd/tldeck-issabel-monitor.service" /etc/systemd/system/
fi
install -m 644 "$HERE/systemd/tldeck-issabel-audit.service" "$HERE/systemd/tldeck-issabel-audit.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tldeck-issabel-audit.timer
systemctl enable --now tldeck-issabel-monitor.service

echo
echo "Instalado. Próximos passos (README): usuário MySQL somente leitura, usuário AMI 'tldeck',"
echo "liberar a porta $(sed -n 's/^port *= *//p' "$ETC/config.ini") só para a rede interna e configurar o TLDeck."
echo "Teste local: $PY $APP/tldeck_issabel_monitor.py --config $ETC/config.ini --once  (como asterisk: sudo -u asterisk ...)"
