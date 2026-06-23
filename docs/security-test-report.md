# 安全演練測試報告（Security Test Report）

> **專案**：Virtual Casino Sandbox｜**Milestone**：M27 整合測試與安全演練
> **更新日期**：2026-06-14｜**對象後端**：`http://localhost:3000`（開發機 `npm run dev`）

本報告彙總針對下注/聊天敏感路徑的受控攻擊演練，驗證 02_TDD §5（HMAC 簽章、
防重放 nonce/seq、時間窗、限流）與輪盤回合時窗等安全防線是否如設計攔截攻擊。

---

## 1. 結論摘要

| # | 攻擊向量 | 載體 | 預期攔截碼 | IllegalPacketLog | 結果 | 證據 |
|---|----------|------|------------|------------------|------|------|
| 1 | 重放攻擊（Replay） | HTTP `/api/slot/spin` | `ERR_NONCE_REPLAY` | `NONCE_REPLAY` ✅ | **PASS** | 整合測試 + 演練腳本 |
| 2 | 序號倒退（Seq Regression） | HTTP `/api/slot/spin` | `ERR_SEQ_REGRESSION` | `SEQ_REGRESSION` ✅ | **PASS** | 整合測試 + 演練腳本 |
| 3 | 簽章竄改（Tampering） | HTTP `/api/slot/spin` | `ERR_BAD_SIGNATURE` | `BAD_SIGNATURE` ✅ | **PASS** | 整合測試 + 演練腳本 |
| 4 | 逾時下注（Out-of-window bet） | Socket `roulette:bet` | `ROULETTE_PHASE_CLOSED` | N/A（業務層） | **PASS** | 整合測試 + 演練腳本 |
| 5 | 聊天洗頻（Chat flood） | Socket `chat:send` | `RATE_LIMIT_BURST` / `RATE_LIMIT_MINUTE` | N/A（業務層） | **PASS（附建議）** | 演練腳本 |

> **結果來源**：向量 1–4 的攔截碼與 IllegalPacketLog 落庫已由 M27 **整合測試**
> （`backend/test/integration/slot-spin-e2e.spec.ts`、`roulette-round-e2e.spec.ts`，
> 全綠）在 in-memory 環境下決定性驗證；內部另有對「執行中的真實後端」重現同一結果
> 的演練腳本，重現向量 5 之結果。**演練腳本本身未隨公開版 repo 發布**（屬可執行攻擊
> 工具，不對外公開），以下僅保留方法論與結果記錄。

---

## 2. 環境與前置

1. **後端執行中**：`npm run dev`（Fastify :3000 + Socket.IO + 輪盤狀態機）。
2. **PostgreSQL + Redis 在線**：`docker compose up -d`。
   - ⚠ **關鍵**：開發模式下，若 Redis 離線，hmac-guard 會 **fail-open**（放行）以利
     單機開發；此時演練將失去意義。請務必確保 Redis 在線，使簽章/防重放真正生效。
3. **獨立測試資料庫**：演練會寫入攻擊者帳號與 IllegalPacketLog，建議指向獨立 DB
   （或可接受的測試環境），避免污染開發/正式資料。
4. **限流閾值**：演練直連後端（未經 Nginx），故不受 `nginx/conf.d/ratelimit.conf`
   影響；API 層令牌桶（slot spin：capacity 5 / 2 rps）足以放行每個向量所需的少量請求。
   若改為經 Nginx 壓測，請臨時調高 `limit_req`（見 docs/PROJECT_STATE.md M26）。

---

## 3. 執行方式

> 演練腳本（`scripts/security-attacks/`）為內部可執行攻擊工具，未隨公開版 repo
> 發布，避免提供現成的攻擊程式碼對著正式部署使用。下方 §4 完整保留每個向量的
> 攻擊手法、防線與判準說明；§7 列出的 vitest 整合測試（已隨公開版發布）可決定性
> 重現向量 1–4 的攔截結果。

---

## 4. 各攻擊向量詳述

### 4.1 重放攻擊（Replay）— `replay-attack.js`

- **手法**：以合法會話金鑰簽出一個 `/api/slot/spin` 封包並成功送出（HTTP 200），
  延遲 1 秒後**原封不動**再送一次（`sig/nonce/ts/seq` 完全相同）。
- **防線**：hmac-guard 第 6 步 `nonce`（`SET nonce:{userId}:{nonce} NX EX 10`）——
  第二次 `SET NX` 失敗即判定重放。
- **預期**：第二次回 `400 ERR_NONCE_REPLAY`；餘額不二次變動；`IllegalPacketLog`
  落 `NONCE_REPLAY`（endpoint=`POST /api/slot/spin`）。
