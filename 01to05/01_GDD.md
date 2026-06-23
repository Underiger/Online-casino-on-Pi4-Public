# Game Design Document（GDD）
**專案代號：Virtual Casino Sandbox（VCS）**
**版本：v1.1（Phase 1 設計凍結稿 + Phase 2 第一類「莊家 vs 閒家」三款已實作，見 §8）｜目標平台：Web（桌面 + 行動瀏覽器）｜伺服器：Raspberry Pi 4 4GB**

> Phase 1（老虎機 + 輪盤 + 社交/每日/管理後台，M01–M28）已於 2026-06-14 發布 v1.0.0。
> Phase 2 規劃四大類新遊戲擴充：①莊家 vs 閒家（射龍門/High-Low/Blackjack，M29 已完成，見 §8）
> ②多人桌局 PvP ③麻將 ④Solitaire——②③④尚未排入 Milestone。

---

## 1. 專案概述

### 1.1 一句話定位
一個可自架於 Raspberry Pi 4 的多人線上虛擬娛樂平台：以 **Roguelite Build 構築老虎機** 為核心賣點，搭配 **公共歐式輪盤房**、**莊家 vs 閒家系列（射龍門 / High-Low / Blackjack）**、聊天室、排行榜與每日系統，全程僅使用無現實價值的虛擬遊戲幣。

### 1.2 設計支柱（Design Pillars）
| 支柱 | 說明 |
|---|---|
| **Build 驅動** | 老虎機不是純運氣，玩家透過護符（Charm）搭配改變機率結構，形成可研究、可分享的 Build |
| **全服共感** | Jackpot 累積、公共輪盤房、聊天室開獎公告，讓單人遊戲行為產生全服事件感 |
| **Server Authoritative** | 客戶端零信任：所有 RNG、結算、餘額異動只在伺服器發生 |
| **輕量可自架** | 200 同時在線為設計上限，所有系統以 Pi 4 4GB 的 CPU/RAM/IO 預算反推設計 |

### 1.3 虛擬幣聲明（寫入遊戲內條款）
- 遊戲幣（Coin）**不可儲值、不可提領、不可兌換任何現實價值**。
- 取得管道僅限：每日登入、每日任務、遊戲贏分、管理員 Gift Code。
- 餘額歸零時由每日系統補發保底，確保遊戲可持續進行。

### 1.4 核心循環（Core Loop）
```
登入 → 領每日獎勵/查看今日幸運符號 → 選擇護符 Build → 旋轉老虎機/下注輪盤
  → 贏分/Jackpot 事件 → 聊天室炫耀/排行榜爬升 → 完成每日任務 → 解鎖新護符 → 回到 Build
```

---

## 2. 經濟系統

### 2.1 貨幣
| 貨幣 | 單位 | 用途 | 備註 |
|---|---|---|---|
| Coin | 整數（最小單位 1） | 下注、所有消費 | DB 以 `BIGINT` 儲存，**全系統禁止浮點數** |
| Jackpot 點數 | 整數 | Diamond 中獎累積，達標進入 Jackpot 模式 | 個人累積值 |

### 2.2 注入與回收（Faucet / Sink）
| 注入（Faucet） | 數值（初版） | 回收（Sink） |
|---|---|---|
| 每日登入獎勵 | 500 + 連續登入加成（最高 ×2） | 老虎機旋轉成本（10/50/100 三檔） |
| 每日任務（3 則） | 各 200～500 | 輪盤下注 |
| 新手禮包 | 5,000 | 護符購買/重抽（Phase 2 擴充） |
| 破產保底（餘額 < 10 且當日未領） | 300（每人每日限領一次，防止故意歸零反覆領取） | — |
| 老虎機 RTP | 目標 **92%**（不含 Jackpot） | 每注 1% 進入全服 Jackpot（屬玩家間轉移，非回收） |

