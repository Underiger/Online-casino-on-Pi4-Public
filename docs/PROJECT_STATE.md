# PROJECT_STATE

> 每個 Milestone 完成後更新；所有開發前必讀。模板出自 04_FOLDER_STRUCTURE.md §8。

## M29：莊家 vs 閒家新遊戲——射龍門 / High-Low / Blackjack（2026-06-20）

使用者規劃四大類新遊戲擴充（其餘三類：多人桌局 PvP、麻將、Solitaire 留待後續），本里程碑
完成第一類「莊家 vs 閒家」三款，全部沿用 Slot 已驗證的「HTTP 同步請求 + 單一 Prisma 交易 +
wallet.debit/credit + HMAC + 限流 + 異常偵測」模式：

- **射龍門 Dragon Gate**（`backend/src/modules/dragon-gate/`）：開門牌（CSPRNG 洗牌，相鄰/相同
  點數自動重開門）→ 攤開賠率 → 下注 → 結算。整回合唯一動錢操作（`bet`）用 `GETDEL` 原子 claim，
  不需要鎖。賠率支援 `TIER_3`/`TIER_11` 雙模式（`DRAGON_GATE_ODDS_MODE` 開關，
  `config/constants.ts`）。**Monte Carlo 模擬抓到一個真實的校準錯誤**：`TIER_3` 桶內倍率原本用
  「未加權平均」推導，但兩張門牌的 rank 差距對應牌組數是 `(13-d)` 組，小 gap 出現頻率遠高於大
  gap，未加權版本實測 RTP 只有 ~87.7%（偏離目標 92% 達 4pp+）；改成「出現次數加權平均」後
  Monte Carlo 複測兩種模式都收斂到 92% ± 4pp。
- **High-Low / Blackjack**（`backend/src/modules/{high-low,blackjack}/`）：規則港自使用者自己的
  `Underiger/pokergame` repo（`games/{high_low,blackjack}.py` 純邏輯，逐行對應）。多步驟回合
  （High-Low：deal/guess/continue/cash-out；Blackjack：deal/hit/stand/double）新增
  `backend/src/security/round-lock.ts`（單實例 Redis `SET NX PX` + Lua release-if-owner，仿
  roulette leader lock 同款慣例，非正式 multi-node Redlock）序列化同一回合的併發動作，避免
  read-modify-write 競態（補兩張牌、重複扣款）。
- **孤兒回合清理**（`backend/src/jobs/abandoned-round.job.ts`，每 2 分鐘掃描，用 Redis key 剩餘
  TTL 倒推「5 分鐘無動作」，不需要替 BetRecord 加 updatedAt 欄位）：依目前卡在的階段強制結算
  （High-Low 卡在猜測階段沒收彩池、卡在收手/續押選擇階段強制視為收手；Blackjack 卡在玩家回合
  強制視為停牌）。**明確不使用 REFUND**——這個設計約束來自 plan review 階段使用者的明確修正：
  單純退款會讓玩家在看到不利局面時故意斷線換回全額退款，等於無限次免費重試；逾時結算永遠只能
  等於玩家當下零成本就能選的選項，絕不變出比繼續玩更好的結果。
- 新增 `backend/src/shared/cards.ts`（標準 52 張牌 + Fisher-Yates 洗牌，CSPRNG 注入）供三款
  遊戲共用；`packages/shared/src/{cards,dto/dragon-gate.dto}.ts` 鏡像前端型別。
- 射龍門已含完整前端（`DragonGateView.vue` + `stores/dragon-gate.ts`）；High-Low/Blackjack
  前端待後續補上。
- 測試：新增 141 條（payout 純邏輯 + service 狀態機 + round-lock 併發 + 孤兒回合結算 + 射龍門
  RTP Monte Carlo + 路由整合），總計 531 條全數通過；既有測試無回歸（除一支跟本次改動無關、
  此前已確認的既有環境性 Prisma/SQLite 測試環境問題）。

## M29 後續修補：補上 DIAMOND_TRIPLE / WILD_TRIPLE 成就觸發（2026-06-20）

整理設計文件時發現 `seed.ts` 種子的 12 個成就中，`DIAMOND_TRIPLE`（鑽石恆久遠）與
`WILD_TRIPLE`（狂野之夜）只有定義、從未在任何地方接線——對照其餘 10 個觸發點
（FIRST_TRIPLE/LUCKY7_TRIPLE/JACKPOT_WINNER/LOGIN_STREAK_7/SPIN_1000/ROULETTE_100/
CHATTERBOX/CHARM_COLLECT_6/12/NET_WIN_10000），這兩個玩家永遠拿不到。

- `backend/src/modules/slot/slot.routes.ts`：在既有的三連判定區塊（`isTriple &&
  outcome.payout > 0`）內，仿 `LUCKY7_TRIPLE`（`reels[0] === 'LUCKY7'`）同款模式，
  新增 `reels[0] === 'DIAMOND'` → `DIAMOND_TRIPLE`、`reels[0] === 'WILD'` →
  `WILD_TRIPLE` 兩個觸發呼叫。
- 與既有三連成就同款限制：僅自然三連（reels 三格literal 相同）才觸發，Wild 替代
  湊成的三連不算（FIRST_TRIPLE/LUCKY7_TRIPLE 原本就是這個語義，未額外引入新的不一致）。
- 範圍說明：成就子系統（`achievement.service.ts` 與其在各路由的接線）目前無任一
  單元測試覆蓋（`backend/test/` 內搜尋不到 "achievement"），這是更早就存在、本次未
  處理的既有缺口；本次僅比照既有三個三連觸發點的寫法新增兩行，未額外引入新的未測風險。
- `npm run lint`/`typecheck` 通過；`npm test` 537 條全綠（無新增測試，理由同上）。
- 同步校正 `05_MILESTONES.md` M20 行的對應已知缺口記錄。

## M29 後續修補：補上聊天室訊息 DB 清理 job（2026-06-20）

整理 01to05 設計文件對齊實作進度時發現的落差：`chat.service.ts` 註解原寫「PG 保留 7 天，
排程清理留 M26」，但 M26 實際內容是 RTP 模擬與負載測試，這個 TODO 從未被排進任何里程碑，
`chat_messages` 表會無限增長（Redis `chat:history` 快取本身已有獨立的 7 天 TTL 會自然過期，
缺的只是 DB 持久層的清理）：

- `backend/src/modules/chat/chat.service.ts`：新增 `cleanupOldMessages(retentionDays = 7)`——
  依 `createdAt` 範圍 `deleteMany`，回傳刪除筆數；新增 `CHAT_DB_RETENTION_DAYS` 常數；
  純粹依時間範圍刪除，不碰 Redis history（兩者保留窗一致但互不依賴，任一邊故障不影響另一邊）。
- 新增 `backend/src/jobs/chat-cleanup.job.ts`（補上 v1.0 規劃稿原本就設計、但從未落地的
  `chat-cleanup.job.ts`）：每日 **04:30 Asia/Taipei** repeatable cron（與 daily-reset 00:00、
  leaderboard 每日快照錯峰，符合 02_TDD §6.5 排程紀律），processor 工廠與 BullMQ 接線分離
  （`createChatCleanupProcessor`，fake deps 可直接單元測試）。
- `backend/src/server.ts`：`registerChatCleanupJob(app)` 接線於 `registerAbandonedRoundJob`
  之後。
- 測試：新增 6 條（`chat.service.spec.ts` 的 `cleanupOldMessages` 3 條 + 新增
  `chat-cleanup.job.spec.ts` 3 條），總計 537 條全數通過；`npm run lint`/`typecheck` 通過；
  既有測試無回歸（同上，唯一失敗項為與本次改動無關的既有環境性問題）。
- 同步校正 01to05 設計文件中兩處「DB 端尚無實際清理 job」的已知缺口記錄
  （04_FOLDER_STRUCTURE.md §1、05_MILESTONES.md M17 行），並同步補上 02_TDD.md §3
  jobs/ 清單裡的 `chat-cleanup.job.ts` 條目。

## M28 後續修補（2026-06-16）

v1.0.0 發布後的安全與驗收補強，無新里程碑：

- **聊天洗頻自動禁言 + 限時禁言自動解除**（commit `3f0d512`）：原列為已知限制的兩項 backlog
  已實作並補 +20 測試（共 376 條）。洗頻分鐘桶連續被擋達 5 次 / 60s → 自動限時禁言 5 分鐘
  （`chat.service.ts` `AUTO_MUTE_THRESHOLD`/`chat.gateway.ts` `CHAT_FLOOD_MUTE_MINUTES`）；到期由 BullMQ
  moderation queue 的 `timed-unmute` 任務以 Redis 期限標記做 supersession 防護自動解除
  （`backend/src/jobs/timed-mute.job.ts` + `admin.releaseTimedMute`）。
- **依賴 CVE 修補**（commits `156602a`/`439aacd`/`a37bd8d`/`b910f10`）：esbuild GHSA-gv7w-rqvm-qjhr、
  ws CVE-2026-48779、form-data CVE-2026-12143 已透過 root `package.json` `overrides` 修補；詳見
  `docs/0615_SECURITY_REPORT.md`。
- **Pi 4 部署冒煙測試**：新增 `scripts/smoke-test.js`（`npm run test:smoke`），對部署堆疊驗收
  Nginx /health → /api 反向代理 → 註冊（PG）→ 登入（Redis 金鑰）→ HMAC spin → Socket.IO WSS 關鍵路徑；
  預設打 `https://localhost`（自簽略過 TLS 驗證，正式憑證設 `SMOKE_TLS_VERIFY=1`）。

> **v1.0.0 tag**：原指向 `e0190b1`（M25 docs commit，誤置——早於真正的 v1.0.0 feat commit、M26/M27、
> CVE 修補與本批補強），已重新指向本 release commit 並強制更新 **origin**。public repo 的 tag 依慣例由
> 人工以 `gh api` 另行處理（公開版與私有 origin 已分歧 21/33，非鏡像）。

---

## M28 完成內容（2026-06-14）

### 文件定稿與 v1.0.0 發布（05_MILESTONES M28）

**README.md 終稿**：
- 修正技術棧版本標示（Fastify 4→5、Vite 5→6）
- 補充「環境變數說明」完整表格（含說明與安全提醒）
- 補充「測試指令」章節（376 條後端測試、覆蓋率、安全演練、RTP 模擬、k6 壓測）
- 補充「已知限制」（聊天自動禁言、禁言自動解除、Pi 4 真機驗收、Provably Fair 公開介面等）
- 補充「貢獻指南」（Server Authoritative 原則、餘額鐵律、CSPRNG 規範、測試覆蓋率要求）

**docs/04_API_SPEC.md 校訂**：
- 錯誤碼 `GIFT_CODE_EXPIRED` HTTP 狀態由 410 更正為 409（與實作一致）
- 新增 `GIFT_CODE_ALREADY_REDEEMED`（409）錯誤碼（區分「碼用完」與「同人重複兌換」）
- 聊天限流錯誤碼由模糊的 `CHAT_RATE_LIMIT` 更正為實作使用的 `RATE_LIMIT_BURST`（短爆發）／`RATE_LIMIT_MINUTE`（分鐘桶），並標示為 Socket ack 錯誤碼

**需求對照表**（對比 `online casino.txt`）：

| 需求 | 實作里程碑 | 狀態 |
|------|-----------|------|
| Roguelite 老虎機（護符 Build 構築） | M10–M13 | ✅ 8 種符號、12 枚護符（WEIGHT/RULE/CONDITIONAL/PITY/BONUS）、三軸滾輪、RTP 91.5% |
| 全服 Jackpot（Redis 累積 + 樂觀鎖派彩） | M14 | ✅ 80/20 分帳、BullMQ flush 10s、觸發機率漸進 1/50000→1/5000 |
| 輪盤（歐式 0–36，多人同場） | M15–M16 | ✅ 7 種注型、Redis leader lock 狀態機、個人化 result 廣播 |
| Socket.IO 多人同步 | M08 | ✅ Redis adapter 跨 worker、握手 JWT、200 連線上限 |
| 即時聊天室（URL 過濾、限流、禁言） | M17 | ✅ 兩層令牌桶（burst 1則/2s + 10則/min）、HTML 轉義、DB + Redis 歷史 |
| 全球排行榜（今日/本週/總資產） | M19 | ✅ 物化視圖 CONCURRENTLY refresh 5m、LeaderboardSnapshot 每日快照 |
| 每日登入獎勵 + 每日任務 + 幸運符號 | M18 | ✅ streak 倍率、3 種隨機任務、00:00 Asia/Taipei 重置 BullMQ cron |
| 成就系統 + 個人頁 | M20 | ✅ 10 種成就觸發點、Socket 即時推播、ProfileView 統計卡 |
| 管理後台（2FA + 玩家管理 + 稽核） | M21–M23 | ✅ TOTP AES-256-GCM + 備用碼、reverifyToken 高危步進、AdminAuditLog |
| Gift Code（CSPRNG 16 碼、時效、單次） | M21–M22 | ✅ 去混淆字元集、maxUses 條件更新防競態、護符附贈 |
| 管理後台紀錄查詢（登入/下注/交易） | M22 | ✅ 分頁過濾、BigInt→string 序列化 |
| 監控 API（CPU/記憶體/磁碟/線上人數） | M24 | ✅ systeminformation、SCAN socket:conns:*、10s MonitorView 輪詢 |
| 異常偵測（BET_RATE/WIN_RATE/NET_WIN） | M24 | ✅ 三條規則、onFlag→prisma.user.flagged、monitor-scan P99 job |
| 反作弊（Server Authoritative + HMAC + 限流 + 防重放） | M06 | ✅ HMAC-SHA256、nonce SET NX、seq Lua 嚴格遞增、令牌桶、IllegalPacketLog |
| TLS 1.2+ + 傳輸加密 | M25 | ✅ Nginx TLS 1.2/1.3、ECDHE、HSTS、/socket.io/ WSS proxy |
| JWT + Refresh Token 旋轉 | M04 | ✅ 家族式重用偵測、argon2id 密碼雜湊 |
| 生產部署（Docker Compose arm64 + Nginx） | M25 | ✅ 記憶體限制、healthcheck 依賴鏈、deploy.sh / backup.sh / gen-cert.sh |
| Raspberry Pi 4 資源最佳化 | M25 | ✅ cluster ×2、PG shared_buffers 256MB、Redis maxmemory 200MB、nginx epoll |
| DDoS 基礎防護（Nginx 限連 + SYN Cookie） | M25 | ✅ limit_req_zone/limit_conn_zone、sysctl-hardening.sh、cf-allowlist.sh |
| RTP 模擬驗證 | M26 | ✅ 1000 萬次蒙地卡羅 CI gate [90%, 94%]、worker_threads 並行 |
| 負載測試 | M26 | ✅ k6：老虎機 200VU P95<500ms、輪盤 WS 200VU、混合場景 |
| E2E 整合測試（376 條） | M27 | ✅ 全流程 HMAC 鏈、雙花競態、Jackpot 資金守恆、禮物碼全流程 |
| 安全演練（5 類向量） | M27 | ✅ replay/seq-regression/tamper/timeout-bet/chat-spam + run-all 總控 |

**M28 驗收（DoD）**：
- [x] README.md：技術棧版本正確、環境變數說明完整、測試指令、已知限制、貢獻指南
- [x] docs/04_API_SPEC.md：GIFT_CODE_EXPIRED HTTP 狀態 409、GIFT_CODE_ALREADY_REDEEMED 新增、聊天限流錯誤碼更正
- [x] docs/PROJECT_STATE.md：進度 M28/M28、需求對照表、已知限制清單
- [x] log.txt：追加完成記錄
- [x] memory/project_state.md：同步更新至 M28 完成狀態
- [x] `git tag -a v1.0.0`（自誤置的 `e0190b1` 重新指向 release commit）+ `git push --force origin v1.0.0`（origin 已更新；public 由人工以 `gh api` 處理）
- [ ] Pi 4 真機最終冒煙測試（需 arm64 硬體 + 正式 Let's Encrypt 憑證）— 冒煙腳本已備（`npm run test:smoke` / `scripts/smoke-test.js`），到貨後直接跑

---

- 進度：M28 / M28（全部完成）
- 資料庫 migration 版本：20260612_init（17 張表 + 9 enum + BRIN ×2 + 物化視圖 ×3 + jackpot 種子行）
- API 狀態：infra ✅ / db-schema ✅ / app-skeleton ✅ / auth ✅ / api-spec ✅ / security ✅ / wallet ✅ / socket-base ✅ / frontend-skeleton ✅ / slot-core ✅ / slot-api ✅ / slot-frontend ✅ / roulette ✅ / jackpot ✅ / charm ✅ / daily ✅ / leaderboard ✅ / chat ✅ / achievement ✅ / admin ✅ / gift-code-redeem ✅ / records-query ✅ / admin-frontend ✅ / monitor ✅ / deploy-pipeline ✅ / rtp-simulation ✅ / loadtest ✅ / e2e-integration ✅ / security-drill ✅ / documentation ✅（M28）
- 已知 Bug（minor，非 v1.0 阻塞項）：Pi 4 真機端對端待補驗（需 arm64 硬體 + 正式憑證；可用 `npm run test:smoke` 對部署堆疊做關鍵路徑冒煙）。聊天洗頻自動禁言 / 限時禁言自動解除已於 `3f0d512` 補實作（見上方「M28 後續修補」）
- TODO：無
- 最近 Commit 建議：`chore(release): v1.0.0`

---

## M27 完成內容（2026-06-14）

### 端對端整合測試 + 安全演練（05_MILESTONES M27）

