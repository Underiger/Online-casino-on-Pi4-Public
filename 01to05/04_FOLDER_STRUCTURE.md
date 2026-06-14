# 專案資料夾結構（Monorepo）
**專案：Virtual Casino Sandbox｜版本 v1.0｜與 02_TDD.md §3/§4 模組劃分一一對應**

---

## 0. 頂層總覽

```
virtual-casino-sandbox/
├── backend/                 # Node.js + TS 後端（API + Socket.IO + BullMQ）
├── frontend/                # 玩家端 Vue 3 SPA
├── admin-frontend/          # 管理後台 Vue 3 SPA（獨立 app，獨立登入 + 2FA）
├── packages/
│   └── shared/              # 前後端共用 TS 型別（DTO / Socket 事件 / Enum）— 單一真值來源
├── nginx/                   # 反向代理設定（TLS、限流、靜態檔）
├── scripts/                 # 部署、備份、壓測、RTP 模擬、金鑰產生
├── docs/                    # 01_GDD / 02_TDD / 03_DATABASE_DESIGN / API_SPEC / PROJECT_STATE
├── docker-compose.yml       # 開發用（含熱重載 volume mount）
├── docker-compose.arm64.yml # 生產用（Pi 4，mem_limit、healthcheck、restart policy）
├── .env.example             # 全部環境變數範本（敏感值留空）
├── .gitignore               # .env / node_modules / dist / *.pem / pgdata
├── README.md                # 專案說明 + 快速啟動
└── package.json             # workspace root（npm workspaces）
```

> Monorepo 採 **npm workspaces**（不引入 turbo/nx，Pi 上與小團隊規模不需要）。`packages/shared` 被 backend、frontend、admin-frontend 三方引用，API DTO 與 Socket 事件 payload 改一處全專案同步。

---

## 1. backend/

