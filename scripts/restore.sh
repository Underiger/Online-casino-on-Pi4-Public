#!/usr/bin/env bash
# ============================================================
# restore.sh — PostgreSQL 資料庫還原（互動式）
#
# 功能：
#   - 列出可用的備份檔案供選擇
#   - 互動式確認（需輸入 "yes" 才執行）
#   - 還原前自動 DROP 並重建目標資料庫
#   - 支援直接指定備份檔案（非互動模式）
#
# 用法：
#   bash scripts/restore.sh                             # 互動式選擇
#   bash scripts/restore.sh backups/backup_20260614_030000.sql.gz  # 指定檔案
#
# ⚠  警告：此操作會覆蓋目前資料庫，不可逆！請先確認有最新備份！
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ROOT_DIR}/.env.production"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"

# ── 彩色輸出 ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}[restore]${NC} $*"; }
warning() { echo -e "${YELLOW}[restore]${NC} $*"; }
error()   { echo -e "${RED}[restore]${NC} $*" >&2; exit 1; }

cd "$ROOT_DIR"

# ── 讀取環境變數 ──────────────────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || error ".env.production 不存在"
set +a; source <(grep -v '^#' "$ENV_FILE" | grep -v '^$'); set -a

POSTGRES_USER="${POSTGRES_USER:-casino}"
POSTGRES_DB="${POSTGRES_DB:-casino_prod}"
CONTAINER="${POSTGRES_CONTAINER:-casino-postgres}"

# ── 選擇備份檔案 ──────────────────────────────────────────────────────────────
BACKUP_FILE=""

if [[ $# -ge 1 ]]; then
  # 直接傳入路徑
  BACKUP_FILE="$1"
  [[ -f "$BACKUP_FILE" ]] || error "備份檔案不存在：$BACKUP_FILE"
else
  # 互動式：列出備份清單
  mapfile -t BACKUPS < <(find "${BACKUP_DIR}" -maxdepth 1 -name "backup_*.sql.gz" \
                            2>/dev/null | sort -r)

  if [[ ${#BACKUPS[@]} -eq 0 ]]; then
    error "在 ${BACKUP_DIR} 找不到任何備份（backup_*.sql.gz）"
  fi

  echo ""
  warning "=== 可用備份清單（最新優先）==="
  for i in "${!BACKUPS[@]}"; do
    SIZE="$(du -h "${BACKUPS[$i]}" | cut -f1)"
    MTIME="$(date -r "${BACKUPS[$i]}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || stat -c '%y' "${BACKUPS[$i]}" | cut -d. -f1)"
    printf "  [%d] %s  (%s, %s)\n" "$((i+1))" "$(basename "${BACKUPS[$i]}")" "$SIZE" "$MTIME"
  done
  echo ""

  read -rp "請輸入編號（1–${#BACKUPS[@]}），或按 Enter 取消：" CHOICE
  [[ -z "$CHOICE" ]] && { info "取消。"; exit 0; }
  [[ "$CHOICE" =~ ^[0-9]+$ ]] && [[ "$CHOICE" -ge 1 ]] && [[ "$CHOICE" -le "${#BACKUPS[@]}" ]] \
    || error "無效選擇：$CHOICE"
  BACKUP_FILE="${BACKUPS[$((CHOICE-1))]}"
fi

# ── 驗證備份檔案 ──────────────────────────────────────────────────────────────
info "選擇的備份：$BACKUP_FILE"
gzip -t "$BACKUP_FILE" || error "備份檔案 gzip 損毀，中止"
BACKUP_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
info "檔案大小：$BACKUP_SIZE"

# ── 確認 postgres 容器運行中 ────────────────────────────────────────────────
docker ps --filter "name=${CONTAINER}" --filter "status=running" | grep -q "${CONTAINER}" \
  || error "容器 ${CONTAINER} 未運行，請先啟動 postgres"

# ── ⚠ 互動式確認 ──────────────────────────────────────────────────────────────
echo ""
warning "================================================================="
warning " ⚠  警告：此操作將覆蓋資料庫 ${POSTGRES_DB}！"
warning "    所有現有資料將被刪除並以選擇的備份取代。"
warning "    此動作不可逆。"
warning "================================================================="
echo ""
read -rp "確認還原？請輸入「yes」繼續（其他輸入取消）：" CONFIRM
[[ "$CONFIRM" == "yes" ]] || { info "取消。"; exit 0; }

# ── 停止 app 服務（避免 DB 連線干擾）─────────────────────────────────────────
info "停止 app 服務..."
docker compose -f "${ROOT_DIR}/docker-compose.arm64.yml" \
  --env-file "$ENV_FILE" \
  stop app nginx 2>/dev/null || true

# ── 重建資料庫 ─────────────────────────────────────────────────────────────────
info "重建資料庫 ${POSTGRES_DB}..."
docker exec "${CONTAINER}" \
  psql -U "${POSTGRES_USER}" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  2>/dev/null || true

docker exec "${CONTAINER}" \
  psql -U "${POSTGRES_USER}" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";" \
  -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";" \
  || error "重建資料庫失敗"

# ── 還原資料 ────────────────────────────────────────────────────────────────
info "還原資料中（可能需要數分鐘）..."
gunzip -c "${BACKUP_FILE}" | \
  docker exec -i "${CONTAINER}" \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -q \
  || error "資料還原失敗"

info "=== 還原完成 ==="
info "資料庫：${POSTGRES_DB}"
info "來源：$(basename "${BACKUP_FILE}")"

# ── 重啟 app 服務 ──────────────────────────────────────────────────────────────
echo ""
read -rp "是否重新啟動 app 與 nginx 服務？[y/N] " RESTART
if [[ "$RESTART" =~ ^[Yy]$ ]]; then
  docker compose -f "${ROOT_DIR}/docker-compose.arm64.yml" \
    --env-file "$ENV_FILE" \
    up -d app nginx
  info "服務已重啟。"
else
  warning "請手動執行：bash scripts/deploy.sh"
fi
