# Virtual Casino Sandbox — Project Context

> 快速入門文件：給新加入的開發者或 AI 助手，用於理解專案狀態、架構與下一步。
> 詳細設計見 `docs/04_API_SPEC.md`、`docs/PROJECT_STATE.md` 及 `docs/` 設計文件資料夾。

---

## 專案簡介

**Virtual Casino Sandbox**（VCS）是一個運行於 Raspberry Pi 4（arm64）的全端線上賭場沙盒系統。
採用 Roguelite 機率設計：老虎機（92% RTP）、歐式輪盤、即時聊天、成就系統、排行榜、管理後台。
**技術棧**：Fastify 5 + Prisma + PostgreSQL + Redis + BullMQ（後端）、Vue 3 + Vite + Pinia + Socket.IO（前端）、npm workspaces monorepo。

---

## 目錄結構

```
casino/
├── backend/          # Fastify 5 API + Socket.IO + BullMQ 佇列
│   ├── src/
│   │   ├── modules/  # 各功能模組（auth, wallet, slot, roulette, admin, monitor…）
│   │   ├── plugins/  # Fastify 插件（prisma, redis, auth, rate-limit, hmac-guard）
│   │   ├── security/ # 密碼學工具（csprng, totp, aes, anomaly）
│   │   ├── sockets/  # Socket.IO 事件定義與 Gateway
│   │   └── jobs/     # BullMQ 排程任務（jackpot-flush, leaderboard-refresh, daily-reset, monitor-scan）
│   ├── prisma/       # Prisma schema + migrations + seed
│   └── test/         # Vitest 單元 & 整合測試（376 筆，全綠）
├── frontend/         # Vue 3 玩家端（老虎機、輪盤、聊天、排行榜、成就、個人頁）
├── admin-frontend/   # Vue 3 管理後台（M23 完成；base: /admin/）
├── packages/shared/  # DTO / enum / 常數（前端專用；後端自行鏡像）
├── nginx/            # Nginx 設定（nginx.conf + conf.d/）
├── scripts/          # 維運工具（gen-secrets, deploy, backup, restore, gen-cert, sysctl-hardening, cf-allowlist）
├── docs/             # 設計文件（API spec, PROJECT_STATE, project_context…）
├── docker-compose.yml          # 開發用 PostgreSQL + Redis
└── docker-compose.arm64.yml    # 生產部署（Pi 4 arm64，M25 建立）
```

---

## Milestone 進度（截至 2026-06-15）

| Milestone | 內容 | 狀態 |
|-----------|------|------|
| M01–M10 | Infra、DB schema、Auth、Wallet、Slot 核心 | ✅ |
| M11–M13 | 前端骨架、老虎機前端、護符系統 | ✅ |
| M14 | Jackpot（Redis 累積 + BullMQ 10s flush + 派彩） | ✅ |
| M15 | Roulette 後端（Redis 狀態機、分散式 leader lock） | ✅ |
| M16 | Roulette 前端（WheelCanvas、BetBoard、ChipSelector） | ✅ |
| M17 | 聊天系統（Socket.IO + 7天清理排程） | ✅ |
| M18 | Daily 系統（登入連續獎勵 + 每日任務 + BullMQ 00:00 重設） | ✅ |
| M19 | 排行榜（物化視圖 daily/weekly/total + 快照） | ✅ |
| M20 | 成就系統 + 個人頁前端 | ✅ |
| M21 | 管理後台後端核心（TOTP 2FA、玩家管理、稽核、公告、Gift Code） | ✅ |
| M22 | Gift Code 兌換（玩家端）+ 紀錄查詢 API（admin） | ✅ |
| M23 | 管理後台前端（Vue 3 SPA，六個 View + ReverifyDialog） | ✅ |
| M24 | 系統監控 API + 異常偵測（WIN_RATE / NET_WIN_OUTLIER / BET_RATE） | ✅ |
| M25 | 生產部署管線（docker-compose.arm64.yml / nginx / scripts） | ✅ |
| M26 | RTP 模擬（千萬次蒙地卡羅）+ k6 負載測試 | ✅ |
| M27 | E2E 整合測試（376 條）+ 安全演練（5 向量） | ✅ |
| M28 | 文件定稿 + v1.0.0 發布 | ✅ |
| — | 最終 Pi 4 真機驗收（需 arm64 硬體 + 正式 TLS 憑證） | ⏳ 待硬體 |

---

## 關鍵架構決策

### 安全
- **餘額鐵律**：全系統只有 `wallet` 模組可改 `users.balance`（ESLint `no-restricted-syntax` 強制）。
  每次改動伴隨一筆 `BalanceTransaction`，可全帳回放。
- **HMAC 封包簽章**（slot spin / roulette bet）：前端帶 `sig+nonce+seq+ts`，後端 `hmac-guard` 驗證。
- **Admin 2FA**：TOTP（otplib v13 + AES-256-GCM 加密 secret）+ reverifyToken 流（高危操作需 `x-reverify-token` header）。
- **backend 禁止 import @casino/shared**：shared 的 index.ts 無 `.js` 副檔名，NodeNext 模組解析失敗；後端自行鏡像型別。