> RTP 由賠率表 + 加權機率表離線計算驗證，調整任一權重後必須重跑 `scripts/simulate-rtp.ts`（蒙地卡羅 1,000 萬次）確認落在 90%～94% 區間。

---

## 3. 核心玩法一：Roguelite 老虎機

### 3.1 基本規則
- 3 輪轉軸，每軸 8～12 種符號（初版每軸 10 格邏輯帶）。
- 每次旋轉消耗所選注額（10 / 50 / 100）。
- **後端完成全部運算**（抽樣、賠付、保底、Jackpot 判定）後，前端僅依結果播放動畫。
- RNG 一律使用 `crypto.randomBytes()`（詳見 TDD §5.1）。

### 3.2 符號與賠率表（Paytable，倍率 × 注額）
| 符號 | 三連 | 二連（左起） | 特性 |
|---|---|---|---|
| Cherry 🍒 | ×4 | ×1 | 高頻低賠 |
| Lemon 🍋 | ×5 | — | |
| Bell 🔔 | ×8 | — | |
| Bar ▬ | ×12 | — | |
| Clover 🍀 | ×16 | — | 今日幸運符號常客 |
| Lucky7 7️⃣ | ×40 | — | 條件護符聯動 |
| Diamond 💎 | ×60 | — | 三連時 +Jackpot 點數 50 |
| Wild ⭐ | ×100 | — | 預設**不可**替代，需護符解鎖替代能力；無護符時 Wild 僅作為普通高賠符號，不具萬用功能 |

### 3.3 護符系統（Charm）— 核心設計

#### 3.3.1 護符分類
| 類型 | 生效方式 | 範例 |
|---|---|---|
| **權重型（WEIGHT）** | 修改某符號在某些轉軸的出現權重 | 「四葉草出現率 +30%」 |
| **規則型（RULE）** | 修改賠付判定規則 | 「Wild 可替代任何符號」 |
| **條件型（CONDITIONAL）** | 滿足盤面條件時切換到另一張預計算表 | 「前兩軸為 Lucky7 時，第三軸 Lucky7 權重 ×3」 |
| **保底型（PITY）** | 基於連續未中獎計數器 | 「連續 10 次未中獎，下次中獎倍率 +50%」 |
| **獎勵型（BONUS）** | 中獎後附加效果 | 「Diamond 中獎額外 +100 Jackpot 點數」 |

#### 3.3.2 預計算加權機率表（核心守則）
**原則：旋轉路徑（hot path）上零機率計算，只做一次「累積權重二分查找」。**

1. **基礎表**：每軸一張靜態權重表，例如第 1 軸：
   ```json
   { "CHERRY": 28, "LEMON": 20, "BELL": 14, "BAR": 11, "CLOVER": 10,
     "LUCKY7": 8, "DIAMOND": 6, "WILD": 3 }   // 總和 100
   ```
2. **編譯時機**：玩家**裝備/卸下護符時**（非旋轉時），伺服器將「基礎表 × 所有 WEIGHT 型護符修正 × 今日幸運符號修正」合成為最終表，並針對每一個 CONDITIONAL 護符**額外編譯其條件變體表**。
3. **編譯產物（CompiledLoadout）**：
   ```jsonc
   {
     "loadoutHash": "sha256(userId + charmIds排序 + luckySymbol + 表版本)",
     "reels": [
       { "cum": [28,48,62,73,83,91,97,100], "symbols": ["CHERRY",...] },  // 累積權重陣列
       { ... }, { ... }
     ],
     "variants": {            // 條件型護符的預編譯變體（同結構）
       "lucky7_boost_reel3": { "cum": [...], "symbols": [...] }
     },
     "rules": { "wildSubstitute": true, "pityThreshold": 10, "pityMultiplier": 1.5 },
     "version": 4
   }
   ```
