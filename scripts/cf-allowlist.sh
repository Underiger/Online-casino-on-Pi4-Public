#!/usr/bin/env bash
# ============================================================
# cf-allowlist.sh — Cloudflare IP 白名單（可選，僅使用 Cloudflare 時啟用）
#
# 功能：
#   - 透過 iptables 僅允許 Cloudflare IP 段進入 80/443
#   - 非 Cloudflare IP 一律 DROP（直接訪問 Pi 4 IP 會被拒絕）
#   - 同時支援 IPv4 與 IPv6 白名單
#   - 以 ipset 管理 Cloudflare IP 段（效能優於多條 iptables 規則）
#
# 前提條件（需先安裝）：
#   sudo apt install ipset iptables-persistent
#
# 用法：
#   sudo bash scripts/cf-allowlist.sh           # 套用白名單
#   sudo bash scripts/cf-allowlist.sh --remove  # 移除白名單（恢復全開放）
#   sudo bash scripts/cf-allowlist.sh --update  # 更新 Cloudflare IP 後重新套用
#
# 注意：
#   - Cloudflare IP 段會變動，建議每月執行 --update 或設定 crontab
#   - 若不使用 Cloudflare，請勿執行此腳本
#   - 套用後直接訪問 Pi 4 的 IP 地址（非 Cloudflare 代理）將無法連線
#
# 參考：https://www.cloudflare.com/ips/（請定期更新以下 IP 段）
# 最後更新：2026-06-14
# ============================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "請以 root 或 sudo 執行此腳本" >&2
  exit 1
fi

ACTION="${1:---apply}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}[cf-allowlist]${NC} $*"; }
warning() { echo -e "${YELLOW}[cf-allowlist]${NC} $*"; }
error()   { echo -e "${RED}[cf-allowlist]${NC} $*" >&2; exit 1; }

# ── Cloudflare IPv4 段（2026-06-14）────────────────────────────────────────────
# 最新清單：https://www.cloudflare.com/ips-v4
CF_IPv4=(
  173.245.48.0/20
  103.21.244.0/22
  103.22.200.0/22
  103.31.4.0/22
  141.101.64.0/18
  108.162.192.0/18
  190.93.240.0/20
  188.114.96.0/20
  197.234.240.0/22
  198.41.128.0/17
  162.158.0.0/15
  104.16.0.0/13
  104.24.0.0/14
  172.64.0.0/13
  131.0.72.0/22
)

# ── Cloudflare IPv6 段（2026-06-14）────────────────────────────────────────────
# 最新清單：https://www.cloudflare.com/ips-v6
CF_IPv6=(
  2400:cb00::/32
  2606:4700::/32
  2803:f800::/32
  2405:b500::/32
  2405:8100::/32
  2a06:98c0::/29
  2c0f:f248::/32
)

IPSET_NAME4="cloudflare-ipv4"
IPSET_NAME6="cloudflare-ipv6"

# ── 移除白名單 ────────────────────────────────────────────────────────────────
remove_allowlist() {
  info "移除 Cloudflare 白名單規則..."
  # 移除 iptables 規則
  iptables  -D INPUT -p tcp --dport 80  -m set ! --match-set "${IPSET_NAME4}" src -j DROP 2>/dev/null || true
  iptables  -D INPUT -p tcp --dport 443 -m set ! --match-set "${IPSET_NAME4}" src -j DROP 2>/dev/null || true
  ip6tables -D INPUT -p tcp --dport 80  -m set ! --match-set "${IPSET_NAME6}" src -j DROP 2>/dev/null || true
  ip6tables -D INPUT -p tcp --dport 443 -m set ! --match-set "${IPSET_NAME6}" src -j DROP 2>/dev/null || true
  # 銷毀 ipset
  ipset destroy "${IPSET_NAME4}" 2>/dev/null || true
  ipset destroy "${IPSET_NAME6}" 2>/dev/null || true
  info "白名單已移除，80/443 port 恢復全開放。"
}

# ── 套用白名單 ────────────────────────────────────────────────────────────────
apply_allowlist() {
  command -v ipset >/dev/null 2>&1 \
    || error "ipset 未安裝，請執行：sudo apt install ipset"

  # 清理舊 ipset
  remove_allowlist 2>/dev/null || true

  info "建立 Cloudflare IPv4 ipset..."
  ipset create "${IPSET_NAME4}" hash:net family inet  maxelem 32
  for cidr in "${CF_IPv4[@]}"; do
    ipset add "${IPSET_NAME4}" "$cidr"
  done

  info "建立 Cloudflare IPv6 ipset..."
  ipset create "${IPSET_NAME6}" hash:net family inet6 maxelem 16
  for cidr in "${CF_IPv6[@]}"; do
    ipset add "${IPSET_NAME6}" "$cidr"
  done

  info "套用 iptables 規則（非 Cloudflare IP DROP 80/443）..."
  # 允許 loopback（Docker 健康檢查使用）
  iptables  -I INPUT -i lo -j ACCEPT 2>/dev/null || true
  ip6tables -I INPUT -i lo -j ACCEPT 2>/dev/null || true

  # 非 Cloudflare IP 訪問 80/443 → DROP
  iptables  -A INPUT -p tcp --dport  80 -m set ! --match-set "${IPSET_NAME4}" src -j DROP
  iptables  -A INPUT -p tcp --dport 443 -m set ! --match-set "${IPSET_NAME4}" src -j DROP
  ip6tables -A INPUT -p tcp --dport  80 -m set ! --match-set "${IPSET_NAME6}" src -j DROP
  ip6tables -A INPUT -p tcp --dport 443 -m set ! --match-set "${IPSET_NAME6}" src -j DROP

  info "=== Cloudflare 白名單套用完成 ==="
  info "IPv4 IP 段數量：${#CF_IPv4[@]}"
  info "IPv6 IP 段數量：${#CF_IPv6[@]}"
  echo ""
  warning "⚠  直接訪問 Pi 4 的 IP（非透過 Cloudflare 代理）的 80/443 請求將被 DROP。"
  warning "   SSH（22）等其他 port 不受影響。"
  echo ""

  # 持久化（需安裝 iptables-persistent）
  if command -v netfilter-persistent >/dev/null 2>&1; then
    info "持久化 iptables 規則..."
    netfilter-persistent save
  else
    warning "iptables-persistent 未安裝，重啟後規則不保留。"
    warning "安裝：sudo apt install iptables-persistent"
  fi
}

case "$ACTION" in
  --remove)  remove_allowlist ;;
  --update)
    info "更新 Cloudflare IP 白名單..."
    info "提示：若要獲取最新 IP 段，請參考："
    info "  https://www.cloudflare.com/ips-v4"
    info "  https://www.cloudflare.com/ips-v6"
    apply_allowlist
    ;;
  --apply|*)
    apply_allowlist
    ;;
esac