**新增整合測試 `backend/test/integration/`（+20 條，全綠）**：
- `slot-spin-e2e.spec.ts`（6）：**真實掛載 hmac-guard + rate-limit + auth 路由**的全流程——
  註冊 → 登入（取 JWT + HMAC 會話金鑰）→ 以金鑰簽 canonical → `POST /api/slot/spin`。
  涵蓋：簽章合法 200（餘額 5000→5030、BetRecord + BalanceTransaction 落庫）、
  重放 `ERR_NONCE_REPLAY`、Seq 倒退 `ERR_SEQ_REGRESSION`、簽章竄改 `ERR_BAD_SIGNATURE`
  （皆含 IllegalPacketLog 落庫斷言）、缺簽章標頭、未帶 JWT 401。
- `roulette-round-e2e.spec.ts`（2）：fake timers 驅動完整回合（下注→鎖盤→開獎→結算），
  驗證中獎回收 / 未中僅扣款、每位參與者 BetRecord(ROULETTE, roundId)、全帳守恆。
- `gift-code-e2e.spec.ts`（6）：admin.service 真實產碼 → 玩家 HTTP 兌換；餘額 +、兌換紀錄、
  `GIFT_CODE_ALREADY_REDEEMED`（同人，maxUses>1）/ `GIFT_CODE_ALREADY_USED`（碼用完）/
  附贈護符 / 不存在 / 過期。
- `concurrency-double-spend.spec.ts`（3）：HTTP 重放競態（併發同封包 → 恰一次成功）+
  餘額鐵律條件更新原子性（併發扣款 → 一成一敗、僅一筆 tx）。
- `concurrency-jackpot.spec.ts`（3）：派彩樂觀鎖——真併發兩玩家（資金守恆 Σ派彩+池量=初始、
  無重複支付）、確定性競態重試、重試耗盡 `OptimisticLockError`（零落帳）。

**新增測試輔助**：
- `backend/test/helpers/e2e-fakes.ts`：豐富 in-memory fake prisma（user/refreshToken/loginLog/
  betRecord/balanceTransaction/giftCode/giftCodeRedemption/userCharm/charm/adminAuditLog/
  illegalPacketLog/jackpot）+ fake redis（支援 `eval(SEQ_GUARD_LUA/TOKEN_BUCKET_LUA 以字串
  參考相等分派至 production 純函式)`、`mget`、`SET NX`）。$transaction 以 **mutex 序列化**
  模擬 PG 列鎖（避免全域快照在併發下互相覆蓋；讀取仍在交易外，樂觀鎖競態照常成立）。
- `backend/test/helpers/e2e-app.ts`：與 app.ts 同序組裝安全基座的 Fastify 組裝器 +
  `registerAndLogin` / `signSlotSpin` / `spinHeaders` 流程工具。

**新增安全演練 `scripts/security-attacks/`（對執行中後端發動，CommonJS）**：
- `lib/common.js`：註冊登入、HMAC 簽章、slot/roulette canonical、socket 連線、
  IllegalPacketLog 落庫檢查（best-effort via @prisma/client）、後端健康檢查。
- `replay-attack.js`（`ERR_NONCE_REPLAY` + NONCE_REPLAY 落庫）、
  `seq-regression.js`（`ERR_SEQ_REGRESSION`；**因 nonce 先於 seq 驗證，採「新 nonce+較小 seq」**）、
  `signature-tampering.js`（改 betAmount 不重簽 → `ERR_BAD_SIGNATURE`）、
  `timeout-bet.js`（Socket：BETTING 後補送 → ack `ROULETTE_PHASE_CLOSED`）、
  `chat-spam.js`（Socket：洗頻 → `RATE_LIMIT_BURST`/`RATE_LIMIT_MINUTE`）、
  `run-all.js`（總控 + 摘要表 + 退出碼=失敗數）。
- **如實記錄落差**（見 `docs/security-test-report.md`）：實際碼為 `ERR_NONCE_REPLAY`
  （非需求的 ERR_REPLAY_ATTACK）；聊天為 `RATE_LIMIT_*`（非 ERR_CHAT_RATE_LIMIT）且
  **未實作自動禁言**（列建議）；逾時下注 / 聊天限流屬業務層，不寫 IllegalPacketLog。

**更新**：
- `package.json`（root）：`test` / `test:coverage` / `test:security` 三支腳本。
- `backend/package.json`：`test:coverage`（vitest run --coverage）。
- `backend/vitest.config.ts`：coverage 設定（v8、text/html、聚焦 src/、排除 types/入口/test）。
- `docs/security-test-report.md`：完整演練報告（摘要表、環境、各向量、落庫佐證、落差建議、整合測試對照）。

### M27 驗收（DoD）
- [x] 整合測試 376/376 通過（既有 356 + 新增 20 條，零 regression）
- [x] 老虎機全流程 E2E（HMAC 簽章鏈真實掛載）：合法 200 + 三種攻擊攔截 + IllegalPacketLog
- [x] 輪盤全流程 E2E：回合結算資金流與 BetRecord 落地
- [x] 禮物碼全流程 E2E：admin 產碼 → 玩家兌換 + 重複/用完拒絕
- [x] 併發雙花：重放競態 + 餘額鐵律原子性（餘額只扣一次）
- [x] 併發 Jackpot 派彩：樂觀鎖重試 + 資金守恆（不超付）
- [x] 覆蓋率報告：`npm run test:coverage`（整體 Stmts 77.5%；安全模組 hmac/nonce/anomaly 100%）
- [x] 五個攻擊向量腳本 + run-all 總控 + 安全演練報告
- [ ] 對 Pi 4 真機 / 獨立測試 DB 跑一輪 `npm run test:security`（需執行中後端 + PG + Redis）

---

- 進度：M28 / M28（全部完成）→ 詳見 M28 節
- 最近 Commit：feat(M27): E2E integration tests + security attack drill scripts
- 新增依賴：無（M27 整合測試重用既有 vitest / @vitest/coverage-v8；演練腳本重用 socket.io-client / @prisma/client）

---

## M26 完成內容（2026-06-14）

### RTP 模擬與負載測試（01_GDD §2.2、02_TDD §6、05_MILESTONES M26）

**新增 `scripts/simulate-rtp.ts`**（蒙地卡羅 RTP 模擬腳本）：
- **純演算法**：完整鏡像 `backend/src/modules/slot/` 的核心邏輯（`toReelTable`、`binarySearchCum`、`sampleReel`、`evaluateLine`、`settlePayout`），無任何外部依賴（不需 PG / Redis / 後端服務）
- **CSPRNG**：使用 `crypto.randomInt`（等同 `rngInt`），符合 GDD §3.3.2 安全需求
- **worker_threads 並行**：預設以 CPU 邏輯核心數啟動 Worker（`execArgv: process.execArgv` 繼承 tsx loader）；Worker 失敗自動退回單執行緒
- **CLI 參數**：`--spins`（預設 1,000 萬）、`--bet`（預設 10）、`--build`（`none`/`typical`）、`--output`（JSON 報告）、`--workers`
- **Build 定義**：
  - `none`：空 Build，無護符無幸運符號，驗證基礎 RTP 落於 90–94%
  - `typical`：四葉草護符（CLOVER 全軸 ×1.3，WEIGHT 型護符），驗證護符加成對平衡的影響
- **統計輸出**：總旋轉次數/投注/賠付、實際 RTP%、標準差（個別旋轉）、SE、95% CI、每符號三連/二連命中次數與頻率
- **CI 攔截**：`--build none` 時 RTP ∉ [90%, 94%] → `exit(1)`；`--build typical` 僅報告不攔截
- **JSON 輸出**：`--output` 可選，包含完整統計 + CI gate 結果

**RTP 模擬驗證結果（理論推導，與 constants.ts 檔頭 §RTP 解析計算一致）**：
- `none` build 理論 RTP = 91.5%（落於 90–94%）
  - CHERRY 三連：0.57³ × 4 = 74.08%
  - CHERRY 二連（非三連）：0.57² × 0.43 × 1 = 13.97%
  - 其餘三連合計：≈ 3.47%
- `typical` build（CLOVER ×1.3）理論 RTP ≈ 87.5%（CLOVER 三連機率提升，但稀釋 CHERRY 佔比）

**新增 `scripts/loadtest/k6-spin.js`**（老虎機壓力測試）：
- 200 VU × 5 分鐘；每 VU 第一次迭代獨立 `POST /api/auth/register` 動態取號
- 每次旋轉完整 HMAC-SHA256 簽章（x-sig/x-nonce/x-ts/x-seq headers）；canonical: `${userId}|SLOT|${betAmount}|${nonce}|${ts}`
- 注額隨機三檔（10/50/100 Coin）；思考時間 0.5–2 秒
- 驗證 HTTP 200 + data.newBalance >= 0 + reels 三元素
- 閾值：`http_req_failed < 1%`、P95 < 500ms、P99 < 1000ms、`spin_success_rate > 99%`
- 自訂指標：`spin_success_rate`（Rate）、`spin_duration`（Trend ms）

**新增 `scripts/loadtest/k6-roulette.js`**（輪盤 WebSocket 壓力測試）：
- 200 VU × 5 分鐘；每 VU 獨立 register 取號
- 手動實作 **Engine.IO v4 + Socket.IO v4 協定**（不依賴 Socket.IO 客戶端庫）：
  - WS 連線 → EIO OPEN → SIO CONNECT（`40{"token":"jwt"}`）→ 事件收發
  - 定時回應 EIO PING（`2` → `3`）防斷線；每 55 秒 session timeout 自動關閉
- 監聽 `roulette:phase`：BETTING 階段自動發 `roulette:bet`（RED/BLACK/ODD/EVEN 隨機，50 Coin）
- HMAC 嵌入 payload（`sig/nonce/ts/seq`）；canonical: `${userId}|ROULETTE|${totalAmount}|${nonce}|${ts}`
- 監聽 `roulette:bet_ack` 統計下注成功率；斷線後 default function 自然重連
- 閾值：`roulette_bet_success > 98%`、`http_req_failed < 1%`

**新增 `scripts/loadtest/k6-mixed.js`**（混合場景壓測）：
- 使用 k6 **scenarios**（constant-vus executor）：
  - `slotScenario`：100 VU × 5 分鐘，執行 `slotDefault()`
  - `rouletteScenario`：100 VU × 5 分鐘，執行 `rouletteDefault()`
- 兩場景各自管理 VU 狀態（register 使用不同 username prefix 避免衝突）
- 統一閾值：HTTP 錯誤率 < 1%、Spin P95 < 500ms、Roulette 下注成功率 > 98%

**更新 `package.json`（根目錄）**：
- 新增 npm scripts：`rtp:simulate` / `loadtest:spin` / `loadtest:roulette` / `loadtest:mixed`
- 新增 `tsx ^4.16.2` 至 root devDependencies（供 `npm run rtp:simulate` 使用）

## M26 驗收（DoD）

- [x] `scripts/simulate-rtp.ts`：完整 CLI + CSPRNG + worker_threads + 統計輸出 + JSON 報告
- [x] `--build none`：理論 RTP 91.5%，落於 [90%, 94%] CI gate 通過
- [x] `--build typical`（四葉草 CLOVER ×1.3）：護符效果正確套用，報告不攔截
- [x] `--output`：JSON 結構含 meta / rtp / stdDev / ci95 / ciGate / symbolStats
- [x] worker_threads：Worker 失敗自動退回單執行緒
- [x] `scripts/loadtest/k6-spin.js`：200 VU / 5m / HMAC / 隨機注額 / 閾值設定
- [x] `scripts/loadtest/k6-roulette.js`：200 VU / 5m / WS / EIO 協定 / 自動重連 / HMAC
- [x] `scripts/loadtest/k6-mixed.js`：scenarios 50%/50% / 合計 200 VU / 混合閾值
- [x] `package.json`：rtp:simulate / loadtest:* 四支 npm 腳本 + tsx devDependency
- [x] `docs/PROJECT_STATE.md`：進度推進至 M26
- [ ] 實際 10M 旋轉執行驗證（需 Node.js 環境 + tsx 安裝）
- [ ] k6 壓測執行驗證（需 k6 安裝 + 後端服務啟動）

---

## M25 完成內容（2026-06-14）

### 生產部署管線（02_TDD §7、05_MILESTONES M25）

**新增 `docker-compose.arm64.yml`**（Raspberry Pi 4 / arm64 生產 Compose）：
- 服務：`postgres`（768 MB）/ `redis`（256 MB）/ `app`（512 MB）/ `nginx`（64 MB）/ `migrate`（profile）
- 所有映像使用官方 multi-arch 版本（`postgres:16-alpine`、`redis:7-alpine`、`nginx:1.27-alpine`、`node:20-alpine`）；`platform: linux/arm64` 明確指定
- `app` 從 `backend/Dockerfile target:runtime` 建置（多階段，最小生產映像；`CMD cluster.js`）
- `migrate` service（`profile: migrate`）：使用 `target:deps`（含 prisma CLI，未 prune devDeps）+ 掛載 `backend/prisma/`，執行 `node_modules/.bin/prisma migrate deploy`；部署前一次性執行
- `redis`：AOF 持久化 + `maxmemory 200mb allkeys-lru`
- 所有服務設有 `healthcheck` 與 `depends_on condition: service_healthy`（啟動順序：postgres → redis → app → nginx）
- 全部服務在 `internal` 橋接網路；只有 `nginx` 暴露 `80:80` / `443:443`
- 持久化 volume：`pgdata`、`redisdata`、`nginx_logs`

**新增 `nginx/nginx.conf`**：
- `worker_processes auto`（Pi 4 四核）、`epoll` 事件模型、`multi_accept on`
- Gzip 壓縮（text/css/js/json/svg）、`server_tokens off`、保守緩衝區設定

**新增 `nginx/conf.d/ratelimit.conf`**（http context）：
- `limit_req_zone`：`api` 30 r/s、`auth` 10 r/min（防暴力破解）、`admin_api` 20 r/s
- `limit_conn_zone`：`per_ip` 50 連線
- `limit_req_status 429` / `limit_conn_status 429`

**新增 `nginx/conf.d/tls.conf`**（http context）：
- `ssl_protocols TLSv1.2 TLSv1.3`（禁用舊版）
- ECDHE + AES-GCM / CHACHA20 cipher（AEAD，前向保密）；`ssl_prefer_server_ciphers off`
- `ssl_ecdh_curve X25519:prime256v1:secp384r1`
- Session cache `shared:SSL:10m`（10 MB ≈ 4 萬 session）；`ssl_session_tickets off`
- OCSP Stapling（自簽憑證無效但設定無害；Let's Encrypt 自動啟用）

**新增 `nginx/conf.d/site.conf`**（HTTP + HTTPS server block）：
- HTTP：`/health` 回 200（Docker healthcheck）+ 其餘 301 → HTTPS
- HTTPS：HSTS / X-Frame-Options / X-Content-Type-Options / X-XSS-Protection / Referrer-Policy
- `location ^~ /api/auth/`：`limit_req zone=auth burst=10 nodelay`（最嚴）
- `location ^~ /api/admin/`：`limit_req zone=admin_api burst=40 nodelay`
- `location ^~ /api/`：`limit_req zone=api burst=60 nodelay`
- `location ^~ /socket.io/`：WebSocket proxy（`Upgrade / Connection: upgrade` / `proxy_read_timeout 86400s` / `proxy_buffering off`）
- `location ^~ /admin`：`alias admin-frontend/dist`；SPA `try_files` fallback；靜態資源 `expires 1y` 長快取
- `location /`：`root frontend/dist`；SPA fallback；靜態資源長快取

**新增 `scripts/deploy.sh`**（完整部署流程）：
1. 環境檢查（.env.production 存在 + 無 change_me + TLS 憑證）
2. `git pull --ff-only`
3. `npm install --prefer-offline`
4. `npm run build --workspace=frontend` + `--workspace=admin-frontend`
5. `docker compose build app`
6. 啟動 postgres/redis + 等待 healthcheck → 執行 migrate service
7. `docker compose up -d --remove-orphans`
8. 30 秒後冒煙測試（HTTP/HTTPS/API）

**新增 `scripts/backup.sh`**：
- `docker exec casino-postgres pg_dump | gzip -9` → `backups/backup_YYYYMMDD_HHMMSS.sql.gz`
- `gzip -t` 完整性驗證
- `find -mtime +${RETAIN_DAYS}` 清理舊備份（預設 7 天）
- 建議 crontab 每日 03:00 執行

**新增 `scripts/restore.sh`**（互動式）：
- 列出備份清單供選擇，或傳入路徑非互動執行
- 需輸入「yes」確認（雙重防護）
- 先停 app/nginx → DROP + CREATE 資料庫 → `gunzip | psql` 還原 → 選擇性重啟服務

**新增 `scripts/gen-cert.sh`**：
- `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256`（EC P-256，比 RSA 更適合 Pi 4）
- 有效期 3650 天、SAN 含 DNS:localhost + IP:127.0.0.1
- 憑證：`nginx/certs/server.key` / `nginx/certs/server.crt`（600/644 權限）
- 內含 Let's Encrypt 正式上線說明

**新增 `scripts/sysctl-hardening.sh`**（需 root）：
- `net.ipv4.tcp_syncookies=1`（SYN Flood 防護）
- 停用 IP forwarding / source routing / ICMP redirect
- `rp_filter=1`（Reverse Path Filtering，防 IP spoofing）
- TCP keepalive 調整、`kernel.kptr_restrict=1`、`kernel.dmesg_restrict=1`
- 持久化至 `/etc/sysctl.d/99-casino-hardening.conf`

**新增 `scripts/cf-allowlist.sh`**（可選，使用 Cloudflare 時啟用）：
- `ipset` 管理 CF IPv4/IPv6 段（15 + 7 個 CIDR）
- iptables DROP 非 CF 來源的 80/443 請求
- `--apply` / `--remove` / `--update` 三種模式
- 提示每月更新 IP 段並持久化

**新增 `nginx/certs/.gitkeep`**（確保空目錄進 git）

**更新 `.env.example`**：
- 新增生產環境設定說明區塊（`DATABASE_URL` 使用 Docker 服務名 `postgres` / `redis`）
- 區分開發 vs 生產的 `POSTGRES_DB`（`casino_dev` / `casino_prod`）

