# Technical Design Document（TDD）
**專案：Virtual Casino Sandbox（VCS）｜版本 v1.0｜部署目標：Raspberry Pi 4 4GB（arm64）**

---

## 1. 技術棧總覽

| 層 | 技術 | 版本基準 | 角色 |
|---|---|---|---|
| 後端 | Node.js 20 LTS + TypeScript 5 | strict mode | API + Socket.IO + 排程 |
| Web 框架 | Fastify | 4.x | 比 Express 低開銷，適合 Pi |
| 即時通訊 | Socket.IO | 4.x | polling + websocket，上限 200 連線 |
| ORM | Prisma | 5.x | Schema 即文件；Prisma Migrate 管版本 |
| 資料庫 | PostgreSQL 16（開發可 SQLite） | alpine arm64 | 唯一持久真值 |
| 快取/狀態 | Redis 7 | alpine arm64 | Loadout 快取、Jackpot 增量、Rate Limit、HMAC 金鑰、Nonce |
| 佇列 | BullMQ | 5.x | 排行榜刷新、每日結算、Jackpot flush |
| 前端 | Vue 3 + Vite + Pinia + Vue Router | Composition API | 玩家端 + Admin 端兩個 app |
| 反向代理 | Nginx | alpine arm64 | TLS 終結、限流、靜態檔 |
| 部署 | Docker + Docker Compose | `docker-compose.arm64.yml` | 全 arm64 映像 |

**開發 SQLite → 生產 PostgreSQL 注意**：Schema 僅使用兩者皆支援的型別；`BIGINT` 餘額在 Prisma 以 `BigInt` 對應；MATERIALIZED VIEW 與 partial index 為 PG 專屬，以 raw SQL migration 管理並在 SQLite 環境跳過（以 `provider` 判斷的條件 migration script）。

---

## 2. 系統架構

```
                         ┌──────────────── Raspberry Pi 4 (4GB, arm64) ────────────────┐
 Browser ── TLS 1.2+ ──► │ Nginx :443                                                  │
 (Vue 3 SPA)             │  ├─ /            → 玩家端靜態檔                              │
   HTTPS + WSS           │  ├─ /admin       → Admin 靜態檔                              │
                         │  ├─ /api/*       → Node cluster (worker ×2) :3000           │
                         │  └─ /socket.io/  → 同上（ip_hash 黏著）                      │
                         │       │                                                     │
                         │  Node.js (Fastify + Socket.IO + BullMQ worker)              │
                         │   ├── Redis 7  ── loadout / jackpot delta / rate limit /    │
                         │   │               nonce / hmac key / socket.io adapter      │
                         │   └── PostgreSQL 16 ── 持久真值（交易、樂觀鎖、物化視圖）     │
                         └─────────────────────────────────────────────────────────────┘
```

- **Cluster 模式**：`node:cluster` 2 workers；Socket.IO 透過 `@socket.io/redis-adapter` 跨 worker 廣播；Nginx `ip_hash` 確保 polling 黏著。若因行動網路 IP 變動導致斷線，可改用 `@socket.io/redis-adapter` 完全移除黏著依賴；初版使用 ip_hash 簡化，視情況升級。
- **BullMQ worker** 與 API 同進程不同 queue consumer（Pi 上避免多開進程吃 RAM）；高峰時段可由環境變數切換為獨立容器。

---

## 3. 後端模組劃分

```
backend/src/
├── app.ts / server.ts / cluster.ts     # Fastify 建構、啟動、cluster 入口
├── config/                              # env 載入與驗證（zod）
├── plugins/                             # fastify 插件：prisma, redis, auth, rate-limit
├── modules/
│   ├── auth/        # 註冊登入、JWT + Refresh、HMAC 金鑰協商與輪換
│   ├── user/        # 個人資料、成就、餘額查詢
│   ├── wallet/      # 唯一允許動餘額的模組：條件更新 + BalanceTransaction
│   ├── slot/        # 老虎機：loadout 編譯器、CSPRNG 抽樣、賠付、pity、jackpot 觸發
│   │   ├── loadout-compiler.ts   # 護符 → CompiledLoadout（含 variants）
│   │   ├── sampler.ts            # 累積權重二分查找 + randomInt
│   │   ├── payout.ts             # 賠付規則（wild 替代、幸運符號、pity）
│   │   └── slot.service.ts       # spin 主流程（單一交易）
│   ├── roulette/    # 回合狀態機（BETTING→LOCK→RESULT→COOLDOWN）、下注驗證、結算
│   ├── jackpot/     # Redis 累積、flush job、樂觀鎖派彩
│   ├── charm/       # 護符 CRUD、裝備/卸下（觸發重新編譯）
│   ├── daily/       # 登入獎勵、任務、幸運符號輪換
│   ├── leaderboard/ # 物化視圖查詢 + 快照
│   ├── chat/        # 訊息過濾、頻率限制、歷史
│   ├── admin/       # 後台 API（2FA 中介層、審計日誌）
│   └── monitor/     # systeminformation 採集
├── sockets/         # Socket.IO 命名空間、事件註冊、簽章驗證中介層
├── jobs/            # BullMQ：jackpot-flush(10s)、leaderboard-refresh(5m)、daily-reset(00:00)
├── security/        # hmac.ts、nonce.ts、csprng.ts、anomaly.ts（異常下注偵測）
└── shared/          # 錯誤類別、常數、型別（與前端共用的 types 由 packages/shared 提供）
```

