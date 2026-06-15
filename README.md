# Virtual Casino Sandbox

虛擬賭場沙盒（純娛樂、無真錢交易），可部署於 **Raspberry Pi 4 4GB**。
Monorepo 採 **npm workspaces**，技術棧：

| 層 | 技術 |
|---|---|
| 後端 | Node.js 20 + TypeScript 5 (strict) + Fastify 5 + Socket.IO 4 + Prisma 5 + BullMQ 5 |
| 前端 | Vue 3 + Vite 6 + Pinia + Vue Router（玩家端 `frontend/`、管理後台 `admin-frontend/`）|
| 共用 | `packages/shared` — 前後端共用 DTO / Socket 事件 / Enum（單一真值來源）|
| 資料 | PostgreSQL 16（dev 亦可用 SQLite）+ Redis 7 |

完整設計文件見 `01to05/`（GDD / TDD / DATABASE_DESIGN / FOLDER_STRUCTURE / MILESTONES）。

---

## 功能特色

### 遊戲

| 遊戲 | 說明 |
|------|------|
| 老虎機 | 5×3 捲軸、8 種像素風格符號（PNG 去背）、機台外觀疊層、拉桿動畫 280ms、護符（Charm）加成、Jackpot 池、連敗保底 |
| 歐式輪盤 | 多人即時 WebSocket 房間、支援直注 / 外注 / 分注等 12 種下法 |

### 系統

- **帳戶**：JWT 雙 Token（Access 15m + Refresh 7d）、TOTP 兩步驟驗證（管理後台）
- **錢包**：樂觀鎖防超額扣款、BullMQ 序列化防競態
- **排行榜**：PostgreSQL Materialized View，每 5 分鐘刷新
- **成就 / 每日任務**：12 種成就、每日登入與任務獎勵
- **聊天室**：Socket.IO 即時聊天、洗頻偵測、管理員禁言
- **管理後台**：2FA 登入、玩家管理、異常偵測（WIN_RATE / NET_WIN_OUTLIER）、禮品碼、公告
- **可驗證公平性**：每局 `serverSeedHash = sha256(rngBytes(32))`，記錄於資料庫

### 效能（k6 壓測）

- P95 回應時間 < 500ms（老虎機 spin / 輪盤下注混合場景，100 VU × 5 分鐘）
- RTP 91.5%（1,000 萬次 Monte Carlo 模擬，驗證區間 90%–94%）
- 376 後端單元 + 整合測試，無需 PostgreSQL / Redis 即可執行

---

## 目錄結構（頂層）

```
├── backend/            # Fastify API + Socket.IO + BullMQ
├── frontend/           # 玩家端 Vue 3 SPA（dev: http://localhost:5173）
├── admin-frontend/     # 管理後台 Vue 3 SPA（dev: http://localhost:5174/admin/）
├── packages/shared/    # 前後端共用 TS 型別
├── scripts/            # 金鑰產生、部署、備份等腳本
├── 01to05/             # 設計文件（GDD / TDD / DB 設計 / 結構 / Milestones）
├── docker-compose.yml  # 開發用 PostgreSQL + Redis
└── .env.example        # 環境變數範本
```

---

## 快速啟動（開發環境）

### 0. 先決條件

- Node.js **20 LTS** 以上、npm 10 以上
- Docker 與 Docker Compose（啟動 PostgreSQL / Redis 用）
- （Windows 使用者）建議透過 Git Bash 或 WSL 執行 `scripts/*.sh`

### 1. 安裝依賴

```bash
npm install
```

npm workspaces 會一次安裝 root、backend、frontend、admin-frontend、packages/shared 的全部依賴。

### 2. 建立環境變數

```bash
cp .env.example .env
bash scripts/gen-secrets.sh   # 產生 JWT_SECRET / AES_256_GCM_KEY / Admin 初始密碼並寫入 .env
```

也可手動編輯 `.env`，把所有 `change_me` 換成自己的值。

### 3. 啟動資料庫服務（PostgreSQL 16 + Redis 7）

```bash
docker compose up -d
docker compose ps        # 確認兩個服務皆 healthy
```

資料以 named volume（`pgdata` / `redisdata`）持久化，`docker compose down` 不會清除資料；
要完全重置請用 `docker compose down -v`。

### 4. 資料庫 Migration

```bash
npm run -w backend prisma:migrate   # = prisma migrate dev
npm run -w backend prisma:seed      # 種子資料：jackpot、護符池、任務池、Admin 帳號
```

### 5. 啟動開發伺服器

```bash
npm run dev              # 同時啟動 backend + frontend + admin-frontend
```

或分開啟動：

```bash
npm run dev:backend      # http://localhost:3000   （GET / → { "ok": true }）
npm run dev:frontend     # http://localhost:5173
npm run dev:admin        # http://localhost:5174/admin/
```

驗證後端：

