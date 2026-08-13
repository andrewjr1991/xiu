#!/usr/bin/env bash
set -Eeuo pipefail

PROGRAM="$(basename "$0")"
INSTALL_DIR="/opt/xiu-searxng"
DOMAIN=""
LOCAL_PORT="8080"
ASSUME_YES="false"

usage() {
  cat <<'EOF'
为 Xiu 安装私有 SearXNG（Docker Compose + Valkey）。

用法：
  sudo bash install-searxng-vps.sh --domain search.example.com

选项：
  --domain DOMAIN       必填，已经解析到 VPS 的 HTTPS 域名
  --install-dir PATH    安装目录，默认 /opt/xiu-searxng
  --port PORT           本机监听端口，默认 8080
  --yes                 跳过覆盖确认；已有配置仍会先备份
  --help                显示帮助

脚本不会修改宝塔/Nginx，也不会占用公网 80/443 端口。完成后会生成：
  bt-nginx-searxng.conf  宝塔反向代理配置
  xiu-client.txt         Xiu 客户端配置说明（包含随机 Token，请妥善保管）
EOF
}

die() {
  printf '\n错误：%s\n' "$*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      [[ $# -ge 2 ]] || die "--domain 缺少参数"
      DOMAIN="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || die "--install-dir 缺少参数"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port 缺少参数"
      LOCAL_PORT="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1（使用 --help 查看帮助）"
      ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "请使用 root 运行：sudo bash $PROGRAM --domain search.example.com"
fi

if [[ -z "$DOMAIN" ]]; then
  read -r -p "请输入已解析到这台 VPS 的域名（例如 search.example.com）：" DOMAIN
fi
DOMAIN="${DOMAIN,,}"
DOMAIN="${DOMAIN%.}"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
  || die "域名格式无效：$DOMAIN"
[[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] || die "端口必须是整数"
(( LOCAL_PORT >= 1024 && LOCAL_PORT <= 65535 )) || die "端口必须在 1024 到 65535 之间"
[[ "$INSTALL_DIR" = /* ]] || die "安装目录必须是绝对路径"
[[ "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != "/opt" ]] || die "安装目录过于宽泛"

command_exists docker || die "未检测到 Docker。请先在宝塔的 Docker 页面安装 Docker，然后重新运行本脚本。"
docker info >/dev/null 2>&1 || die "Docker 服务未运行。请先在宝塔启动 Docker，或执行 systemctl start docker。"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command_exists docker-compose && docker-compose version >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "未检测到 Docker Compose。请在宝塔 Docker 页面安装 Compose 插件后重试。"
fi

command_exists curl || die "缺少 curl，请先安装：yum install -y curl 或 apt-get install -y curl"
command_exists openssl || die "缺少 openssl，请先安装：yum install -y openssl 或 apt-get install -y openssl"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" == "centos" && "${VERSION_ID%%.*}" == "7" ]]; then
    printf '\n警告：CentOS 7 已停止主流安全维护，只建议临时测试；正式服务请迁移到受支持的系统。\n'
  fi
fi

if command_exists ss && ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)$LOCAL_PORT$"; then
  if ! docker ps --format '{{.Names}}' | grep -Fxq 'xiu-searxng'; then
    die "本机端口 $LOCAL_PORT 已被其他程序占用。可用 --port 8081 指定其他端口。"
  fi
fi

if [[ -e "$INSTALL_DIR/docker-compose.yml" || -e "$INSTALL_DIR/config/settings.yml" ]]; then
  if [[ "$ASSUME_YES" != "true" ]]; then
    read -r -p "检测到已有配置。脚本会先备份再更新，是否继续？[y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "用户取消"
  fi
  BACKUP_DIR="${INSTALL_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
  info "备份已有配置到 $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  for item in docker-compose.yml config bt-nginx-searxng.conf xiu-client.txt searxng.env; do
    [[ -e "$INSTALL_DIR/$item" ]] && cp -a "$INSTALL_DIR/$item" "$BACKUP_DIR/"
  done
fi

mkdir -p "$INSTALL_DIR/config" "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR"

SECRET_KEY="$(openssl rand -hex 32)"
BEARER_TOKEN="$(openssl rand -hex 32)"

cat >"$INSTALL_DIR/docker-compose.yml" <<EOF
services:
  valkey:
    image: docker.io/valkey/valkey:8-alpine
    container_name: xiu-searxng-valkey
    restart: unless-stopped
    command: valkey-server --save 30 1 --loglevel warning
    volumes:
      - valkey-data:/data
    mem_limit: 192m
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"

  searxng:
    image: docker.io/searxng/searxng:latest
    container_name: xiu-searxng
    restart: unless-stopped
    depends_on:
      - valkey
    ports:
      - "127.0.0.1:${LOCAL_PORT}:8080"
    volumes:
      - ./config:/etc/searxng:rw
      - ./data:/var/cache/searxng:rw
    environment:
      SEARXNG_BASE_URL: "https://${DOMAIN}/"
      SEARXNG_SECRET: "${SECRET_KEY}"
      SEARXNG_VALKEY_URL: "valkey://valkey:6379/0"
      FORCE_OWNERSHIP: "true"
    mem_limit: 768m
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"

volumes:
  valkey-data:
EOF

cat >"$INSTALL_DIR/config/settings.yml" <<EOF
use_default_settings: true

general:
  debug: false
  instance_name: "Xiu Search"

search:
  safe_search: 1
  autocomplete: ""
  formats:
    - html
    - json

server:
  secret_key: "${SECRET_KEY}"
  # 此实例由 Nginx Bearer Token 保护，作为私有 API 使用。
  # SearXNG limiter 会按 User-Agent 拦截 Xiu/curl 等自动客户端，因此关闭。
  limiter: false
  public_instance: false
  image_proxy: false

valkey:
  url: valkey://valkey:6379/0
EOF

cat >"$INSTALL_DIR/searxng.env" <<EOF
SEARXNG_DOMAIN=${DOMAIN}
SEARXNG_LOCAL_PORT=${LOCAL_PORT}
XIU_SEARXNG_TOKEN=${BEARER_TOKEN}
EOF
chmod 600 "$INSTALL_DIR/searxng.env" "$INSTALL_DIR/config/settings.yml"

cat >"$INSTALL_DIR/bt-nginx-searxng.conf" <<EOF
# 将这段配置放入宝塔站点 ${DOMAIN} 的配置文件中，并先为域名申请 SSL。
location / {
    if (\$http_authorization != "Bearer ${BEARER_TOKEN}") {
        return 401;
    }

    proxy_pass http://127.0.0.1:${LOCAL_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 60s;
}
EOF
chmod 600 "$INSTALL_DIR/bt-nginx-searxng.conf"

cat >"$INSTALL_DIR/xiu-client.txt" <<EOF
SearXNG 地址：https://${DOMAIN}
Bearer Token 环境变量名：XIU_SEARXNG_TOKEN
Bearer Token：${BEARER_TOKEN}

Windows PowerShell 当前窗口：
  \$env:XIU_SEARXNG_TOKEN = '${BEARER_TOKEN}'

Windows 永久保存（执行后重新打开终端）：
  setx XIU_SEARXNG_TOKEN "${BEARER_TOKEN}"

Xiu 中执行：
  /web configure searxng

配置时填写：
  HTTPS 端点：https://${DOMAIN}
  Bearer Token 环境变量名：XIU_SEARXNG_TOKEN
EOF
chmod 600 "$INSTALL_DIR/xiu-client.txt"

info "拉取并启动 SearXNG"
cd "$INSTALL_DIR"
"${COMPOSE[@]}" pull
"${COMPOSE[@]}" up -d

info "等待 SearXNG 健康检查就绪"
READY="false"
for attempt in $(seq 1 45); do
  if [[ "$(curl --silent --fail --max-time 3 \
    "http://127.0.0.1:${LOCAL_PORT}/healthz" 2>/dev/null || true)" == "OK" ]]; then
    READY="true"
    break
  fi
  sleep 2
done

if [[ "$READY" != "true" ]]; then
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail=80 searxng || true
  die "SearXNG 在 90 秒内未通过健康检查。上方日志可用于排查；配置和容器均已保留。"
fi

info "服务已就绪，执行一次 JSON 搜索接口检查"
SEARCH_RESPONSE=""
if SEARCH_RESPONSE="$(curl --silent --show-error --fail --max-time 20 \
  --header 'User-Agent: Mozilla/5.0 (compatible; XiuSearchSetup/1.0)' \
  --header 'Accept: application/json' \
  --get \
  --data-urlencode 'q=xiu' \
  --data-urlencode 'format=json' \
  "http://127.0.0.1:${LOCAL_PORT}/search" 2>/dev/null)" \
  && grep -q '"results"' <<<"$SEARCH_RESPONSE"; then
  info "本机 JSON 搜索接口检查通过"
else
  warn "SearXNG 已健康运行，但真实搜索被上游引擎临时拒绝。安装将继续；完成 HTTPS 反向代理后再做公网搜索验收。"
fi

cat <<EOF

============================================================
SearXNG 本机服务安装成功
============================================================

安装目录：$INSTALL_DIR
本机接口：http://127.0.0.1:${LOCAL_PORT}

还需要在宝塔完成 3 步：
  1. 新建网站：${DOMAIN}
  2. 为该网站申请 Let's Encrypt SSL，并开启强制 HTTPS
  3. 将以下文件内容粘贴到该网站的 Nginx 配置：
     ${INSTALL_DIR}/bt-nginx-searxng.conf

Xiu 客户端 Token 和配置说明：
  ${INSTALL_DIR}/xiu-client.txt

查看配置：
  cat ${INSTALL_DIR}/xiu-client.txt

查看服务：
  cd ${INSTALL_DIR} && ${COMPOSE[*]} ps

查看日志：
  cd ${INSTALL_DIR} && ${COMPOSE[*]} logs --tail=100 searxng

注意：xiu-client.txt 和 searxng.env 含密钥，不要公开或上传。
EOF