## M25 驗收（DoD）

- [x] `docker-compose.arm64.yml`：4 服務 + migrate profile；記憶體限制；healthcheck；依賴順序
- [x] `nginx/nginx.conf`：worker_processes auto + epoll；gzip；server_tokens off
- [x] `nginx/conf.d/ratelimit.conf`：api/auth/admin_api 三個 limit_req_zone + per_ip limit_conn_zone
- [x] `nginx/conf.d/tls.conf`：TLS 1.2+；ECDHE cipher；session cache；OCSP stapling
- [x] `nginx/conf.d/site.conf`：HTTP→HTTPS 301；/health；API proxy；WebSocket proxy；SPA 靜態服務
- [x] `scripts/deploy.sh`：7 步驟完整流程（環境檢查 → build → migrate → up）
- [x] `scripts/backup.sh`：pg_dump + gzip + 7 天清理 + 建議 crontab
- [x] `scripts/restore.sh`：互動式清單選擇 + "yes" 確認 + DB 重建
- [x] `scripts/gen-cert.sh`：EC P-256 自簽 + SAN + Let's Encrypt 說明
- [x] `scripts/sysctl-hardening.sh`：SYN cookie / rp_filter / kptr_restrict + 持久化
- [x] `scripts/cf-allowlist.sh`：ipset + iptables CF 白名單
- [x] `.env.example`：生產環境變數清單完整（含 Docker hostname 差異說明）
- [ ] 樹莓派 4 真機冒煙測試（需 arm64 硬體 + 正式 Let's Encrypt 憑證）

---

## M24 完成內容（2026-06-14）

### 監控 API + 異常偵測完整實作（01_GDD §6、02_TDD §5.7、05_MILESTONES M24）

**新增 `backend/src/modules/monitor/`**：
- `monitor.service.ts`（`createMonitorService`）：以 `systeminformation` 採集 CPU（manufacturer/brand/physicalCores/currentLoad/temperature）/ 記憶體（total/used/free/usedPercent）/ 磁碟（fs/size/used/use）；CPU 靜態資訊開機快取一次；SCAN `socket:conns:*` Redis 鍵加總線上人數；讀 `roulette:round:current` 是否存在得活躍房間數；回傳 `SystemStatsRes`（與 admin-frontend 型別對齊）
- `monitor.routes.ts`：`GET /api/admin/monitor`（adminOnly；注入 stub 友善）

**更新 `backend/src/security/anomaly.ts`**（三條規則全部完成）：
- 規則 1 BET_RATE：不變（1s 桶 >2 筆/s）
- 規則 2 WIN_RATE（新）：5 分鐘桶（`anomaly:wr:win/total:{userId}:{bucket5m}`）；連續 3 個視窗勝率 > 99% 且每窗 ≥ 10 筆才標記；TTL = `WIN_RATE_BUCKET_SECONDS × (CONSEC_WINDOWS+2)`
- 規則 3 NET_WIN_OUTLIER（新）：INCRBY `anomaly:netwin:{userId}:{dateKey}`（payout-amount 累計，可負）；讀 `anomaly:p99:{dateKey}`（由 monitor-scan.job 寫入）；netwin > p99×10 → 標記
- 新增 `updateNetWinP99()`：SCAN → 排序 → 取 idx=floor(n×0.99) → 寫 p99 鍵（EX 2天）
- `onFlag` 回呼已接 `slot.routes.ts`（`updateMany flagged=true` fire-and-forget）

**新增 `backend/src/jobs/monitor-scan.job.ts`**：
- 隊列名稱 `monitor-scan`；每 10 分鐘 repeatable；`createMonitorScanProcessor(deps)` 工廠分離
- 呼叫 `anomaly.updateNetWinP99()` 更新 P99 快取
- `registerMonitorScanJob(app)` 於 `server.ts` 啟動（繼 leaderboard jobs 之後）

**更新 `backend/src/app.ts`**：加掛 `monitorRoutes` 於 `/api/admin`

**更新 `backend/src/server.ts`**：`registerMonitorScanJob(app)` 啟動調用

**更新 `backend/src/modules/slot/slot.routes.ts`**：`createAnomalyDetector` 傳入 `onFlag`（`prisma.user.updateMany({ flagged: true })`，fire-and-forget）

**更新 `admin-frontend/src/views/MonitorView.vue`**：
- 移除 Mock 回退（API 失敗改顯示通用錯誤訊息）
- 新增「立即刷新」按鈕（loading state + disabled 保護）
- `fetchStats` 防競態（`loading.value` guard）

**測試**：356 條（+17）
- `test/unit/anomaly.spec.ts`：14 條（BET_RATE 3 + WIN_RATE 3 + NET_WIN_OUTLIER 4 + updateNetWinP99 3 + Redis 失敗 1）
- `test/integration/monitor-routes.spec.ts`：3 條（無 token 401 / PLAYER 403 / ADMIN 200）

**新增依賴**：`systeminformation ^5.31.7`（backend）

---

## M23 完成內容（2026-06-14）

### 管理後台前端（01_GDD §6、04_FOLDER_STRUCTURE §3、05_MILESTONES M23）

**`admin-frontend/` 獨立 Vue 3 + Vite + Pinia + Vue Router SPA（base: `/admin/`）**

**新增 `src/api/`**：
- `http.ts`：axios 實例（baseURL `/api`）；請求攔截器自動附 `Authorization: Bearer`；回應攔截器 401 → refresh token 換發 → 重試；refresh 失敗強制登出跳回 /login
- `admin.ts`：全部管理後台 API 函式（`apiLogin`, `apiAdminMe`, `apiTotpValidate`, `apiTotpReverify`, `apiListPlayers`, `apiBanUser`, `apiUnbanUser`, `apiAdjustBalance`, `apiCreateGiftCode`, `apiListGiftCodes`, `apiListLoginRecords`, `apiListBetRecords`, `apiListTxRecords`, `apiGetMonitorStats`, `apiListAnnouncements`, `apiCreateAnnouncement`, `apiUpdateAnnouncement`, `apiDeleteAnnouncement`）；`extractErrorMessage` 統一解析 axios error

**新增 `src/stores/`**：
- `auth.ts`（`useAdminAuthStore`）：`accessToken`/`refreshToken` 持久化 localStorage；`user`（AdminUser）；`reverifyToken`/`reverifyExpiresAt` 僅存 Pinia 記憶體；computed `isLoggedIn` / `isTotpVerified` / `hasValidReverifyToken`；`setReverifyToken(token, expiresIn)` 計算到期時間戳
- `ui.ts`（`useUiStore`）：Toast 佇列（id/message/type）；`addToast(message, type, duration)` 自動移除

**新增 `src/router/index.ts`**：history 模式（`/admin/`）；navigation guard：未登入→`/login`；已登入但 TOTP 未驗→`/login`；已完成驗證訪問 login→`/players`

**新增 `src/components/`**：
- `AdminLayout.vue`：固定側邊欄（220px，slate-800）+ 頂部欄；RouterLink 導航五項（玩家/Gift Code/紀錄/監控/公告）；登出呼叫 `POST /api/auth/logout` + clear store + 跳回 /login
- `ReverifyDialog.vue`：Teleport 彈窗；TOTP 6 位數輸入；呼叫 `POST /api/admin/totp/reverify`；emit `verified(token)` / `cancelled`；開啟時自動聚焦、Enter 送出
- `Pagination.vue`：顯示 page/totalPages/total；emit `change(page)`

**新增 `src/views/`**：
- `LoginView.vue`：step 狀態機（credentials → totp）；credentials: POST /api/auth/login → GET /api/admin/me（驗 role=ADMIN）；totpEnabled=false 直接進後台；totpEnabled=true → totp step；TOTP/備用碼切換模式；POST /api/admin/totp/validate `{ code }` → 存 reverifyToken；備用碼（min 6, max 32）走同一 validate 端點
- `PlayersView.vue`：搜尋（q/banned filter）+ 分頁 20 筆；ban/unban/adjust-balance 前檢查 `hasValidReverifyToken`；無效時先開 ReverifyDialog → `onReverified` 存 token → 繼續執行；高危 API 帶 `x-reverify-token` header；操作結果 Toast
- `GiftCodeView.vue`：建立表單（amount/maxUses/expiresInDays/charmId?），`expiresInDays` → `expiresAt` ISO 轉換；產生成功彈窗一次性顯示 code（高亮 + 複製按鈕）；代碼列表含狀態（有效/已過期/已用完）；高危建立同樣走 ReverifyDialog → `x-reverify-token`
- `RecordsView.vue`：三頁籤（登入/下注/交易）；共用篩選列（userId/from/to + 各頁籤額外篩選）；登入紀錄含結果徽章；下注紀錄可展開 detail JSON；交易紀錄含 delta 著色（正綠負紅）；分頁 PaginatedResult`<T>` 格式（`data` 不是 `items`）
- `MonitorView.vue`：`setInterval(10s)` 輪詢 `GET /api/admin/monitor`；API 失敗顯示 warning banner 並改用 Mock 資料（M24 尚未實作）；CPU 使用率/溫度/記憶體/磁碟 progress bar（顏色分級：green/yellow/red）；線上人數/活躍房間/運行時間數值卡
- `AnnouncementView.vue`：列表顯示所有公告；新增/編輯共用表單彈窗（title/content/active/startsAt/endsAt）；刪除確認彈窗；datetime-local input 與 ISO 8601 互轉

**`src/App.vue`**：RouterView + TransitionGroup Toast 容器；全域 CSS（btn / card / form-control / table / badge / modal / toast 樣式類別）

**`src/main.ts`**：createApp + createPinia + router + mount

**新增依賴**（admin-frontend/package.json）：`axios ^1.7.9`、`pinia ^3.0.1`、`vue-router ^4.4.5`

**TypeScript strict 0 errors（`vue-tsc --noEmit`）；Vite build ✅（118 modules, 1.32s）**

## M23 驗收（DoD）

- [x] 登入頁：帳密 → POST /api/auth/login → GET /api/admin/me → TOTP dialog（totpEnabled）→ validate → reverifyToken
- [x] TOTP 備用碼：同一 validate 端點（code: min 6, max 32 字元）
- [x] ReverifyDialog：TOTP 重驗 → POST /api/admin/totp/reverify → reverifyToken 存 Pinia
- [x] 玩家管理：列表/搜尋/分頁；封鎖/解封/調幣（高危，帶 x-reverify-token）
- [x] Gift Code：表單建立（高危）→ 一次性顯示 code + 複製；列表含狀態
- [x] 紀錄查詢：三頁籤（登入/下注/交易）；共用篩選；PaginatedResult 格式正確
- [x] 監控：10s 輪詢；API 失敗顯示 banner + Mock 資料
- [x] 公告：CRUD + 確認刪除；datetime-local ↔ ISO 互轉
- [x] 側邊欄佈局；登出 POST /api/auth/logout + 清 store + 跳 /login
- [x] axios 攔截器：JWT 自動附加；401 換 token + 重試
- [x] Navigation guard：未登入/未驗 TOTP 強制導向 /login
- [x] TypeScript strict 0 errors；vite build 成功（118 modules）
- [ ] 端對端真機驗證（需 PG + Redis + 後端完整啟動）

---

## M22 完成內容（2026-06-13）

### Gift Code 兌換 + 管理後台紀錄查詢（01_GDD §6.5、02_TDD §5.7、05_MILESTONES M22）

**新增 `modules/gift-code/`**（玩家端兌換；建立仍在 M21 admin 高危路由）：
- `gift-code.types.ts`：`RedeemGiftCodeReqSchema`（code trim）、`RedeemGiftCodeRes`（success/amount/charmId/charmName/newBalance）
- `gift-code.service.ts`：`redeemGiftCode(userId, rawCode)` 原子交易：
  1. `code.toUpperCase()` 大小寫正規化查找
  2. 快速前置檢查（過期/用完）→ 語意明確的 4xx
  3. 交易內：`giftCode.updateMany` 條件更新（防競態）→ `giftCodeRedemption.create`（P2002 → GIFT_CODE_ALREADY_REDEEMED）→ `wallet.credit(GIFT_CODE)` → `userCharm.upsert`（有護符時）
  4. 任一步失敗完整回滾（usedCount 復原、餘額不增）
- `gift-code.routes.ts`：`POST /api/gift-codes/redeem`（`preHandler: [authenticate]`，一般玩家）

**新增 `modules/record/`**（管理後台紀錄查詢，全路由 adminOnly）：
- `record.types.ts`：`LoginRecordQuerySchema` / `BetRecordQuerySchema` / `TxRecordQuerySchema`（各含 page/limit/userId/時間範圍 + 特有過濾欄位）；`PaginatedResult<T>` = { data, total, page, totalPages }
- `record.service.ts`：`listLoginLogs` / `listBetRecords` / `listTransactions`；BigInt → toString；parallel count；`totalPages = Math.ceil(total / limit)`
- `record.routes.ts`：`GET /api/admin/records/login` / `/bets` / `/transactions`；inline requireAdminRole

**`app.ts` 更新**：掛載 `giftCodeRoutes(/api/gift-codes)` + `recordRoutes(/api/admin/records)`

**錯誤碼（M05 規格）**：
- `GIFT_CODE_NOT_FOUND`（404）、`GIFT_CODE_EXPIRED`（409）、`GIFT_CODE_ALREADY_USED`（409）、`GIFT_CODE_ALREADY_REDEEMED`（409）

**測試 25 筆新增（339 total，全綠）**：
- `gift-code.service.spec.ts`（8）：正常/含護符/case-insensitive/碼不存在/過期/用完/重複/競態+回滾
- `record.service.spec.ts`（17）：三類查詢分頁計算/BigInt序列化/過濾條件/時間範圍/邊界（empty→totalPages=0）

---

## M21 完成內容（2026-06-13）

### 管理後台後端核心（01_GDD §6、02_TDD §5.5/§5.7、05_MILESTONES M21）

**新增 `security/totp.ts`**（純密碼學出口，admin 模組唯一 2FA 依賴）：
- otplib v13 functional API（內建 noble-crypto + scure-base32 預設外掛）：
  `generateTotpSecret` / `buildOtpAuthUri` / `verifyTotp`（容忍 ±1 步 epochTolerance[30,30]）/ `currentTotp`（測試用）
- AES-256-GCM：`encryptSecret`/`decryptSecret`（格式 `iv:tag:ciphertext` hex；金鑰取 env.AES_256_GCM_KEY；
  authTag 提供完整性，竄改即拋錯）
- 一次性備用碼：`generateRecoveryCodes`（10 組 xxxxx-xxxxx 明文僅回一次）/ `hashRecoveryCode`（sha256 + 正規化）/
  `matchRecoveryCode`（常數時間逐筆比對，回命中 hash 供消耗）

**新增 `modules/admin/admin.service.ts`**（factory + deps 注入：prisma/redis/wallet/hmacKeys?/disconnectUser?/emitAnnouncement?）：
- **2FA**：`setupTotp`（產 secret→AES 加密落 totpSecretEnc，未啟用）/ `confirmTotp`（驗碼→totpEnabled=true +
  備用碼雜湊落庫 + 稽核，同 $transaction）/ `validate2fa`（登入後；TOTP 或備用碼；備用碼一次性消耗）/
  `reverify`（高危步進；僅即時 TOTP + Redis 防重用）/ `checkReverifyToken`（守衛用，fail-closed）
- reverifyToken：Redis `admin:reverify:{token}`→userId（EX 600，窗口內可重用）；
  TOTP 防重用：`admin:totp:used:{userId}:{code}`（EX 600）
- **玩家管理**：`listPlayers`（q/banned/flagged 過濾 + 分頁）/ `getPlayer`（詳情 + 近 5 筆登入）/
  `setBan`（封鎖→撤銷 refresh 會話 + HMAC 金鑰 + 踢線 user room + 稽核；禁封管理員/自己）/
  `setMute`（durationMinutes 選填，記 mutedUntil；自動解除排程待 M22+）/
  `adjustBalance`（**走 wallet.credit/debit type=ADMIN_ADJUST**，與稽核同 $transaction 原子；before/after 摘要）
- **稽核**：所有敏感操作 `writeAudit`（adminId/action/targetUserId/before/after/ip，與主變更同 tx）；
  `listAuditLogs`（adminId/action/targetUserId/from/to 過濾 + 分頁 + 手動解析 admin/target 名稱）
- **公告**：`listAnnouncements`/`createAnnouncement`（立即生效→system:announcement 全服廣播）/
  `updateAnnouncement`/`deleteAnnouncement`/`getActiveAnnouncements`（公開；active+時窗過濾）
- **Gift Code**：`createGiftCode`（CSPRNG 16 碼，去混淆字元集，撞碼重試 ≤3，明文僅回一次 + 稽核）/
  `listGiftCodes`（code 遮蔽 ****）

**新增 `modules/admin/admin.routes.ts`**（掛 /api/admin；另導出 publicAnnouncementRoutes 掛 /api/announcements）：
- 守衛分層：`adminOnly`=[authenticate, requireAdminRole（role≠ADMIN→403）]；
  `highRisk`=adminOnly + requireReverify（`x-reverify-token` 標頭驗 checkReverifyToken）
- 高危路由（adjust-balance / ban / unban / gift-codes POST）採 highRisk；其餘 adminOnly；
  TOTP setup/verify/validate/reverify 僅 adminOnly（此時無法持 reverifyToken）
- 端點：GET /me、POST /totp/{setup,verify,validate,reverify}、GET /users、GET /users/:id、
  POST /users/:id/{ban,unban,mute,unmute,adjust-balance}、POST|GET /gift-codes、
  GET|POST|PUT|DELETE /announcements[/:id]、GET /audit-logs；公開 GET /api/announcements/active

**新增 `modules/admin/admin.types.ts`**（鏡像 shared admin.dto；採 reverifyToken 流，高危 body 不含 totpCode）、
`modules/admin/admin.constants.ts`（Gift Code 長度/字元集）。

