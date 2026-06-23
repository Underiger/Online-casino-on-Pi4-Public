# Technical Design Document（TDD）
**專案：Virtual Casino Sandbox（VCS）｜版本 v1.1｜部署目標：Raspberry Pi 4 4GB（arm64）**

> 版本紀錄：v1.0 為 Phase 1（M01–M28，2026-06-14 發布 v1.0.0）設計凍結稿；v1.1 補上
> Phase 2 第一類「莊家 vs 閒家」三款新遊戲（M29，2026-06-20）實作細節，並將下表版本
> 基準由規劃值校正為**實際安裝版本**（見各 `package.json`）。

---

## 1. 技術棧總覽

| 層 | 技術 | 實際版本 | 角色 |
|---|---|---|---|
| 後端 | Node.js 20 LTS + TypeScript 5 | `typescript ^5.5.4`，strict mode | API + Socket.IO + 排程；ESLint 9 flat config（`eslint.config.js`） |
| Web 框架 | Fastify | `fastify ^5.8.5` | 比 Express 低開銷，適合 Pi（規劃為 4.x，實際安裝 5.x） |
| 即時通訊 | Socket.IO | `socket.io ^4.8.3` + `@socket.io/redis-adapter ^8.3.0` | polling + websocket，上限 200 連線 |
| ORM | Prisma | `prisma`/`@prisma/client ^5.22.0` | Schema 即文件；Prisma Migrate 管版本；`binaryTargets` 含 `linux-musl-arm64-openssl-3.0.x` |
| 資料庫 | PostgreSQL 16（開發可 SQLite） | 生產映像 `postgres:16.7-alpine` | 唯一持久真值 |
| 快取/狀態 | Redis 7 | 生產映像 `redis:7.4.6-alpine` + `ioredis ^5.10.1` | Loadout 快取、Jackpot 增量、Rate Limit、HMAC 金鑰、Nonce、RoundLock（M29） |
| 佇列 | BullMQ | `bullmq ^5.78.0` | 排行榜刷新、每日結算、Jackpot flush、孤兒回合清理（M29）、限時禁言解除 |
| 認證/密碼學 | argon2id + otplib + zod | `argon2 ^0.41.1` / `otplib ^13.4.1` / `zod ^3.23.8` | 密碼雜湊、Admin TOTP 2FA、Schema 驗證 |
| 前端 | Vue 3 + Vite + Pinia + Vue Router | `vue ^3.4.31` / `vite ^6.4.2`（規劃 Vite 5，實際 6） | Composition API；玩家端 + Admin 端兩個 app |
| 反向代理 | Nginx | `nginx:1.27-alpine` | TLS 終結、限流、靜態檔、CSP 等安全標頭（`conf.d/security-headers.inc`，見 §5.9） |
| 部署 | Docker + Docker Compose | `docker-compose.arm64.yml` | 全 arm64 映像（`platform: linux/arm64` 明確指定） |

**開發 SQLite → 生產 PostgreSQL 注意（實作與 v1.0 規劃不同）**：Prisma 3+ 已移除
`provider = env(...)` 動態切換，故實際採**雙實體 schema 檔**：`backend/prisma/schema.prisma`
（PostgreSQL，生產 + docker-compose dev）與 `backend/prisma/schema.sqlite.prisma`
（enum/Json 降級為 String，供無 Docker 環境快速以 SQLite 開發），以 `npm run prisma:push:sqlite`
/ `prisma:generate:sqlite` 搭配 `--schema` 旗標切換，取代原規劃的「單一 schema + 條件
migration script」。MATERIALIZED VIEW 仍為 PG 專屬、以 raw SQL migration 管理；BRIN 索引
已改用 Prisma schema 原生 `@@index([...], type: Brin)` 語法，不再需要額外的 raw SQL（詳見
03_DATABASE_DESIGN §2/§3）。前端 `vue-router` 玩家端為 `^5.1`、Admin 端為 `^4.4`——歷史
版本落差，兩者功能均涵蓋所需路由特性，未規劃統一。

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
│   ├── achievement/ # 成就判定（事件驅動）+ Socket 即時推播
│   ├── gift-code/   # 玩家端兌換（建碼為 admin 高危路由）
│   ├── record/      # 管理後台紀錄查詢（登入/下注/交易，分頁 + 篩選）
│   ├── audit/        # IllegalPacketLog 落庫（簽章失敗/重放/逾時等）
│   ├── admin/       # 後台 API（2FA 中介層、審計日誌）
│   ├── monitor/     # systeminformation 採集 + 異常偵測接線
│   ├── dragon-gate/ # ★M29 射龍門：open（開門牌不動錢）/ bet（GETDEL 原子單步結算）
│   │   └── payout.ts             # 純函式：開門/判定介於-踩柱-門外/結算（Monte Carlo 可直測）
│   ├── high-low/    # ★M29 猜高低：deal/guess/continue/cash-out，RoundLock 序列化
│   │   └── payout.ts             # 純函式：合法猜測檢查、猜測比較、牌堆重洗門檻
│   └── blackjack/   # ★M29 二十一點：deal/hit/stand/double，RoundLock 序列化
│       └── payout.ts             # 純函式：點數計算、莊家補牌迴圈、勝負結算
├── sockets/         # Socket.IO 命名空間、事件註冊、簽章驗證中介層
├── jobs/            # BullMQ：jackpot-flush(10s)、leaderboard-refresh(5m)、daily-reset(00:00)、
│                    #   monitor-scan(10m)、timed-mute(限時禁言到期解除)、
│                    #   ★abandoned-round(2m，M29 孤兒回合清理：High-Low/Blackjack)、
│                    #   ★chat-cleanup(每日 04:30 Asia/Taipei，補上規劃稿原訂但長期缺漏的
│                    #   DB 端聊天訊息清理 job，2026-06-20 補上)
├── security/        # hmac.ts、nonce.ts、csprng.ts、anomaly.ts（異常下注偵測）、
│                    #   ★round-lock.ts（M29：多步驟回合序列化鎖，見 §5.9）、totp.ts
└── shared/          # 錯誤類別、常數、型別、★cards.ts（M29：標準 52 張牌 + Fisher-Yates 洗牌，
                       #   射龍門/High-Low/Blackjack 共用，CSPRNG 注入）
