#!/bin/sh
# Remove o TLDeck Issabel monitor. --purge também apaga a configuração e o estado.
# Não mexe no Asterisk, no MySQL nem nas gravações (o usuário MySQL e o bloco AMI são removidos à mão: README).
set -eu
[ "$(id -u)" -eq 0 ] || { echo "rode como root"; exit 1; }

systemctl disable --now tldeck-issabel-monitor.service tldeck-issabel-audit.timer 2>/dev/null || true
rm -f /etc/systemd/system/tldeck-issabel-monitor.service /etc/systemd/system/tldeck-issabel-audit.service /etc/systemd/system/tldeck-issabel-audit.timer
systemctl daemon-reload
rm -rf /opt/tldeck-monitor
if [ "${1:-}" = "--purge" ]; then
  rm -rf /etc/tldeck-monitor /var/lib/tldeck-monitor
  echo "configuração e estado apagados"
else
  echo "configuração mantida em /etc/tldeck-monitor (use --purge para apagar)"
fi
echo "Removido. Falta (manual): DROP USER 'tldeck_ro'@'localhost'; e o bloco [tldeck] do manager_custom.conf."