4. **快取策略**：寫入 Redis `slot:loadout:{userId}`，TTL 24h；旋轉時直接讀取。Redis miss 時從 PostgreSQL 的 UserCharm 重新編譯（冪等）。今日幸運符號於每日 00:00 切換時，由 Bull 排程**批量失效**所有 loadout 快取（DEL by SCAN，離峰執行）。
5. **抽樣**：每軸取 `randomInt(0, totalWeight)`（CSPRNG），對 `cum` 陣列二分查找 → O(log n)，三軸合計 < 0.01ms。
6. **條件切換**：第三軸抽樣前檢查前兩軸結果，若命中條件護符，**直接改用對應 variant 表**抽樣——仍然是查表，不是即時改權重。
7. **保底計數器**：`slot:pity:{userId}` 存於 Redis（INCR / DEL），結算時讀取，屬 O(1) 狀態而非機率重算。

#### 3.3.3 護符取得與裝備
- 裝備槽位：3 格（Phase 2 可擴充至 5）。
- 取得：每日任務獎池、成就解鎖、Gift Code 附贈；稀有度 COMMON / RARE / EPIC / LEGENDARY。
- 同名護符重複取得 → 轉化為碎片（Phase 2）；初版直接忽略並補償 Coin。

### 3.4 全服 Jackpot（核心守則）

#### 3.4.1 累積流程（Redis 原子 + 批量寫庫）
```
玩家下注 100 Coin
  ├─ PostgreSQL 交易：條件更新扣款（balance >= 100）
  ├─ Redis：INCRBY jackpot:pool 1        ← 1%，原子操作，整數 Coin
  └─ Redis：INCR  jackpot:txcount
每 10 秒（Bull repeatable job）或 txcount ≥ 500：
  ├─ GETSET jackpot:delta 歸零取增量（原子）
  └─ PostgreSQL：UPDATE jackpot SET pool = pool + :delta, version = version + 1
     （單行表，id=1，永久保存）
```
- **真值來源**：PostgreSQL `Jackpot.pool` 為持久真值；Redis 僅是「尚未落庫的增量 + 展示用即時值」。重啟恢復流程：`pool(DB) + delta(Redis)`。
- 前端顯示值由 Socket.IO 每 5 秒廣播一次（讀 Redis），不開放查詢 API 輪詢。

#### 3.4.2 觸發與派彩（樂觀鎖）
1. 每次旋轉以 CSPRNG 判定是否進入 Jackpot 模式（基礎機率 1/50,000，Diamond 點數每 100 點 +10% 相對機率，觸發後點數歸零）。最終機率 = 基礎機率 × (1 + jackpotPoints / 1000)，上限 1/5,000；等效整數判定：`randomInt(Math.ceil(50000 / (1 + points / 1000))) === 0`。
2. 派彩在**單一 PostgreSQL 交易**內完成：
   ```sql
   SELECT pool, version FROM jackpot WHERE id = 1;
   UPDATE jackpot SET pool = pool * 0.20, version = version + 1
     WHERE id = 1 AND version = :version;   -- 受影響行數 = 0 → 重試（最多 3 次）
   UPDATE users SET balance = balance + :payout WHERE id = :userId;
   INSERT INTO jackpot_history (...);        -- 永久保存
   ```
   派彩前先觸發一次強制 flush（將 Redis delta 落庫），確保中獎金額完整。
3. 中獎者獲得 **80%**，**20%** 留底繼續累積（避免獎池歸零的冷感）。
4. 觸發即透過 Socket.IO `jackpot:won` 全服廣播 + 系統訊息進聊天室。

---

## 4. 核心玩法二：歐式輪盤（公共房）

### 4.1 規則
- 單零（0～36），標準歐式賠率。
- **公共房模式**：全服共用一張桌、同一輪結果；每位玩家下注互不影響、各自結算。
- 回合節奏（固定循環，伺服器排程驅動）：

| 階段 | 時長 | 行為 |
|---|---|---|
| BETTING | 15s | 接受下注（逾時請求一律拒絕，見 TDD §5.3） |
| LOCK | 2s | 鎖盤，伺服器以 CSPRNG 產生結果 |
| RESULT | 8s | 廣播結果 + 動畫 + 各玩家結算 |
| COOLDOWN | 5s | 顯示熱門下注統計，準備下一輪 |

