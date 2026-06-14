# Game Design Document（GDD）
**專案代號：Virtual Casino Sandbox（VCS）**
**版本：v1.0（Phase 1 設計凍結稿）｜目標平台：Web（桌面 + 行動瀏覽器）｜伺服器：Raspberry Pi 4 4GB**

---

## 1. 專案概述

### 1.1 一句話定位
一個可自架於 Raspberry Pi 4 的多人線上虛擬娛樂平台：以 **Roguelite Build 構築老虎機** 為核心賣點，搭配 **公共歐式輪盤房**、聊天室、排行榜與每日系統，全程僅使用無現實價值的虛擬遊戲幣。

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

---
*本文件與 TDD、資料庫設計書同步維護；任何賠率/權重變更需更新 §2.2 並重跑 RTP 模擬。*
