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
#   6. 執行 Prisma migration（依賴 postgres 健康）
#   7. 滾動重啟服務（up -d --build）
#
# 用法（專案根目錄執行）：
#   bash scripts/deploy.sh
#
# 環境前置：
#   cp .env.example .env.production
#   nano .env.production          # 至少設定 NODE_ENV=production + 所有機密值
#   bash scripts/gen-secrets.sh   # 若 .env.production 中有 change_me 值
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

# 檢查關鍵機密是否仍為 change_me
if grep -q "change_me" "$ENV_FILE"; then
  error ".env.production 中仍有 change_me 佔位值，請先執行：bash scripts/gen-secrets.sh"
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
  app

# ── 6. 資料庫 Migration ───────────────────────────────────────────────────────
info "[6/7] 執行 Prisma migration..."

# 先確保 postgres 啟動
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres redis
info "  等待 PostgreSQL 健康檢查..."
timeout 60 bash -c "
  until docker compose --env-file '$ENV_FILE' -f '$COMPOSE_FILE' exec postgres \
    pg_isready -q 2>/dev/null; do
    sleep 2
  done
"

# 使用 migrate 服務（deps build stage，含 prisma CLI）
docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  --profile migrate \
  run --rm migrate

info "  Migration 完成"

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