```

**模組鐵律**：除 `wallet` 外任何模組不得直接 UPDATE `users.balance`；所有遊戲結算呼叫 `wallet.debit()/credit()`，內部強制條件更新 + 交易 + 寫 BalanceTransaction。三款新遊戲（M29）同樣遵守此鐵律，且**沿用 `BetRecord` 表**（擴充 `GameType` enum + `detail` JSON 形狀）而不新增資料模型，詳見 03_DATABASE_DESIGN §2。

---

## 4. 前端架構

```
frontend/src/
├── api/            # axios 封裝：自動附 JWT、計算 HMAC 簽章、401→refresh 重試一次
│   └── endpoints/  # 按模組分檔：auth/wallet/slot/roulette/charm/daily/leaderboard/
│                    #   achievement/★dragon-gate/★high-low/★blackjack（M29）
├── socket/         # socket.io-client 單例 + 事件型別（共用 packages/shared）
├── stores/         # Pinia：auth, wallet, slot, roulette, chat, leaderboard, daily,
│                    #   charm, achievement, ★dragon-gate, ★high-low, ★blackjack（M29）
├── views/          # Lobby / Slot / Roulette / Leaderboard / Profile / Login /
│                    #   ★DragonGateView / ★HighLowView / ★BlackjackView（M29）
├── components/
│   ├── slot/       # ReelColumn（CSS transform 動畫，結果驅動）、CharmSlotBar、
│   │                #   PaytableModal、PityIndicator
│   ├── roulette/   # WheelCanvas、BetBoard、ChipSelector、PhaseTimer
│   └── common/     # JackpotTicker、ChatPanel、CoinDisplay、AchievementBadge、
│                    #   DailyTaskDrawer、★PlayingCard（M29：射龍門/High-Low/Blackjack
│                    #   共用撲克牌渲染，依 rank/suit 對應 `public/cards/` 真實撲克牌圖片）
└── router/
admin-frontend/      # 獨立 Vue app：登入(2FA)、玩家管理、Coin 調整、GiftCode、紀錄、監控
packages/shared/     # TS 型別：API DTO、Socket 事件 payload、Enum、★cards.ts（前後端單一來源）
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
- 頻率：Redis 兩層令牌桶 — burst 1 則/2s、分鐘桶 10 則/min；超限回實際錯誤碼 `RATE_LIMIT_BURST` / `RATE_LIMIT_MINUTE`（規劃稿原訂單一 `ERR_CHAT_RATE_LIMIT`，落地時依 `plugins/rate-limit.ts` 共用碼表校正，見 `docs/security-test-report.md` 落差記錄）。
- **自動禁言**（M28 後續修補，commit `3f0d512`）：分鐘桶連續被擋達 5 次 / 60 秒 → 自動限時禁言 5 分鐘；到期由 `jobs/timed-mute.job.ts`（BullMQ `timed-unmute`）以 Redis 期限標記做 supersession 防護自動解除（避免後續手動禁言被提前誤解除）。