### 4.2 下注類型與賠率
| 類型 | 賠率 | 初版 | 類型 | 賠率 | 初版 |
|---|---|---|---|---|---|
| 單號 Straight | 35:1 | ✅ | Column | 2:1 | ✅ |
| 紅/黑 | 1:1 | ✅ | Dozen | 2:1 | ✅ |
| 奇/偶 | 1:1 | ✅ | Split | 17:1 | Phase 2 |
| 大/小 (1-18/19-36) | 1:1 | ✅ | Street / Corner | 11:1 / 8:1 | Phase 2 |

- 單注上限 1,000、單回合單人總注上限 5,000（防止排行榜刷分波動過大）。
- 每局結束系統訊息進聊天室：開獎號碼、顏色、本輪總下注、最熱門注型。

---

## 5. 社交與每日系統

### 5.1 每日系統（每日 00:00 Asia/Taipei 重置，Bull 排程）
| 系統 | 內容 |
|---|---|
| 每日登入 | 500 Coin × 連續登入係數（1.0→2.0，7 天封頂；中斷重置） |
| 每日任務 | 從任務池抽 3 則：「旋轉 20 次」「輪盤下注 5 局」「中獎 1 次三連」等，獎勵 Coin 或護符抽取券 |
| 今日幸運符號 | 每日隨機指定一種符號，該符號賠率 ×1.5；切換時批量失效 loadout 快取（見 §3.3.2） |

### 5.2 排行榜
- 三榜：**今日淨贏分**、**本週淨贏分**、**總資產**，各取 Top 100。
- 實作：PostgreSQL **MATERIALIZED VIEW**，Bull 每 5 分鐘 `REFRESH MATERIALIZED VIEW CONCURRENTLY`；API 直接查視圖，零即時聚合。
- 每日結算時將前一日 Top 100 快照寫入 `LeaderboardSnapshot`（永久保存，供個人頁展示歷史名次）。

### 5.3 聊天室
- 全服單一頻道（初版），系統事件（Jackpot、輪盤開獎）以系統身分插入。
- 防護：長度 ≤ 200 字、**URL 一律過濾替換為 `[連結已移除]`**、單人 1 則/2 秒 + 10 則/分鐘（Redis 計數）、被封鎖者禁言。
- 歷史訊息僅保留最近 200 則於 Redis List，DB 保留 7 天後由排程清理。

### 5.4 個人資料與成就
- 個人頁：頭像（預設圖庫選擇）、總旋轉次數、最大單次贏分、Jackpot 紀錄、護符圖鑑收集度、歷史名次。
- 成就（初版 12 個）：「首次三連」「Lucky7 三連」「Jackpot 得主」「連續登入 7 天」等，達成即發 Coin + 聊天室廣播（可關閉）。

---

## 6. 管理後台（Admin Panel）功能概覽

獨立前端入口（`/admin`，與玩家端分離部署路徑），所有操作寫入 AdminAuditLog。

| 模組 | 功能 | 安全要求 |
|---|---|---|
| 玩家管理 | 查詢、封鎖/解封、禁言 | 操作留審計日誌 |
| 虛擬幣調整 | 手動加/扣 Coin | **強制 2FA（TOTP）逐次驗證** + 審計日誌 + 對應 BalanceTransaction |
| Gift Code | 建立兌換碼：≥16 字元 CSPRNG、單次使用、有效期限必填 | 兌換走資料庫交易防重複 |
| 紀錄查詢 | 登入紀錄、下注紀錄、交易紀錄（分頁 + 篩選） | 唯讀 |
| 監控 | 線上人數、活躍房間、Pi CPU/RAM/溫度/磁碟（systeminformation） | 唯讀，10s 輪詢 |
| 公告/活動 | 跑馬燈公告、活動開關 | 審計日誌 |

