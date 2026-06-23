# 專案資料夾結構（Monorepo）
**專案：Virtual Casino Sandbox｜版本 v1.1｜與 02_TDD.md §3/§4 模組劃分一一對應**

> v1.1：補上 M29（射龍門/High-Low/Blackjack）新增的後端模組、前端頁面與共用工具；
> 並校正一處與 v1.0 規劃不同的實際佈局——設計文件（本系列 01–05）實際落在獨立的
> `01to05/` 目錄，而非規劃稿設想的 `docs/` 之下；`docs/` 實際存放的是持續更新的
> `04_API_SPEC.md`、`PROJECT_STATE.md`、`project_context.md` 及安全報告（見 §7）。

---

## 0. 頂層總覽

```
Online-casino-on-Pi4/
├── 01to05/                  # ★實際路徑（非規劃稿的 docs/ 之下）：本系列設計文件
│                            #   01_GDD / 02_TDD / 03_DATABASE_DESIGN / 04_FOLDER_STRUCTURE / 05_MILESTONES
├── backend/                 # Node.js + TS 後端（API + Socket.IO + BullMQ）
├── frontend/                # 玩家端 Vue 3 SPA
├── admin-frontend/          # 管理後台 Vue 3 SPA（獨立 app，獨立登入 + 2FA）
├── packages/
│   └── shared/              # 前後端共用 TS 型別（DTO / Socket 事件 / Enum）— 單一真值來源
├── nginx/                   # 反向代理設定（TLS、限流、CSP 等安全標頭、靜態檔）
├── scripts/                 # 部署、備份、壓測、RTP 模擬、金鑰產生、安全演練腳本
├── docs/                    # 04_API_SPEC.md / PROJECT_STATE.md / project_context.md /
│                            #   security-test-report.md（持續更新文件）
├── docker-compose.yml       # 開發用（含熱重載 volume mount）
├── docker-compose.arm64.yml # 生產用（Pi 4，mem_limit、healthcheck、restart policy）
├── online casino.txt        # ★使用者原始需求簡述（專案發起文件，非規格書）
├── .env.example             # 全部環境變數範本（敏感值留空）
├── .env.production          # 生產機密值（已 gitignore，僅存在於部署主機本機）
├── .gitignore               # .env* / node_modules / dist / *.pem / pgdata
├── .prettierrc              # Prettier 全專案格式化規則
├── README.md                # 專案說明 + 快速啟動
└── package.json             # workspace root（npm workspaces）
```

> Monorepo 採 **npm workspaces**（不引入 turbo/nx，Pi 上與小團隊規模不需要）。`packages/shared` 被 backend、frontend、admin-frontend 三方引用，API DTO 與 Socket 事件 payload 改一處全專案同步。

---

## 1. backend/