### 5.9 多步驟回合鎖（RoundLock，M29）
- `security/round-lock.ts`：High-Low / Blackjack 的多步驟動作（deal/guess/continue/cash-out、deal/hit/stand/double）需要在多次請求之間保留「進行中一局」的 Redis 狀態，必須序列化同一玩家對同一回合的併發請求，否則會出現讀-改-寫競態（例如 `hit` 補兩張牌、或重複扣款）。
- 機制：取鎖 `SET key token NX PX ttlMs`（取不到視為「另一個請求正在處理」，直接拋 409 `OPTIMISTIC_LOCK_FAILED`，不排隊重試）；釋放用 Lua `RELEASE_IF_OWNER` 比對 token 才刪除，避免刪掉「鎖已過期、被別人重新搶到」的新鎖；釋放失敗不拋錯（鎖有 TTL 會自然過期）。
- 屬單一 Redis 實例鎖語義（與 roulette leader lock 的 `SET NX EX` 同款前例），非多節點 Redlock——本專案 Redis 為單一實例部署，已足夠安全；Redis 不可用時 fail-closed（直接收到例外，不靜默放行），與全專案防重放的一致原則相同。
- 射龍門不使用本機制：`bet` 是整回合唯一一次動錢操作，改用 `GETDEL`（讀出同時刪除）做單一原子操作即可，比鎖更簡單。

### 5.10 CSP 與安全標頭（commit `5423d6c`）
- `nginx/conf.d/security-headers.inc`：集中定義安全標頭，新增 **Content-Security-Policy**（v1.0 規劃稿原僅有 HSTS/X-Frame-Options/X-XSS-Protection，缺 CSP——X-XSS-Protection 已是現代瀏覽器棄用機制，CSP 才是實際防線）。
- 修正既有問題：`/admin` 與 `/` 下 `*.{js,css,woff,...}` 靜態資源 location 各自宣告 `add_header Cache-Control`，依 Nginx 繼承規則會導致外層 server 區塊的 HSTS/X-Frame-Options 等標頭整組遺失；改為 `include` 共用片段補回。
- 依賴 CVE 修補（commits `156602a`/`439aacd`/`a37bd8d`/`b910f10`）：esbuild（GHSA-gv7w-rqvm-qjhr）、ws（CVE-2026-48779）、form-data（CVE-2026-12143）透過根目錄 `package.json` 的 `overrides` 修補。

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
- ★（M29）孤兒回合清理每 2 分鐘掃描一次（`jobs/abandoned-round.job.ts`，介於 High-Low/Blackjack
  的 5 分鐘不活躍門檻與 30 分鐘 round TTL 之間，確保及時處理）；異常偵測 P99 更新（`monitor-scan`）
  每 10 分鐘；限時禁言解除（`timed-mute`）依個別到期時間觸發，皆與既有排程錯峰不衝突。

---

## 7. 部署架構（arm64）

### 7.1 docker-compose.arm64.yml 概念（已落地，圖中為實際 pinned tag）
```yaml
services:
  nginx:    image: nginx:1.27-alpine          # TLS 終結（自簽/certbot）、限流、CSP 等安全標頭、靜態檔
  app:      build: ./backend (target: runtime) # node:20-alpine 多階段建置，cluster ×2，platform: linux/arm64
  postgres: image: postgres:16.7-alpine
  redis:    image: redis:7.4.6-alpine          # --appendonly yes + maxmemory 200mb allkeys-lru
  migrate:  build: ./backend (target: deps)     # profile: migrate；含 prisma CLI，部署前一次性 migrate deploy
# 皆為官方 multi-arch 映像（含 linux/arm64），platform 明確指定；volumes 持久化 pg/redis/憑證
# healthcheck + depends_on(condition: service_healthy) 控制啟動順序（postgres → redis → app → nginx）
# 全部服務在 internal 橋接網路，只有 nginx 對外暴露 80/443
```
- 一鍵腳本：`scripts/deploy.sh`（環境檢查 → git pull → npm install → build 前端 → docker build → migrate service → up -d → 冒煙測試）、`scripts/backup.sh`（pg_dump + gzip，保留 7 份）、`scripts/restore.sh`（互動式還原）。
- `.env.example` 列出全部變數；`.env`/`.env.production` 進 `.gitignore`；JWT/AES 金鑰由 `scripts/gen-secrets.sh` 產生。
- 部署冒煙驗收：`scripts/smoke-test.js`（`npm run test:smoke`）對 Nginx /health → API 反代 → 註冊(PG) → 登入(Redis 金鑰) → HMAC spin → Socket.IO WSS 關鍵路徑做一次性驗收。

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
| 新遊戲沿用 `BetRecord`（M29） | 零 schema 變更、不必為每款遊戲建獨立表 | `detail` JSON 需各自定義形狀、查詢需依賴 `gameType` 過濾而非獨立表的型別約束 | 三款新遊戲玩法差異大但「下注 + 結算」骨架相同，獨立建表只是換一種重複；多遊戲長期若分化嚴重可再拆 |
| 射龍門用 `GETDEL` 單步原子、High-Low/Blackjack 用 RoundLock | 前者更簡單（無鎖開銷）；後者保留多步驟決策彈性 | RoundLock 為單實例鎖語義，非正式多節點 Redlock | 依各遊戲「動錢操作次數」決定：射龍門整回合僅一次動錢可用原子操作；後兩者跨多次請求維護同一局狀態，必須序列化 |