**模組鐵律**：除 `wallet` 外任何模組不得直接 UPDATE `users.balance`；所有遊戲結算呼叫 `wallet.debit()/credit()`，內部強制條件更新 + 交易 + 寫 BalanceTransaction。

---

## 4. 前端架構

```
frontend/src/
├── api/            # axios 封裝：自動附 JWT、計算 HMAC 簽章、401→refresh 重試一次
├── socket/         # socket.io-client 單例 + 事件型別（共用 packages/shared）
├── stores/         # Pinia：auth, wallet, slot, roulette, chat, leaderboard, daily
├── views/          # Lobby / Slot / Roulette / Leaderboard / Profile / Login
├── components/
│   ├── slot/       # ReelColumn（CSS transform 動畫，結果驅動）、CharmSlot、PityBar
│   ├── roulette/   # WheelCanvas、BetBoard、PhaseTimer
│   └── common/     # JackpotTicker、ChatPanel、CoinDisplay
└── router/
admin-frontend/      # 獨立 Vue app：登入(2FA)、玩家管理、Coin 調整、GiftCode、紀錄、監控
packages/shared/     # TS 型別：API DTO、Socket 事件 payload、Enum（前後端單一來源）
```

- 動畫原則：前端收到 `spin:result` 後**回放**結果（轉軸減速停在指定符號），不存在「前端先轉再要結果」。
- 餘額顯示一律以伺服器回傳值覆蓋，前端不自行加減。

---

## 5. 安全與防作弊設計（詳細）

### 5.1 CSPRNG（嚴禁 Math.random）
```ts
// security/csprng.ts — 全專案唯一亂數出口，ESLint rule 禁用 Math.random
import { randomInt, randomBytes } from "node:crypto";
export const rngInt = (maxExclusive: number) => randomInt(maxExclusive); // 無模偏差
export const rngToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
```
- 轉軸抽樣：`rngInt(totalWeight)` → 對 CompiledLoadout 的 `cum` 陣列二分查找。
- 輪盤：`rngInt(37)`。Jackpot 判定：`rngInt(50_000) === 0`（含點數修正後的等效整數化機率）。
- Gift Code / HMAC 金鑰 / nonce salt：`randomBytes`。
- 每筆 BetRecord 落庫 `serverSeedHash`（當次 32-byte seed 的 SHA-256），保留日後做可驗證公平（provably fair）的擴充空間。

### 5.2 HMAC-SHA256 請求簽章（金鑰協商與輪換）

**協商**
1. 登入成功（密碼驗證 + 簽發 JWT/Refresh）後，伺服器 `randomBytes(32)` 產生會話 HMAC 金鑰。
2. 金鑰存 Redis：`hmac:{userId}` → `{ key, issuedAt }`，TTL = Refresh Token 壽命（7d）。
3. 金鑰僅透過 **TLS 的登入回應**下發一次（`hmacKey` 欄位，base64url）；前端存於記憶體（Pinia），不落 localStorage。

**簽章（HTTP 下注/敏感請求 與 Socket.IO 遊戲事件一體適用）**
```
canonical = `${userId}|${gameType}|${betAmount}|${nonce}|${timestamp}`
signature = HMAC-SHA256(sessionKey, canonical)  // hex
```
- 標頭/payload 攜帶：`x-sig`、`x-nonce`（uuid v4）、`x-ts`（epoch ms）、`x-seq`。
- 伺服器以 `crypto.timingSafeEqual` 比對；canonical 由伺服器依「已驗證的 JWT userId + 解析後欄位」重組，**欄位任何一項被改動簽章即失效**（涵蓋 userId+gameType+betAmount+nonce+timestamp 的完整性綁定）。