```
backend/
├── prisma/
│   ├── schema.prisma            # 03_DATABASE_DESIGN：18 個邏輯分組 / 20 個 model（PostgreSQL，唯一權威）
│   ├── schema.sqlite.prisma     # ★雙 schema 之二：SQLite 開發用（enum/Json 降級為 String）
│   ├── migrations/              # 20260612_init（初始）、★20260620_add_new_game_types（M29）
│   └── seed.ts                  # 種子：jackpot 單行、護符池 12 枚、每日任務池 7 則、成就 12 個、Admin 帳號
├── src/
│   ├── cluster.ts               # node:cluster 入口，fork ≤2 workers，worker 崩潰自動重啟
│   ├── server.ts                # 單 worker 啟動：Fastify + Socket.IO + BullMQ consumer
│   ├── app.ts                   # Fastify 實例組裝：註冊 plugins → modules → error handler
│   ├── config/
│   │   ├── env.ts               # zod 驗證所有環境變數，缺漏即啟動失敗（fail loud）
│   │   └── constants.ts         # 賠率表、轉軸基礎權重表、回合時長、注額檔位；★射龍門/High-Low/Blackjack 規則常數（M29）
│   ├── plugins/                 # Fastify 插件（裝飾 app 實例）
│   │   ├── prisma.ts            # PrismaClient 單例 + graceful shutdown
│   │   ├── redis.ts             # ioredis 連線（主連線 + pub/sub 連線）
│   │   ├── auth.ts              # JWT 驗證 decorator（preHandler）
│   │   ├── hmac-guard.ts        # 簽章 + nonce + seq + 時間窗驗證（敏感路由 preHandler）
│   │   └── rate-limit.ts        # Redis 令牌桶（API 層第二道，Nginx 之後）
│   ├── modules/                 # 一模組 = routes + service + types（必要時 + payout 純函式）
│   │   ├── auth/                #   登入/註冊/refresh/登出、HMAC 金鑰協商與輪換
│   │   ├── user/                #   user.service.ts：個人頁輔助查詢
│   │   ├── wallet/              #   ★ 唯一動 balance 的模組：debit()/credit() 條件更新
│   │   ├── slot/
│   │   │   ├── loadout-compiler.ts  # 護符 → CompiledLoadout（基礎表×修正×幸運符號 + variants）
│   │   │   ├── sampler.ts           # rngInt + 累積權重二分查找
│   │   │   ├── payout.ts            # 賠付判定（wild 替代、二連、pity、幸運符號 ×1.5）
│   │   │   ├── slot.service.ts      # spin 主流程（單一 PG 交易編排）
│   │   │   └── slot.routes.ts
│   │   ├── roulette/                # round-machine/bet-validator/settle 實際合併為單檔，非原規劃三檔
│   │   │   ├── roulette.service.ts  # BETTING→LOCK→RESULT→COOLDOWN 狀態機 + 下注驗證 + 結算
│   │   │   ├── roulette.types.ts
│   │   │   └── roulette.gateway.ts  # Socket 事件出入口
│   │   ├── jackpot/             #   accumulate()(Redis INCRBY)、flush()、tryTriggerJackpot()/payout()(樂觀鎖)
│   │   ├── charm/               #   持有/裝備/卸下 → 觸發 loadout 重編譯 + 快取覆寫
│   │   ├── daily/               #   登入獎勵、任務進度（事件驅動累加）、幸運符號輪換 + daily.jobs.ts（00:00 重置，就近放在模組內）
│   │   ├── leaderboard/         #   讀物化視圖、寫每日快照
│   │   ├── chat/                #   過濾（URL/長度/轉義）、兩層令牌桶、Redis List 歷史（7d TTL）、自動禁言
│   │   ├── achievement/         #   ★成就判定（事件驅動 tryUnlock）+ Socket 即時推播
│   │   ├── gift-code/           #   ★玩家端兌換（建碼仍在 admin 高危路由）
│   │   ├── record/              #   ★管理後台紀錄查詢（登入/下注/交易，分頁 + 篩選）
│   │   ├── audit/               #   ★illegal-packet.service.ts：IllegalPacketLog 落庫（fire-and-forget）
│   │   ├── admin/               #   後台 API：totp-guard preHandler、審計日誌中介層、公告、Gift Code 建碼
│   │   ├── monitor/             #   systeminformation：CPU/RAM/溫度/磁碟/線上數 + 異常偵測串接
│   │   ├── dragon-gate/         #   ★M29：open（開門牌不動錢）/ bet（GETDEL 單步原子結算）
│   │   │   └── payout.ts            # 純函式：開門/gap 判定/倍率表/結算（Monte Carlo 可直測）
│   │   ├── high-low/            #   ★M29：deal/guess/continue/cash-out，RoundLock 序列化
│   │   │   └── payout.ts            # 純函式：合法猜測檢查/猜測比較/牌堆重洗門檻（港自 pokergame）
│   │   └── blackjack/           #   ★M29：deal/hit/stand/double，RoundLock 序列化
│   │       └── payout.ts            # 純函式：點數計算/莊家補牌迴圈/勝負結算（港自 pokergame）
│   ├── sockets/
│   │   ├── index.ts             # Socket.IO 初始化：redis-adapter、握手 JWT 驗證、連線數上限 200
│   │   ├── middleware.ts        # 遊戲事件層 HMAC 簽章驗證（與 HTTP 同邏輯共用 security/）
│   │   └── events.ts            # 事件名稱常數（鏡像 packages/shared，backend 暫無法直接 import .ts 入口）
│   ├── jobs/
│   │   ├── queues.ts            # BullMQ queue 共用連線工廠（createJobConnection）
│   │   ├── jackpot-flush.job.ts     # 10s flush + 5s tick repeatable
│   │   ├── leaderboard-refresh.job.ts # 5m REFRESH MATERIALIZED VIEW CONCURRENTLY
│   │   ├── monitor-scan.job.ts      # 10m：異常偵測 NET_WIN P99 快取更新
│   │   ├── timed-mute.job.ts        # 限時禁言到期自動解除（supersession 防護）
│   │   ├── abandoned-round.job.ts   # M29：每 2 分鐘掃描 High-Low/Blackjack 孤兒回合並強制結算
│   │   └── ★chat-cleanup.job.ts     # 2026-06-20 補上：每日 04:30 Asia/Taipei 刪除超過 7 天的
│   │       DB ChatMessage（與 Redis history 的 7 天 TTL 互不依賴）；先前缺漏的「已知缺口」已補齊
│   │       （daily-reset 實際放在 modules/daily/daily.jobs.ts，非本目錄）
│   ├── security/
│   │   ├── csprng.ts            # ★ 全專案唯一亂數出口（ESLint 禁 Math.random）
│   │   ├── hmac.ts              # canonical 組字串、timingSafeEqual 比對、金鑰存取
│   │   ├── nonce.ts             # SET NX EX + seq Lua script
│   │   ├── totp.ts              # otplib 封裝 + secret AES-256-GCM 加解密
│   │   ├── anomaly.ts           # 滑動視窗異常下注偵測（BET_RATE/WIN_RATE/NET_WIN_OUTLIER）→ flagged
│   │   └── ★round-lock.ts       # M29：多步驟回合序列化鎖（SET NX PX + Lua release-if-owner，見 02_TDD §5.9）
│   └── shared/
│       ├── errors.ts            # AppError 階層（含錯誤碼，回應永不洩漏 stack）
│       ├── validation.ts        # zod parse() 包裝（支援 .default()/.coerce 分頁 schema）
│       └── ★cards.ts            # M29：標準 52 張牌 + Fisher-Yates 洗牌（CSPRNG 注入），三款新遊戲共用
├── test/
│   ├── unit/                    # sampler、payout（各遊戲）、loadout-compiler、hmac…（純函式優先覆蓋）
│   ├── integration/             # spin/roulette/gift-code 全流程、雙花競態、Jackpot 並發派彩
│   └── helpers/                 # e2e-fakes.ts（in-memory fake prisma/redis）、e2e-app.ts
├── Dockerfile                   # node:20-alpine 多階段：deps → build → runtime（arm64 相容；migrate 服務借用 deps 階段）
├── eslint.config.js             # ★ESLint 9 flat config（非規劃稿的 .eslintrc.cjs）：禁 Math.random + 禁繞過 wallet 改 balance
├── tsconfig.json                # strict: true
└── package.json
```