```
backend/
├── prisma/
│   ├── schema.prisma            # 03_DATABASE_DESIGN 的 17 張表
│   ├── migrations/              # Prisma Migrate 版本目錄（含 raw SQL：物化視圖、BRIN）
│   └── seed.ts                  # 種子：jackpot 單行、初版護符池、每日任務池、成就、Admin 帳號
├── src/
│   ├── cluster.ts               # node:cluster 入口，fork ≤2 workers，worker 崩潰自動重啟
│   ├── server.ts                # 單 worker 啟動：Fastify + Socket.IO + BullMQ consumer
│   ├── app.ts                   # Fastify 實例組裝：註冊 plugins → modules → error handler
│   ├── config/
│   │   ├── env.ts               # zod 驗證所有環境變數，缺漏即啟動失敗（fail loud）
│   │   └── constants.ts         # 賠率表、轉軸基礎權重表、回合時長、注額檔位
│   ├── plugins/                 # Fastify 插件（裝飾 app 實例）
│   │   ├── prisma.ts            # PrismaClient 單例 + graceful shutdown
│   │   ├── redis.ts             # ioredis 連線（主連線 + pub/sub 連線）
│   │   ├── auth.ts              # JWT 驗證 decorator（preHandler）
│   │   ├── hmac-guard.ts        # 簽章 + nonce + seq + 時間窗驗證（敏感路由 preHandler）
│   │   └── rate-limit.ts        # Redis 令牌桶（API 層第二道，Nginx 之後）
│   ├── modules/                 # 一模組 = routes + service + （必要時）repository
│   │   ├── auth/                #   登入/註冊/refresh/登出、HMAC 金鑰協商與輪換
│   │   ├── user/                #   個人頁、成就查詢
│   │   ├── wallet/              #   ★ 唯一動 balance 的模組：debit()/credit() 條件更新
│   │   ├── slot/
│   │   │   ├── loadout-compiler.ts  # 護符 → CompiledLoadout（基礎表×修正×幸運符號 + variants）
│   │   │   ├── sampler.ts           # rngInt + 累積權重二分查找
│   │   │   ├── payout.ts            # 賠付判定（wild 替代、二連、pity、幸運符號 ×1.5）
│   │   │   ├── slot.service.ts      # spin 主流程（單一 PG 交易編排）
│   │   │   └── slot.routes.ts
│   │   ├── roulette/
│   │   │   ├── round-machine.ts     # BETTING→LOCK→RESULT→COOLDOWN 狀態機（setTimeout 驅動）
│   │   │   ├── bet-validator.ts     # 注型/上限/階段時窗驗證
│   │   │   ├── settle.ts            # 批量結算（單交易逐玩家條件更新）
│   │   │   └── roulette.gateway.ts  # Socket 事件出入口
│   │   ├── jackpot/             #   accumulate()(Redis INCRBY)、flush()、tryWin()(樂觀鎖)
│   │   ├── charm/               #   持有/裝備/卸下 → 觸發 loadout 重編譯 + 快取覆寫
│   │   ├── daily/               #   登入獎勵、任務進度（事件驅動累加）、幸運符號輪換
│   │   ├── leaderboard/         #   讀物化視圖、寫每日快照
│   │   ├── chat/                #   過濾（URL/長度/轉義）、令牌桶、Redis List 歷史
│   │   ├── admin/               #   後台 API：totp-guard preHandler、審計日誌中介層
│   │   └── monitor/             #   systeminformation：CPU/RAM/溫度/磁碟/線上數
│   ├── sockets/
│   │   ├── index.ts             # Socket.IO 初始化：redis-adapter、握手 JWT 驗證、連線數上限 200
│   │   ├── middleware.ts        # 遊戲事件層 HMAC 簽章驗證（與 HTTP 同邏輯共用 security/）
│   │   └── events.ts            # 事件名稱常數（從 packages/shared 匯入）
│   ├── jobs/
│   │   ├── queues.ts            # BullMQ queue 定義（共用 Redis 連線）
│   │   ├── jackpot-flush.job.ts     # 10s repeatable + txcount 觸發
│   │   ├── leaderboard-refresh.job.ts # 5m REFRESH MATERIALIZED VIEW CONCURRENTLY
│   │   ├── daily-reset.job.ts       # 00:00 Asia/Taipei：任務重置、幸運符號、loadout 快取 SCAN 批量失效（初版可接受；玩家數 > 500 時建議改為全域版本號避免 SCAN CPU 尖峰）
│   │   └── chat-cleanup.job.ts      # 04:30 清 7 天前訊息
│   ├── security/
│   │   ├── csprng.ts            # ★ 全專案唯一亂數出口（ESLint 禁 Math.random）
│   │   ├── hmac.ts              # canonical 組字串、timingSafeEqual 比對、金鑰存取
│   │   ├── nonce.ts             # SET NX EX + seq Lua script
│   │   ├── totp.ts              # otplib 封裝 + secret AES-256-GCM 加解密
│   │   └── anomaly.ts           # 滑動視窗異常下注偵測 → flagged
│   └── shared/
│       ├── errors.ts            # AppError 階層（含錯誤碼，回應永不洩漏 stack）
│       └── tx.ts                # prisma.$transaction 包裝（統一逾時/重試策略）
├── test/
│   ├── unit/                    # sampler、payout、loadout-compiler、hmac（純函式優先覆蓋）
│   └── integration/             # spin 全流程、條件更新競態、Gift Code 重複兌換
├── Dockerfile                   # node:20-alpine 多階段：build → prune → runtime（arm64 相容）
├── .eslintrc.cjs                # 含 no-restricted-properties: Math.random；另加規則禁止直接 prisma.user.update 改餘額（需走 wallet 模組）
├── tsconfig.json                # strict: true
└── package.json
```

## 2. frontend/（玩家端）

```
frontend/
├── src/
│   ├── main.ts / App.vue
│   ├── api/
│   │   ├── http.ts              # axios 實例：JWT 附加、401→refresh 單次重試、錯誤碼映射
│   │   ├── sign.ts              # WebCrypto HMAC-SHA256 簽章（key 僅存記憶體；需 HTTPS 或 localhost，開發時用 vite --https 或信任自簽憑證）
│   │   └── endpoints/           # 按模組分檔的 API 函式（型別來自 packages/shared）
│   ├── socket/
│   │   └── client.ts            # socket.io-client 單例：重連、事件型別綁定
│   ├── stores/                  # Pinia：auth / wallet / slot / roulette / chat / leaderboard / daily
│   ├── views/                   # LobbyView / SlotView / RouletteView / LeaderboardView / ProfileView / LoginView
│   ├── components/
│   │   ├── slot/                # ReelColumn（結果驅動 CSS 動畫）、CharmSlotBar、PityIndicator、PaytableModal
│   │   ├── roulette/            # WheelCanvas、BetBoard、ChipSelector、PhaseTimer、HotBetsPanel
│   │   └── common/              # JackpotTicker、ChatPanel、CoinDisplay、AnnouncementBar、DailyTaskDrawer
│   ├── composables/             # useCountdown、useSocketEvent、useToast
│   └── router/index.ts          # 路由守衛：未登入 → /login
├── public/                      # 符號圖、音效（CC0 素材）
├── Dockerfile                   # 多階段：vite build → 產物由 nginx 容器掛載
├── vite.config.ts               # /api 與 /socket.io 開發代理
└── package.json
```

