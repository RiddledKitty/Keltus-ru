#!/usr/bin/env bash
# Install script for keltus.ru on a Latvian (or any other) server.
#
# Assumes the target server already has:
#   - Node.js 20+    (node, npm on PATH)
#   - MariaDB 10.6+  (running, root access via sudo)
#   - nginx          (with sites-available / sites-enabled layout)
#   - certbot        (with the nginx plugin) — optional but recommended
#   - git, curl, openssl, rsync
#
# What this script does, end to end:
#   1. Generates a fresh secrets bundle under /root/keltus-ru-secrets/
#   2. Creates two MariaDB databases + users (Directus CMS + Go analytics)
#   3. Writes cms/.env, web/.env, analytics/.env, .deploy-secrets
#   4. npm install for cms, web, and every Directus extension
#   5. Bootstraps Directus (creates schema + first admin user)
#   6. Installs systemd units and starts the CMS + rebuild-listener
#   7. Runs setup-collections.mjs, setup-contact-requests.mjs, seed-content.mjs
#   8. Grants public READ permissions to the Public policy via the API
#   9. Triggers the first build
#  10. Installs the nginx vhost and offers to call certbot
#
# Re-running is mostly safe: secrets are generated once, the DB user is
# created with IF NOT EXISTS, every seed script is idempotent.

set -euo pipefail

# --- 0. configuration ---------------------------------------------------

SITE_ROOT="${SITE_ROOT:-/var/www/keltus.ru}"
SECRETS_DIR="${SECRETS_DIR:-/root/keltus-ru-secrets}"
DOMAIN="${DOMAIN:-keltus.ru}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-admin.keltus.ru}"
WWW_DOMAIN="${WWW_DOMAIN:-www.keltus.ru}"
DIRECTUS_PORT="${DIRECTUS_PORT:-8057}"
ANALYTICS_PORT="${ANALYTICS_PORT:-4330}"
REBUILD_PORT="${REBUILD_PORT:-4338}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-/var/www/.npm}"
SERVICE_USER="${SERVICE_USER:-www-data}"

green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
note()  { printf '\033[36m· %s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  red "Запустите через sudo / от root."
  exit 1
fi

if [[ ! -d "$SITE_ROOT" ]]; then
  red "Не вижу $SITE_ROOT. Сначала разверните в неё содержимое архива keltus.ru."
  exit 1
fi

# Sanity-check the things we depend on early so the failure mode is obvious.
for bin in node npm mariadb nginx openssl curl rsync; do
  command -v "$bin" >/dev/null 2>&1 || { red "Не найден $bin"; exit 1; }
done
note "Базовые утилиты на месте: node $(node -v), nginx, MariaDB"

# --- 1. secrets ---------------------------------------------------------

step "1/10 — секреты"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [[ -f "$SECRETS_DIR/secrets.env" ]]; then
  note "$SECRETS_DIR/secrets.env уже существует — переиспользуем."
  # shellcheck disable=SC1090
  source "$SECRETS_DIR/secrets.env"
else
  DB_NAME=keltus_ru_cms
  DB_USER=keltus_ru_cms
  DB_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/' | head -c 24)
  ANALYTICS_DB_USER=keltus_ru_analytics
  ANALYTICS_DB_NAME=keltus_ru_analytics
  ANALYTICS_DB_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/' | head -c 24)
  DIRECTUS_KEY=$(cat /proc/sys/kernel/random/uuid)
  DIRECTUS_SECRET=$(openssl rand -base64 48 | tr -d '=+/' | head -c 48)
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@$DOMAIN}"
  ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '=+/' | head -c 20)
  REBUILD_SECRET=$(openssl rand -hex 32)
  STATIC_API_TOKEN=$(openssl rand -hex 32)

  cat > "$SECRETS_DIR/secrets.env" <<EOF
# keltus.ru secrets — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
ANALYTICS_DB_USER=$ANALYTICS_DB_USER
ANALYTICS_DB_NAME=$ANALYTICS_DB_NAME
ANALYTICS_DB_PASSWORD=$ANALYTICS_DB_PASSWORD
DIRECTUS_KEY=$DIRECTUS_KEY
DIRECTUS_SECRET=$DIRECTUS_SECRET
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
REBUILD_SECRET=$REBUILD_SECRET
STATIC_API_TOKEN=$STATIC_API_TOKEN
DIRECTUS_PORT=$DIRECTUS_PORT
ANALYTICS_PORT=$ANALYTICS_PORT
REBUILD_PORT=$REBUILD_PORT
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=
EOF
  chmod 600 "$SECRETS_DIR/secrets.env"
  green "+ свежие секреты записаны в $SECRETS_DIR/secrets.env"
