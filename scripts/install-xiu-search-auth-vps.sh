#!/usr/bin/env bash
set -Eeuo pipefail

PROGRAM="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/xiu-search-auth"
INSTALL_DIR="/opt/xiu-search-auth"
SEARXNG_DIR="/opt/xiu-searxng"
DOMAIN="search.jingran.vip"
SEARXNG_PORT="8080"
AUTH_PORT="8787"
TRUSTED_CIDRS=""
ASSUME_YES="false"

usage() {
  cat <<'EOF'
为现有 Xiu SearXNG 安装设备注册与短期 Token 网关。

用法：
  sudo bash install-xiu-search-auth-vps.sh --domain search.jingran.vip

选项：
  --domain DOMAIN          SearXNG HTTPS 域名，默认 search.jingran.vip
  --searxng-port PORT      SearXNG 本机端口，默认 8080
  --auth-port PORT         授权服务本机端口，默认 8787
  --trusted-cidrs CIDRS    允许免邀请码注册的公司出口 IP/CIDR，逗号分隔
  --install-dir PATH       授权服务目录，默认 /opt/xiu-search-auth
  --searxng-dir PATH       现有 SearXNG 目录，默认 /opt/xiu-searxng
  --source-dir PATH        server.py 与 Dockerfile 所在目录
  --yes                    跳过覆盖确认；仍会先备份
  --help                   显示帮助

脚本不会直接修改宝塔 Nginx。它会生成 bt-nginx-xiu-search.conf，
验收服务后再用该文件替换站点中原有的 location / 区块。
EOF
}

die() { printf '\n错误：%s\n' "$*" >&2; exit 1; }
info() { printf '\n==> %s\n' "$*"; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain 缺少参数}"; shift 2 ;;
    --searxng-port) SEARXNG_PORT="${2:?--searxng-port 缺少参数}"; shift 2 ;;
    --auth-port) AUTH_PORT="${2:?--auth-port 缺少参数}"; shift 2 ;;
    --trusted-cidrs) TRUSTED_CIDRS="${2:?--trusted-cidrs 缺少参数}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?--install-dir 缺少参数}"; shift 2 ;;
    --searxng-dir) SEARXNG_DIR="${2:?--searxng-dir 缺少参数}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?--source-dir 缺少参数}"; shift 2 ;;
    --yes) ASSUME_YES="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知参数：$1（使用 --help 查看帮助）" ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "请使用 root 运行本脚本"