**輪換**
- JWT Access Token 15 分鐘過期 → 前端用 Refresh 換新；**每次 Refresh 伺服器重新產生 HMAC 金鑰**並隨回應下發（自然達成 ≤24h 輪換）；前端收到新金鑰後須立即更新記憶體，並以新金鑰簽章後續請求。
- 登出 / 管理員封鎖：DEL `hmac:{userId}` + Refresh Token 撤銷 → 所有後續簽章即刻失效。
- 寬限：輪換後舊金鑰保留 30s（`hmac:{userId}:prev`）容忍在途請求。

### 5.3 防重放（Nonce + Timestamp + Sequence）
| 機制 | 實作 |
|---|---|
| 時間窗 | `|now - x-ts| ≤ 5000ms`，否則 `ERR_STALE_REQUEST` |
| Nonce | Redis `SET nonce:{userId}:{nonce} 1 NX EX 10`；SET 失敗＝重放，拒絕並記 IllegalPacketLog |
| Sequence | Redis `last_seq:{userId}`；`x-seq` 必須嚴格遞增（Lua script 原子比較交換），舊封包拒絕 |
| 回合時窗 | 輪盤下注僅在 BETTING 階段（15s）受理，伺服器以回合 `roundId` + 階段狀態機判斷，逾時拒絕 |

### 5.4 認證
- 註冊/登入：argon2id 雜湊密碼；JWT（HS256，15m）+ Refresh Token（不透明隨機串，雜湊後存 DB，7d，旋轉式：每次 refresh 作廢舊 token，重用偵測即全撤銷）。
- Socket.IO 握手：`auth.token` 帶 JWT，中介層驗證後綁定 `socket.data.userId`；其後每個遊戲事件仍需 §5.2 簽章。

### 5.5 管理後台 2FA（TOTP）
- otplib 實作 TOTP（30s 步長，±1 步容忍）；綁定流程：QR（otpauth://）→ 驗證一次成功才啟用；secret 以 AES-256-GCM（金鑰來自 env）加密存 DB。
- **登入必過 2FA**；**高危操作（手動加扣幣、建 Gift Code、封鎖）需逐次重驗 TOTP**，驗過的 code 記 Redis 10 分鐘防重用。
- 後備：10 組一次性恢復碼（CSPRNG，雜湊存庫）。

### 5.6 餘額一致性（核心約束）
```sql
UPDATE users SET balance = balance - :amount, version = version + 1
WHERE id = :userId AND balance >= :amount;
-- affectedRows = 0 → 拋 ERR_INSUFFICIENT_BALANCE，整筆交易回滾
```
- 隔離層級：**READ COMMITTED + 條件更新/樂觀鎖**（PG 預設，低開銷）；Jackpot 派彩等高風險路徑採樂觀鎖重試（≤3 次），必要時個案升級 SERIALIZABLE。
- 每筆異動同交易寫入 `BalanceTransaction(before, after, delta, type, refId)`，可全帳回放對帳；提供 `scripts/audit-balance.ts` 比對 `SUM(delta)` 與現值。

### 5.7 異常偵測與日誌
- `security/anomaly.ts`：滑動視窗統計（Redis）— 下注頻率 > 2 次/秒、勝率連續 3 視窗 > 99%、單日淨贏 > 全服 P99 ×10 → 標記 `User.flagged` + Admin 通知（不自動封鎖，人工裁決；通知方式：Bull 排程每日寄送摘要至管理員 Email 或 Discord Webhook，由環境變數配置）。
- IllegalPacketLog：簽章失敗、nonce 重放、seq 倒退、逾時下注全量落庫（含 IP、UA、原始 payload 截斷 1KB）。
- AdminAuditLog：後台所有寫操作（操作者、動作、目標、前後值、IP）。

### 5.8 聊天室防護
- 長度 ≤ 200；URL regex（含裸網域/punycode 常見變形）過濾為 `[連結已移除]`；HTML entity 轉義（前端再以純文字渲染，雙保險防 XSS）。
- 頻率：Redis 令牌桶 — 1 則/2s、10 則/min；超限回 `ERR_CHAT_RATE_LIMIT` 並遞增違規計數，5 次違規禁言 10 分鐘。

---

## 6. 效能與基礎防護（Pi 4 4GB 預算）

