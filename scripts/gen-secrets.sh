#!/usr/bin/env bash
# ============================================================
# gen-secrets.sh — 產生 JWT_SECRET / AES_256_GCM_KEY / Admin 初始密碼
# 並寫入專案根目錄的 .env（已存在的非 change_me 值不會被覆蓋）。
#
# 用法（repo 根目錄執行）：
#   cp .env.example .env   # 若尚未建立
#   bash scripts/gen-secrets.sh
#
# 依賴：openssl（macOS / Linux / Git Bash / WSL 皆內建）
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

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