```bash
curl http://localhost:3000/
# {"ok":true}
```

### 6. 其他常用命令

```bash
npm run build            # 建置全部 workspace
npm run lint             # ESLint（後端含 Math.random 禁用規則）+ 前端型別檢查
npm run typecheck        # 全部 workspace 型別檢查
npm run format           # Prettier 全專案格式化
```

---

## 開發約定（重點）

- **嚴禁 `Math.random`**：全專案唯一亂數出口為 `backend/src/security/csprng.ts`，ESLint `no-restricted-properties` 會直接報 error。
- **餘額只能經 wallet 模組**：禁止在其他模組直接 `prisma.user.update` 改餘額，ESLint 已設規則攔截。

## Docker（後端映像）

`backend/Dockerfile` 為多階段建置（node:20-alpine，arm64 相容，目標部署平台 Raspberry Pi 4）。
開發階段以本機 `npm run dev` 為主；生產部署使用 `docker-compose.arm64.yml`（見下方「生產部署」章節）。

```bash
# 以 repo 根目錄為 build context
docker build -f backend/Dockerfile --target runtime -t casino-backend .
```

---

## 生產部署（Raspberry Pi 4 / arm64）

### 架構概覽

```
Internet ─── Nginx (80/443) ─── Node.js App (3000, cluster ×2)
                                  ├── PostgreSQL (internal)
                                  └── Redis (internal)
```

所有服務在 Docker 橋接網路內互通；只有 Nginx 對外暴露 80/443。

### 先決條件（Pi 4 上）

- Docker Engine 24+ 與 Docker Compose v2
- Node.js 20 LTS（用於建置前端 dist；若已有 CI/CD 可省略）
- 已設定 SSH 金鑰登入（建議停用密碼登入）

### 部署步驟

#### 1. 建立生產環境設定

```bash
cp .env.example .env.production
nano .env.production
# 必須修改：
#   NODE_ENV=production
#   POSTGRES_PASSWORD=（強密碼）
#   POSTGRES_DB=casino_prod
#   DATABASE_URL=postgresql://casino:PASSWORD@postgres:5432/casino_prod?schema=public
#   REDIS_URL=redis://redis:6379
# 然後執行：
bash scripts/gen-secrets.sh    # 自動填入 JWT_SECRET / AES_256_GCM_KEY / ADMIN_INITIAL_PASSWORD
```

#### 2. 產生 TLS 憑證

```bash
# 自簽憑證（測試用，瀏覽器會警告）：
bash scripts/gen-cert.sh

# 正式域名請改用 Let's Encrypt：
# sudo apt install certbot
# sudo certbot certonly --standalone -d yourdomain.com
# 然後更新 nginx/conf.d/site.conf 中的 ssl_certificate 路徑
```

#### 3. 執行部署

```bash
bash scripts/deploy.sh
```

`deploy.sh` 自動完成以下步驟：
1. 環境檢查（.env.production / TLS 憑證）
2. `git pull --ff-only`
3. `npm install --prefer-offline`
4. 建置前端 dist（frontend + admin-frontend）
5. 建置 Docker 映像（backend/Dockerfile target:runtime）
6. 執行 Prisma migration（使用 `--profile migrate` 服務）
7. `docker compose up -d` 啟動全部服務

#### 4. 核心強化（選用，需 root）

```bash
# Linux 核心參數強化（SYN Cookie / rp_filter / kptr_restrict 等）
sudo bash scripts/sysctl-hardening.sh

# 若使用 Cloudflare 代理：僅允許 CF IP 段訪問 80/443
sudo bash scripts/cf-allowlist.sh
```

### 備份與還原

```bash
# 手動備份（保留最近 7 天）
bash scripts/backup.sh

# 建議加入 crontab（每日 03:00）：
# 0 3 * * * /bin/bash /home/pi/casino/scripts/backup.sh >> /var/log/casino-backup.log 2>&1

# 互動式還原
bash scripts/restore.sh

# 還原指定備份
bash scripts/restore.sh backups/backup_20260614_030000.sql.gz
```

### 服務管理

```bash
# 查看狀態
docker compose -f docker-compose.arm64.yml --env-file .env.production ps

# 查看日誌
docker compose -f docker-compose.arm64.yml --env-file .env.production logs -f app
docker compose -f docker-compose.arm64.yml --env-file .env.production logs -f nginx

# 重啟單一服務
docker compose -f docker-compose.arm64.yml --env-file .env.production restart app

# 更新部署（拉取最新代碼後）
bash scripts/deploy.sh
```

### 資源限制（Pi 4 4 GB RAM）

| 服務 | 記憶體上限 | 說明 |
|------|-----------|------|
| PostgreSQL | 768 MB | 主資料庫 |
| Node.js App | 512 MB | cluster ×2 workers，共用 |
| Redis | 256 MB | maxmemory 200 MB + LRU |
| Nginx | 64 MB | TLS 終止 + 靜態檔案 |