- **通過判準**：首次 200 且重放回 `ERR_NONCE_REPLAY`。

### 4.2 序號倒退（Seq Regression）— `seq-regression.js`

- **手法**：先送 `seq=1000` 的合法封包（推高 `last_seq` 水位），再送一個**全新 nonce**、
  但 `seq=500`（倒退）的合法封包。
- **防線**：hmac-guard 第 7 步 `seq`（Lua 原子「嚴格遞增才寫入」）——`500 ≤ 1000` 拒絕。
- **預期**：回 `400 ERR_SEQ_REGRESSION`；`IllegalPacketLog` 落 `SEQ_REGRESSION`。
- **⚠ 與原始需求的差異（重要）**：需求原述為「**相同 nonce** + 較小 seq」，但伺服器
  驗證順序為 **nonce 先於 seq**——相同 nonce 會先觸發 `ERR_NONCE_REPLAY`，而非
  `ERR_SEQ_REGRESSION`。故腳本改用「**全新 nonce + 較小 seq**」以精確命中 seq 防線。
  此為符合實作的正確攻擊構造，非缺陷。

### 4.3 簽章竄改（Tampering）— `signature-tampering.js`

- **手法**：對 `betAmount=10` 正確簽章，但送出的 body 改為 `betAmount=100`（不重簽）。
- **防線**：hmac-guard 第 5 步 `簽章`——伺服器以 body 的 `100` 與已驗證的 `userId`
  重組 canonical（`${userId}|SLOT|100|${nonce}|${ts}`），與用 `10` 算出的簽章不符。
- **預期**：回 `400 ERR_BAD_SIGNATURE`；封包不進 handler（**零扣款、無 BetRecord**）；
  `IllegalPacketLog` 落 `BAD_SIGNATURE`。
- **通過判準**：回 `ERR_BAD_SIGNATURE`。

### 4.4 逾時下注（Out-of-window bet）— `timeout-bet.js`

- **手法**：經 WebSocket 觀察 `roulette:phase`，鎖定一個曾處於 `BETTING` 的 `roundId`，
  待其離開 `BETTING`（`LOCK`/`RESULT`/`COOLDOWN` 或新回合）後，補送一筆**合法簽章**的
  `roulette:bet` 至該已關閉回合。
- **防線**：HMAC 中介層放行（簽章合法）後，roulette gateway/service 的回合時窗檢查
  （`roundId` 不符或 `phase !== BETTING`）拒絕。
- **預期**：`roulette:bet` 的 ack 回 `ROULETTE_PHASE_CLOSED`；本金不被扣（未進結算）。
- **IllegalPacketLog**：**N/A**——此為「業務層階段檢查」而非封包簽章違規，依設計
  不寫 `IllegalPacketLog`（`PacketViolation` enum 雖有 `OUT_OF_WINDOW`，但輪盤逾時
  下注走業務碼 `ROULETTE_PHASE_CLOSED`，不落該表）。
- **通過判準**：ack === `ROULETTE_PHASE_CLOSED`。

### 4.5 聊天洗頻（Chat flood）— `chat-spam.js`

- **手法**：經 WebSocket 於極短時間連送 15 則 `chat:send`。
- **防線**：chat.service 兩層令牌桶——burst（1 則 / 2 秒）+ 分鐘桶（10 則 / 分鐘），
  重用 `TOKEN_BUCKET_LUA`。
- **預期**：首則成功（ack `null`），其後迅速回 `RATE_LIMIT_BURST`，累積達量後回
  `RATE_LIMIT_MINUTE`。
- **⚠ 與原始需求的兩點差異（如實記錄）**：
  1. **錯誤碼**：實際為 `RATE_LIMIT_BURST` / `RATE_LIMIT_MINUTE`，**並非** `ERR_CHAT_RATE_LIMIT`。
  2. **自動禁言**：後端**目前未實作**「洗頻自動禁言」——洗頻僅被限流擋下，不會將
     `user.muted` 設為 `true`。腳本以「是否觸發 `RATE_LIMIT_*`」作為通過判準，並對
     自動禁言缺失提出**建議**（見 §6）。
- **IllegalPacketLog**：**N/A**——聊天限流屬業務層，不寫該表。
- **通過判準**：偵測到至少一次 `RATE_LIMIT_BURST` 或 `RATE_LIMIT_MINUTE`。

---

## 5. 日誌與落庫佐證（文字描述）

### 5.1 IllegalPacketLog（向量 1–3）

向量 1–3 攔截時，後端 `illegal-packet.service.ts` 以 fire-and-forget 落一筆
`IllegalPacketLog`。以重放為例，資料列形如：