fi

# shellcheck disable=SC1090
source "$SECRETS_DIR/secrets.env"

# --- 2. databases -------------------------------------------------------

step "2/10 — MariaDB: базы данных и пользователи"

mariadb -u root <<EOF
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'127.0.0.1';

CREATE DATABASE IF NOT EXISTS $ANALYTICS_DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$ANALYTICS_DB_USER'@'127.0.0.1' IDENTIFIED BY '$ANALYTICS_DB_PASSWORD';
GRANT ALL PRIVILEGES ON $ANALYTICS_DB_NAME.* TO '$ANALYTICS_DB_USER'@'127.0.0.1';

FLUSH PRIVILEGES;
EOF
green "+ $DB_NAME и $ANALYTICS_DB_NAME готовы"

# --- 3. .env files ------------------------------------------------------

step "3/10 — .env файлы"

cat > "$SITE_ROOT/cms/.env" <<EOF
HOST="127.0.0.1"
PORT="$DIRECTUS_PORT"
PUBLIC_URL="https://$ADMIN_DOMAIN"

DB_CLIENT="mysql"
DB_HOST="127.0.0.1"
DB_PORT="3306"
DB_DATABASE="$DB_NAME"
DB_USER="$DB_USER"
DB_PASSWORD="$DB_PASSWORD"
DB_CHARSET="utf8mb4"

KEY="$DIRECTUS_KEY"
SECRET="$DIRECTUS_SECRET"

ADMIN_EMAIL="$ADMIN_EMAIL"
ADMIN_PASSWORD="$ADMIN_PASSWORD"

LOG_LEVEL="info"
CACHE_ENABLED="false"

CORS_ENABLED="true"
CORS_ORIGIN="https://$DOMAIN,https://$WWW_DOMAIN"

CONTACT_TO_EMAIL="$ADMIN_EMAIL"

# Brevo — заполните, если хотите доставку через Brevo
BREVO_API_KEY=""
BREVO_FROM_EMAIL=""
BREVO_FROM_NAME="Keltus"

# SMTP — заполните, если хотите отправку напрямую через SMTP
EMAIL_TRANSPORT="smtp"
EMAIL_FROM=""
EMAIL_SMTP_HOST=""
EMAIL_SMTP_PORT="587"
EMAIL_SMTP_USER=""
EMAIL_SMTP_PASSWORD=""
EMAIL_SMTP_SECURE="false"

GEO_DB_PATH="/var/lib/GeoIP/GeoLite2-City.mmdb"

REBUILD_SECRET="$REBUILD_SECRET"
REBUILD_URL="http://127.0.0.1:$REBUILD_PORT/rebuild"
GOOGLE_PSI_API_KEY=""
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$SITE_ROOT/cms/.env"
chmod 600 "$SITE_ROOT/cms/.env"

cat > "$SITE_ROOT/web/.env" <<EOF
DIRECTUS_URL="http://127.0.0.1:$DIRECTUS_PORT"
DIRECTUS_TOKEN=""
PUBLIC_CMS_URL="https://$ADMIN_DOMAIN"
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$SITE_ROOT/web/.env"

cat > "$SITE_ROOT/analytics/.env" <<EOF
KELTUS_ANALYTICS_LISTEN="127.0.0.1:$ANALYTICS_PORT"
KELTUS_ANALYTICS_DSN="$ANALYTICS_DB_USER:$ANALYTICS_DB_PASSWORD@tcp(127.0.0.1:3306)/$ANALYTICS_DB_NAME"
KELTUS_ANALYTICS_OWN_HOST="$DOMAIN"
KELTUS_ANALYTICS_GEOIP="/var/lib/GeoIP/GeoLite2-City.mmdb"
KELTUS_ANALYTICS_ADMIN_TOKEN=""
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$SITE_ROOT/analytics/.env"
chmod 600 "$SITE_ROOT/analytics/.env"