---

## 環境變數說明

完整範本見 `.env.example`。執行 `bash scripts/gen-secrets.sh` 可自動填入機密值。

| 變數 | 必填 | 說明 |
|------|------|------|
| `NODE_ENV` | ✅ | `development` / `production` |
| `PORT` | | 後端監聽 port（預設 `3000`）|
| `LOG_LEVEL` | | `fatal/error/warn/info/debug`（生產建議 `warn`）|
| `WORKERS` | | Node.js cluster fork 數（預設 `2`，Pi 4 上限 `2`）|
| `SOCKET_MAX_CONNECTIONS` | | Socket.IO 最大同時連線數（預設 `200`）|
| `DATABASE_URL` | ✅ | PostgreSQL 連線字串（開發用 `localhost`，生產用服務名 `postgres`）|
| `REDIS_URL` | ✅ | Redis 連線字串（開發用 `localhost`，生產用服務名 `redis`）|
| `JWT_SECRET` | ✅ | JWT HS256 簽章金鑰（≥ 64 hex chars）|
| `JWT_ACCESS_TTL` | | Access Token 效期（預設 `15m`）|
| `REFRESH_TOKEN_TTL_DAYS` | | Refresh Token 效期（預設 `7` 天）|
| `AES_256_GCM_KEY` | ✅ | AES-256-GCM 金鑰（恰 64 hex chars，TOTP secret 加密用）|
| `ADMIN_USERNAME` | | 初始管理員帳號（預設 `admin`）|
| `ADMIN_INITIAL_PASSWORD` | ✅ | 初始管理員密碼（首次部署後請立即更改）|
| `ALERT_WEBHOOK_URL` | | 異常通知 Webhook（可選，留空則停用）|

> **安全提醒**：`.env` / `.env.production` 已列入 `.gitignore`，嚴禁提交至版本控制。

---

## 測試指令

```bash
# 執行全部後端單元 + 整合測試（376 條，無需 PG/Redis）
npm test

# 產生覆蓋率報告（輸出至 backend/coverage/）
npm run test:coverage

# RTP 蒙地卡羅模擬（1000 萬次，驗證 RTP ∈ [90%, 94%]）
npm run rtp:simulate

# 老虎機負載測試（需 k6 + 後端服務）
npm run loadtest:spin

# 輪盤 WebSocket 壓力測試（需 k6 + 後端服務）
npm run loadtest:roulette

# 混合場景壓測（老虎機 + 輪盤各 100 VU × 5 分鐘）
npm run loadtest:mixed

# 全 workspace 型別檢查
npm run typecheck

# ESLint（後端：Math.random 禁用 + 餘額鐵律）
npm run lint

# 資料庫帳目對帳（三項不變量）
npm run -w backend audit:balance
```

---

## 已知限制

| 項目 | 說明 |
|------|------|
| 聊天室自動禁言 | 洗頻偵測（`RATE_LIMIT_BURST`/`RATE_LIMIT_MINUTE`）已實作，但違規後自動禁言尚未完成 |
| 禁言自動解除 | `setMute` 已記錄 `mutedUntil`，但自動解除的 BullMQ 延遲任務尚未排程 |
| Pi 4 真機端對端 | 部署章節各驗收項待實機驗證 |
| Provably Fair | `serverSeedHash` 已落庫（`sha256(rngBytes(32))`），但客戶端驗證介面尚未對外開放 |
| Roulette HMAC | 輪盤下注目前透過 Socket.IO payload 攜帶 HMAC，HTTP 備援路由不存在 |
| 聊天 URL 過濾 | 以正則過濾 `https?://` 及裸域名，不包含短網址 / 協定相對網址 |

---

## 貢獻指南

本專案以教育與娛樂為目的，採閉源維護。如需回報問題或提交改善建議：

1. **閱讀文件**：先閱讀 `01to05/05_MILESTONES.md`（功能進度）及 `01to05/02_TDD.md`（技術設計）。
2. **保持 Server Authoritative**：所有遊戲邏輯必須由後端決定，Client 不得影響任何遊戲結果。
3. **餘額鐵律**：任何涉及 `users.balance` 的修改，必須透過 `backend/src/modules/wallet/wallet.service.ts`，ESLint 規則會自動攔截違規。
4. **不使用 `Math.random()`**：全專案唯一亂數出口為 `backend/src/security/csprng.ts`。
5. **測試覆蓋率**：新增後端邏輯時需附帶單元測試，目標覆蓋率 ≥ 80%（安全模組 100%）。
6. **Commit Message 規範**：遵循 `feat/fix/chore/docs/test(scope): 說明` 格式。

> 本平台僅使用虛擬遊戲幣，不涉及任何真實金錢、儲值、提領或兌換功能。