## 2. frontend/（玩家端）

```
frontend/
├── src/
│   ├── main.ts / App.vue        # App.vue：全域 ChatPanel 掛載（登入後）+ Toast 容器
│   ├── api/
│   │   ├── http.ts              # axios 實例：JWT 附加、401→refresh 單次重試、錯誤碼映射
│   │   ├── sign.ts              # WebCrypto HMAC-SHA256 簽章（key 僅存記憶體；需 HTTPS 或 localhost，開發時用 vite --https 或信任自簽憑證）
│   │   └── endpoints/           # 按模組分檔：auth/wallet/slot/roulette/charm/daily/leaderboard/
│   │                             #   achievement/★dragon-gate/★high-low/★blackjack（M29）
│   ├── socket/
│   │   └── client.ts            # socket.io-client 單例：重連、事件型別綁定
│   ├── stores/                  # Pinia：auth/wallet/slot/roulette/chat/leaderboard/daily/charm/
│   │                             #   achievement/★dragon-gate/★high-low/★blackjack（M29）
│   ├── views/                   # LobbyView/SlotView/RouletteView/LeaderboardView/ProfileView/LoginView/
│   │                             #   ★DragonGateView/★HighLowView/★BlackjackView（M29）
│   ├── components/
│   │   ├── slot/                # ReelColumn（結果驅動 CSS 動畫）、CharmSlotBar、PityIndicator、PaytableModal
│   │   ├── roulette/            # WheelCanvas、BetBoard、ChipSelector、PhaseTimer
│   │   └── common/              # JackpotTicker＊、ChatPanel、CoinDisplay、AchievementBadge、
│   │                             #   DailyTaskDrawer、★PlayingCard（M29：依 rank/suit 對應
│   │                             #   `public/cards/` 真實撲克牌圖片，card=null 時顯示牌背）
│   └── router/index.ts          # 路由守衛：未登入 → /login
├── public/
│   ├── symbols/                 # 老虎機 8 符號 PNG（pixel art）+ slot-up/slot-down（拉霸把手）
│   ├── cards/                   # ★M29：52 張真實撲克牌 PNG（PlayingCard.vue 依 rank_of_suit.png 對應）
│   └── audio/                   # 背景音樂（BGM）
├── Dockerfile                   # 多階段：vite build → 產物由 nginx 容器掛載
├── vite.config.ts               # /api 與 /socket.io 開發代理
└── package.json
```