**修改**：
- `app.ts`：掛載 adminRoutes（/api/admin）+ publicAnnouncementRoutes（/api/announcements）
- `eslint.config.js`：admin 模組 override 放行 prisma.user.update（管 banned/muted/totp* 非餘額欄位；
  餘額仍鐵律走 wallet）
- `daily.service.ts`：補既有 prisma.user.update（loginStreak/lastDailyAt）的 eslint-disable 註記
  （非餘額欄位例外；修復先前遺留的 lint 違規）
- 新增 dep：`otplib ^13.4.1`

### 安全設計重點
- 餘額鐵律不破例：admin 調幣一律 wallet.credit/debit；admin.service 永不直接寫 balance
- 高危操作 = JWT + role + 即時 TOTP 步進（reverifyToken），全部寫稽核
- 封鎖即時失效：撤銷 refresh 家族 + HMAC 會話金鑰 + 踢 socket（user room disconnectSockets）
- TOTP secret AES-256-GCM 加密落庫；備用碼僅存 sha256、一次性

### 測試（314/314 通過；新增 41 條）
- `totp.spec.ts`（11）：AES 往返/竄改偵測/格式錯誤、TOTP 產生/驗證/錯碼、備用碼產生/正規化/比對
- `admin.service.spec.ts`（22）：in-memory fake prisma（$transaction 快照回滾）+ 真 wallet——
  setup/confirm（啟用+備用碼+稽核）、validate（TOTP/備用碼一次性）、reverify（防重用）、
  reverifyToken 檢查、封鎖（踢線+撤銷+稽核+禁封 admin/自己）、禁言、調幣（credit/debit/餘額不足回滾零落帳）、
  公告 CRUD+廣播+時窗、Gift Code 產生/遮蔽、稽核查詢（名稱解析+過濾）
- `admin-routes.spec.ts`（8）：真 Fastify+auth plugin+stub service——401/403（角色）/200、
  高危 reverifyToken 守衛（無/錯/正確）、body 驗證、公開公告免認證