## 3. admin-frontend/（管理後台）

```
admin-frontend/
├── src/
│   ├── api/                     # 同 frontend 封裝 + TOTP code 注入器（高危操作攔截彈窗）
│   ├── stores/                  # adminAuth / players / records / monitor
│   ├── views/
│   │   ├── LoginView.vue        # 帳密 + TOTP 兩步
│   │   ├── PlayersView.vue      # 查詢/封鎖/禁言/Coin 調整（調整需重驗 TOTP）
│   │   ├── GiftCodeView.vue     # 建碼（顯示一次即遮蔽）、核銷紀錄
│   │   ├── RecordsView.vue      # 登入/下注/交易三分頁（分頁 + 篩選）
│   │   ├── MonitorView.vue      # 線上數、房間、Pi CPU/RAM/溫度（10s 輪詢）
│   │   └── AnnouncementView.vue
│   └── components/              # DataTable、TotpDialog、AuditBadge
└── package.json                 # 構建產物部署於 /admin 路徑（Nginx 另設 location）
```

## 4. packages/shared/

```
packages/shared/
├── src/
│   ├── dto/                     # 各 API request/response 型別（zod schema 同步導出，後端直接驗證）
│   ├── socket-events.ts         # 事件名稱常數 + payload 型別（slot:spin、roulette:bet、jackpot:won…）
│   ├── enums.ts                 # GameType / CharmType / TxType…（與 Prisma enum 對齊）
│   └── constants.ts             # 注額檔位、訊息長度上限等前後端共用常數
└── package.json
```

## 5. nginx/

```
nginx/
├── nginx.conf                   # worker_processes 2、gzip、基礎 header
├── conf.d/
│   ├── ratelimit.conf           # limit_conn perip 10 / limit_req 10r/s burst 20 / socket.io conn 5；/admin 路徑另設 burst 5 nodelay + perip 3
│   ├── tls.conf                 # TLS 1.2+、HSTS、ssl_ciphers；80 → 301 → 443
│   └── site.conf                # / → 玩家端、/admin → 後台、/api → app:3000、/socket.io → ip_hash upstream
└── certs/                       # 憑證掛載點（.gitignore；certbot 或自簽腳本產出）
```

## 6. scripts/

```
scripts/
├── deploy.sh                    # git pull → build → prisma migrate deploy → compose up -d
├── backup.sh                    # pg_dump | gzip → 保留 7 份輪替（建議掛 cron）
├── restore.sh                   # 還原指定備份（互動確認）
├── gen-secrets.sh               # 產生 JWT_SECRET / AES_KEY / 初始 Admin 密碼 → 寫入 .env
├── gen-cert.sh                  # 自簽憑證（無網域場景）；有網域改用 certbot
├── cf-allowlist.sh              # 可選：iptables 僅放行 Cloudflare IP 段
├── sysctl-hardening.sh          # SYN cookies、somaxconn 等核心參數
├── simulate-rtp.ts              # ★ 蒙地卡羅 1,000 萬次驗證 RTP 90~94%（權重改動後必跑）
└── loadtest/                    # k6 腳本：200 連線併發 spin / 輪盤滿房壓測
```

## 7. docs/

```
docs/
├── 01_GDD.md
├── 02_TDD.md
├── 03_DATABASE_DESIGN.md
├── 04_API_SPEC.md               # Milestone M05 產出：REST 路由 + Socket 事件全表
├── PROJECT_STATE.md             # ★ 每個 Milestone 完成後更新；所有開發前必讀
└── adr/                         # 重大決策紀錄（ADR-001-fastify-over-express.md …）
```

---

## 8. PROJECT_STATE.md 模板（隨 M01 一併建立）

```markdown
# PROJECT_STATE
- 進度：M04 / M26
- 資料庫 migration 版本：20260615_add_jackpot
- API 狀態：auth ✅ / wallet ✅ / slot 🚧 / roulette ⬜
- 已知 Bug：#3 refresh 競態（修復中）
- TODO（下一步）：M05 API 規格凍結
- 最近 Commit：feat(wallet): conditional debit with version bump
```