---

## 7. 名詞表（Glossary）
| 名詞 | 定義 |
|---|---|
| Loadout | 玩家當前裝備的護符組合 |
| CompiledLoadout | 由 Loadout 編譯出的最終加權表 + 規則物件（Redis 快取） |
| Pity | 保底計數器 |
| RTP | Return To Player，長期回報率 |
| Flush | 將 Redis 中 Jackpot 增量批量落庫的動作 |
| 孤兒回合 | 多步驟回合遊戲（High-Low/Blackjack）玩家中途斷線/棄置、逾時由排程強制結算的回合 |
| RoundLock | 序列化同一回合多步驟動作的 Redis 單實例鎖（`SET NX PX` + Lua release-if-owner） |
| GETDEL 原子認領 | 射龍門 `bet` 用「讀出同時刪除」單步操作取代鎖，省去序列化需求 |

---

## 8. 核心玩法三：莊家 vs 閒家系列（射龍門 / High-Low / Blackjack）

> M29（2026-06-20）新增。四大類 Phase 2 新遊戲規劃中的第一類；規則與賠率推導詳見
> `backend/src/config/constants.ts` 對應章節，後端實作見
> `backend/src/modules/{dragon-gate,high-low,blackjack}/`。三款共用 Slot 已驗證的
> 「HTTP 同步請求 + 單一 Prisma 交易 + wallet.debit/credit + HMAC + 限流 + 異常偵測」模式，
> **不新增資料表**——沿用 `BetRecord`，僅擴充 `GameType` enum（見 03_DATABASE_DESIGN §2）。

### 8.1 射龍門 Dragon Gate

**規則**：開兩張門牌（不含門牌本身）；閒家下注「第三張牌是否介於兩門之間」。
- **介於（WIN）**：贏得 `注額 × (1 + 倍率)`（含本金）。
- **踩柱（DOOR_HIT，第三張等於某張門牌點數）**：視為「賠雙倍」，再輸一個注額（餘額不足時降級為僅輸單注，不卡住結算）。
- **門外（LOSE）**：輸掉單注。
- 兩門相鄰或相同（gap ≤ 0，機率上無法介於）由伺服器自動重開門，不進入下注流程。

**流程**：`open`（開門牌、攤開賠率，**不動錢**，狀態存 Redis 短 TTL）→ 玩家確認後 `bet`（唯一一次動錢操作，`GETDEL` 原子讀出並清空 Redis 狀態，單一 PG 交易完成扣款/派彩）。

**賠率**：依 `DRAGON_GATE_ODDS_MODE` 開關支援兩種精細度（目標 RTP 92%，與老虎機一致）：
- `TIER_11`（預設）：gap 1～11 各自一個倍率，最貼近真實機率。
- `TIER_3`：gap 分窄(1-3)/中(4-7)/寬(8-11) 三檔，倍率取桶內**出現次數加權平均**（非單純平均——兩門 rank 差距對應牌組數為 `13-d` 組，小 gap 出現頻率遠高於大 gap；Monte Carlo 模擬曾抓到「未加權平均」版本實測 RTP 僅 ~87.7% 的校準錯誤，已修正）。

| gap | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TIER_11 倍率 | 12.0 | 5.5 | 3.33 | 2.25 | 1.6 | 1.17 | 0.86 | 0.63 | 0.44 | 0.3 | 0.18 |

| TIER_3 桶 | 範圍 | 倍率 |
|---|---|---|
| NARROW | 1–3 | 5.72 |
| MEDIUM | 4–7 | 1.45 |
| WIDE | 8–11 | 0.44 |

### 8.2 High-Low 猜高低

> 規則港自使用者自己的 `Underiger/pokergame`（`games/high_low.py`），純邏輯逐行對應。