> ＊v1.0 規劃稿曾列出 `composables/`（useCountdown/useSocketEvent/useToast）、`HotBetsPanel.vue`、
> `AnnouncementBar.vue` 等獨立檔案，實作時對應功能（倒數、公告橫幅、熱門注型展示）改為直接寫在
> 各 View/Store 內（如 LobbyView 內嵌公告橫幅、PhaseTimer 自帶倒數邏輯），並未真正拆成這些檔案——
> 屬規劃與實作的細節落差，功能本身均已涵蓋。

## 3. admin-frontend/（管理後台）

```
admin-frontend/
├── src/
│   ├── api/
│   │   ├── http.ts              # axios 實例：JWT 附加、401→refresh 重試
│   │   └── admin.ts             # 全部管理後台 API 函式（單檔，非按實體分檔）
│   ├── stores/                  # 實際僅 2 個（非規劃稿的 adminAuth/players/records/monitor 四個）：
│   │   ├── auth.ts              #   useAdminAuthStore：accessToken/refreshToken/user + reverifyToken（記憶體）
│   │   └── ui.ts                #   useUiStore：Toast 佇列
│   ├── views/
│   │   ├── LoginView.vue        # 帳密 → TOTP/備用碼兩步
│   │   ├── PlayersView.vue      # 查詢/封鎖/禁言/Coin 調整（高危操作走 ReverifyDialog）
│   │   ├── GiftCodeView.vue     # 建碼（顯示一次即遮蔽）、核銷狀態列表
│   │   ├── RecordsView.vue      # 登入/下注/交易三分頁（共用篩選列 + 分頁）
│   │   ├── MonitorView.vue      # 線上數、活躍房間、Pi CPU/RAM/溫度/磁碟（10s 輪詢）
│   │   └── AnnouncementView.vue # CRUD + 刪除確認
│   └── components/              # AdminLayout（側邊欄佈局）、ReverifyDialog（TOTP 高危重驗彈窗）、
│                                 #   Pagination（非規劃稿的 DataTable/TotpDialog/AuditBadge）
└── package.json                 # 構建產物部署於 /admin 路徑（Nginx 另設 location）
```

## 4. packages/shared/

```
packages/shared/
├── src/
│   ├── dto/                     # 各 API request/response 型別（zod schema 同步導出）：
│   │                             #   admin / auth / charm / chat / daily / gift-code / jackpot /
│   │                             #   leaderboard / monitor / roulette / slot / user / wallet /
│   │                             #   ★blackjack / ★dragon-gate / ★high-low（M29）+ index.ts
│   ├── socket-events.ts         # 事件名稱常數 + payload 型別（slot:spin、roulette:bet、jackpot:won…）
│   ├── enums.ts                 # GameType（含 ★DRAGON_GATE/HIGH_LOW/BLACKJACK）/ CharmType / TxType…
│   ├── constants.ts             # 注額檔位、訊息長度上限等前後端共用常數
│   ├── ★cards.ts                # M29：Card/Rank/Suit 型別鏡像（供 PlayingCard.vue 等前端元件使用）
│   └── index.ts                 # 重新導出（backend 因 rootDir 限制暫無法直接 import，僅前端使用）
└── package.json
```

## 5. nginx/

```
nginx/
├── nginx.conf                   # worker_processes auto、epoll、gzip、server_tokens off
├── conf.d/
│   ├── ratelimit.conf           # limit_req_zone：api 30r/s、auth 10r/min、admin_api 20r/s；limit_conn_zone per_ip 50
│   ├── tls.conf                 # TLS 1.2/1.3、ECDHE+AES-GCM/CHACHA20、session cache、OCSP stapling
│   ├── ★security-headers.inc    # M18：HSTS/X-Content-Type-Options/X-Frame-Options/Referrer-Policy + ★CSP
│   │                             #   （集中片段供多個 location include，修正先前 Cache-Control 覆蓋繼承遺失安全標頭的問題）
│   └── site.conf                # 80→301→443、/health、/api 反代、/socket.io WS 反代、/admin 與 / 靜態檔（皆 include security-headers.inc）
└── certs/                       # 憑證掛載點（.gitignore；certbot 或 gen-cert.sh 自簽產出）
```

