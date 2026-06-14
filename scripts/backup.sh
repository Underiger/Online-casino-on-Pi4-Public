#!/usr/bin/env bash
# ============================================================
# backup.sh — PostgreSQL 資料庫備份（生產環境 Pi 4）
#
# 功能：
#   - 使用 pg_dump 備份 casino_prod 資料庫
#   - 以 gzip 壓縮並附上時間戳命名（backup_YYYYMMDD_HHMMSS.sql.gz）
#   - 預設儲存至 ./backups/（可用 BACKUP_DIR 環境變數覆蓋）
#   - 自動刪除超過 7 天的舊備份（RETAIN_DAYS 可覆蓋）
#
# 用法：
#   bash scripts/backup.sh                  # 互動式
#   BACKUP_DIR=/mnt/usb/backups bash scripts/backup.sh  # 自訂目錄
#   RETAIN_DAYS=14 bash scripts/backup.sh   # 保留 14 天
#
# 建議加入 crontab（每日 03:00 備份）：
#   0 3 * * * /bin/bash /home/pi/casino/scripts/backup.sh >> /var/log/casino-backup.log 2>&1
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ROOT_DIR}/.env.production"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-7}"
TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
BACKUP_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.sql.gz"

# ── 彩色輸出 ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[backup]${NC} $*"; }
error() { echo -e "${RED}[backup]${NC} $*" >&2; exit 1; }

cd "$ROOT_DIR"

# ── 讀取環境變數 ──────────────────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || error ".env.production 不存在"
# shellcheck source=/dev/null
set +a; source <(grep -v '^#' "$ENV_FILE" | grep -v '^$'); set -a

POSTGRES_USER="${POSTGRES_USER:-casino}"
POSTGRES_DB="${POSTGRES_DB:-casino_prod}"
CONTAINER="${POSTGRES_CONTAINER:-casino-postgres}"

info "=== 資料庫備份開始 ==="
info "資料庫：${POSTGRES_DB}（使用者：${POSTGRES_USER}）"
info "容器：${CONTAINER}"
info "目的地：${BACKUP_FILE}"
info "保留天數：${RETAIN_DAYS} 天"

# ── 確認 postgres 容器運行中 ────────────────────────────────────────────────
docker ps --filter "name=${CONTAINER}" --filter "status=running" | grep -q "${CONTAINER}" \
  || error "容器 ${CONTAINER} 未運行，請先執行 deploy.sh"

# ── 建立備份目錄 ────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

# ── 執行備份 ─────────────────────────────────────────────────────────────────
info "開始 pg_dump..."
docker exec "${CONTAINER}" \
  pg_dump \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    --verbose \
    --no-password \
    --format=plain \
    --no-privileges \
    --no-owner \
  2>/tmp/pg_dump_err.log \
| gzip -9 > "${BACKUP_FILE}"

DUMP_EXIT_CODE="${PIPESTATUS[0]}"
if [[ "$DUMP_EXIT_CODE" -ne 0 ]]; then
  cat /tmp/pg_dump_err.log >&2
  rm -f "${BACKUP_FILE}"
  error "pg_dump 失敗（exit code: ${DUMP_EXIT_CODE}）"
fi

# ── 驗證備份檔案 ────────────────────────────────────────────────────────────
BACKUP_SIZE="$(du -h "${BACKUP_FILE}" | cut -f1)"
info "備份完成：${BACKUP_FILE}（${BACKUP_SIZE}）"

# 快速驗證 gzip 完整性
gzip -t "${BACKUP_FILE}" || error "備份檔案 gzip 損毀！"

# ── 刪除超過 RETAIN_DAYS 天的舊備份 ─────────────────────────────────────────
info "清理 ${RETAIN_DAYS} 天前的備份..."
DELETED=0
while IFS= read -r old_file; do
  rm -f "$old_file"
  info "  已刪除：$(basename "$old_file")"
  DELETED=$((DELETED + 1))
done < <(find "${BACKUP_DIR}" -maxdepth 1 -name "backup_*.sql.gz" \
           -mtime "+${RETAIN_DAYS}" 2>/dev/null)

[[ "$DELETED" -eq 0 ]] && info "  無需清理"

# ── 顯示備份目錄狀態 ─────────────────────────────────────────────────────────
info "=== 備份完成 ==="
echo ""
echo "目前備份清單："
ls -lh "${BACKUP_DIR}/backup_"*.sql.gz 2>/dev/null || echo "  （無備份）"
echo ""
TOTAL_SIZE="$(du -sh "${BACKUP_DIR}" 2>/dev/null | cut -f1)"
info "備份目錄總大小：${TOTAL_SIZE}"
