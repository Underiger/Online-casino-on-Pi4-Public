#!/usr/bin/env bash
# ============================================================
# sysctl-hardening.sh — Linux 核心參數強化（Raspberry Pi 4 / arm64）
#
# 功能：
#   - TCP SYN Cookie 防護（防 SYN flood）
#   - 停用 IP forwarding / source routing / ICMP redirect
#   - 啟用 Reverse Path Filtering（防 IP spoofing）
#   - 記憶體 & 連線參數調整（Pi 4 4 GB 優化）
#   - 持久化寫入 /etc/sysctl.d/99-casino-hardening.conf
#
# 用法（需 root 權限）：
#   sudo bash scripts/sysctl-hardening.sh
#   sudo bash scripts/sysctl-hardening.sh --apply-only  # 只套用不重寫設定檔
#
# 復原：
#   sudo rm /etc/sysctl.d/99-casino-hardening.conf
#   sudo sysctl --system
# ============================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "請以 root 或 sudo 執行此腳本" >&2
  exit 1
fi

APPLY_ONLY="${1:-}"
CONF_FILE="/etc/sysctl.d/99-casino-hardening.conf"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[sysctl]${NC} $*"; }

# ── 寫入設定檔（除非 --apply-only）────────────────────────────────────────────
if [[ "$APPLY_ONLY" != "--apply-only" ]]; then
  info "寫入核心參數設定：$CONF_FILE"

  cat > "$CONF_FILE" << 'EOF'
# Virtual Casino Sandbox — Kernel Hardening（Raspberry Pi 4）
# 產生：scripts/sysctl-hardening.sh
# 復原：sudo rm /etc/sysctl.d/99-casino-hardening.conf && sudo sysctl --system

# ── TCP SYN Cookie（防 SYN Flood 攻擊）───────────────────────────────────────
net.ipv4.tcp_syncookies = 1

# ── 停用 IP forwarding（Pi 4 不作路由器）───────────────────────────────────────
net.ipv4.ip_forward = 0
net.ipv6.conf.all.forwarding = 0

# ── 停用 Source Routing（防 IP 欺騙路由）──────────────────────────────────────
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0

# ── 停用 ICMP Redirect 接受與發送 ─────────────────────────────────────────────
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# ── Reverse Path Filtering（防 IP Spoofing）────────────────────────────────────
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# ── ICMP Broadcast & Bogus Error 防護 ─────────────────────────────────────────
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1

# ── 記錄可疑封包（Martian Packets）────────────────────────────────────────────
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1

# ── TCP 連線調整（Pi 4 記憶體有限，保守設定）─────────────────────────────────
# 加快 TIME_WAIT socket 回收（Pi 4 上 200 連線限制）
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 3

# 本地 port 範圍（預設 32768–60999，足夠 200 並發）
net.ipv4.ip_local_port_range = 10000 65535

# ── 核心記憶體保護 ─────────────────────────────────────────────────────────────
# 防止核心指標洩漏到非特權使用者
kernel.kptr_restrict = 1
# 限制 dmesg 給 root
kernel.dmesg_restrict = 1

# ── 防止 core dump 洩露機密資訊 ───────────────────────────────────────────────
fs.suid_dumpable = 0
EOF

  info "設定檔已寫入：$CONF_FILE"
fi

# ── 套用設定 ──────────────────────────────────────────────────────────────────
info "套用核心參數..."
sysctl --system 2>&1 | grep -E "(casino|Applying)" || true

info "=== 核心強化完成 ==="
echo ""
info "已啟用的主要保護："
info "  TCP SYN Cookie：$(sysctl -n net.ipv4.tcp_syncookies)"
info "  IP Forward 停用：$(sysctl -n net.ipv4.ip_forward)"
info "  Reverse Path Filter：$(sysctl -n net.ipv4.conf.all.rp_filter)"
info "  ICMP Broadcast 忽略：$(sysctl -n net.ipv4.icmp_echo_ignore_broadcasts)"
info "  kptr_restrict：$(sysctl -n kernel.kptr_restrict)"