### 即時通訊
- Socket.IO 所有玩家連線時加入 `user:{userId}` 個人 room，供後端定向推播。
- Roulette 狀態機以 Redis `roulette:leader` NX lock 確保跨程序單一 leader。
- 前端預設 WebSocket transport（規避 long-polling 跨 cluster worker 黏著問題）。

### BullMQ 佇列
- 專用 ioredis 連線（`maxRetriesPerRequest: null`），與 redis plugin 連線語義衝突故獨立建立。
- Queue 清單：`jackpot-flush`（10s flush + 5s tick）、`daily-reset`（00:00 TPE cron）、`leaderboard-refresh`（5m + 00:00 snapshot）、`monitor-scan`（10m）。
- 所有 `registerXxxJobs()` 在 `server.ts` 的 `initSocketServer()` 之後呼叫（tick 廣播依賴 `app.io`）。

### 排行榜
- 三張 PG 物化視圖（`leaderboard_daily/weekly/total`），BullMQ 每 5 分鐘 REFRESH CONCURRENTLY。
- 每日 00:00 Asia/Taipei 快照前 100 名至 `LeaderboardSnapshot`。

### 異常偵測（M24）
- `BET_RATE`：1s 桶 > 2 筆/s 標記。
- `WIN_RATE`：5 分鐘桶連續 3 窗 > 99% 勝率（≥ 10 筆/窗）標記。
- `NET_WIN_OUTLIER`：當日淨贏超過 P99 × 10 標記；P99 由 `monitor-scan` job 每 10 分鐘更新。

### 生產部署（M25）
- `docker-compose.arm64.yml`：postgres(768 MB) / redis(256 MB) / app(512 MB) / nginx(64 MB)；僅 nginx 對外暴露 80/443。
- Prisma 生產 migration：`prisma` 為 devDep，runtime image 無 CLI；使用 `--profile migrate` 服務（`target: deps` build stage + 掛載 `backend/prisma/`）。
- TLS：`nginx/certs/server.{key,crt}`（gen-cert.sh 產生自簽；正式上線改 Let's Encrypt）。
- 生產 `DATABASE_URL` 使用 Docker 服務名 `postgres`（非 localhost）；`REDIS_URL` 使用 `redis`。

### Gift Code
- 玩家兌換：`POST /api/gift-codes/redeem`（JWT 認證）。
- 競態防護雙保險：`giftCode.updateMany` 條件更新 + `GiftCodeRedemption @@unique([giftCodeId, userId])`（P2002）。

---

## 開發指令速查

```bash
# 安裝依賴
npm install

# 啟動基礎設施（PostgreSQL + Redis）
docker compose up -d

# 初始化 DB
cd backend && npm run prisma:migrate && npm run prisma:seed

# 啟動開發（後端 :3000 + 玩家端 :5173 + 管理後台 :5174）
npm run dev              # 在 monorepo 根目錄
npm run dev:backend      # http://localhost:3000
npm run dev:frontend     # http://localhost:5173
npm run dev:admin        # http://localhost:5174/admin/

# 測試（376 筆）
cd backend && npm test

# TypeScript 檢查 + Lint
cd backend && npm run typecheck && npm run lint
cd admin-frontend && npm run build   # vue-tsc + vite build
```

---

## 環境變數（必填）

複製 `.env.example` 為 `.env`（開發）或 `.env.production`（生產）：

```bash
# 開發
cp .env.example .env
bash scripts/gen-secrets.sh   # 產生 JWT_SECRET / AES_256_GCM_KEY / Admin 初始密碼

# 生產（DATABASE_URL / REDIS_URL 使用 Docker 服務名）
cp .env.example .env.production
# 修改 NODE_ENV=production、POSTGRES_DB=casino_prod
# DATABASE_URL=postgresql://casino:<PWD>@postgres:5432/casino_prod?schema=public
# REDIS_URL=redis://redis:6379
bash scripts/gen-secrets.sh .env.production
```

---

## 生產部署（Pi 4 arm64）

```bash
bash scripts/gen-cert.sh      # 產生 TLS 自簽憑證（首次）
bash scripts/deploy.sh        # 完整自動部署（env-check → build → migrate → up）
bash scripts/backup.sh        # 手動備份（建議 crontab 每日 03:00）
bash scripts/restore.sh       # 互動式還原
sudo bash scripts/sysctl-hardening.sh   # 核心安全參數強化（選用）
```

---

## 下一步：Pi 4 真機驗收

M14–M28 已全部完成，v1.0.0 已發布。唯一未完成項為 **Pi 4 真機最終驗收**
（需 arm64 硬體 + 正式 Let's Encrypt 憑證；硬體到貨前無法執行）。
其餘端對端冒煙測試需 PostgreSQL + Redis 執行環境。詳見 `docs/PROJECT_STATE.md`。

---

*更新日期：2026-06-15　Milestone：M28（v1.0.0 已發布）*
