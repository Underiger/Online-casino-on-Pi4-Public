#!/usr/bin/env bash
# ============================================================
# deploy.sh — 生產部署腳本（Raspberry Pi 4 / arm64）
#
# 執行順序：
#   1. 環境檢查（.env.production、TLS 憑證）
#   2. 拉取最新程式碼（git pull）
#   3. 安裝依賴（npm install）
#   4. 建置前端 dist（frontend + admin-frontend）
#   5. 拉取/建置 Docker 映像
#   6. 執行 Prisma migration + seed（依賴 postgres 健康；seed 為 upsert，可重複執行）
#   7. 滾動重啟服務（up -d --build）
#
# 用法（專案根目錄執行）：
#   bash scripts/deploy.sh
#
# 環境前置：
#   cp .env.example .env.production
#   nano .env.production          # 至少設定 NODE_ENV=production + 所有機密值
#   bash scripts/gen-secrets.sh .env.production   # 若 .env.production 中有 change_me 值
#   bash scripts/gen-cert.sh      # 首次部署：產生 TLS 憑證
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$ROOT_DIR/docker-compose.arm64.yml"
ENV_FILE="$ROOT_DIR/.env.production"

cd "$ROOT_DIR"

# ── 彩色輸出 ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}[deploy]${NC} $*"; }
warning() { echo -e "${YELLOW}[deploy]${NC} $*"; }
error()   { echo -e "${RED}[deploy]${NC} $*" >&2; exit 1; }

info "=== Virtual Casino Sandbox 生產部署開始 ==="
info "時間：$(date '+%Y-%m-%d %H:%M:%S')"
info "目錄：$ROOT_DIR"

# ── 1. 環境檢查 ───────────────────────────────────────────────────────────────
info "[1/7] 環境檢查..."

[[ -f "$ENV_FILE" ]] || error ".env.production 不存在！請先執行：cp .env.example .env.production"

# 檢查關鍵機密是否仍為 change_me（忽略註解行，避免範本說明文字誤判）
if grep -vE '^\s*#' "$ENV_FILE" | grep -q "change_me"; then
  error ".env.production 中仍有 change_me 佔位值，請先執行：bash scripts/gen-secrets.sh .env.production"
fi

# 檢查 TLS 憑證
CERT_DIR="$ROOT_DIR/nginx/certs"
if [[ ! -f "$CERT_DIR/server.crt" || ! -f "$CERT_DIR/server.key" ]]; then
  warning "TLS 憑證不存在，自動執行 gen-cert.sh..."
  bash "$SCRIPT_DIR/gen-cert.sh"
fi

# 確認 docker 與 docker compose 可用
command -v docker >/dev/null 2>&1 || error "docker 未安裝"
docker compose version >/dev/null 2>&1 || error "docker compose（v2）未安裝"

# ── 2. 拉取最新程式碼 ─────────────────────────────────────────────────────────
info "[2/7] 拉取最新程式碼（git pull）..."
if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$ROOT_DIR" pull --ff-only
  info "目前 commit：$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
else
  warning "不在 git 倉庫中，跳過 git pull"
fi

# ── 3. 安裝 Node.js 依賴 ─────────────────────────────────────────────────────
info "[3/7] 安裝/更新 Node.js 依賴（npm install）..."
npm install --prefer-offline

# ── 4. 建置前端 dist ──────────────────────────────────────────────────────────
info "[4/7] 建置前端 dist..."

# 設置 NODE_ENV=production 確保 Vite 生產模式 build
NODE_ENV=production npm run build --workspace=frontend
info "  玩家端 frontend/dist 建置完成"

NODE_ENV=production npm run build --workspace=admin-frontend
info "  管理後台 admin-frontend/dist 建置完成"

# 確認 dist 目錄存在
[[ -d "$ROOT_DIR/frontend/dist" ]]       || error "frontend/dist 不存在，build 可能失敗"
[[ -d "$ROOT_DIR/admin-frontend/dist" ]] || error "admin-frontend/dist 不存在，build 可能失敗"

# ── 5. 建置 Docker 映像 ────────────────────────────────────────────────────────
info "[5/7] 建置 Docker 映像（docker compose build）..."
docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  build \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  app migrate seed

# ── 6. 資料庫 Migration ───────────────────────────────────────────────────────
info "[6/7] 執行 Prisma migration..."

# 先啟動 redis（不阻塞 migrate；Prisma migration 僅依賴 postgres），再用 compose 原生
# healthcheck 等 postgres 變「健康」。改用 --wait 取代手寫 pg_isready 迴圈的理由：
#   1. 杜絕「容器 Up ≠ DB 就緒」競態：up -d 一見進程存在就回 Running，但 postgres 首次
#      initdb／崩潰復原期間 pg_isready 會回 rejecting connections，舊迴圈 60 秒窗口在 Pi4
#      build 後的 I/O 壓力下容易逾時誤判。--wait 直接採用容器自身 healthcheck（含 start_period）。
#   2. 不再用 2>/dev/null 吞掉真正的失敗原因，逾時即報錯。
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d redis
info "  等待 PostgreSQL 變健康（compose --wait，上限 120 秒）..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  up -d --wait --wait-timeout 120 postgres \
  || error "PostgreSQL 120 秒內未變健康，請執行 docker compose -f \"$COMPOSE_FILE\" logs postgres 檢查"

# 使用 migrate 服務（deps build stage，含 prisma CLI）
docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  --profile migrate \
  run --rm migrate

info "  Migration 完成"

# Seed 為 upsert，可重複執行；確保新增的種子資料（如護符池）每次部署都同步到生產環境
info "  執行 prisma db seed（upsert，安全可重複執行）..."
docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  --profile migrate \
  run --rm seed

info "  Seed 完成"

# ── 7. 滾動重啟全部服務 ────────────────────────────────────────────────────────
info "[7/7] 啟動/重啟全部服務..."
docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  up -d \
  --remove-orphans

info "=== 部署完成 ==="
info "服務狀態："
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

echo ""
info "健康檢查（等待 30 秒讓服務穩定）..."
sleep 30
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

echo ""
info "快速冒煙測試："
info "  HTTP  → $(curl -sI http://localhost/ | head -1)"
info "  HTTPS → $(curl -skI https://localhost/ | head -1)"
info "  API   → $(curl -sk https://localhost/api/ | head -c 80)"
