#!/usr/bin/env bash
set -euo pipefail

app_dir=/opt/anchor-identity-monitor
state_dir=/var/lib/anchor-identity-monitor
env_file=/etc/anchor-identity-monitor.env

if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' 'Run this script as root.'
  exit 1
fi

if [[ ! -f "${env_file}" ]]; then
  printf 'Missing %s\n' "${env_file}"
  exit 1
fi

PUBLIC_HOSTNAME="$(
  awk -F= '$1 == "PUBLIC_HOSTNAME" {
    sub(/^[^=]*=/, "");
    print;
    exit;
  }' "${env_file}"
)"
: "${PUBLIC_HOSTNAME:?PUBLIC_HOSTNAME is required}"

dnf update -y
dnf install -y ca-certificates

if ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != v22.* ]]; then
  curl --fail --silent --show-error https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  caddy_version=2.10.2
  caddy_archive="caddy_${caddy_version}_linux_arm64.tar.gz"
  caddy_release_url="https://github.com/caddyserver/caddy/releases/download/v${caddy_version}"
  mkdir -p /tmp/caddy-install
  curl --fail --silent --show-error --location \
    "${caddy_release_url}/${caddy_archive}" \
    --output "/tmp/caddy-install/${caddy_archive}"
  curl --fail --silent --show-error --location \
    "${caddy_release_url}/caddy_${caddy_version}_checksums.txt" \
    --output /tmp/caddy-install/checksums.txt
  checksum_line="$(grep -F "${caddy_archive}" /tmp/caddy-install/checksums.txt | head -n 1)"
  expected_checksum="$(printf '%s\n' "${checksum_line}" | grep -Eo '[0-9A-Fa-f]{128}' | head -n 1)"
  actual_checksum="$(sha512sum "/tmp/caddy-install/${caddy_archive}" | awk '{print $1}')"
  if [[ -z "${expected_checksum}" || "${actual_checksum,,}" != "${expected_checksum,,}" ]]; then
    printf '%s\n' 'Caddy checksum verification failed.'
    exit 1
  fi
  tar -xzf "/tmp/caddy-install/${caddy_archive}" -C /tmp/caddy-install
  install -m 0755 /tmp/caddy-install/caddy /usr/bin/caddy
  rm -rf /tmp/caddy-install
fi

id anchor-monitor >/dev/null 2>&1 || useradd --system --home-dir "${state_dir}" --create-home anchor-monitor
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --shell /sbin/nologin caddy
mkdir -p "${state_dir}/thumbnails" /etc/caddy
mkdir -p /var/lib/caddy /var/log/caddy
chown -R anchor-monitor:anchor-monitor "${state_dir}"
chown -R anchor-monitor:anchor-monitor "${app_dir}"
chown -R caddy:caddy /var/lib/caddy /var/log/caddy

chmod 640 "${env_file}"
chown root:anchor-monitor "${env_file}"

cd "${app_dir}"
npm ci
npm run build

install -m 0644 deploy/aws/anchor-identity-monitor.service \
  /etc/systemd/system/anchor-identity-monitor.service
install -m 0644 deploy/aws/anchor-identity-monitor-discover.service \
  /etc/systemd/system/anchor-identity-monitor-discover.service
install -m 0644 deploy/aws/anchor-identity-monitor-discover.timer \
  /etc/systemd/system/anchor-identity-monitor-discover.timer
install -m 0644 deploy/aws/Caddyfile /etc/caddy/Caddyfile
install -m 0644 deploy/aws/caddy.service /etc/systemd/system/caddy.service

systemctl daemon-reload
systemctl enable --now anchor-identity-monitor.service
systemctl enable --now anchor-identity-monitor-discover.timer
systemctl enable --now caddy.service
systemctl restart caddy.service