**流程**：`deal`（扣注額、開基準牌）→ `guess`（猜高/低）→ 猜對彩池 ×2，可選 `cash-out`（收手，落袋為安）或 `continue`（繼續挑戰下一張，連勝上限 5 次自動收手）→ 猜錯（或同點 `PUSH` 換新基準牌不算輸不算贏）彩池歸零。
- 基準牌為 A（最大）不可猜「高」、為 2（最小）不可猜「低」——伺服器強制驗證（不只是前端 UI 擋）。
- 單一 52 張牌，剩餘 < 10 張時整副重新洗牌（防記牌必勝），而非補牌續用。

**多步驟回合併發控制**：`deal/guess/continue/cash-out` 四個動作共用同一把 `RoundLock`（見 §8.4），避免同一回合被併發請求讀-改-寫競態（補兩張牌、重複扣款）。

### 8.3 Blackjack 二十一點

> 規則港自使用者自己的 `Underiger/pokergame`（`games/blackjack.py` 上半部純函式），逐行對應。

**規則**：J/Q/K=10、A=11（爆牌時逐張降為 1）；莊家 **S17**（含軟 17 一律停牌，常數開關可切 H17）；天生 Blackjack 賠 **3:2**；一般勝 1:1；平手退注；**Double Down** 限前兩張、加倍後強制停牌；**不支援 Split**（與港源一致，留待未來版本）。

**與港源唯一差異**：原版是「剩 < 20 張才重洗」的物理牌堆跨局延續；本專案改成**每一局重新 CSPRNG 洗一副全新 4 副牌**（不延續上一局剩餘牌），徹底排除算牌可能性，更符合 Server Authoritative 原則。

**流程**：`deal`（扣注額、發 4 張；天生 BJ 直接結算，莊家不補牌）→ `hit`（補牌；爆牌或湊滿 21 自動停牌）/ `stand`（進莊家補牌迴圈，伺服器內一次跑完不暫停，因為補牌純粹是規則沒有玩家決策）/ `double`（限手牌數=2，再扣一次注額、補一張、強制停牌）。

### 8.4 共用設計：多步驟回合的併發與孤兒回合處理

- **RoundLock**（`backend/src/security/round-lock.ts`）：High-Low / Blackjack 的多步驟動作（deal/guess/continue/cash-out、deal/hit/stand/double）共用一把 Redis 單實例鎖——`SET key token NX PX ttlMs` 取鎖，Lua `RELEASE_IF_OWNER` 比對 token 才刪除，避免誤刪別人在鎖過期後重新取得的鎖。取不到鎖直接回 409（不排隊重試）。射龍門不使用本機制：它整回合只有一次動錢操作（`bet`），改用 `GETDEL` 把「讀出同時刪除」做成單一原子操作即可。
- **孤兒回合清理**（`backend/src/jobs/abandoned-round.job.ts`，每 2 分鐘掃描）：用 Redis key 剩餘 TTL 倒推「5 分鐘無任何動作」，不需要替 `BetRecord` 加 `updatedAt` 欄位。依目前卡住的階段強制結算：
  - High-Low 卡在「猜測中」→ **沒收目前彩池**（FORFEITED）；卡在「收手或繼續」的選擇 → 強制視為**收手**（AUTO_SETTLED）。
  - Blackjack 卡在「玩家回合」→ 強制視為**停牌**（Auto Stand），照正常莊家補牌流程結算。
  - **明確不使用退款（REFUND）**：單純退款會讓玩家在看到不利局面時故意斷線換回全額退款，等於無限次免費重試；逾時結算的結果永遠只能等於玩家當下零成本就能主動選擇的選項，絕不會比繼續玩更好，因此沒有套利空間。
  - 射龍門不需要本 job：`open` 不動錢、`bet` 是單步原子操作，沒有「卡在半路」的可能狀態。

---
*本文件與 TDD、資料庫設計書同步維護；任何賠率/權重變更需更新 §2.2 並重跑 RTP 模擬；新遊戲賠率變更需同步更新 §8 並重跑對應 Monte Carlo 模擬腳本。*