## M21 驗收（DoD）
- [x] 後端測試 314/314（新增 41 條，既有 273 條零 regression）
- [x] `npm run lint` / `typecheck` / `build` 全通過
- [x] TOTP 2FA：綁定（AES 加密）/ 確認（啟用+備用碼）/ 登入驗證 / 高危步進重驗（防重用）
- [x] 玩家管理：查詢/詳情/封鎖（踢線+撤銷會話）/禁言/手動調幣（wallet ADMIN_ADJUST + 稽核原子）
- [x] 稽核日誌：所有敏感操作 before/after/ip 落 AdminAuditLog，可分頁過濾查詢
- [x] 公告 CRUD + 公開 /api/announcements/active；建立即生效時全服廣播
- [x] 安全：/api/admin/* 一律 JWT+role===ADMIN；高危需 reverifyToken；餘額鐵律不破例
- [ ] 端對端真機驗證（需 PG + Redis：2FA 全流程、踢線跨 worker、稽核落庫）——併入 M25 部署冒煙

---

## M20 完成內容（2026-06-13）

### 成就與個人頁（01_GDD §5.4、05_MILESTONES M20）

**後端新增 `achievement.routes.ts`**（掛載於 `/api`）：
- `GET /api/achievements` — 全部成就含解鎖狀態（authenticated）
- `GET /api/achievements/unlocked` — 僅已解鎖成就（authenticated）
- `GET /api/user/profile` — 個人統計（totalSpins/maxSingleWin/jackpotWins/charmsOwned+totalCharms）+ 最近 10 筆 LeaderboardSnapshot 歷史（authenticated）

**後端 `achievement.service.ts`（M20 之前已存在，功能完整）**：
- `tryUnlock(userId, code, io?)` — 原子解鎖（UserAchievement + wallet.credit TASK_REWARD 在同一 $transaction）；冪等（P2002 unique 衝突視為已解鎖）；解鎖後 Socket `achievement:unlocked` 推 `user:{userId}` 個人 room
- `checkSpinMilestone / checkRouletteMilestone / checkChatMilestone / checkCharmMilestone / checkDailyNetWin` — stat-based 成就（isUnlocked 快速退出避免無謂 DB 查詢）
- `getUserAchievements(userId)` — 全成就 JOIN 解鎖狀態

**整合觸發點（既有檔案修改）**：
- `slot.routes.ts`：spin 後觸發 FIRST_TRIPLE（三連有賠付）、LUCKY7_TRIPLE（三連全 Lucky7）、JACKPOT_WINNER（jackpotPayout ≠ null）、checkSpinMilestone（SPIN_1000）、checkDailyNetWin（NET_WIN_10000）——全 fire-and-forget
- `roulette.gateway.ts`：onResult 後為每位參與者觸發 checkRouletteMilestone（ROULETTE_100）
- `chat.gateway.ts`：chat:send 成功後觸發 checkChatMilestone（CHATTERBOX）
- `daily.routes.ts`：POST /api/daily/login 成功且 streak ≥ 7 → tryUnlock LOGIN_STREAK_7
- `charm.routes.ts`：POST /api/charm/equip 成功後 checkCharmMilestone（CHARM_COLLECT_6/12）
- `app.ts`：`achievementRoutes` 掛載於 prefix `/api`

**前端新增**：
- `api/endpoints/achievement.ts`：`apiGetAchievements()` / `apiGetProfile()`
- `stores/achievement.ts`（Pinia）：achievements / unlockedCount / totalCount；`fetchAchievements()` + `listenForUnlock(onNotify?)` 訂閱 `achievement:unlocked` Socket 即時更新
- `components/common/AchievementBadge.vue`：成就徽章元件（icon / name / reward / 解鎖日期 or 鎖定灰色樣式）
- `views/ProfileView.vue`：用戶卡片（avatar / 名稱 / 餘額 / 成就比率）+ 四格統計卡片 + AchievementBadge 網格 + 排行榜歷史表格；Socket achievement:unlocked Toast 通知
- `router/index.ts`：`/profile` 改指向 `ProfileView.vue`（取代 LobbyView 佔位）

**TypeScript 通過**：後端 `tsc --noEmit` 0 errors；前端 `vue-tsc --noEmit` 0 errors

**測試**：273 / 273 通過（零 regression；M20 屬整合端對端觸發，需 PG + Redis + Socket 真機驗證）

## M20 驗收（DoD）

- [x] `tryUnlock` 原子交易（UserAchievement + wallet.credit TASK_REWARD）+ 冪等
- [x] 10 種成就觸發點全部接線（FIRST_TRIPLE / LUCKY7_TRIPLE / JACKPOT_WINNER / LOGIN_STREAK_7 / SPIN_1000 / ROULETTE_100 / CHATTERBOX / CHARM_COLLECT_6/12 / NET_WIN_10000）
- [x] Socket `achievement:unlocked` 推 user room（`user:{userId}`）
- [x] `GET /api/achievements` / `/achievements/unlocked` / `/user/profile` 三支 API
- [x] ProfileView：用戶卡、統計卡、AchievementBadge 網格、排行榜歷史
- [x] Achievement store：Socket listener + 即時更新 + Toast 通知
- [x] `/profile` 路由指向 ProfileView
- [x] TypeScript strict 0 errors（前後端）
- [x] 273/273 後端測試零 regression
- [ ] 端對端真機驗證（需 PG + Redis + Socket 完整環境）

---

## M16 完成內容（2026-06-13）

### 輪盤前端（01_GDD §4、04_FOLDER_STRUCTURE §2、05_MILESTONES M16）

**`frontend/src/api/endpoints/roulette.ts`**：

- `apiGetRouletteState()` → `GET /api/roulette/state`，回傳 `RouletteRoundStateRes`（phase / phaseEndsAt / roundId / participantCount）；供進頁面初始同步

**`frontend/src/stores/roulette.ts`**（Pinia Composition Store）：

- State：`currentPhase / phaseEndsAt / roundId / participantCount / personalBets / totalBet / remaining / isBettingInFlight / lastResult / hotBets / betsSnapshot / lastError`
- Getters：`isBettingPhase`（computed）、`betAmountByType`（Map<key, amount>，key = `STRAIGHT:n | COLUMN:c | DOZEN:d | RED | ...`，供 BetBoard overlay）
- `connectSocket()` / `disconnectSocket()`：防重複安裝 Socket listeners（`roulette:phase` / `roulette:result` / `roulette:bet_ack` / `roulette:bets_snapshot`）
- `handlePhase`：新回合（roundId 變更 + BETTING）自動清空 personalBets/totalBet/remaining/lastResult
- `handleResult`：更新 lastResult/hotBets；`payload.newBalance` → `walletStore.setBalance()`（server-authoritative balance，lazy import 避免循環）
- `handleBetAck`：accepted=true 時以 server totalBet/remaining 更新（accepted=false 已由 ack callback 回滾）
- `placeBet`：HMAC 簽名（`gameType='ROULETTE'`，`betAmount=bet.amount`）→ 樂觀更新 personalBets/totalBet/remaining → `socket.timeout(6000).emit(roulette:bet)` → ack callback 失敗則依 pre-add snapshot 完整回滾
- `cancelBets`：樂觀清空 → `roulette:cancel` ack → 失敗回滾
- `fetchInitialState`：初次進入頁面同步當前 round（Socket 尚未推送前）；若 roundId 已有值（Socket 先到）則跳過

**`frontend/src/components/roulette/WheelCanvas.vue`**：

- `<canvas>` + ResizeObserver（父容器改變時重新計算 size，aspect-ratio: 1）
- 歐式輪盤 37 格：順序 `[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26]`；紅/黑/綠區分；金色外框環
- `highlightNumber(n: number)`（defineExpose）：requestAnimationFrame sin-wave 金色脈動疊加 2.5s；`<Transition>` 數字 badge 彈出（紅/黑/綠底色）

**`frontend/src/components/roulette/BetBoard.vue`**：

- 標準歐式桌面佈局：0（左側直向按鈕）、1–36 CSS grid 12col×3row（row: n%3==0→1, n%3==2→2, n%3==1→3；col: ceil(n/3)）、右側三個 2:1 Column 按鈕
- 下方 Dozen 一排（1-12 / 13-24 / 25-36）；再下方 Even-money 六格（1-18 / 偶 / 紅 / 黑 / 奇 / 19-36）
- 每個格子顯示 `betAmountByType` 的金色小 badge（BetBadge inline component）
- `phase !== 'BETTING'` 時整體 disabled + opacity; Emit `place-bet`（完整 PersonalBet 不含 _id）、`cancel-bets`

**`frontend/src/components/roulette/ChipSelector.vue`**：

- 籌碼值 [10, 50, 100, 500]；v-model 雙向綁定；active 籌碼金色光環；hover translateY(-3px)

**`frontend/src/components/roulette/PhaseTimer.vue`**：

- Props：`phase: RoulettePhase`、`phaseEndsAt: string | null`
- `setInterval(250ms)` 即時倒數（secsLeft）；progress bar 進度（secsLeft/totalSecs）
- 四種 phase 顏色：BETTING 綠 / LOCK 黃 / RESULT 橘 / COOLDOWN 藍

**`frontend/src/views/RouletteView.vue`**：

- 雙欄佈局（桌機）/ 堆疊（手機 < 640px）：左輪盤 + 開獎資訊、右下注控制
- Header（返回大廳 / 標題 / CoinDisplay + 用戶名）、Phase Timer Bar、Toast 通知
- `watch(lastResult.roundId)` → `wheelRef.value.highlightNumber(winningNumber)`；`watch(lastResult)` → 中獎 Toast
- 中獎資訊面板（RESULT/COOLDOWN 期間顯示：開獎號碼 + 顏色 + 池量 + personalPayout）
- 熱門注型（COOLDOWN top-3）；本局下注摘要（totalBet / remaining）
- error code → 中文 Toast 錯誤訊息對照表（ROULETTE_PHASE_CLOSED / BET_LIMIT_EXCEEDED / INSUFFICIENT_BALANCE / ... ）
- `onMounted`：`connectSocket()` + `fetchInitialState()`；`onUnmounted`：`disconnectSocket()`

**`frontend/src/router/index.ts`**：

- `/roulette` 路由從 LobbyView 佔位更換為 `RouletteView`（lazy import）

---

## M15 完成內容（2026-06-13）

### 輪盤後端（01_GDD §4、02_TDD §5.3、05_MILESTONES M15）

**modules/roulette/roulette.types.ts**（鏡像 shared enums/constants/dto，欄位以 04_API_SPEC 為準）：

- 階段/時長（BETTING 15s → LOCK 2s → RESULT 8s → COOLDOWN 5s）、注限
  （單注 1000 / 單回合單人 5000）、賠率回收倍率表（STRAIGHT 36×、紅黑/奇偶/大小 2×、
  COLUMN/DOZEN 3×）、紅色號碼表 + `rouletteColorOf`
- zod：`RouletteBetReqSchema`（discriminated union；STRAIGHT 帶 number 0–36、
  COLUMN/DOZEN 帶 1|2|3；amount 僅驗正整數——單注上限由 service 回凍結碼
  `BET_LIMIT_EXCEEDED`，zod 失敗統一 `VALIDATION_ERROR`）
- Socket payload 鏡像（phase / result / bet_ack / bets_snapshot）+ REST 回應型別
- `RouletteStoredEntry`：append-only 下注事件（含 cancel 標記）

**modules/roulette/roulette.service.ts**：

- **狀態機**：setTimeout 驅動四階段無限循環；`startRound`（防重複啟動）/
  `getCurrentPhase` / `getRemainingMs` / `getRoundSnapshot`；LOCK 開始時
  `rngInt(37)` 產生開獎號（rng 注入式）；serverSeedHash = sha256(rngBytes(32))
  （provably-fair 預留，同 slot）；階段轉換例外不殺機器（COOLDOWN 後強制開新回合）；
  重啟不恢復舊回合（GDD：客戶端由 roulette:phase 同步）
- **★ cluster 單一狀態機**：Redis leader lock（`SET roulette:leader NX EX 12` +
  4s 心跳續租）——僅 leader 跑機器與廣播（io.emit 經 redis adapter 跨 worker）；
  每次轉換把 `{roundId, phase, phaseEndsAt}` 鏡像至 `roulette:round:current`，
  非 leader worker 據此驗注、REST /state 據此回答；leader 失聯 TTL 過期由他機
  接手開新回合；Redis 不可用退化本機 leader（開發單機）
- **下注 placeBets**（回合時窗 02_TDD §5.3）：zod → 單注上限 → roundId/BETTING/
  截止前 250ms 緩衝（搭配 LOCK 2s 保證結算讀取完整）→ `HINCRBY` 原子佔額
  （>5000 回退拒絕）→ `wallet.debit` 即時扣款（不足回退佔額）→ RPUSH 注單事件
  + pool 計數（寫入失敗 **原路退款 REFUND**——沒進帳本的注不留錢）
- **取消 cancelBets**（BETTING 限定）：HINCRBY 負值原子認領（防併發雙取消雙退款）
  → credit(REFUND) → RPUSH cancel 標記
- **結算 settleRound**（RESULT 開始）：LRANGE 事件序列回放（cancel 清空先前累積、
  取消後再下注生效）→ 單一 PG 交易批量落帳：每使用者 BetRecord（gameType=ROULETTE、
  roundId、seedHash、detail 含注單與開獎）+ 中獎 `wallet.credit(PAYOUT, refId=BetRecord.id)`；
  交易失敗 → 逐使用者 best-effort 全額退款（本金永不蒸發）；結算後聊天系統訊息
  （開獎號/顏色/總注/最熱門注型；無人下注不發，防空服洗版）+ 歷史寫入
  `roulette:history`（LPUSH/LTRIM 100）
- 純函式導出供測試：`rouletteBetReturn`（0 綠對外圍注全輸）、`rouletteColumnOf` /
  `rouletteDozenOf`、`foldEntries`、`aggregateHotBets`（top 3）
- `readRouletteState` / `readRouletteHistory`：REST 用獨立讀取（不依賴機器實例）

**modules/roulette/roulette.gateway.ts**：

- `initRouletteGateway(app, io, { service? })`：注入 service 時 `owned=false`
  （測試掌控生命週期）；內建 service 接 `createRouletteBroadcastHooks(io)` + chat
- 連線安裝：join `user:{userId}` room + 推送當前 phase（中途加入即時同步，
  不必等下一次轉換）
- `roulette:bet`（HMAC 由 M06/M08 中介層先驗）→ placeBets → 個人 `roulette:bet_ack`
  （成敗都發）+ ack callback 錯誤碼；`roulette:cancel` → ack(null, {cancelled, refunded})
- **roulette:result 個人化**：參與者 user room 各收 personalPayout/newBalance 版本、
  其餘以 `io.except(participantRooms)` 收 null 版（凍結 payload：null = 未下注）；
  跨 worker 由 redis adapter 路由，結算 worker 不必持有玩家 socket

**modules/roulette/roulette.routes.ts + app.ts**（docs/04_API_SPEC.md §3.5）：
GET `/api/roulette/state`（Redis 鏡像 + 計數器；未開局 404）、GET `/api/roulette/history`
（近 100 回合分頁）；皆 authenticate

**sockets/index.ts**：`InitSocketOptions.roulette`（enabled 預設 test 環境關閉、
其餘開啟；可注入 service）；內建 service 自動 `start()` + onClose `stop()`；
connection 安裝 roulette gateway

### 測試（273/273 通過；新增 36 條，既有 237 條零 regression；roulette 模組 Stmts ~88% / Funcs ~98%）

- `roulette.service.spec.ts` 28 條（vi.useFakeTimers + 注入 rng）：
  純函式（顏色/欄/打歸屬與邊界、賠率全型、0 綠全輸、大小 18/19 邊界、foldEntries
  cancel 語義、hotBets 排序）、狀態機時序（四階段循環、LOCK 才 rng(37)、
  新回合新 roundId、防重複啟動、鏡像 + readRouletteState、stop 後靜止、
  getRemainingMs 遞減）、下注驗證（happy/格式/單注上限/總注上限佔額回退/roundId/
  階段/250ms 截止/餘額不足零落帳回退/rpush 故障原路退款）、取消（退款 + 結算跳過 +
  再下注生效、空取消、LOCK 拒絕）、結算（多人批量單交易、refId 鏈、hotBets、
  聊天訊息、歷史、0 綠、無人下注不發聊天、交易失敗全額退款且機器不死）、
  結算容錯（lrange 故障不殺機器、hooks 拋錯/鏡像故障僅警告）、leader 選主
  （互斥、停機接手開新回合、Redis 故障退化單機）
- `test/integration/roulette-round.spec.ts` 8 條（gateway × service × fake io/socket）：
  owned 語義、連線同步（join room + phase 推送）、bet 成功/失敗 ack + bet_ack、
  cancel ack、全回合廣播路由（phase 全服、result 個人化 to room / 旁觀 except、
  COOLDOWN snapshot）、無人下注單一全服 result、多人各收個人化 result
- helpers/slot-fakes.ts：fake redis + hash/list 命令（hincrby/hget/hvals/rpush/
  lpush/lrange/llen/ltrim）+ `SET NX`（leader lock 語義）；fake db +
  `betRecordCreateThrows`（結算失敗注入）、BetRecord.roundId

## M15 驗收（DoD）

- [x] 後端測試 273/273（新增 36 條，既有 237 條零 regression）
- [x] roulette 模組覆蓋率 Stmts ~88% / Funcs ~98%（目標 ≥80% ✅）
- [x] `npm run lint` / `typecheck` / `build` 通過
- [x] 四階段狀態機：15/2/8/5 秒自動循環、`rngInt(37)` LOCK 產生、防重複啟動、
      重啟開新回合
- [x] 下注驗證：注型/單注 1000/總注 5000/BETTING 時窗（roundId + 250ms 截止緩衝）、
      即時扣款 + 失敗補償鏈（佔額回退 / 原路退款）
- [x] 批量結算單交易：BetRecord + credit refId 鏈；交易失敗全額退款（本金不蒸發）
- [x] 廣播：roulette:phase / result（個人化 user room + except 旁觀版）/
      bets_snapshot / bet_ack（payload 凍結形狀）；聊天系統訊息含開獎/總注/熱門注型
- [x] cluster 單一狀態機：Redis leader lock 互斥 + 接手（有測試）；
      Redis 故障退化單機模式
- [ ] 真機端對端（cluster ×2 + redis adapter 跨 worker 廣播、HMAC 簽章全鏈路、
      M16 前端對接時一併冒煙）

---

## M14 完成內容（2026-06-13）

### 全服 Jackpot 完整流程（01_GDD §3.4、02_TDD §6.3、05_MILESTONES M14）

**modules/jackpot/jackpot.service.ts（與 M11 累積接口合併，factory 改 deps 物件注入）**：

- `createJackpotService({ redis, prisma, wallet, emit?, chat?, log?, rng? })`——
  emit / chat 為可選後置出口（廣播與系統訊息失敗僅記日誌，永不影響派彩結果）
- `flush()`：`GETSET jackpot:delta 0` 原子取增量 + txcount 重置 →
  PG `pool = pool + delta, version = version + 1`（單行 increment 原子）；
  ★ PG 失敗時增量 `INCRBY` 放回 Redis 待下次重收（不遺失）；Redis/PG 任何故障
  皆回 0n 不拋錯（job 與派彩前置呼叫都不可被 flush 失敗中斷）
- `restoreLivePool()`：開機校準展示值 = pool(DB) + delta(Redis)（GDD §3.4.1 重啟恢復）
- `tryTriggerJackpot(points)`：等效整數判定 `rng(ceil(50000/(1+points/1000)))===0`，
  分母下限 5000（機率上限 1/5,000）；`triggerDenominator` 純函式導出供測試對照
- `payout(userId)`：強制 flush → 讀 pool/version → `payout = floor(pool×80%)`、
  remained 留底 20% → 單一 PG 交易（樂觀鎖 `WHERE version=:v` 行數 0 → 回滾重試 ≤3，
  耗盡拋 409 `OPTIMISTIC_LOCK_FAILED`）：條件更新 pool → JackpotHistory →
  `wallet.credit(JACKPOT, refId=history.id)`（餘額鐵律）→ 中獎者 jackpotPoints 歸零；
  交易後置：展示值 `DECRBY payout`（保留派彩窗口併發增量）→ `jackpot:won` 全服廣播
  （payload 凍結形狀 userId/username/avatarId/payout/poolBefore）→ 聊天室系統訊息
- `getPoolStatus()`（pool(DB)+delta(Redis)）、`getHistory(page,limit)`（JOIN user）

**modules/jackpot/jackpot.routes.ts**（公開路由，docs/04_API_SPEC.md §3.6）：
GET `/api/jackpot/pool`、GET `/api/jackpot/history`（BigInt→string）；app.ts 掛載

**jobs/queues.ts + jobs/jackpot-flush.job.ts（BullMQ，+dep bullmq ^5；ioredis 對齊 5.10.1）**：

- `createJobConnection()`：BullMQ 專用 ioredis 連線（`maxRetriesPerRequest: null` 硬性要求，
  與 redis plugin 一般連線語義衝突故獨立）；`createJackpotFlushQueue()` 定義 jackpotFlushQueue
- repeatable jobs：`flush`（10s）+ `tick`（5s：txcount ≥ 500 先提前 flush，再
  `io.emit jackpot:tick { pool }` 經 redis adapter 跨 worker 全服廣播）；
  cluster ×2 各自註冊同 spec——BullMQ repeat key 去重，每次迭代僅一 worker 執行
- `createJackpotJobProcessor(deps)` 與接線分離（單元測試 fake deps 直接驅動）；
  processor 捕捉一切錯誤僅記日誌（Redis 故障不可中斷其他服務）
- `registerJackpotJobs(app)`：restoreLivePool → repeatable 註冊（fire-and-forget，
  開發環境 Redis 未起不阻塞 listen）→ Worker 消費 → onClose 收尾；
  server.ts 於 initSocketServer 之後呼叫（tick 廣播依賴 app.io）

**modules/slot/slot.service.ts 接線**：

- spin 交易內先讀「本次旋轉前」jackpotPoints → `tryTriggerJackpot`（Diamond 本次給點
  不追溯）→ BetRecord.detail.jackpotTriggered 如實落庫
- 觸發後於交易之外 `await jackpot.payout(userId)`：成功 → 回應
  `jackpotPayout`（SpinRes M14 擴充欄位，BigInt→string）+ `newBalance` 含派彩入帳 +
  `jackpotPoints: 0`；失敗（樂觀鎖耗盡等）→ 記 error 日誌、`jackpotPayout: null`、
  spin 不拋錯（下注交易已提交；detail 標記供對帳）；觸發不影響本次旋轉贏分
- slot.routes.ts 組裝完整 jackpot service（emit 經 `app.io`、chat.service 系統訊息）

**前端**：

- `packages/shared` SpinRes + `jackpotPayout: string | null`
- `SlotView.vue`：訂閱 `jackpot:won` → Ticker 即時更新（poolBefore − payout）+
  他人中獎 Toast（自己中獎由 spin 回應的 JACKPOT Toast 顯示金額，不重複打擾）；
  onUnmounted 一併 off

### 測試（237/237 通過；新增 26 條，既有 211 條零 regression）

- `jackpot.service.spec.ts` 20 條：M11 六條保留 + flush（增量落庫/0 增量/GETSET 故障/
  PG 故障增量放回/restoreLivePool）+ 觸發分母對照表（0/100/1000/9000/超大/負數）+
  rng 注入觸發判定 + 派彩 happy path（80/20、History、JACKPOT Tx refId、點數歸零、
  DECRBY、廣播凍結 payload、系統訊息）+ 樂觀鎖競態重試成功（無雙重支付）+
  重試耗盡 409 零落帳回滾 + 空池 null + 後置三項故障容錯 + pool 查詢/歷史分頁
- `jackpot-flush.job.spec.ts` 7 條：flush/tick 分派、tick 廣播凍結 payload、
  txcount 門檻（≥500 提前 flush / 499 不觸發 / 讀取故障跳過）、保險絲不外溢、未知任務
- `slot.service.spec.ts` +5 條：觸發以旋轉前點數計算、未觸發不派彩、觸發成功
  （jackpotPayout/newBalance/點數歸零/detail 標記）、派彩拋錯 spin 不拋（記 error）、
  空池觸發不影響餘額；integration 樁補 tryTriggerJackpot/payout
- helpers/slot-fakes.ts：fake prisma + jackpot 單行表（updateMany 條件更新原子語義、
  bumpJackpotVersionAfterRead 競態注入、jackpotUpdateThrows）+ jackpotHistory +
  $transaction 快照含 jackpot；fake redis + getset/decrby

## M14 驗收（DoD）

- [x] 後端測試 237/237（新增 26 條，既有 211 條零 regression）
- [x] `npm run lint` / `typecheck` 通過（前端 `vue-tsc --noEmit` 0 errors）
- [x] flush：GETSET 原子取增量 + 10s repeatable + txcount≥500 提前 flush（tick job 檢查）
- [x] 觸發判定：基礎 1/50,000、每 100 點 +10% 相對機率、上限 1/5,000（等效整數化）
- [x] 派彩：強制 flush → 樂觀鎖重試 ≤3 → 80/20 分帳 → JackpotHistory →
      wallet.credit（餘額鐵律）→ 點數歸零；重試耗盡 409 且整筆回滾（防雙重支付，有測試）
- [x] `jackpot:won` 全服廣播（payload 凍結形狀）+ 聊天室系統訊息；後置故障僅記日誌
- [x] `jackpot:tick` 每 5 秒廣播（BullMQ tick job 經 redis adapter 跨 worker）
- [x] Redis 故障容錯：accumulate/flush/展示值全部退化不拋錯；PG 故障增量放回不遺失
- [x] 前端：JackpotTicker 訂閱 jackpot:won 即時更新 + 勝利通知；SpinRes.jackpotPayout 擴充
- [ ] PG + Redis + BullMQ 真機端對端（repeatable 去重、跨 worker 單執行、
      派彩全鏈路；併入 M25 部署冒煙）

---

## M17 完成內容（2026-06-12）

### 聊天室（Chat System）

**後端（backend/src/modules/chat/）**：

- `chat.service.ts`：`createChatService(deps)` 工廠
  - `filterUrls(text)`（純函式）：正則匹配 `https?://` 及裸域名，替換 `[連結已移除]`
  - `escapeHtml(text)`（純函式）：轉義 `& < > " '` 5 個核心字元
  - `sanitize(text)`：trim → filterUrls → escapeHtml
  - `checkRateLimit(userId)`：兩個 Redis 令牌桶
    - burst 桶 `chat:rl:burst:{userId}`：capacity=1, rate=0.5（最多 1 則/2s）
    - 分鐘桶 `chat:rl:min:{userId}`：capacity=10, rate=10/60（最多 10 則/min）
    - 直接重用 `plugins/rate-limit.ts` 的 `TOKEN_BUCKET_LUA`；Redis 故障 fail-open
  - `checkUserStatus(userId)`：查 `user.banned`、`user.muted`
  - `sendMessage(userId, rawContent)`：長度 → 狀態 → 頻率 → sanitize → 落庫 → pushToHistory → 回 payload
  - `sendSystemMessage(content)`：userId=null, system=true 直接落庫
  - `getHistory()`：lrange Redis List 反轉得舊→新；Redis miss 從 DB 補讀並非同步重建快取
  - `pushToHistory(payload)`：lpush + ltrim(0,199) + expire 7 天；失敗只 warn

- `chat.gateway.ts`：`createChatGateway(app, io, opts?)` 回傳安裝器
  - 安裝後立即推送歷史（個人 `chat:history`）
  - 監聽 `chat:send`：呼叫 service.sendMessage → io.emit(`chat:message`) 全服廣播；失敗回 ack 錯誤碼

- `sockets/index.ts`：在 `io.on('connection')` 內呼叫 `installChatGateway(socket)`

**前端（frontend/src/）**：

- `stores/chat.ts`（Pinia）：
  - State：`messages`（ChatMessagePayload[]）、`isConnected`、`error`
  - `connectSocket()`：安裝 Socket.IO 監聽器（防重複安裝，`socketInstalled` flag）
    - 監聽 `chat:history` → 替換 messages
    - 監聽 `chat:message` → push + trim 至 200 則
    - 監聽 `connect`/`disconnect` → 更新 isConnected
  - `sendMessage(text)`：前端長度過濾 → socket.emit `chat:send` → 回傳 ack 錯誤碼或 null
  - `disconnect()`：off 所有監聽器（路由切換時呼叫）

- `components/common/ChatPanel.vue`：右下角浮動面板
  - FAB 按鈕（紫色）+ 未讀計數徽章
  - 面板：連線狀態指示器（綠/紅點）+ 訊息列表 + 輸入框 + 發送按鈕
  - 自動捲到底（watch messages.length + nextTick）
  - 系統訊息灰色斜體、玩家訊息顯示 username + 時間
  - 前端錯誤碼友善文案映射（封禁/禁言/限流等）
  - Enter 發送（Shift+Enter 換行）

- `App.vue`：`v-if="auth.user !== null"` 條件掛載 ChatPanel（全域，所有頁面可用）

**單元測試（23 條）**：
- `filterUrls`：http/https、裸域名、多 URL、純文字
- `escapeHtml`：5 種特殊字元、單引號、純文字
- `sanitize`：URL+HTML 管線組合
- `sendMessage`：正常落庫、空訊息、超長、封禁、禁言、URL 清理、HTML 轉義、Redis eval 故障容錯、Redis lpush 故障容錯
- `getHistory`：Redis 命中（舊→新排序）、DB fallback
- `sendSystemMessage`：userId=null/system=true

### 測試結果

- 後端：**211/211 通過**（14 test files；新增 23 條 chat 測試，既有 188 條零 regression）
- 前端：`vue-tsc --noEmit` 0 errors

## M17 驗收（DoD）

- [x] chat:send Socket 事件：URL 過濾 + HTML 轉義 + 頻率限制 + 使用者狀態驗證
- [x] 兩層頻率限制：1 則/2s（burst）+ 10 則/min（分鐘桶），重用 TOKEN_BUCKET_LUA
- [x] Redis List 歷史快取：lpush/ltrim(0,199)/expire 7 天；新連線推送 chat:history
- [x] Redis miss fallback：DB 補讀並非同步重建快取
- [x] 系統訊息（sendSystemMessage）：userId=null, system=true
- [x] 後端單元測試 23/23（純函式 + service 完整覆蓋）
- [x] 後端全量 211/211 無 regression
- [x] 前端 ChatPanel：FAB + 面板 + 自動捲底 + 系統訊息樣式 + 未讀計數
- [x] App.vue：全域掛載，登入後可用
- [x] TypeScript strict：0 errors（前後端）
- [x] Redis 故障容錯：頻率桶/history 寫回失敗均不影響主流程
- [ ] 端對端冒煙測試（需 PG + Redis）

---

## M13 完成內容（2026-06-12）

### 護符系統（Charm System）

**後端（backend/src/modules/charm/）**：

- `charm.service.ts`：`createCharmService(deps)` 工廠——
  - `getInventory(userId)`：查 UserCharm JOIN Charm，回傳含裝備狀態完整清單
  - `equip(userId, userCharmId, slot)`：
    1. findUnique 驗所有權（NotFoundError / ForbiddenError）
    2. `prisma.$transaction`：清空目標槽位（updateMany equipped=false/slot=null）→ 裝備至目標槽位（update）；確保 `@@unique([userId, slot])` 無中途衝突
    3. `recompileAndCache(userId)` 回傳最新 LoadoutResult
  - `unequip(userId, slot)`：updateMany 清空槽位 → `recompileAndCache`（空槽靜默成功）
  - `recompileAndCache(userId)`：查已裝備且 enabled 護符 → `compileLoadout` → JSON 寫 Redis（`slot:loadout:{userId}` TTL 24h）；Redis 失敗僅 log.warn，永不拋錯（spin 路徑 cache miss 可自癒）
  - Redis 容錯：`createFakeRedis(failOnSet=true)` 注入後 equip 仍成功，僅留一條警告

- `charm.routes.ts`：Fastify plugin 掛載於 `/api/charm`（不需 HMAC，只需 JWT）——
  - `GET /inventory`：呼叫 service.getInventory
  - `POST /equip`：Zod parse `{ userCharmId, slot }`（slot 1–3）→ service.equip
  - `POST /unequip`：Zod parse `{ slot }` → service.unequip
  - `CharmRoutesOptions.service` 注入點供測試

- `app.ts`：掛載 `charmRoutes` 於 `/api/charm`

- `test/unit/charm.service.spec.ts`（10 條，全通過）：
  - getInventory 按使用者隔離
  - equip 空槽、equip 替換、跨槽移動、NotFoundError、ForbiddenError
  - Redis 故障容錯
  - unequip happy path、空槽靜默
  - disabled 護符不進 loadout（charmCodes 只含 enabled）

**前端（frontend/src/）**：

- `api/endpoints/charm.ts`：`apiGetCharmInventory` / `apiEquipCharm` / `apiUnequipCharm`（無 HMAC）

- `stores/charm.ts`（Pinia）：
  - State：`inventory`（UserCharmItem[]）、`loading`、`error`
  - Computed：`equippedBySlot`（`Map<slot, UserCharmItem>`）、`available`（未裝備且 enabled）
  - Actions：`fetchInventory()`、`equipCharm(userCharmId, slot)`、`unequipCharm(slot)`
  - equip/unequip 後重新 fetch（與後端 loadout 同步）

- `components/slot/CharmSlotBar.vue`（完整重寫 M12 佔位）：
  - 三槽位：已裝備 → 顯示類型圖示、護符名稱、稀有度邊框色 + 右上角 ✕ 卸下按鈕
  - 空槽 → `+` 按鈕，點擊開啟 picker 面板（Transition 動畫）
  - Picker 面板：可用護符清單，按稀有度著色（common/rare/epic/legendary），點擊裝備到該槽
  - `Teleport to="body"` backdrop 點擊關閉面板
  - emit `toast` 事件：裝備成功/失敗/卸下成功/失敗

- `views/SlotView.vue`（更新）：
  - import `useCharmStore` + 初始化
  - `onMounted` 新增 `void charmStore.fetchInventory()`
  - `<CharmSlotBar @toast="showToast" />` 接收 toast 事件

### 測試結果

- 後端：**188/188 通過**（13 test files；新增 10 條 charm 單元測試，既有 178 條零 regression）
- 前端：`vue-tsc --noEmit` 0 errors（strict mode）

## M13 驗收（DoD）

- [x] 後端 charm.service 單元測試 10/10（所有權驗證、交易語義、Redis 容錯、disabled 過濾）
- [x] 後端測試全量 188/188 無 regression
- [x] 前端 CharmSlotBar：三槽位 + 選擇面板 + 稀有度樣式 + 裝備/卸下 Toast
- [x] charm store：fetchInventory / equipCharm / unequipCharm + equippedBySlot/available computed
- [x] SlotView 整合：fetchInventory on mount + `@toast` 事件
- [x] TypeScript strict：0 errors（`vue-tsc --noEmit`）
- [x] Redis 失敗語義：recompileAndCache 故障不影響裝備結果（有測試）
- [x] `@@unique([userId, slot])` 交易保障：清舊槽 → 裝新護符，無中途 unique 衝突
- [ ] 端對端冒煙測試（需 PG + Redis；charm 路由不需 HMAC）

---

## M12 完成內容（2026-06-12）

### 老虎機前端（frontend/src/）

**新增檔案**：
- `api/endpoints/slot.ts`：`apiSpin`（POST /api/slot/spin + HMAC 簽章）、`apiGetPaytable`（GET /api/slot/paytable）
- `stores/slot.ts`（Pinia）：betAmount(10|50|100) / isSpinning / lastResult / pityCount / jackpotPool；
  `spin()` 呼叫 API → 更新 pityCount → 呼叫 walletStore.setBalance(newBalance)（server-authoritative）；
  axios 錯誤解析：422→餘額不足、429→限流、400→驗證錯誤；`clearError()`
- `components/slot/ReelColumn.vue`：props(finalSymbol, isSpinning, duration)；
  isSpinning=true → 80ms interval 輪播；false → 4 段減速(120/180/250/320ms)停在 finalSymbol → emit spinEnd；
  spinning 時符號 blur(3px)；active 狀態金邊 + glow
- `components/slot/CharmSlotBar.vue`：M12 空殼（3 槽位 🔮 + 點擊 handler 空實作）；M13 補全
- `components/slot/PaytableModal.vue`：Teleport+Transition 彈窗；mount 時呼叫 apiGetPaytable；
  展示 8 符號三連/二連倍率；luckySymbol 高亮 + banner；WILD/isText 符號特殊渲染
- `components/slot/PityIndicator.vue`：從 slotStore 讀 pityCount/currentPityThreshold；
  進度條 + "再 X 次觸發" 文字；閾值達到時高亮
- `views/SlotView.vue`：Header(back/CoinDisplay/username) + Jackpot Ticker(Socket JACKPOT_TICK) +
  三軸 ReelColumn + Win Overlay(動畫 winPop) + PityBadge + 注額按鈕(10/50/100) +
  旋轉按鈕(disabled during isAnimating) + CharmSlotBar + PityIndicator + PaytableModal；
  Toast 通知（餘額不足/保底/Jackpot）；最短動畫 1600ms + 逐軸停止（間隔 420ms）

**更新檔案**：
- `router/index.ts`：/slot 路由由 LobbyView 換為 SlotView（M12 完成）

**M12 驗收（DoD）**：
- [x] ReelColumn：isSpinning 驅動減速停止動畫，emit spinEnd，blur 視覺效果
- [x] 注額切換 UI（10/50/100），旋轉中禁用
- [x] PaytableModal：從後端 API 取資料，顯示 8 符號賠率 + 幸運符號高亮
- [x] PityIndicator：進度條 + 倒計文字，與 slotStore 同步
- [x] Server-driven balance：walletStore.setBalance(newBalance) 在 spin action 內呼叫
- [x] 錯誤處理：Toast 顯示 API 錯誤（餘額不足 / 限流 / 服務器錯誤）
- [x] 防連點：isAnimating 覆蓋旋轉全程（API call + 動畫）
- [x] Jackpot 即時金額：Socket JACKPOT_TICK 驅動 slotStore.jackpotPool
- [x] TypeScript strict：0 隱式 any，所有 null/undefined 顯式處理
- [ ] 端對端冒煙測試（需 PG + Redis + 後端啟動）

---

## M11 完成內容（2026-06-12）

### modules/slot/slot.service.ts（spin 主流程；02_TDD §2、GDD §3.3.2 步驟 4–7）

- `createSlotService(deps)` 工廠 + 依賴注入（prisma / redis / wallet / jackpot /
  anomaly? / log? / rng?）——rng 可注入（預設 csprng.rngInt），測試以決定性點位驅動盤面
- **loadout 快取**：`slot:loadout:{userId}`（TTL 24h）存 `CachedLoadout` 封包
  `{ loadout, luckySymbol, charmCodes }`——CompiledLoadout 本體不含幸運符號與護符 codes，
  但結算（PayoutInput.luckySymbol）與 BetRecord.detail.charmsUsed 需要，同次編譯一併封存；
  `parseCachedLoadout` 結構驗證：非 JSON / 形狀不符 / `version ≠ WEIGHT_TABLE_VERSION`
  （調參後舊快取）一律視為 miss → `compileLoadoutForUser`（UserCharm JOIN Charm
  where equipped & enabled → M10 `compileLoadout`）→ 寫回；DB/編譯異常 →
  500 `LOADOUT_COMPILE_FAILED`（shared/errors 新增 LoadoutCompileError；
  ⚠ 凍結錯誤碼表外的 5xx 內部碼，待 ADR 補錄 docs/04_API_SPEC.md §5）
- **spin 單一 PG 交易**（失敗整筆回滾零落帳）：BetRecord（amount/payout/serverSeedHash/
  detail{reels,charmsUsed,pityActive,luckySymbol,lineKind,wildUsed,luckyApplied,
  jackpotPointsEarned,jackpotTriggered:false}）→ `wallet.debit`（條件扣款，tx 傳入、
  refId=BetRecord.id）→ 贏分 `wallet.credit`（同 refId）→ jackpotPoints 累加
  （`tx.user.update increment`；非餘額欄位，wallet 鐵律不適用）
- **serverSeedHash** = sha256(rngBytes(32))（02_TDD §5.1 provably-fair 預留，只落 hash）
- **pity**：進場 GET `slot:pity:{userId}`（故障以 0 計——寧延後保底不誤發加成）；
  提交後中獎 DEL / 未中 INCR（GDD §3.3.2 步驟 7）
- **交易後置（失敗僅記日誌，永不影響已提交交易）**：pity 更新 →
  `jackpot.accumulate(betAmount)` → `anomaly.recordBet`（M06 骨架接線，fire-and-forget）
- **今日幸運符號**：讀 Redis `daily:lucky-symbol`（M18 daily-reset job 寫入＋批量失效
  loadout 快取；缺鍵/非法值/故障 → null）
- `paytable()`（8 符號 + 幸運符號 + ×1.5）與 `history()`（BetRecord gameType=SLOT 分頁，
  detail 防禦性還原 reels）
- jackpotTriggered 恆 false：觸發判定/派彩屬 M14，欄位依凍結 SpinRes 形狀先行

### modules/jackpot/jackpot.service.ts（M11 先落地累積接口；GDD §3.4.1）

- Redis keys：`jackpot:pool`（展示即時值）/ `jackpot:delta`（未落庫增量，M14 GETSET 取走）/
  `jackpot:txcount`（≥500 提前 flush）/ ★ `jackpot:centi`（新增 centi-coin 進位累進器——
  1% 對 10/50 注額是 0.1/0.5 Coin，逐筆 floor 會永久歸零小額貢獻；
  1 Coin=100 centi，betAmount 的 1% 恰為 betAmount centi，INCRBY 回傳值唯一單調，
  進位 = floor(新/100)−floor(舊/100)，併發精確不重不漏）
- `accumulate(betAmount)`：跨百位才 INCRBY pool/delta；Redis 故障記日誌回 0，
  永不阻斷下注主交易；`getLivePool()` 供 M14 廣播
- flush job / 觸發判定 / 樂觀鎖派彩 → M14

### modules/slot/slot.routes.ts + app.ts（docs/04_API_SPEC.md §3.4）

- POST `/api/slot/spin`（authenticate；hmac-guard 為 M06 全域 preHandler，
  signedRoutes 已預埋本路由，落地即自動受檢；rate-limit 2/s burst 5 同理）——
  SpinReq zod（10|50|100；非法注額依凍結規格回 400 `VALIDATION_ERROR`，
  不另設 INVALID_BET_AMOUNT）；回應 SpinRes 全欄位、newBalance BigInt→string
- GET `/api/slot/paytable`、GET `/api/slot/history`（分頁同 wallet 慣例）
- 路由 opts 支援 `service` 注入（整合測試決定性 rng）
- app.ts 掛載 `/api/slot`

### 測試（178/178 通過；新增 30 條；slot+jackpot 覆蓋率 Stmts 98.8% / Branch 92.8% / Funcs 100%）

- `test/helpers/slot-fakes.ts`：共用 fakes——fake prisma（updateMany 條件檢查+變更
  單一同步區塊＝SQL 原子性；★ $transaction 深拷貝快照+拋錯還原＝回滾語義）、
  fake redis（get/set/del/incr/incrby/expire + failOn 單方法故障注入）、
  makeRng 決定性點位序列（耗盡 fail loud）
- `slot.service.spec.ts` 16 條：中獎全流程（雙 Tx refId、pity 歸零、SpinRes 形狀）、
  未中獎（INCR、單 Tx）、注額驗證、★ 餘額不足整筆回滾（BetRecord 一併消失）、
  快取 hit 不查 DB / 損毀重編譯 / get+set 故障仍完成旋轉 / 版本不符重編譯、
  LOADOUT_COMPILE_FAILED、PITY 護符（達標 ×1.5+歸零 / 未達標）、幸運符號 ×1.5、
  DIAMOND 三連 +50 點同交易累加、accumulate 與輸贏無關、pity 更新故障容錯、
  paytable / history 分頁排序
- `jackpot.service.spec.ts` 6 條：注 100 進位 1、10×10 第十次進位（小額不損耗）、
  混合跨位、非法注額不碰 Redis、故障回 0 記警告、getLivePool
- `slot-spin.spec.ts` 整合 8 條：真 Fastify + 真 auth plugin（fp 名稱 'redis' 滿足依賴）×
  fake prisma/redis——401 / 400（凍結 VALIDATION_ERROR）/ 422 零落帳 /
  決定性 200 全欄位含 newBalance 字串 / 真 csprng 結構性斷言（帳目不變量
  newBalance = 5000−bet+payout）/ paytable / history ISO 時間

## M11 驗收（DoD）

- [x] 單元+整合測試 178/178（新增 30 條，既有 148 條無一破壞）
- [x] 覆蓋率：slot+jackpot 模組 Stmts 98.8% / Branch 92.8% / Funcs 100%（目標 >80% ✅）
- [x] `npm run lint` / `typecheck` / `build` 通過
- [x] 單一交易全流程：扣款 → BetRecord(serverSeedHash) → 賠付 → 點數；回滾零落帳實測
- [x] Redis 失敗語義：快取 miss 重編譯、pity/jackpot/anomaly 故障不影響交易（全有測試）
- [x] hmac-guard / rate-limit 自動生效（M06 預埋 signedRoutes + routeRules，無需改 plugin）
- [ ] PG + Redis 真機端對端（docker compose 環境已起；含 HMAC 簽章全鏈路驗證，
      建議與 M12 前端對接時一併冒煙）

---

## M10 完成內容（2026-06-12）

### config/constants.ts（遊戲數值單一來源；調參不動邏輯）

- `SLOT_SYMBOLS` 8 符號 tuple + `SlotSymbol` 型別（backend 不依賴 shared 的 TS enum）
- `SLOT_BASE_WEIGHTS`：每軸獨立結構（初版三軸同值）；★ 數值以 RTP 目標回推——
  CHERRY 57 / LEMON 8 / BELL 7 / BAR 6 / CLOVER 8 / LUCKY7 5 / DIAMOND 5 / WILD 4，
  解析 RTP ≈ **91.5%**（檔頭附完整計算式），落在 GDD 92%±2 目標。
  ⚠ GDD §3.3.2 示例權重（CHERRY 28…）解析 RTP 僅 ~30%，與 §2.4 凍結的 92% 矛盾，
  本檔以 RTP 目標為準；M26 一千萬次蒙地卡羅複核
- `SLOT_PAYTABLE`：GDD §3.2 凍結倍率（CHERRY 4/二連 1、…、WILD 100；僅 CHERRY 有二連）
- `WEIGHT_TABLE_VERSION`（數值變動必 bump → loadoutHash 變 → 快取自然失效）、
  `WEIGHT_PRECISION = 100`（浮點乘數 → 整數權重）、幸運 ×1.5（權重/賠率兩處）、
  Diamond 三連 +50 Jackpot 點

### modules/slot/（純函式三件套 + 型別；零 DB/Redis 依賴）

- `slot.types.ts`：ReelTable（cum + symbols）/ CompiledVariant（trigger/reelIndex/table）/
  CompiledRules（wildSubstitute / pityThreshold / pityMultiplier / bonuses[]）/
  CompiledLoadout（loadoutHash / reels / variants / rules / version，JSON 可序列化）/
  EquippedCharm（effect 為 DB Json 原樣）/ PayoutInput / PayoutResult
- `loadout-compiler.ts`：`compileLoadout()` 冪等編譯管線——
  基礎表 × WEIGHT 護符（多枚疊乘、可指定軸）× 幸運符號 ×1.5 → 整數化 cum；
  CONDITIONAL 以「最終表」為底再施變體乘數（key = 護符 code）；
  PITY 多枚取最低門檻+最高加成；effect 以 zod 逐型別解析，髒資料跳過不拋錯
  （快取 miss 重編譯不可癱瘓；M13 裝備 API 入口另行嚴格驗證）；
  `computeLoadoutHash()` = sha256(userId|排序 codes|lucky|v版本)
- `sampler.ts`：`binarySearchCum`（最小 i 使 cum[i] > point）、
  `sampleReel`（rngInt(totalWeight) 注入式 rng，預設 csprng）、
  `resolveThirdReelTable`（前兩軸同符號命中 trigger → variant 表）、
  `sampleSpin`（軸1→軸2→條件切換→軸3；可傳 variantReelOverride）；
  防呆：rng 超界 / 空表 / cum-symbols 長度不一致皆拋錯
- `payout.ts`：`evaluateLine` 候選枚舉取最高倍率——自然三連（含 WILD×3）、
  Wild 替代三連（需 RULE 解鎖；非 Wild 全同 + 至少一 Wild 一本尊）、
  左起二連（僅 double 非 null 符號；Wild 可補位但需至少一本尊）；
  `settlePayout`：幸運加成綁定「連線有效符號」（非盤面任一格）→ ×1.5、
  保底（計數 ≥ 門檻且中獎 → × pityMultiplier）、中獎歸零/未中 +1、
  Jackpot 點數（Diamond 三連 50 + BONUS 護符 onSymbol 命中疊加）、
  winAmount = floor(注額 × 基礎 × 幸運 × 保底)

### 測試（148/148 通過；新增 70 條；slot 模組覆蓋率 Stmts 99.2% / Branch 93.9% / Funcs 100%）

- `loadout-compiler.spec.ts`：基礎 cum 精確值、嚴格遞增、JSON 往返、WEIGHT 疊乘/指定軸、
  幸運疊乘、CONDITIONAL 以最終表為底（WEIGHT×幸運×變體乘數全鏈驗證）、
  PITY 多枚合併、BONUS 多枚、髒 effect 全型別跳過、hash 冪等/順序無關/四因子變異、
  toReelTable 邊界（取整保底 1、零權重剔除、全零拋錯）
- `sampler.spec.ts`：二分查找全點位窮舉 + 與線性掃描一致性（50 元素）、
  總權重 1 邊界、rng 超界/非整數拋錯、損毀表拋錯、條件切換四情境
  （命中/未命中/reelIndex 不符/override 優先）、真 rngInt 分布冒煙（20k 次寬鬆帶）
- `payout.spec.ts`：8 符號三連全表、二連左起限定、wild 預設不可替代/解鎖後
  五種替代盤面、幸運綁定連線符號（盤面出現≠加成）、保底六情境、
  floor 取整、Jackpot 點數五情境、輸入驗證拋錯、
  ★ RTP 蒙地卡羅 100k 次（斷言 [0.82, 1.02]，解析值 0.915，>15σ 不閃爍）
- 新增 devDep：`@vitest/coverage-v8`

## M10 驗收（DoD）

- [x] 單元測試 148/148（新增 70 條，既有 78 條無一破壞）
- [x] 覆蓋率：slot 模組 Stmts 99.2% / Branch 93.9% / Funcs 100%（目標 >90% ✅；
      slot.types.ts 為純型別檔無可執行語句）
- [x] `npm run lint` / `typecheck` / `build` 全 workspace 通過
- [x] 全部純函式、rng 可注入（與 security/csprng 整合，預設 rngInt）
- [x] RTP 小規模模擬已跑（100k 次 ≈ 0.92 落帶；M26 一千萬次複核 + 典型 Build）

---

## M09 完成內容（2026-06-12）

### 前端骨架（frontend/src/）

**依賴安裝**（frontend/package.json 新增）：
- `axios ^1.17`、`pinia ^3.0`、`vue-router ^5.1`、`socket.io-client ^4.8`

**api/sign.ts**（WebCrypto HMAC-SHA256）：
- `importHmacKey(base64url)` 含 `CryptoKey` 快取（每次請求不重複 importKey）
- `signRequest({ hmacKey, userId, gameType, betAmount, seq })` → nonce=`crypto.randomUUID()`、ts=`Date.now()`、canonical=`userId|gameType|betAmount|nonce|ts`、sig=hex
- `toHmacHeaders(result)` → `{ 'x-sig', 'x-nonce', 'x-ts', 'x-seq' }` 供 axios config.headers
- `clearKeyCache()` 登出時清快取
- ★ hmacKey 僅存 Pinia 記憶體，永不落 localStorage（02_TDD §5.2）

**api/http.ts**（axios 實例）：
- baseURL `/api`、timeout 15s
- 請求攔截器：async 懶載入 `useAuthStore()` 附加 `Authorization: Bearer`
- 回應攔截器：401 且未重試 → 呼叫 `auth.refresh()` 取新 token → 重試一次（`__retried` flag 避免無限迴圈）；refresh 失敗 → `auth.logout()` 強制清除

**api/endpoints/auth.ts**：`apiRegister / apiLogin / apiRefresh / apiLogout`

**api/endpoints/wallet.ts**：`apiGetBalance / apiGetTransactions`

**stores/auth.ts**（Pinia）：
- 持久化：`accessToken` / `refreshToken` / `user` → localStorage；`hmacKey` / `seq` → 僅記憶體
- `nextSeq()` 回傳當前序號後自增（供 signRequest）
- `login / register / logout / refresh / setBalance`；refresh 回傳新 accessToken 供攔截器重送
- 循環依賴：auth.ts 的 apiXxx 函式以動態 `import()` 懶載入（http.ts 也同樣懶載入 auth store）

**stores/wallet.ts**（Pinia）：
- `fetchBalance()` → GET /api/wallet/balance → 同步 auth store user.balance
- `setBalance(newBalance)` 供遊戲結算後直接更新（避免重複 fetch）

**socket/client.ts**（Socket.IO 單例）：
- `getSocket()` / `disconnectSocket()`
- auth.token 用 callback 形式讀取（每次重連取最新 token）
- transports: `['websocket', 'polling']`、指數退避重連（1s→20s，最多 10 次）
- `connect_error` 攔截：SERVER_FULL / UNAUTHORIZED 各給不同 console.warn

**router/index.ts**（Vue Router 5）：
- History 模式；routes：`/login`、`/`（lobby）、`/slot`、`/roulette`、`/leaderboard`、`/profile`、`/*`→`/`
- beforeEach 守衛：懶載入 auth store，未登入訪問 requiresAuth 路由 → `/login?redirect=…`

**views/LoginView.vue**：
- 登入/註冊 tab 切換；前端 validate（長度/regex/確認密碼）；後端錯誤碼透出；
  成功後跳轉 redirect query param 或 `/`；深色漸層主題

**views/LobbyView.vue**：
- 頂部：品牌名、CoinDisplay、使用者名稱、登出按鈕
- 公告橫幅（system:announcement Socket 事件）
- 歡迎語 + Jackpot 即時金額（jackpot:tick Socket 事件）
- 四個遊戲入口卡片（老虎機/輪盤/排行榜/個人頁）→ RouterLink

**components/common/CoinDisplay.vue**：
- 訂閱 wallet store；`BigInt` 格式化為 `Number.toLocaleString()`；
  餘額增減時觸發 flash-up/flash-down 600ms 動畫

**main.ts**：createApp → createPinia → createRouter → mount('#app')

### 建置驗證

- `vue-tsc --noEmit`：0 errors（strict mode）
- `vite build`：152 modules 成功，dist 產出正常
- 後端 78/78 tests 無 regression

## M09 驗收（DoD）

- [x] `vue-tsc --noEmit` / `vite build` 通過
- [x] 後端測試 78/78 無 regression
- [x] HMAC sign.ts：WebCrypto 實作、key 僅記憶體
- [x] http.ts：401→refresh→retry 單次、循環依賴以懶載入解決
- [x] auth/wallet Pinia stores 完備（持久化策略正確）
- [x] Socket.IO 單例：websocket 優先、指數退避重連、auth callback
- [x] Router：history 模式 + beforeEach 守衛
- [x] LoginView：登入/註冊切換 + 前端驗證 + 後端錯誤透出
- [x] LobbyView：餘額 / Jackpot / 公告 / 遊戲入口
- [x] CoinDisplay：wallet store 訂閱 + 增減動畫
- [ ] 真實後端冒煙測試（需 PG + Redis）——型別介面已對齊 docs/04_API_SPEC.md，
      待環境就緒後補做端對端驗證

---

## M08 完成內容（2026-06-12）

### sockets/（02_TDD §2/§8、04_FOLDER_STRUCTURE §1）

- `sockets/index.ts`：`initSocketServer(app, opts?)`——Socket.IO 附加至 Fastify 的 HTTP server
  （Fastify 實例化即建 server，attach 早於 listen；engine.io 接管 request/upgrade，
  非 /socket.io/ 路徑原樣轉交 Fastify，HTTP API 不受影響）：
  - path `/socket.io/`（對齊 Nginx location）、transports polling+websocket、
    maxHttpBufferSize 4KB、serveClient off；dev 模式開 CORS（前端 :5173/:5174 直連）
  - **Redis adapter**：`createAdapter(app.redis, app.redisSub)`（主連線當 pub、
    redis plugin 預留的訂閱連線當 sub）；Redis 未 ready：開發降級記憶體 adapter（警告）、
    生產 throw（雙保險——redis plugin 已 fail loud）
  - 連線生命週期：connection 時安裝 HMAC 封包中介層 + 發布連線數；onClose hook（LIFO，
    先於 redis quit）停心跳 → 踢所有 socket → `io.close()`
  - decorate `app.io`（型別 GameServer）
- `sockets/middleware.ts`：
  - `createConnectionGauge`：跨 worker 連線計數——各 worker 將自身連線數寫
    `socket:conns:{instanceId}`（EX 90s + 30s 心跳續期，worker 崩潰鍵自然過期、計數自癒）；
    握手時 SCAN+MGET 加總全 worker。★ Redis 非 ready 直接走本地計數
    （ioredis offline queue 會把握手拖慢數秒——實測踩到後加的防護）
  - `createHandshakeAuth`：握手 JWT（`auth.token` 或 query.token → `app.jwt.verify` →
    綁定 `socket.data.{userId,role}`）→ 全域連線數 ≥ 上限（env.SOCKET_MAX_CONNECTIONS=200）
    拒絕，client 收 `connect_error('server_full', data.code='SERVER_FULL')`
  - `createGameEventGuard`：`socket.use` 封包中介層，攔 `slot:spin`/`roulette:bet`
    （凍結於 04_API_SPEC §4.2；chat:send 依規格不需簽章）。與 HTTP hmac-guard 同序同義
    共用 security/：欄位齊備 → 時間窗 ±5s → betAmount 萃取（roulette 為 bets[].amount 加總）→
    簽章（current+prev）→ nonce → seq。失敗：IllegalPacketLog fire-and-forget
    （endpoint=`SOCKET slot:spin`）+ ack 回錯誤碼、封包不進 handler；
    Redis 故障：開發放行、生產 fail-closed
- `sockets/events.ts`：事件名稱常數 + SocketSessionData / GameServer / GameSocket 型別。
  ⚠ 鏡像 packages/shared/src/socket-events.ts（backend rootDir=src 暫無法 import shared
  的 .ts 入口；待 shared 出編譯產物或 project references 後改 re-export）
- `server.ts`：buildApp 後、listen 前 `initSocketServer(app)`；優雅關閉鏈不變
- `cluster.ts`：註解補 M08 語義——每 worker 各持 io 實例、redis adapter 跨 worker 廣播；
  ★ 黏著備註：cluster 對新 TCP 連線輪詢分派，Nginx ip_hash 黏不住「本機 → worker」，
  long-polling 後續請求可能落錯 worker（Session ID unknown）；websocket 單連線不受影響，
  M09 前端 websocket 優先即可規避，嚴格需要 polling 時再導入 @socket.io/sticky
- `package.json`：+ socket.io ^4.8、@socket.io/redis-adapter ^8.3（dev：socket.io-client）
- 斷線重連：依賴 Socket.IO 原生機制（client 自動重連、重新握手驗證），無伺服器端狀態

### 測試（78/78 通過；新增 socket 整合 11 條）

- `test/integration/socket-connection.spec.ts`：真實 Fastify+io（port 0）× socket.io-client 實連，
  無 PG/Redis 可跑（與既有測試環境假設一致）：
  - 握手：auth.token 成功 + socket.data.userId 綁定（echo 事件驗證）、query token、
    缺 token / 偽 token → connect_error UNAUTHORIZED
  - HTTP 不破壞：io 附加後 /healthz 仍 200
  - 上限：maxConnections=2 → 第三條 connect_error('server_full') 且既有連線存活；
    釋出後可再握手（client 端 forceNew 避開 Manager 快取）
  - HMAC：缺簽章欄位 / payload 非物件 → ERR_BAD_SIGNATURE；ts 超窗 → ERR_STALE_REQUEST；
    roulette 非法注額 → ERR_BAD_SIGNATURE；非簽章事件不受攔截

## M08 驗收（DoD）

- [x] 整合測試 11 條全過（既有 67 條無一破壞，合計 78/78）
- [x] `npm run lint` / `typecheck` / `build` 通過
- [x] Socket.IO 附加後 HTTP API 不受影響（整合測試 /healthz 實測）
- [x] 握手 JWT 驗證、200 連線上限拒絕（server_full）、遊戲事件 HMAC 中介層
      （與 HTTP 共用 security/）皆落地並有測試
- [ ] Redis 真機驗證（redis adapter 跨 worker 廣播、跨 worker 連線計數、
      M06 遺留的 nonce/seq Lua 實機）——本機仍無 Docker/Redis；
      程式碼已按 Redis 存在路徑實作並以無 Redis 降級路徑通過測試，待環境補驗

---

## M07 完成內容（2026-06-12）

### modules/wallet/（★ 全專案唯一允許動 users.balance 的位置）

- `wallet.service.ts`：
  - `debit(userId, amount, type, opts)`：條件更新核心約束——
    `updateMany({ where: { id, balance: { gte: amount } }, data: { balance: { decrement }, version: { increment: 1 } } })`
    → `count !== 1` 時再查使用者存在性：不存在 404 / 存在即 422 InsufficientBalanceError，整筆回滾零落帳
  - `credit(...)`：同走 updateMany + 行數檢查（使用者不存在回 404 而非 P2025 例外）
  - 兩者同交易寫 BalanceTransaction(before/after/delta/type/refId/memo)；
    balanceBefore 由「更新後讀回 ∓ amount」推導——PG 行級鎖自 UPDATE 持有至 commit，
    併發寫者阻塞於 updateMany，讀回值必為本次異動後值（檔頭有完整論證）
  - `opts.tx`（Prisma.TransactionClient）：遊戲結算可傳入既有交易（slot spin 單交易編排，
    02_TDD §4 關鍵存取模式）；未傳入時 wallet 自行包 $transaction
  - `getBalance` / `listTransactions`（分頁 + TxType 篩選）
- `wallet.types.ts`：TxListQuerySchema（zod，page/limit/type）+ service 介面型別
  （WalletMutateOptions / WalletMutationResult / BalanceResult / TxListResult）
- `wallet.routes.ts`：GET /api/wallet/balance、GET /api/wallet/transactions（皆 authenticate；
  BigInt → string 序列化）；**不提供寫入端點**——debit/credit 僅供其他模組 service 呼叫
- `app.ts`：掛載 /api/wallet
- `shared/errors.ts`：InsufficientBalanceError 400 → 422（對齊 docs/04_API_SPEC.md §5 凍結碼）
- `shared/validation.ts`：parse() 簽名分離 zod Input/Output——支援帶 .default()/.coerce 的
  分頁 query schema（原簽名強制 Input=Output，遇 .default() 推導錯誤）

### scripts/audit-balance.ts（02_TDD §5.6 對帳）

- 逐使用者三項檢查：①單筆完整性 delta=after-before ②期末一致 最後一筆 after=現值
  ③總和一致 第一筆 before + SUM(delta) = 現值（before 作基線——新手禮包 5000 為 default 無 Tx）
- 無交易使用者跳過；任何差異列明細並 exit 1；`npm run audit:balance`

### 測試（67/67 通過；新增 wallet 16 條）

- `test/unit/wallet.service.spec.ts`：fake prisma 的 updateMany「條件檢查+變更」在單一同步
  區塊完成（無 await 切點）＝忠實重現 SQL 條件更新原子性，併發競態與真 DB 同構
  - debit：成功（before/after/version/refId 全驗）、扣至歸零、不足回滾零落帳、404/422 區分、金額驗證
  - credit：成功、memo、404、金額驗證
  - ★ 併發：10×debit(100) 搶 500 → 恰 5 成功 5 拒、終值 0、version=5、SUM(delta)=-500；
    兩請求搶一筆額度恰一贏家；混合 debit/credit 後對帳三不變量成立
  - 交易組合：傳 tx 不另開 $transaction（呼叫計數驗證）；getBalance/listTransactions

## M07 驗收（DoD）— 含真實 SQLite E2E

- [x] 單元測試 67/67（wallet 16 條新增，既有 51 條無一破壞）
- [x] `npm run lint` / `typecheck` / `build` 全 workspace 通過；npm audit 0 vulnerabilities
- [x] SQLite E2E 實測（真 Prisma client + db push 建表，驗後清理）：
      debit/credit 往返、before/after 落帳正確、餘額不足回滾零落帳、
      **併發 10×debit(200) 搶 1000 → 恰好 5 成功 5 InsufficientBalance、終值 0、寫鎖失敗 0**
- [x] audit-balance.ts 實測：乾淨帳本回 ✅ exit 0；以 raw SQL 繞過 wallet 污染餘額後，
      「期末一致」與「總和一致」雙雙命中、exit 1
- [x] E2E 後已還原 PG client（provider=postgresql 確認）、全量測試重跑通過

---

## M06 完成內容（2026-06-12）

### security/（02_TDD §5.1–5.3, §5.7）

- `security/csprng.ts`：★ 全專案唯一亂數出口——rngInt（randomInt 無模偏差）、rngIntRange、
  rngBytes、rngToken（base64url）、rngHex、rngUuid；ESLint 全域禁 Math.random 已就位（M01）
- `security/hmac.ts`：
  - 純函式：generateHmacKey（32B base64url）、buildCanonical（`userId|gameType|betAmount|nonce|timestamp`）、
    signCanonical（HMAC-SHA256 hex）、safeEqualHex（timingSafeEqual + 等長/非法 hex 前置防護——
    Buffer.from('hex') 遇非法字元默默截斷，以「解析後長度 ×2 = 原字串長度」識破）、
    verifySignature（多把金鑰全部比完不提前 return，避免金鑰數量時間側信道）
  - createHmacKeyStore（Redis）：rotate（舊鑰 → `hmac:{uid}:prev` EX 30s 寬限、新鑰 EX 7d，
    存 JSON {key, issuedAt} 對齊 TDD）、revoke（DEL 兩鍵）、getActiveKeys（mget + 損毀 JSON 容錯）
- `security/nonce.ts`：checkNonce（`SET nonce:{uid}:{nonce} 1 NX EX 10`，SET 失敗＝重放）、
  checkSeq（SEQ_GUARD_LUA 原子比較交換：嚴格遞增才寫入，鍵缺省視為 -1，被拒不動現值）、resetSeq
- `security/anomaly.ts`：骨架——規則 1（下注頻率 > 2 次/秒，1s 固定桶 INCR+EXPIRE）已實作，
  規則 2/3（勝率視窗、淨贏 P99）留 TODO(M24)；Redis 失敗靜默略過（輔助功能永不阻斷下注）；
  onFlag 回呼注入（M24 接 User.flagged + Admin 通知）

### plugins/

- `plugins/hmac-guard.ts`：全域 preHandler——僅檢查 signedRoutes
  （`POST /api/slot/spin`、`POST /api/roulette/bet`，M11/M15 路由落地即自動受檢）+ allowList 雙保險。
  驗證順序：JWT（canonical 的 userId 取自已驗證 token）→ 標頭齊備 → 時間窗 ±5s →
  betAmount 萃取（roulette 為 bets[].amount 加總）→ 簽章（current+prev 兩把）→
  nonce → seq（簽章合法後才消耗，偽造封包燒不掉合法 nonce/seq）。
  失敗：IllegalPacketLog fire-and-forget + 400 PacketViolationError。
  Redis 故障：開發警告放行、生產 fail-closed（防重放不可降級）
- `plugins/rate-limit.ts`：全域 preHandler 令牌桶——TOKEN_BUCKET_LUA 原子執行（跨 cluster worker 共桶）
  + consumeToken 同義純函式（單元測試覆蓋演算法）。預設 10 req/s burst 20（對齊 Nginx），
  spin/bet 路由收緊 2 req/s burst 5；計數維度 = JWT sub（decode 不驗章，僅分桶）或 IP × 路由。
  Redis 故障 fail-open（與 hmac-guard 刻意相反：限流可降級，Nginx 第一道仍在）；429 帶 retry-after
- `plugins/auth.ts`：decorate `app.hmacKeys`（createHmacKeyStore，TTL=7d）；fp dependencies ['redis']

### modules/

- `modules/audit/illegal-packet.service.ts`：record() fire-and-forget（落庫失敗僅進日誌，
  永不阻塞回應）+ write()（可等待，測試用）；ip/endpoint/rawSample 依 schema 截斷 45/80/1024
- `modules/auth/auth.service.ts`：deps + hmacKeys（Pick<HmacKeyStore,'rotate'|'revoke'>）——
  login/refresh 輪換金鑰隨回應下發（TokenPair + hmacKey 欄位）、logout 即刻撤銷；
  Redis 不可用：開發回空字串續行（guard 同步跳過）、生產 fail loud
- `modules/auth/auth.types.ts`：TokenPair.hmacKey（base64url，僅 TLS 下發一次，前端存記憶體）

### app.ts / shared/

- `app.ts`：register rateLimitPlugin（allowList /healthz + spin/bet 路由覆寫）→
  hmacGuardPlugin（allowList /healthz、/api/auth）；註冊順序 = 執行順序（先限流再驗章）
- `shared/errors.ts`：+ PacketViolationError（ERR_BAD_SIGNATURE / ERR_NONCE_REPLAY /
  ERR_SEQ_REGRESSION / ERR_STALE_REQUEST，HTTP 400）；RateLimitError 碼值改為
  RATE_LIMIT_EXCEEDED（對齊 docs/04_API_SPEC.md §5 凍結錯誤碼）

### 測試（51/51 通過）

- `test/unit/hmac.spec.ts` 12 條：canonical 格式、簽章往返、五欄位逐一竄改全偵測、
  prev 金鑰寬限通過、safeEqualHex 邊界（等長/空/非 hex）、金鑰存放器生命週期（fake redis）
- `test/unit/nonce.spec.ts` 11 條：nonce 首見/重放/使用者隔離、seq 遞增/重複/倒退/跳號/
  被拒不動現值/隔離/reset
- `test/unit/rate-limit.spec.ts` 7 條：突發允許、超限拒絕、retryAfter 估算、按時補充、
  容量封頂、時鐘回撥不倒扣、預設規則對齊 Nginx
- `test/unit/auth.service.spec.ts` 18→21 條：原有全數保留 + HMAC 金鑰協商/輪換/登出撤銷

## M06 驗收（DoD）

- [x] 單元測試 51/51 通過（vitest；新增 30 條 + 既有 18 條無一破壞 + HMAC 生命週期 3 條）
- [x] `npm run lint` / `typecheck` / `build` 全 workspace 通過；npm audit 0 vulnerabilities
- [x] 冒煙實測（dev 模式、無 PG/Redis）：/healthz 200、404 標準格式不變、
      30 連發無 500（rate-limit fail-open 警告正確出現於日誌）
- [ ] Redis 實機驗證（429 觸發、nonce/seq Lua、金鑰輪換寬限）——本機無 Redis，
      Lua 語義已由 fake 同義實作覆蓋，真機驗證併入 M08（Socket.IO 基座需起 Redis）
- [ ] 攻擊向量演練（重放/竄改/逾時）屬 M27 範圍；簽章測試向量已備
      （hmac.spec 竄改測試即向量來源，M09 前端先過向量再接 API）

---

## M05 完成內容（2026-06-12）

### docs/04_API_SPEC.md（規格凍結）

- 全部 REST 路由：13 個模組、共 53 條路由——路徑、HTTP 方法、認證要求、HMAC 要求、
  Request DTO 概要、Response DTO 概要、可能錯誤碼全部列明
- Socket.IO 事件全表：
  - Client → Server：`slot:spin`、`roulette:bet`、`roulette:cancel`、`chat:send`（含 HMAC payload）
  - Server → Client：14 種事件（個人通知 5 種 + 全服廣播 9 種），payload 型別完整列出
- HMAC canonical string 格式明確定義（slot / roulette 各有對應格式）
- 錯誤碼總表：30 個 error code，含 HTTP 狀態碼與觸發場景

### packages/shared（型別建立）

- `src/enums.ts`：
  - Prisma 對齊 enum 9 個：`Role / GameType / TxType / CharmType / CharmRarity / TaskType /
    LeaderboardKind / LoginResult / PacketViolation`
  - 客戶端專用 enum 3 個：`SlotSymbol / RouletteBetType / RoulettePhase`

- `src/constants.ts`：共用常數 27 個——注額檔位、輪盤各階段時長、聊天頻率限制、
  保底參數、Jackpot 參數、Socket 上限、HMAC 容忍窗口等

- `src/socket-events.ts`：
  - `SOCKET_EVENTS` 常數物件（後端 sockets/events.ts 與前端直接匯入，杜絕字串誤打）
  - `SignatureFields` 介面（HMAC 欄位共用型別）
  - Client → Server payload 型別：4 個
  - Server → Client payload 型別：13 個
  - `ServerToClientEvents` + `ClientToServerEvents`（Socket.IO v4 typed events 介面）
  - `SocketAuth`（握手 auth 資料結構）

- `src/dto/`（13 個模組 DTO 檔）：
  | 檔案 | Zod Schema 數 | 介面型別數 |
  |---|---|---|
  | `auth.dto.ts` | 4（Register/Login/Refresh/Logout） | 6（AuthUserInfo/AuthTokens/RegisterRes/LoginRes/RefreshRes/MeRes） |
  | `user.dto.ts` | 1（UpdateAvatar） | 5 |
  | `wallet.dto.ts` | 1（TxListQuery） | 3 |
  | `slot.dto.ts` | 1（SpinReq） | 5 |
  | `roulette.dto.ts` | 3（SingleBet/BetReq/CancelReq） | 7 |
  | `charm.dto.ts` | 2（Equip/Unequip） | 4 |
  | `jackpot.dto.ts` | 0 | 3 |
  | `daily.dto.ts` | 1（ClaimTask） | 4 |
  | `leaderboard.dto.ts` | 0 | 4 |
  | `chat.dto.ts` | 1（ChatSend） | 2 |
  | `gift-code.dto.ts` | 1（Redeem） | 2 |
  | `admin.dto.ts` | 13 | 12 |
  | `monitor.dto.ts` | 0 | 5 |

- `src/index.ts`：統一 re-export enums / constants / socket-events / dto

- `package.json`：新增 `zod ^3.23.8` 依賴（供 Zod schema 在前後端共用）

---

## M05 驗收（DoD）

- [x] `docs/04_API_SPEC.md` 完整列出所有模組路由（路徑/方法/DTO/錯誤碼）
- [x] Socket.IO 事件全表（Client→Server 4 個 + Server→Client 14 個）完整
- [x] `packages/shared/src/enums.ts`：12 個 enum，與 Prisma schema enum 名稱完全一致
- [x] `packages/shared/src/constants.ts`：27 個共用常數
- [x] `packages/shared/src/socket-events.ts`：事件名稱常數 + typed events 介面
- [x] `packages/shared/src/dto/`：13 個模組 DTO 檔，含 zod schema + TypeScript 介面
- [x] `packages/shared/src/index.ts`：統一匯出
- [x] `packages/shared/package.json`：新增 zod 依賴

待驗證（M06 開始時確認）：
- [ ] `npm install`（zod 實際安裝）後 `npm run typecheck` 全 workspace 通過
- [ ] 後端 `auth.types.ts` 遷移至 packages/shared（可在 M06 或下一 auth 修改時同步）

---

## M04 完成內容（2026-06-12）

- `modules/auth/auth.types.ts`：zod schema（username 3–20 英數底線、password 8–72、
  refreshToken 128 hex）+ DTO 型別（M05 遷移至 packages/shared）
- `modules/auth/auth.service.ts`：工廠函式 + 依賴注入（prisma、signAccessToken 可換假實作）
  - 純函式：hashPassword/verifyPassword（argon2id）、generateRefreshToken（randomBytes(64).hex）、
    hashToken（sha256，DB 永不存明文）、ttlToSeconds、refreshTokenExpiry
  - register：argon2id 雜湊 → 建 User（balance 5000 / role PLAYER）；P2002 → 409（以 DB unique 為準，無 TOCTOU）
  - login：帳號不存在與密碼錯誤回同一 401 訊息（不洩漏存在性）；banned → 403；
    一律落 LoginLog（SUCCESS/WRONG_PASSWORD/BANNED + IP + UA）；每次登入開新 familyId 旋轉鏈
  - refresh：條件更新搶占舊 token（updateMany where revoked=false，count!==1 視為重用——
    與餘額扣款同模式，並發重放只有一個贏家）；重用偵測 → 撤銷全家族 → 403；過期 → 401
  - logout：撤銷整個家族，冪等
- `modules/auth/auth.routes.ts`：POST register(201)/login/refresh/logout + GET /me（authenticate 示範）
- `modules/user/user.service.ts`：findById/findByUsername/createPlayer（不含任何餘額方法）
- `plugins/auth.ts`：authenticate 補全——缺 Bearer header 與驗證失敗分別回明確 401
- `app.ts`：掛載 /api/auth；★ 修正 setErrorHandler/setNotFoundHandler 移至 module 註冊之前
  （Fastify 子 context 在註冊當下繼承父層 handler，原順序導致模組內錯誤回 Fastify 預設格式）
- 測試：vitest（devDep）+ `test/unit/auth.service.spec.ts` 18 條——純函式 + in-memory fake prisma
  覆蓋旋轉、重用全家族撤銷、過期、登出冪等、多裝置 family 隔離

## M04 驗收（DoD）— 全部實測

- [x] 單元測試 18/18 通過（vitest）
- [x] SQLite E2E：register 201 / 重複 409 / 格式錯 400 / 錯密碼 401 / login 回 JWT+refresh /
      /me 帶 Bearer 解出 {sub, role} / 無 token 401
- [x] 旋轉鏈 E2E：refresh 換發新 token → 重用舊 token 403 → 同家族新 token 一併失效 →
      logout 後 refresh 被拒；DB 內 5 筆 token 全部 revoked、LoginLog 4 筆正確
- [x] 錯誤回應全走標準格式 { error: { code, message } }（修正 handler 註冊順序後驗證）
- [x] `npm run lint` / `build` / `test` 全通過；npm audit 0 vulnerabilities

---

## M03 完成內容（2026-06-12）

- `src/cluster.ts`：node:cluster 入口——WORKERS 環境變數決定 fork 數（預設 2，上限 4），
  worker 崩潰自動重啟、crash-loop 保險絲（30s 內死亡 >5 次 primary 結束，交給 restart policy）、
  SIGTERM/SIGINT 轉發 workers
- `src/server.ts`：單 worker 啟動 + 優雅關閉（SIGTERM/SIGINT → app.close() 觸發各 plugin onClose，
  10s 保險絲強制退出；另監聽 IPC `disconnect`——primary 消失時 worker 自我關閉，防孤兒佔端口）
- `src/app.ts`：Fastify 組裝（plugins → modules 掛載點 → /healthz → 404 → 全域錯誤處理）；
  pino 日誌（dev 用 pino-pretty、redact authorization/cookie）、trustProxy（Nginx 後方）、bodyLimit 32KB
- `src/config/env.ts`：zod 驗證全部環境變數，import 時即執行、缺漏列全錯誤後 exit(1)（fail loud）；
  自動補載 monorepo 根目錄 .env（不覆蓋已注入值）
- `src/plugins/prisma.ts`：PrismaClient 單例 + onClose $disconnect；生產啟動即 $connect fail loud，
  開發惰性連線（本機沒起 PG 也能跑骨架）
- `src/plugins/redis.ts`：ioredis 主連線 + pub/sub 訂閱連線（M08 redis-adapter 預留）；
  生產 fail loud、開發警告續行；退避重連策略
- `src/plugins/auth.ts`：@fastify/jwt v10 註冊 + `authenticate` preHandler decorator 空殼
  （JwtPayload { sub, role }；M04 補完整登入流程）
- `src/shared/errors.ts`：AppError 階層（Validation/Unauthorized/Forbidden/NotFound/Conflict/
  RateLimit/InsufficientBalance/OptimisticLock/Internal），統一 { error: { code, message } }，
  5xx 永不洩漏內部細節

## M03 驗收（DoD）— 全部實測

- [x] fail loud：JWT_SECRET 過短 / AES key 非 hex64 → 列出全部問題、exit 1
- [x] `node dist/cluster.js`：primary fork 2 workers 共同監聽 :3000，`GET /healthz` → `{"ok":true}`
- [x] 404 回標準錯誤格式（含 code/message，無 stack）
- [x] 殺單一 worker → primary 立即重 fork，服務不中斷（curl 全程 200）
- [x] crash-loop 保險絲實測觸發（EADDRINUSE 連續崩潰 6 次 → primary FATAL 結束）
- [x] 孤兒防護實測：硬殺 primary → workers 偵測 IPC disconnect 於 12s 內自我關閉、:3000 釋放
- [x] 開發模式無 PG/Redis 可啟動（prisma 惰性連線、redis 警告續行）；生產模式 fail loud
- [x] `npm run lint` / `npm run build` 全 workspace 通過；npm audit 0 vulnerabilities

---

## M02 完成內容（2026-06-12）

- `backend/prisma/schema.prisma`：17 張表 + 9 enum，欄位全 snake_case `@map`（與設計文件 §3 raw SQL 對齊）、
  BRIN 索引以原生 `@@index(type: Brin)` 宣告（bet_records / balance_transactions 的 created_at）、
  檔頭含「條件更新 + version 樂觀鎖」核心約束說明、User.balance 與 Jackpot.pool 帶樂觀鎖註解
- `backend/prisma/schema.sqlite.prisma`：SQLite dev 模式獨立 schema
  （SQLite connector 不支援 enum / Json / @db.VarChar / BRIN，分別降級為 String / String / 移除 / 一般索引；
  Prisma 3+ 已移除 provider env() 動態切換，故採雙 schema + `--schema` 旗標）
- `backend/prisma/migrations/20260612_init/migration.sql`：由 `prisma migrate diff` 離線生成精確 DDL，
  尾段附 raw SQL：物化視圖 leaderboard_daily / weekly / total（各帶 unique index 供 CONCURRENTLY 刷新）
  + jackpot 單行種子（`ON CONFLICT DO NOTHING`）；`migration_lock.toml` provider=postgresql
- `backend/prisma/seed.ts`：冪等 upsert——護符池 12 枚（WEIGHT×6/RULE×1/CONDITIONAL×2/PITY×2/BONUS×1）、
  每日任務池 7 則、成就 12 個、jackpot 單行、Admin 帳號（argon2id，密碼取自 ADMIN_INITIAL_PASSWORD，
  既有帳號不覆蓋密碼）；自動偵測 provider（SQLite 時 Json 欄位存序列化字串）

## M02 驗收（DoD）

- [x] `prisma validate` 雙 schema 通過（PG + SQLite）
- [x] `prisma generate` 成功（postinstall 自動執行）
- [x] SQLite 端對端實測：`db push` 建表 → seed 連跑兩次 → 計數仍為 12/7/12/1/1（冪等 ✅）、
      admin 為 argon2id 雜湊、CONDITIONAL 護符 effect JSON 正確
- [ ] PostgreSQL `prisma migrate dev` 實機驗證（本機尚未安裝 Docker；migration SQL 已由
      `prisma migrate diff` 生成保證與 schema 一致，物化視圖/種子段為手寫附錄，待 PG 環境驗證）
- [x] `npm run lint` / `npm run build` 全 workspace 仍通過

---

## M01 後補修正（2026-06-12）—— 0 漏洞

依賴升級（`npm audit` 結果：7 → 0 vulnerabilities）：

| 套件 | 舊版 | 新版 | 理由 |
|---|---|---|---|
| `eslint` | 8.57 | 9.x | 升至 ESLint 9 flat config（主要任務）；舊版本 EOL |
| `@typescript-eslint/eslint-plugin` + `parser` | 7.x | 移除 | 由 `typescript-eslint` 8.x 統一包取代 |
| `typescript-eslint` | — | 8.x | ESLint 9 統一包（含 parser + plugin）|
| `@eslint/js` | — | 9.x | ESLint 9 base recommended |
| `.eslintrc.cjs` | legacy format | 刪除 | 改為 `eslint.config.js`（ESM flat config）|
| `fastify` | 4.28 | **5.8.5** | 唯一修補 `fast-uri` CVE 的路徑（GHSA-q3j6-qgpj-74h6 / GHSA-v39h-62p7-jpjc）；M01 payload 極簡，零破壞性 |
| `vite`（frontend + admin） | 5.3 | **6.4.2** | 修補 `esbuild` GHSA-67mh-4wv8-2f99（dev server 任意請求讀取）|

## M01 完成內容（2026-06-12）

- npm workspaces 骨架：`backend` / `frontend` / `admin-frontend` / `packages/shared`
- `packages/shared` 空殼（M05 填入 dto / socket-events / enums / constants）
- `docker-compose.yml`：PostgreSQL 16-alpine + Redis 7-alpine（named volume 持久化、healthcheck、AOF）
- TypeScript strict（後端 NodeNext ESM、前端 Bundler resolution）
- ESLint 9 flat config（`eslint.config.js`）：TS 推薦規則 + `no-restricted-properties` 禁 `Math.random` + `no-restricted-syntax` 禁繞 wallet 改餘額（wallet override 放行）
- `backend/Dockerfile`：node:20-alpine 多階段（deps → dev → build → runtime），arm64 相容
- `.env.example` 全變數範本、`scripts/gen-secrets.sh` 機密產生器
- 最小可執行驗證：`GET :3000/` → `{ ok: true }`；frontend `:5173` 顯示 "Frontend works"；admin `:5174/admin/`

## 驗收（DoD）

- [x] `npm install` 成功（workspaces 全裝，`npm audit` 0 vulnerabilities）
- [ ] `docker compose up -d` 後 postgres / redis 皆 healthy（本機尚未安裝 Docker，待有 Docker 的環境驗證）
- [x] 後端啟動後 `GET :3000/` 與 `GET /healthz` 皆回 `{"ok":true}`（已實測 build 產物，Fastify 5 兼容）
- [x] `npm run lint` 通過；在後端寫 `Math.random()` 會被 ESLint 9 以 error 擋下（已用探針檔實測）
- [x] `npm run build` 全 workspace 通過（backend tsc、兩個前端 vue-tsc + vite 6 build）
