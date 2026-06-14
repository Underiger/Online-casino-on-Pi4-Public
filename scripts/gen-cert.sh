#!/usr/bin/env bash
# ============================================================
# gen-cert.sh — 產生自簽 TLS 憑證（測試 / 首次部署用）
#
# 產生位置：nginx/certs/server.key、nginx/certs/server.crt
# 有效期：10 年（供內網 / 樹莓派沙盒測試使用）
#
# ⚠  正式上線請改用 Let's Encrypt：
#   1. 安裝 certbot：sudo apt install certbot
#   2. 取得憑證（需域名 & 公開可訪的 80 port）：
#      sudo certbot certonly --standalone -d yourdomain.com
#   3. 憑證路徑（更新 nginx/conf.d/site.conf 的 ssl_certificate 指向）：
#      /etc/letsencrypt/live/yourdomain.com/fullchain.pem
#      /etc/letsencrypt/live/yourdomain.com/privkey.pem
#   4. 自動續期（certbot 已設定 systemd timer 或 crontab）：
#      sudo certbot renew --dry-run
#   5. 掛載到 nginx 容器（docker-compose.arm64.yml nginx.volumes 新增）：
#      - /etc/letsencrypt/live/yourdomain.com:/etc/nginx/certs:ro
#
# 用法（專案根目錄執行）：
#   bash scripts/gen-cert.sh
#   bash scripts/gen-cert.sh yourdomain.com    # 指定 Common Name
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CERT_DIR="${ROOT_DIR}/nginx/certs"
DOMAIN="${1:-localhost}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[gen-cert]${NC} $*"; }
warning() { echo -e "${YELLOW}[gen-cert]${NC} $*"; }

mkdir -p "$CERT_DIR"

KEY_FILE="${CERT_DIR}/server.key"
CRT_FILE="${CERT_DIR}/server.crt"

if [[ -f "$KEY_FILE" && -f "$CRT_FILE" ]]; then
  # 顯示現有憑證資訊
  info "現有憑證資訊："
  openssl x509 -noout -subject -enddate -in "$CRT_FILE" 2>/dev/null || true
  echo ""
  read -rp "憑證已存在，是否覆蓋？[y/N] " OVERWRITE
  [[ "$OVERWRITE" =~ ^[Yy]$ ]] || { info "保留現有憑證。"; exit 0; }
fi

info "產生自簽 TLS 憑證..."
info "Common Name：$DOMAIN"

# 使用 EC P-256（比 RSA 4096 更適合 Pi 4：速度快、金鑰小）
openssl req -x509 -newkey ec \
  -pkeyopt ec_paramgen_curve:P-256 \
  -keyout "$KEY_FILE" \
  -out "$CRT_FILE" \
  -days 3650 \
  -nodes \
  -subj "/C=TW/ST=Taiwan/L=Taipei/O=VirtualCasinoSandbox/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1"

# 設定適當的檔案權限（nginx 容器以 root 讀取，宿主機限制存取）
chmod 600 "$KEY_FILE"
chmod 644 "$CRT_FILE"

info "憑證產生完成："
info "  私鑰：$KEY_FILE"
info "  憑證：$CRT_FILE"
echo ""
info "憑證詳細資訊："
openssl x509 -noout -text -in "$CRT_FILE" | grep -E "(Subject:|Not (Before|After)|Public Key Algorithm|Subject Alternative Name)" | sed 's/^/  /'

echo ""
warning "⚠  此為自簽憑證，瀏覽器會顯示「不安全」警告。"
warning "   正式上線請依上方說明使用 Let's Encrypt 取得免費憑證。"