cat > "$SITE_ROOT/.deploy-secrets" <<EOF
REBUILD_SECRET=$REBUILD_SECRET
STATIC_API_TOKEN=$STATIC_API_TOKEN
SITE_ROOT=$SITE_ROOT
DIRECTUS_URL=http://127.0.0.1:$DIRECTUS_PORT
REBUILD_PORT=$REBUILD_PORT
CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:-}
CLOUDFLARE_ZONE_ID=${CLOUDFLARE_ZONE_ID:-}
EOF
chmod 600 "$SITE_ROOT/.deploy-secrets"
green "+ cms/.env, web/.env, analytics/.env, .deploy-secrets написаны"

# --- 4. npm install -----------------------------------------------------

step "4/10 — npm install (CMS, web, расширения)"

mkdir -p "$NPM_CACHE_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$NPM_CACHE_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$SITE_ROOT"

run_as_service() { sudo -u "$SERVICE_USER" -H bash -c "$*"; }

run_as_service "cd '$SITE_ROOT/cms' && npm install --no-audit --no-fund"
run_as_service "cd '$SITE_ROOT/web' && npm install --no-audit --no-fund"
for ext in "$SITE_ROOT"/cms/extensions/*/; do
  if [[ -f "$ext/package.json" ]]; then
    run_as_service "cd '$ext' && npm install --no-audit --no-fund"
    # If a build script exists (e.g. keltus-analytics has Vue source code),
    # rebuild it; the pre-shipped dist/ for others stays untouched.
    if grep -q '"build"' "$ext/package.json"; then
      run_as_service "cd '$ext' && npm run build" || note "сборка $ext завершилась с ошибкой — продолжаем (dist/ из архива уже есть)"
    fi
  fi
done
green "+ зависимости установлены"

# --- 5. Directus bootstrap ----------------------------------------------

step "5/10 — Directus bootstrap (схема + первый администратор)"

# Bootstrap is idempotent — if the schema is already there, it just exits.
run_as_service "cd '$SITE_ROOT/cms' && node node_modules/.bin/directus bootstrap" | tail -10

# --- 6. systemd ---------------------------------------------------------

step "6/10 — systemd-юниты"

install_unit() {
  local name=$1
  local src="$SITE_ROOT/deploy/systemd-$name.service.example"
  local dest="/etc/systemd/system/$name.service"
  [[ -f "$src" ]] || { red "Не найден $src"; exit 1; }
  cp "$src" "$dest"
  chmod 644 "$dest"
}

install_unit keltus-ru-cms
install_unit keltus-ru-rebuild
install_unit keltus-ru-analytics
systemctl daemon-reload
systemctl enable --now keltus-ru-cms keltus-ru-rebuild
green "+ keltus-ru-cms и keltus-ru-rebuild запущены"
note "keltus-ru-analytics установлен, но НЕ запущен: сначала соберите Go-бинарник"
note "  cd $SITE_ROOT/analytics && go build -o keltusanalytics ./cmd/keltusanalytics"
note "  затем: systemctl enable --now keltus-ru-analytics"

# Wait for Directus to actually answer /server/ping before running the seeds.
note "ждём готовности Directus на 127.0.0.1:$DIRECTUS_PORT…"
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$DIRECTUS_PORT/server/ping" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf "http://127.0.0.1:$DIRECTUS_PORT/server/ping" >/dev/null || {
  red "Directus не отвечает; смотрите: journalctl -u keltus-ru-cms -n 50"
  exit 1
}

# --- 7. content collections + seeds ------------------------------------

step "7/10 — коллекции и контент"

CMS_URL="http://127.0.0.1:$DIRECTUS_PORT"
run_as_service "DIRECTUS_URL=$CMS_URL ADMIN_EMAIL='$ADMIN_EMAIL' ADMIN_PASSWORD='$ADMIN_PASSWORD' \
  node '$SITE_ROOT/cms/scripts/setup-collections.mjs'" | tail -5
run_as_service "DIRECTUS_URL=$CMS_URL ADMIN_EMAIL='$ADMIN_EMAIL' ADMIN_PASSWORD='$ADMIN_PASSWORD' \
  node '$SITE_ROOT/cms/scripts/setup-contact-requests.mjs'" | tail -5
run_as_service "DIRECTUS_URL=$CMS_URL ADMIN_EMAIL='$ADMIN_EMAIL' ADMIN_PASSWORD='$ADMIN_PASSWORD' \
  node '$SITE_ROOT/cms/scripts/seed-content.mjs'" | tail -5
green "+ коллекции и контент засеяны"

# --- 8. Public policy permissions (Directus 11) -------------------------

step "8/10 — публичные READ-разрешения (политика Public)"

TOKEN=$(curl -s -X POST "$CMS_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["access_token"])')

# List all policies and find the one whose name contains "public_label"
# (Directus 11 stores it as the i18n key "$t:public_label"). Filtering on
# that literal value through a URL gets messy with $/[/], so do it in code.
PUB_POLICY=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$CMS_URL/policies?fields=id,name&limit=20" \
  | python3 -c 'import sys,json
data = json.load(sys.stdin).get("data", [])
hits = [p["id"] for p in data if "public_label" in (p.get("name") or "")]
print(hits[0] if hits else "")')

if [[ -z "$PUB_POLICY" ]]; then
  red "Не нашёл политику Public — разрешения нужно выставить вручную в админке."
else
  # Idempotent: skip if permission already exists.
  add_perm() {
    local coll=$1; local body=$2
    local exists
    # Wrap the python parse in try/except — if the API returns HTML/empty,
    # we treat that as "no existing permission" and let the create attempt
    # happen. The create is itself a no-op if a permission with the same
    # (policy, collection, action) tuple already exists.
    exists=$(curl -s -H "Authorization: Bearer $TOKEN" \
      "$CMS_URL/permissions?filter%5Bpolicy%5D%5B_eq%5D=$PUB_POLICY&filter%5Bcollection%5D%5B_eq%5D=$coll&filter%5Baction%5D%5B_eq%5D=read&fields=id&limit=1" \
      | python3 -c 'import sys,json
try:
    d = json.load(sys.stdin).get("data", [])
    print(d[0]["id"] if d else "")
except Exception:
    print("")')
    if [[ -n "$exists" ]]; then
      note "permissions/$coll: уже есть (id=$exists)"
    else
      curl -s -X POST "$CMS_URL/permissions" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
        -d "$body" >/dev/null
      note "+ permissions/$coll"
    fi
  }
  for coll in project team_member testimonial technology; do
    add_perm "$coll" \
      "{\"policy\":\"$PUB_POLICY\",\"collection\":\"$coll\",\"action\":\"read\",\"fields\":[\"*\"],\"permissions\":{\"_and\":[{\"status\":{\"_eq\":\"published\"}}]}}"
  done
  add_perm site_config \
    "{\"policy\":\"$PUB_POLICY\",\"collection\":\"site_config\",\"action\":\"read\",\"fields\":[\"*\"]}"
  add_perm directus_files \
    "{\"policy\":\"$PUB_POLICY\",\"collection\":\"directus_files\",\"action\":\"read\",\"fields\":[\"id\",\"storage\",\"filename_disk\",\"filename_download\",\"title\",\"type\",\"width\",\"height\",\"description\",\"modified_on\"]}"
fi

# Ensure the site_config singleton row exists with the theme defaults.
# (The setup script tries this too, but the singleton PATCH semantics in
# Directus 11 are finicky; this POST is the reliable fallback.)
SC_EXISTS=$(curl -s -H "Authorization: Bearer $TOKEN" "$CMS_URL/items/site_config" \
  | python3 -c 'import sys,json
try:
    d = json.load(sys.stdin).get("data")
    print("1" if d else "")
except Exception:
    print("")')
if [[ -z "$SC_EXISTS" ]]; then
  curl -s -X POST "$CMS_URL/items/site_config" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"accent":"#38bdf8","accent_hover":"#0ea5e9","bg":"#0a0e14","bg_alt":"#11161f","bg_3":"#1a212e","border":"#1f2937","border_2":"#2c3848","text":"#e6edf5","text_2":"#9aa6b8","text_3":"#5b6679","success":"#10b981","warn":"#f59e0b","danger":"#f43f5e","konami_toast":"да, мы знаем — но синапсы всё равно лучше."}' >/dev/null
  note "+ site_config: засеян значениями по умолчанию"
fi

green "+ публичные разрешения настроены"

# --- 9. first build -----------------------------------------------------

step "9/10 — первая сборка статики"

curl -sf -X POST "http://127.0.0.1:$REBUILD_PORT/rebuild" \
  -H "Authorization: Bearer $REBUILD_SECRET" >/dev/null || {
    red "Не удалось запустить rebuild-листенер на :$REBUILD_PORT"
    exit 1
  }

note "ждём появления dist/index.html…"
for i in $(seq 1 60); do
  [[ -f "$SITE_ROOT/web/dist/index.html" ]] && break
  sleep 2
done
if [[ ! -f "$SITE_ROOT/web/dist/index.html" ]]; then
  red "Сборка не завершилась за 120 с; смотрите: journalctl -u keltus-ru-rebuild -n 50"
  exit 1
fi
green "+ статика собрана: $(ls -la "$SITE_ROOT/web/dist/index.html" | awk '{print $5" байт"}')"

# --- 10. nginx + TLS ----------------------------------------------------

step "10/10 — nginx vhost"

NGINX_AVAILABLE=/etc/nginx/sites-available/$DOMAIN
NGINX_ENABLED=/etc/nginx/sites-enabled/$DOMAIN

if [[ -f "$NGINX_AVAILABLE" ]]; then
  note "nginx-конфиг $NGINX_AVAILABLE уже существует — не трогаем."
else
  cat > "$NGINX_AVAILABLE" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN $WWW_DOMAIN;

  root $SITE_ROOT/web/dist;
  index index.html;

  gzip_static on;
  open_file_cache          max=2000 inactive=60s;
  open_file_cache_valid    60s;
  open_file_cache_min_uses 1;
  open_file_cache_errors   on;

  location ^~ /_astro/ {
    access_log off;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files \$uri =404;
  }
  location ^~ /fonts/ {
    access_log off;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files \$uri =404;
  }
  location ~* \.(?:svg|png|jpg|jpeg|webp|avif|ico|gif)\$ {
    access_log off;
    add_header Cache-Control "public, max-age=2592000" always;
    try_files \$uri =404;
  }
  location ~* \.xml\$ {
    add_header Cache-Control "public, max-age=3600" always;
    try_files \$uri =404;
  }
  location / {
    add_header Cache-Control "public, max-age=60, stale-while-revalidate=600";
    try_files \$uri \$uri/ \$uri.html =404;
  }
}

server {
  listen 80;
  listen [::]:80;
  server_name $ADMIN_DOMAIN;

  client_max_body_size 100m;

  location /api/analytics/ {
    proxy_pass http://127.0.0.1:$ANALYTICS_PORT/;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Real-IP \$remote_addr;
  }

  location = /favicon.ico {
    alias $SITE_ROOT/web/dist/favicon-32.png;
    expires 30d;
    add_header Cache-Control "public, max-age=2592000";
    access_log off;
  }

  location ~ ^/admin/content/[^/]+/+langs/[a-zA-Z-]+\.js\$ {
    default_type application/javascript;
    return 200 "export default {};";
    access_log off;
  }

  location / {
    proxy_pass http://127.0.0.1:$DIRECTUS_PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_buffering off;
  }
}
EOF
  ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  nginx -t && systemctl reload nginx
  green "+ nginx vhost установлен и перезагружен"
fi

# --- summary -----------------------------------------------------------

cat <<EOF

╭──────────────────────────────────────────────────────────────────────╮
│  ✔ keltus.ru установлен                                              │
╰──────────────────────────────────────────────────────────────────────╯

Сервисы:
  systemctl status keltus-ru-cms       — Directus на :$DIRECTUS_PORT
  systemctl status keltus-ru-rebuild   — rebuild-листенер на :$REBUILD_PORT
  systemctl status keltus-ru-analytics — Go-аналитика (после сборки бинарника)

Сайт:
  http://$DOMAIN/       → статика из $SITE_ROOT/web/dist
  http://$ADMIN_DOMAIN/ → Directus админка
  Логин админки:        $ADMIN_EMAIL
  Пароль админки:       $ADMIN_PASSWORD
  (все секреты сохранены в $SECRETS_DIR/secrets.env)

Что осталось сделать руками:
  1) Указать DNS A-записи domain → этот сервер:
        $DOMAIN
        $WWW_DOMAIN
        $ADMIN_DOMAIN
  2) Когда DNS поднимется, получить HTTPS-сертификаты:
        certbot --nginx -d $DOMAIN -d $WWW_DOMAIN -d $ADMIN_DOMAIN
  3) Собрать Go-сервис аналитики и запустить юнит:
        cd $SITE_ROOT/analytics && go build -o keltusanalytics ./cmd/keltusanalytics
        systemctl enable --now keltus-ru-analytics
  4) (Опционально) заполнить SMTP/Brevo в $SITE_ROOT/cms/.env и
     systemctl restart keltus-ru-cms — иначе контактная форма не отправит письмо.
  5) (Опционально) заполнить CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID
     в $SITE_ROOT/.deploy-secrets и перезапустить keltus-ru-rebuild —
     иначе кэш CDN придётся сбрасывать вручную после изменений в админке.

EOF