## 6. scripts/

```
scripts/
├── deploy.sh                    # 環境檢查 → git pull → npm install → build 前端 → docker build → migrate service → up -d → 冒煙
├── backup.sh                    # pg_dump | gzip → 保留 7 份輪替（建議掛 cron 03:00）
├── restore.sh                   # 還原指定備份（互動確認 / 可傳路徑非互動執行）
├── gen-secrets.sh               # 產生 JWT_SECRET / AES_256_GCM_KEY / 初始 Admin 密碼 → 寫入 .env[.production]
├── gen-cert.sh                  # 自簽憑證（EC P-256，無網域場景）；有網域改用 certbot
├── cf-allowlist.sh              # 可選：ipset + iptables 僅放行 Cloudflare IP 段
├── sysctl-hardening.sh          # SYN cookies、somaxconn、rp_filter、kptr_restrict 等核心參數
├── simulate-rtp.ts              # ★ 蒙地卡羅 1,000 萬次驗證 RTP 90~94%（worker_threads 並行；權重改動後必跑）
├── ★smoke-test.js               # M28：部署堆疊冒煙（Nginx→API→PG/Redis→HMAC spin→Socket.IO WSS）
├── loadtest/                    # k6 腳本：k6-spin.js / k6-roulette.js / k6-mixed.js（各 200 VU）
└── ★security-attacks/           # M27 安全演練共用工具（攻擊腳本本身未隨公開版發布，見 docs/security-test-report.md）
    └── lib/common.js            #   註冊登入、HMAC 簽章、socket 連線、IllegalPacketLog 落庫檢查（smoke-test.js 共用）
```

> `backend/scripts/audit-balance.ts`（注意：不在本目錄，而在 `backend/` 自己的 `scripts/`
> 子目錄）：02_TDD §5.6 對帳腳本，`npm run -w backend audit:balance` 執行。

## 7. docs/

> ★與 v1.0 規劃稿不同：01_GDD/02_TDD/03_DATABASE_DESIGN/04_FOLDER_STRUCTURE/05_MILESTONES
> 五份設計文件實際落在獨立的根目錄 `01to05/`（本系列文件自身），並非規劃稿設想的 `docs/` 之下。
> `docs/` 實際只放「持續更新」的營運/規格文件：

```
docs/
├── 04_API_SPEC.md               # ★M05 產出，持續校訂：REST 路由 + Socket 事件全表 + 錯誤碼總表
├── PROJECT_STATE.md             # ★每個 Milestone 完成後更新；所有開發前必讀（見 §8 範例）
├── project_context.md           # ★快速入門文件：給新加入開發者/AI 助手的專案現況速覽
└── security-test-report.md      # ★M27 安全演練報告（5 類攻擊向量 + 落庫佐證 + 落差記錄）
```

> 規劃稿原列的 `adr/`（重大決策紀錄）目錄實際未建立——架構決策改以 02_TDD §8（取捨表）與
> PROJECT_STATE.md 各 Milestone 章節的行文記錄，未採獨立 ADR 檔案形式。

---

## 8. PROJECT_STATE.md 模板（隨 M01 一併建立；實際格式較規劃稿豐富）

實際每個 Milestone 章節為「完成內容敘述 + 變更檔案列點 + 測試結果 + 驗收 DoD checklist」，
而非規劃稿設想的純摘要式單行清單；檔案末尾固定維護一段「目前進度」摘要，格式示例（節錄自
M29 實際內容，見 `docs/PROJECT_STATE.md`）：

```markdown
# PROJECT_STATE

## M29：莊家 vs 閒家新遊戲——射龍門 / High-Low / Blackjack（2026-06-20）

（完成內容敘述：規則摘要、複用既有模式、新增檔案、測試新增條數…）

## M29 驗收（DoD）
- [x] ...

---

- 進度：M29（M01–M28 全部完成，v1.0.0 已發布；M29 為 Phase 2 第一類新遊戲）
- 資料庫 migration 版本：20260620_add_new_game_types
- API 狀態：…既有模組 ✅… / dragon-gate ✅ / high-low ✅（前端待補）/ blackjack ✅（前端待補）
- 已知 Bug：無新增（既有：Pi 4 真機端對端待補驗）
- TODO（下一步）：射龍門已有完整前端；High-Low/Blackjack 前端待補
- 最近 Commit 建議：feat(casino): 新增 Blackjack 二十一點（莊家 vs 閒家第三款，動作最多）
```