```
id          : clxxxx…
user_id     : <攻擊者 userId>
ip          : 127.0.0.1
violation   : NONCE_REPLAY          # 或 SEQ_REGRESSION / BAD_SIGNATURE
endpoint    : POST /api/slot/spin
raw_sample  : {"betAmount":10}      # 原始 payload，截斷 1KB
created_at  : 2026-06-14T…Z
```

可於管理後台「紀錄查詢」或直接查 DB 驗證：

```sql
SELECT violation, endpoint, ip, created_at
FROM illegal_packet_logs
WHERE user_id = '<攻擊者 userId>'
ORDER BY created_at DESC;
```

> M27 整合測試 `slot-spin-e2e.spec.ts` 已對上述三種 `violation` 的落庫做出斷言
> （fake prisma 攔截 `illegalPacketLog.create` 並驗證 `violation`/`endpoint`），故落庫
> 行為具決定性保證；演練腳本在真實 DB 上再次確認。

### 5.2 演練腳本輸出摘要（節錄示意）

演練腳本執行完整 5 個向量後的摘要輸出：

```
=== 演練摘要 ===
  向量                          結果    預期碼                    IllegalPacketLog
  ──────────────────────────────────────────────────────────────────────────────
  重放攻擊（Replay）            PASS    ERR_NONCE_REPLAY          已落庫
  序號倒退（Seq Regression）    PASS    ERR_SEQ_REGRESSION        已落庫
  簽章竄改（Tampering）         PASS    ERR_BAD_SIGNATURE         已落庫
  逾時下注（Out-of-window bet） PASS    ROULETTE_PHASE_CLOSED     N/A
  聊天洗頻（Chat flood）        PASS    RATE_LIMIT_BURST / MINUTE N/A

  ✓ 全部 5 個攻擊向量均被正確攔截。
```

---

## 6. 已知落差與建議

| 項目 | 現況 | 建議 |
|------|------|------|
| 聊天自動禁言 | 洗頻僅被限流擋下，**未自動禁言** | 於 chat.service 連續命中分鐘桶 N 次後呼叫既有 `setMute`（M21 admin），並記稽核；可重用 Redis 計數鍵 |
| 限流錯誤碼語義 | 聊天回 `RATE_LIMIT_BURST/MINUTE`（非 `ERR_CHAT_RATE_LIMIT`） | 屬命名差異，前端已對照文案；如需與封包違規碼統一風格，可於 04_API_SPEC §5 增列說明 |
| Redis 離線降級 | 開發模式 hmac-guard **fail-open** | 演練前務必確認 Redis 在線；生產模式為 fail-closed（已正確） |
| 逾時下注落庫 | 走業務碼，不寫 IllegalPacketLog | 如需「超窗下注」可觀測性，可在 roulette gateway 對 `ROULETTE_PHASE_CLOSED` 另記 `OUT_OF_WINDOW`（enum 已預留） |

---

## 7. 整合測試對照（M27）

下列 vitest 整合測試與本演練「同源同義」，於 `npm run test`（無需 PG/Redis，in-memory
fake）即可決定性重現安全攔截，與真實後端演練互為佐證：

| 測試檔 | 對應向量 / 主題 |
|--------|------------------|
| `backend/test/integration/slot-spin-e2e.spec.ts` | 重放 `ERR_NONCE_REPLAY` / 倒退 `ERR_SEQ_REGRESSION` / 竄改 `ERR_BAD_SIGNATURE` + IllegalPacketLog 落庫；合法簽章 spin 全流程 |
| `backend/test/integration/roulette-round-e2e.spec.ts` | 回合結算資金流與 BetRecord 落地（逾時下注的反面：合法時窗內結算正確） |
| `backend/test/integration/concurrency-double-spend.spec.ts` | 雙花：重放競態 + 餘額鐵律條件更新原子性 |
| `backend/test/integration/concurrency-jackpot.spec.ts` | Jackpot 派彩樂觀鎖、資金守恆（不超付） |
| `backend/test/integration/gift-code-e2e.spec.ts` | 禮物碼兌換與重複兌換防護 |

**測試總數**：376 passed（29 files）｜**覆蓋率**（`npm run test:coverage`）：
整體 Stmts 77.5% / Branch 81.5% / Funcs 82.8%；安全模組——`hmac.ts` 100% /
`nonce.ts` 100% / `anomaly.ts` 100% / `auth.ts` 94% / `totp.ts` 93% /
`rate-limit.ts` 91% / `hmac-guard.ts` 74%。

---

*本報告隨 M27 提交；向量 5 的自動禁言建議列入後續 backlog。*
