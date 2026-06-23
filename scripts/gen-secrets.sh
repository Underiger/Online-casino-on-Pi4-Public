#!/usr/bin/env bash
# ============================================================
# gen-secrets.sh — 產生 JWT_SECRET / AES_256_GCM_KEY / Admin 初始密碼
# 並寫入指定的 env 檔（預設 .env；已存在的非 change_me 值不會被覆蓋）。
#
# 用法（repo 根目錄執行）：
#   cp .env.example .env             # 開發環境，若尚未建立
#   bash scripts/gen-secrets.sh
#
#   cp .env.example .env.production  # 生產環境
#   bash scripts/gen-secrets.sh .env.production
#
# 依賴：openssl（macOS / Linux / Git Bash / WSL 皆內建）
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "找不到 $ENV_FILE，先從範本複製..."
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
fi

# set_secret <KEY> <VALUE>
# 僅在該變數不存在、為空或仍是 change_me 時寫入，避免覆蓋手動設定的值。
set_secret() {
  local key="$1"
  local value="$2"
  local current
  current="$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"

  if [[ -n "$current" && "$current" != "change_me" ]]; then
    echo "  - ${key}: 已有自訂值，略過"
    return
  fi

  if grep -qE "^${key}=" "$ENV_FILE"; then
    # 以 | 為分隔符避免值中的 / 衝突；產生的值僅含 hex 與 A-Za-z0-9，安全
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  echo "  - ${key}: 已產生並寫入"
}

echo "產生機密並寫入 $ENV_FILE ..."

# JWT HS256 簽章金鑰：64 bytes -> 128 hex chars
set_secret "JWT_SECRET" "$(openssl rand -hex 64)"

# AES-256-GCM 金鑰：恰 32 bytes -> 64 hex chars（TOTP secret 加密用）
set_secret "AES_256_GCM_KEY" "$(openssl rand -hex 32)"

# Redis AUTH 密碼：32 bytes -> 64 hex chars（縱深防禦，防止 Redis 暴露時被未授權存取）。
# 生產 docker-compose.arm64.yml 的 redis 以 --requirepass 強制認證；密碼須同時出現在
# REDIS_URL 才能讓 app/BullMQ/socket.io adapter 連得上。僅在 REDIS_URL 指向生產服務
# （hostname=redis）時自動注入；dev 的 localhost 維持無認證、保留本機開發便利。
REDIS_PASS_CURRENT="$(grep -E '^REDIS_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
if [[ -z "$REDIS_PASS_CURRENT" || "$REDIS_PASS_CURRENT" == "change_me" ]]; then
  REDIS_PASS="$(openssl rand -hex 32)"
  set_secret "REDIS_PASSWORD" "$REDIS_PASS"
  REDIS_URL_CURRENT="$(grep -E '^REDIS_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  if [[ "$REDIS_URL_CURRENT" == redis://redis:* || "$REDIS_URL_CURRENT" == "redis://redis" ]]; then
    # 強制改寫（不可用 set_secret——其遇非 change_me 值會略過）。hex 密碼不含 | / @，sed/URL 皆安全。
    sed -i.bak "s|^REDIS_URL=.*|REDIS_URL=redis://:${REDIS_PASS}@redis:6379|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    echo "  - REDIS_URL: 已注入 Redis 密碼（生產服務 hostname=redis）"
  fi
else
  echo "  - REDIS_PASSWORD: 已有自訂值，略過（請自行確認 REDIS_URL 一致）"
fi

# Admin 初始密碼：24 字元 base64url（去除易混淆符號）
set_secret "ADMIN_INITIAL_PASSWORD" "$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"

# 開發資料庫密碼（docker-compose 與 DATABASE_URL 需一致，僅在仍為 change_me 時帶入）
PG_PASS_CURRENT="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
if [[ -z "$PG_PASS_CURRENT" || "$PG_PASS_CURRENT" == "change_me" ]]; then
  PG_PASS="$(openssl rand -hex 16)"
  set_secret "POSTGRES_PASSWORD" "$PG_PASS"
  PG_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
  PG_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
  PG_PORT="$(grep -E '^POSTGRES_PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
  set_secret "DATABASE_URL" "postgresql://${PG_USER:-casino}:${PG_PASS}@localhost:${PG_PORT:-5432}/${PG_DB:-casino_dev}?schema=public"
else
  echo "  - POSTGRES_PASSWORD: 已有自訂值，略過（請自行確認 DATABASE_URL 一致）"
fi

echo "完成。請確認 .env 內容後執行：docker compose up -d"