DOMAIN="${DOMAIN,,}"; DOMAIN="${DOMAIN%.}"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "域名无效：$DOMAIN"
for port in "$SEARXNG_PORT" "$AUTH_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || die "端口无效：$port"
done
[[ "$SEARXNG_PORT" != "$AUTH_PORT" ]] || die "SearXNG 与授权服务不能使用同一端口"
for directory in "$INSTALL_DIR" "$SEARXNG_DIR" "$SOURCE_DIR"; do
  [[ "$directory" = /* ]] || die "目录必须是绝对路径：$directory"
done
[[ -f "$SOURCE_DIR/server.py" && -f "$SOURCE_DIR/Dockerfile" ]] || die "缺少服务端文件：$SOURCE_DIR/server.py 或 Dockerfile"

command_exists docker || die "未检测到 Docker，请先在宝塔安装并启动 Docker"
docker info >/dev/null 2>&1 || die "Docker 服务未运行"
command_exists openssl || die "缺少 openssl"
command_exists curl || die "缺少 curl"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command_exists docker-compose; then
  COMPOSE=(docker-compose)
else
  die "未检测到 Docker Compose"
fi

if [[ -e "$INSTALL_DIR/docker-compose.yml" ]]; then
  if [[ "$ASSUME_YES" != "true" ]]; then
    read -r -p "检测到已有授权服务。将先备份再升级，是否继续？[y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "用户取消"
  fi
  BACKUP_DIR="${INSTALL_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
  info "备份到 $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  for item in docker-compose.yml auth.env bt-nginx-xiu-search.conf admin.txt app; do
    [[ -e "$INSTALL_DIR/$item" ]] && cp -a "$INSTALL_DIR/$item" "$BACKUP_DIR/"
  done
fi

mkdir -p "$INSTALL_DIR/app" "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR" "$INSTALL_DIR/data"
chown 10001:10001 "$INSTALL_DIR/data"
cp "$SOURCE_DIR/server.py" "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR/.dockerignore" "$INSTALL_DIR/app/"

existing_value() {
  local key="$1"
  [[ -f "$INSTALL_DIR/auth.env" ]] || return 0
  sed -n "s/^${key}=//p" "$INSTALL_DIR/auth.env" | head -n 1
}

JWT_SECRET="$(existing_value XIU_AUTH_JWT_SECRET)"
ADMIN_TOKEN="$(existing_value XIU_AUTH_ADMIN_TOKEN)"
ENROLLMENT_CODE="$(existing_value XIU_AUTH_ENROLLMENT_CODE)"
[[ -n "$JWT_SECRET" ]] || JWT_SECRET="$(openssl rand -hex 48)"
[[ -n "$ADMIN_TOKEN" ]] || ADMIN_TOKEN="$(openssl rand -hex 32)"
[[ -n "$ENROLLMENT_CODE" ]] || ENROLLMENT_CODE="$(openssl rand -hex 16)"

LEGACY_TOKEN_HASH=""
if [[ -r "$SEARXNG_DIR/searxng.env" ]]; then
  LEGACY_TOKEN="$(sed -n 's/^XIU_SEARXNG_TOKEN=//p' "$SEARXNG_DIR/searxng.env" | head -n 1)"
  if [[ -n "$LEGACY_TOKEN" ]]; then
    LEGACY_TOKEN_HASH="$(printf '%s' "$LEGACY_TOKEN" | openssl dgst -sha256 -r | awk '{print $1}')"
  fi
fi

cat >"$INSTALL_DIR/auth.env" <<EOF
XIU_AUTH_ISSUER=https://${DOMAIN}/xiu-auth
XIU_AUTH_JWT_SECRET=${JWT_SECRET}
XIU_AUTH_ADMIN_TOKEN=${ADMIN_TOKEN}
XIU_AUTH_ENROLLMENT_CODE=${ENROLLMENT_CODE}
XIU_AUTH_LEGACY_TOKEN_SHA256=${LEGACY_TOKEN_HASH}
XIU_AUTH_TRUSTED_REGISTER_CIDRS=${TRUSTED_CIDRS}
XIU_AUTH_TOKEN_TTL_SECONDS=900
XIU_AUTH_REQUESTS_PER_MINUTE=20
XIU_AUTH_REQUESTS_PER_IP_PER_MINUTE=60
XIU_AUTH_PUBLIC_REGISTRATION=true
XIU_AUTH_REGISTRATIONS_PER_IP_PER_DAY=5
XIU_AUTH_DATABASE=/data/xiu-search-auth.sqlite3
XIU_AUTH_HOST=127.0.0.1
XIU_AUTH_PORT=8787
XIU_AUTH_UPSTREAM_URL=http://127.0.0.1:${SEARXNG_PORT}
XIU_AUTH_UPSTREAM_TIMEOUT_SECONDS=60
EOF
chmod 600 "$INSTALL_DIR/auth.env"

cat >"$INSTALL_DIR/docker-compose.yml" <<EOF
services:
  auth:
    build:
      context: ./app
    container_name: xiu-search-auth
    restart: unless-stopped
    env_file:
      - ./auth.env
    network_mode: host
    volumes:
      - xiu-search-auth-data:/data
    mem_limit: 128m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=16m,noexec,nosuid,nodev
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"

volumes:
  xiu-search-auth-data:
    name: xiu-search-auth-data
EOF

cat >"$INSTALL_DIR/bt-nginx-xiu-search.conf" <<EOF
# 用本文件中的 location 区块替换宝塔站点 ${DOMAIN} 原来的 location /。
# 不要保留旧的 location /，否则 Nginx 会报重复 location。

location = /xiu-auth/healthz {
    proxy_pass http://127.0.0.1:${AUTH_PORT}/healthz;
    proxy_set_header Host \$host;
}

location = /xiu-auth/v1/devices/register {
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:${AUTH_PORT}/v1/devices/register;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
}

location = /xiu-auth/v1/tokens {
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:${AUTH_PORT}/v1/tokens;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
}

location = /xiu-auth/v1/devices {
    proxy_pass http://127.0.0.1:${AUTH_PORT}/v1/devices;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header Authorization \$http_authorization;
}

location / {
    proxy_pass http://127.0.0.1:${AUTH_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Authorization \$http_authorization;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 60s;
}
EOF
chmod 600 "$INSTALL_DIR/bt-nginx-xiu-search.conf"

cat >"$INSTALL_DIR/admin.txt" <<EOF
域名：https://${DOMAIN}
设备注册网址：https://${DOMAIN}/xiu-auth/v1/devices/register
短期 Token 网址：https://${DOMAIN}/xiu-auth/v1/tokens
邀请码：${ENROLLMENT_CODE}
管理 Token：${ADMIN_TOKEN}
免邀请码注册 CIDR：${TRUSTED_CIDRS:-未配置}
旧 Token 兼容：$([[ -n "$LEGACY_TOKEN_HASH" ]] && printf '已启用' || printf '未启用')

查看设备（仅在 VPS 执行）：
  curl -sS -H 'Authorization: Bearer ${ADMIN_TOKEN}' http://127.0.0.1:${AUTH_PORT}/v1/admin/devices

撤销设备（替换 DEVICE_ID，仅在 VPS 执行）：
  curl -sS -X POST -H 'Authorization: Bearer ${ADMIN_TOKEN}' http://127.0.0.1:${AUTH_PORT}/v1/admin/devices/DEVICE_ID/revoke
EOF
chmod 600 "$INSTALL_DIR/admin.txt"

info "构建并启动授权服务"
cd "$INSTALL_DIR"
"${COMPOSE[@]}" build auth
info "初始化 Docker 数据卷权限"
"${COMPOSE[@]}" run --rm --no-deps --user 0 --entrypoint sh auth -c \
  'chown -R 10001:10001 /data && chmod 700 /data'
"${COMPOSE[@]}" up -d

info "等待健康检查"
READY="false"
for _ in $(seq 1 30); do
  if curl --silent --fail --max-time 3 "http://127.0.0.1:${AUTH_PORT}/healthz" | grep -q '"status":"ok"'; then
    READY="true"
    break
  fi
  sleep 2
done
if [[ "$READY" != "true" ]]; then
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail=100 auth || true
  die "授权服务未能在 60 秒内启动"
fi

cat <<EOF

============================================================
Xiu Search 短期 Token 服务安装成功
============================================================

下一步：
  1. 在宝塔站点配置中，删除原有 location / 区块。
  2. 粘贴以下文件中的全部 location 配置：
     ${INSTALL_DIR}/bt-nginx-xiu-search.conf
  3. 保存宝塔配置后访问：
     https://${DOMAIN}/xiu-auth/healthz

邀请码和本机管理命令保存在：
  ${INSTALL_DIR}/admin.txt

注意：auth.env 和 admin.txt 含敏感信息，权限已设为 600，不要上传或公开。
旧 SearXNG Token 已转换为不可逆 SHA-256 摘要继续兼容，正文没有复制到授权服务。
EOF