### 6.1 資源配置
| 服務 | 記憶體上限（compose `mem_limit`） | 關鍵參數 |
|---|---|---|
| PostgreSQL | 768MB | `shared_buffers=256MB`、`effective_cache_size=512MB`、`max_connections=40` |
| Node ×2 workers | 各 512MB | `--max-old-space-size=384` |
| Redis | 256MB | `maxmemory 200mb`、`maxmemory-policy volatile-lru`、AOF everysec |
| Nginx | 64MB | worker_processes 2 |
| （餘量） | ~1.4GB | OS + 突發 |

### 6.2 排行榜：物化視圖
```sql
CREATE MATERIALIZED VIEW leaderboard_daily AS
SELECT user_id, SUM(payout - amount) AS net_win
FROM bet_records WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Taipei')
GROUP BY user_id ORDER BY net_win DESC LIMIT 100;
CREATE UNIQUE INDEX ON leaderboard_daily(user_id);  -- CONCURRENTLY 刷新必需
```
- BullMQ repeatable job 每 5 分鐘 `REFRESH MATERIALIZED VIEW CONCURRENTLY`（不鎖讀）；weekly / total 同模式。建議將刷新任務排程在整點後的 2、7、12、17… 分鐘（錯開整點可能的流量高峰）。
- API 只讀視圖；`bet_records(created_at)` 建 BRIN 索引壓低刷新成本。

### 6.3 Jackpot flush（見 GDD §3.4）
- repeatable job 10s 一次 + `txcount ≥ 500` 觸發提前 flush；`GETSET jackpot:delta 0` 原子取增量。

### 6.4 DDoS 基礎防護
**Nginx（nginx/conf.d/ratelimit.conf）**
```nginx
limit_conn_zone $binary_remote_addr zone=perip:10m;
limit_req_zone  $binary_remote_addr zone=reqs:10m rate=10r/s;
server {
  limit_conn perip 10;
  location /api/      { limit_req zone=reqs burst=20 nodelay; }
  location /socket.io/ { limit_conn perip 5; proxy_read_timeout 70s; }
}
```
**核心（scripts/sysctl-hardening.sh）**
```
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.core.somaxconn = 1024
```
**Cloudflare（可選，推薦）**：有網域時 DNS 接 CF 免費方案（Proxied），開啟 WebSocket 支援；origin 僅放行 CF IP 段（提供 `scripts/cf-allowlist.sh`）。零程式碼變更。

### 6.5 連線與排程紀律
- Socket.IO `maxHttpBufferSize=4KB`、全域連線數 > 200 時拒絕新握手（回 `server_full`）。
- 每日結算 00:00、視圖刷新打散在 :00/:05…、聊天清理 04:30 — 排程錯峰，避免 IO 疊加。

---

## 7. 部署架構（arm64）

### 7.1 docker-compose.arm64.yml 概念
```yaml
services:
  nginx:    image: nginx:1.27-alpine          # TLS 終結（certbot 或自簽）、限流、靜態檔
  app:      build: ./backend                  # node:20-alpine 多階段建置，cluster ×2
  postgres: image: postgres:16-alpine
  redis:    image: redis:7-alpine
# 皆為官方 multi-arch 映像（含 linux/arm64）；volumes 持久化 pg/redis/憑證
# healthcheck + depends_on(condition: service_healthy) 控制啟動順序
```
- 一鍵腳本：`scripts/deploy.sh`（pull → prisma migrate deploy → up -d）、`scripts/backup.sh`（pg_dump 每日 cron）。
- `.env.example` 列出全部變數；`.env` 進 `.gitignore`；JWT/AES 金鑰由 `scripts/gen-secrets.sh` 產生。

### 7.2 環境
| 環境 | DB | 用途 |
|---|---|---|
| dev | SQLite（或本機 PG） | 快速迭代，`prisma migrate dev` |
| prod (Pi) | PostgreSQL 16 | `prisma migrate deploy`，禁止 db push |

---

## 8. 明確的取捨（Trade-offs）
| 決策 | 取 | 捨 | 原因 |
|---|---|---|---|
| Fastify 而非 Nest | 低記憶體、低樣板 | 框架級 DI | Pi 資源優先；以模組約定補結構 |
| 同進程跑 BullMQ | 省 ~150MB | 隔離性 | 200 人規模負載可承受 |
| READ COMMITTED + 條件更新 | 吞吐 | 理論最強隔離 | 條件更新已消滅超扣競態；SERIALIZABLE 留給 Jackpot 個案 |
| 公共輪盤單房 | 全服共感、省排程 | 多房彈性 | 架構保留 roomId 欄位，Phase 2 可開私房 |
| HMAC 金鑰存記憶體不落 localStorage | 防 XSS 竊鑰 | 重新整理需重新 refresh | refresh 流程本就會重發金鑰 |
