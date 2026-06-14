# API 規格書（API Spec）
**專案：Virtual Casino Sandbox｜版本 v1.0｜Milestone M05 規格凍結**

> 本文件為規格文件（設計凍結稿），與 `packages/shared` 的型別定義互為單一真值來源。
> 任何欄位異動需同步更新本文件、shared DTO、以及相關後端路由。

---

## 目錄

1. [通用規範](#1-通用規範)
2. [REST API 路由總表](#2-rest-api-路由總表)
3. [各模組詳細說明](#3-各模組詳細說明)
   - [3.1 Auth](#31-auth)
   - [3.2 User](#32-user)
   - [3.3 Wallet](#33-wallet)
   - [3.4 Slot（老虎機）](#34-slot老虎機)
   - [3.5 Roulette（輪盤）](#35-roulette輪盤)
   - [3.6 Jackpot](#36-jackpot)
   - [3.7 Charm（護符）](#37-charm護符)
   - [3.8 Daily（每日系統）](#38-daily每日系統)
   - [3.9 Leaderboard（排行榜）](#39-leaderboard排行榜)
   - [3.10 Chat（聊天室）](#310-chat聊天室)
   - [3.11 Gift Code](#311-gift-code)
   - [3.12 Admin（管理後台）](#312-admin管理後台)
   - [3.13 Monitor（監控）](#313-monitor監控)
4. [Socket.IO 事件規格](#4-socketio-事件規格)
   - [4.1 連線與握手](#41-連線與握手)
   - [4.2 Client → Server 事件](#42-client--server-事件)
   - [4.3 Server → Client 事件](#43-server--client-事件)
5. [錯誤碼總表](#5-錯誤碼總表)

---

## 1. 通用規範

### 1.1 Base URL

| 環境 | Base URL |
|---|---|
| 開發（前端代理） | `http://localhost:5173/api` |
| 後端直連 | `http://localhost:3000/api` |
| 生產（Nginx） | `https://<domain>/api` |

### 1.2 Content-Type

所有請求與回應均使用 `application/json`。

### 1.3 認證

```
Authorization: Bearer <accessToken>
```

- `accessToken` 為 JWT（HS256），有效期 15 分鐘。
- 需要認證的路由若缺少或 token 無效，回 `401 UNAUTHORIZED`。
- Access Token 過期時，前端以 `POST /api/auth/refresh` 自動換發（單次重試）。

### 1.4 HMAC 請求簽章（下注敏感路由）

標記 **HMAC** 的路由（目前：`POST /api/slot/spin`；Socket 事件：`slot:spin`, `roulette:bet`）
需額外攜帶以下 HTTP Headers：

| Header | 型別 | 說明 |
|---|---|---|
| `x-sig` | string（hex） | HMAC-SHA256 簽章 |
| `x-nonce` | string（UUID v4） | 防重放隨機 nonce |
| `x-ts` | string（epoch ms） | 請求時間戳，伺服器容忍 ±5000ms |
| `x-seq` | string（integer） | 嚴格遞增序號 |

**canonical 字串格式**：
```
${userId}|${gameType}|${betAmount}|${nonce}|${timestamp}
```

HMAC 金鑰（`hmacKey`）在登入/refresh 回應中以 base64url 格式下發，前端存於 Pinia 記憶體，不得落 localStorage。

### 1.5 統一回應格式

**成功**（2xx）：
```json
{ "data": <payload> }
```

**錯誤**（4xx / 5xx）：
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "人類可讀訊息"
  }
}
```

> 5xx 回應永不洩漏 stack trace 或內部細節。

### 1.6 BigInt 序列化

後端所有 `BigInt` 欄位（餘額、獎池、獎勵金額等）在 JSON 中序列化為 **字串**（`string`）。
前端轉換：`BigInt(value)` 或直接顯示字串。

---

## 2. REST API 路由總表

| 模組 | 方法 | 路徑 | 認證 | HMAC | 說明 |
|---|---|---|---|---|---|
| Auth | POST | `/api/auth/register` | ✗ | ✗ | 註冊 |
| Auth | POST | `/api/auth/login` | ✗ | ✗ | 登入 |
| Auth | POST | `/api/auth/refresh` | ✗ | ✗ | 換發 Token |
| Auth | POST | `/api/auth/logout` | ✗ | ✗ | 登出 |
| Auth | GET | `/api/auth/me` | ✓ | ✗ | 當前使用者 |
| User | GET | `/api/user/profile` | ✓ | ✗ | 個人資料 |
| User | PATCH | `/api/user/avatar` | ✓ | ✗ | 更換頭像 |
| User | GET | `/api/user/achievements` | ✓ | ✗ | 成就列表 |
| User | GET | `/api/user/charms/gallery` | ✓ | ✗ | 護符圖鑑 |
| User | GET | `/api/user/leaderboard-history` | ✓ | ✗ | 個人歷史名次 |
| Wallet | GET | `/api/wallet/balance` | ✓ | ✗ | 查餘額 |
| Wallet | GET | `/api/wallet/transactions` | ✓ | ✗ | 交易紀錄 |
| Slot | POST | `/api/slot/spin` | ✓ | ✓ | 旋轉 |
| Slot | GET | `/api/slot/paytable` | ✓ | ✗ | 賠率表 |
| Slot | GET | `/api/slot/history` | ✓ | ✗ | 旋轉歷史 |
| Roulette | GET | `/api/roulette/state` | ✓ | ✗ | 當前回合狀態 |
| Roulette | GET | `/api/roulette/history` | ✓ | ✗ | 近期回合紀錄 |
| Jackpot | GET | `/api/jackpot/pool` | ✗ | ✗ | 獎池即時值 |
| Jackpot | GET | `/api/jackpot/history` | ✗ | ✗ | 歷史中獎紀錄 |
| Charm | GET | `/api/charm/inventory` | ✓ | ✗ | 持有護符清單 |
| Charm | POST | `/api/charm/equip` | ✓ | ✗ | 裝備護符 |
| Charm | POST | `/api/charm/unequip` | ✓ | ✗ | 卸下護符 |
| Charm | GET | `/api/charm/loadout` | ✓ | ✗ | 當前 Loadout |
| Daily | POST | `/api/daily/login` | ✓ | ✗ | 領取每日登入獎勵 |
| Daily | GET | `/api/daily/tasks` | ✓ | ✗ | 今日任務與幸運符號 |
| Daily | POST | `/api/daily/tasks/:taskId/claim` | ✓ | ✗ | 領取任務獎勵 |
| Leaderboard | GET | `/api/leaderboard/:kind` | ✗ | ✗ | 排行榜（daily/weekly/total） |
| Chat | GET | `/api/chat/history` | ✓ | ✗ | 近期聊天記錄 |
| Gift Code | POST | `/api/gift-code/redeem` | ✓ | ✗ | 兌換 Gift Code |
| Admin Auth | POST | `/api/admin/auth/login` | ✗ | ✗ | 後台第一步登入 |
| Admin Auth | POST | `/api/admin/auth/totp` | ✗ | ✗ | 後台 TOTP 驗證 |
| Admin Auth | POST | `/api/admin/auth/refresh` | ✗ | ✗ | 後台 Token 換發 |
| Admin Auth | POST | `/api/admin/auth/logout` | Admin | ✗ | 後台登出 |
| Admin TOTP | POST | `/api/admin/totp/setup` | Admin | ✗ | TOTP 綁定（取得 QR） |
| Admin TOTP | POST | `/api/admin/totp/confirm` | Admin | ✗ | TOTP 綁定確認 |
| Admin Players | GET | `/api/admin/players` | Admin | ✗ | 玩家列表 |
| Admin Players | GET | `/api/admin/players/:id` | Admin | ✗ | 玩家詳情 |
| Admin Players | POST | `/api/admin/players/:id/ban` | Admin | ✗ | 封鎖/解封（TOTP 必填） |
| Admin Players | POST | `/api/admin/players/:id/mute` | Admin | ✗ | 禁言/解禁 |
| Admin Players | POST | `/api/admin/players/:id/adjust-balance` | Admin | ✗ | 手動加扣幣（TOTP 必填） |
| Admin Gift Code | GET | `/api/admin/gift-codes` | Admin | ✗ | Gift Code 列表 |
| Admin Gift Code | POST | `/api/admin/gift-codes` | Admin | ✗ | 建立 Gift Code（TOTP 必填） |
| Admin Records | GET | `/api/admin/records/login` | Admin | ✗ | 登入紀錄 |
| Admin Records | GET | `/api/admin/records/bets` | Admin | ✗ | 下注紀錄 |
| Admin Records | GET | `/api/admin/records/transactions` | Admin | ✗ | 交易紀錄 |
| Admin Records | GET | `/api/admin/records/audit` | Admin | ✗ | 稽核日誌 |
| Admin Announcement | GET | `/api/admin/announcements` | Admin | ✗ | 公告列表 |
| Admin Announcement | POST | `/api/admin/announcements` | Admin | ✗ | 新增公告 |
| Admin Announcement | PATCH | `/api/admin/announcements/:id` | Admin | ✗ | 更新公告 |
| Admin Announcement | DELETE | `/api/admin/announcements/:id` | Admin | ✗ | 刪除公告 |
| Monitor | GET | `/api/monitor/stats` | Admin | ✗ | 系統資源 + 線上統計 |

> **認證**欄：`✓` = 玩家 JWT、`Admin` = Admin JWT + role 驗證、`✗` = 公開。

---

## 3. 各模組詳細說明

### 3.1 Auth

#### POST `/api/auth/register`

| 項目 | 說明 |
|---|---|
| 認證 | 無 |
| 成功狀態碼 | 201 |

**Request Body**
| 欄位 | 型別 | 規則 |
|---|---|---|
| `username` | string | 3–20 字元，英數底線（`^[A-Za-z0-9_]{3,20}$`） |
| `password` | string | 8–72 字元 |

**Response** `201`
| 欄位 | 型別 | 說明 |
|---|---|---|
| `user.id` | string | cuid() |
| `user.username` | string | |
| `user.role` | `'PLAYER'` | |
| `user.balance` | string | 初始 5000 Coin |
| `user.avatarId` | number | 初始 0 |
| `accessToken` | string | JWT（HS256，15m） |
| `refreshToken` | string | 128 hex 字元 |
| `tokenType` | `'Bearer'` | |
| `expiresIn` | number | 900（秒） |
| `hmacKey` | string | base64url，前端存記憶體 |

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 格式不符 |
| 409 | `USERNAME_TAKEN` | 使用者名稱已存在 |

---

#### POST `/api/auth/login`

**Request Body**
| 欄位 | 型別 | 說明 |
|---|---|---|
| `username` | string | 1–20 字元 |
| `password` | string | 1–72 字元 |

**Response** `200`：同 Register（`user` + tokens + `hmacKey`）

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 格式不符 |
| 401 | `INVALID_CREDENTIALS` | 帳號不存在或密碼錯誤（回同一訊息，不洩漏存在性） |
| 403 | `ACCOUNT_BANNED` | 帳號已封鎖 |

---

#### POST `/api/auth/refresh`

**Request Body**
| 欄位 | 型別 | 說明 |
|---|---|---|
| `refreshToken` | string | 128 hex 字元 |

**Response** `200`
| 欄位 | 型別 | 說明 |
|---|---|---|
| `accessToken` | string | 新 JWT |
| `refreshToken` | string | 新 refresh token（舊 token 立即失效） |
| `tokenType` | `'Bearer'` | |
| `expiresIn` | number | 900 |
| `hmacKey` | string | 新 HMAC 金鑰（前端收到後立即更新記憶體） |

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 401 | `TOKEN_EXPIRED` | refresh token 已過期 |
| 403 | `TOKEN_REUSE` | 重用偵測：已撤銷全家族，需重新登入 |

---

#### POST `/api/auth/logout`

**Request Body**：同 Refresh（`refreshToken`）

**Response** `204`（無 body）；冪等，即使 token 已撤銷也回 204。

---

#### GET `/api/auth/me`

**Response** `200`（型別：`MeRes`）
| 欄位 | 型別 |
|---|---|
| `id` | string |
| `username` | string |
| `role` | `Role` |
| `balance` | string |
| `avatarId` | number |
| `jackpotPoints` | number |
| `pityCounter` | number |
| `loginStreak` | number |
| `muted` | boolean |
| `flagged` | boolean |
| `totpEnabled` | boolean |
| `createdAt` | string |

---

### 3.2 User

#### GET `/api/user/profile`

**Response** `200`（型別：`UserProfileRes`）
| 欄位 | 型別 |
|---|---|
| `id` | string |
| `username` | string |
| `balance` | string |
| `avatarId` | number |
| `jackpotPoints` | number |
| `loginStreak` | number |
| `createdAt` | string |
| `stats.totalSpins` | number |
| `stats.totalRouletteRounds` | number |
| `stats.maxSingleWin` | string |
| `stats.jackpotWins` | number |

---

#### PATCH `/api/user/avatar`

**Request Body**
| 欄位 | 型別 | 規則 |
|---|---|---|
| `avatarId` | number | 0–19（整數） |

**Response** `200` `{ avatarId: number }`

---

#### GET `/api/user/achievements`

**Response** `200` `{ items: AchievementItem[] }`
| AchievementItem 欄位 | 型別 |
|---|---|
| `achievementId` | string |
| `code` | string |
| `name` | string |
| `description` | string |
| `rewardCoin` | string |
| `unlockedAt` | string |

---

#### GET `/api/user/charms/gallery`

**Response** `200`（型別：`UserCharmGalleryRes`）
| 欄位 | 型別 |
|---|---|
| `items[].charmId` | string |
| `items[].code` | string |
| `items[].name` | string |
| `items[].description` | string |
| `items[].type` | `CharmType` |
| `items[].rarity` | `CharmRarity` |
| `items[].obtained` | boolean |
| `items[].obtainedAt` | string \| null |
| `owned` | number |
| `total` | number |

---

#### GET `/api/user/leaderboard-history`

**Response** `200` `{ items: LeaderboardSnapshotItem[] }`

---

### 3.3 Wallet

#### GET `/api/wallet/balance`

**Response** `200`（型別：`BalanceRes`）
| 欄位 | 型別 |
|---|---|
| `balance` | string |
| `version` | number |

---

#### GET `/api/wallet/transactions`

**Query Params**
| 欄位 | 型別 | 預設 |
|---|---|---|
| `page` | number | 1 |
| `limit` | number（max 100） | 20 |
| `type` | `TxType`（可選） | — |

**Response** `200`（型別：`TxListRes`）
| 欄位 | 型別 |
|---|---|
| `items[].id` | string |
| `items[].type` | `TxType` |
| `items[].delta` | string（正負皆可） |
| `items[].balanceBefore` | string |
| `items[].balanceAfter` | string |
| `items[].refId` | string \| null |
| `items[].memo` | string \| null |
| `items[].createdAt` | string |
| `total` | number |
| `page` | number |
| `limit` | number |

---

### 3.4 Slot（老虎機）

#### POST `/api/slot/spin`

| 項目 | 說明 |
|---|---|
| 認證 | JWT（玩家） |
| HMAC | **必須**（headers：x-sig / x-nonce / x-ts / x-seq） |

**Request Body**（型別：`SpinReq`）
| 欄位 | 型別 | 說明 |
|---|---|---|
| `betAmount` | 10 \| 50 \| 100 | 注額三檔 |

**HMAC canonical string**：`${userId}|SLOT|${betAmount}|${nonce}|${timestamp}`

**Response** `200`（型別：`SpinRes`）
| 欄位 | 型別 | 說明 |
|---|---|---|
| `betRecordId` | string | BetRecord.id |
| `betAmount` | number | |
| `reels` | `[SlotSymbol, SlotSymbol, SlotSymbol]` | 三軸結果 |
| `payout` | number | 0 表示未中 |
| `newBalance` | string | |
| `pityActive` | boolean | 本次旋轉保底加成是否生效 |
| `pityCounter` | number | 旋轉後計數 |
| `jackpotTriggered` | boolean | |
| `jackpotPayout` | string \| null | M14 擴充：觸發且派彩成功時的金額；其餘 null |
| `jackpotPoints` | number | 旋轉後累積點數（派彩成功時為 0） |
| `luckySymbol` | `SlotSymbol` \| null | 今日幸運符號 |
| `serverSeedHash` | string | SHA-256（provably-fair 預留） |

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 注額不合法 |
| 401 | `UNAUTHORIZED` | JWT 無效 |
| 422 | `INSUFFICIENT_BALANCE` | 餘額不足 |
| 429 | `RATE_LIMIT_EXCEEDED` | 旋轉頻率過高 |
| 400 | `ERR_BAD_SIGNATURE` | HMAC 簽章錯誤 |
| 400 | `ERR_NONCE_REPLAY` | nonce 重放 |
| 400 | `ERR_SEQ_REGRESSION` | seq 倒退 |
| 400 | `ERR_STALE_REQUEST` | 時間戳超出容忍 |

---

#### GET `/api/slot/paytable`

**Response** `200`（型別：`SlotPaytableRes`）
| 欄位 | 型別 |
|---|---|
| `entries[].symbol` | `SlotSymbol` |
| `entries[].tripleMultiplier` | number |
| `entries[].doubleMultiplier` | number \| null |
| `entries[].isWild` | boolean |
| `luckySymbol` | `SlotSymbol` \| null |
| `luckyMultiplierBonus` | number |

---

#### GET `/api/slot/history`

**Query**：`page`, `limit`（同 wallet/transactions）

**Response** `200`（型別：`SlotHistoryRes`）

---

### 3.5 Roulette（輪盤）

> 輪盤**下注與取消**主要透過 Socket.IO 事件（見 §4），REST API 提供狀態查詢。

#### GET `/api/roulette/state`

**Response** `200`（型別：`RouletteRoundStateRes`）
| 欄位 | 型別 |
|---|---|
| `roundId` | string |
| `phase` | `RoulettePhase` |
| `phaseEndsAt` | string（ISO 8601） |
| `participantCount` | number |
| `totalPool` | number |

---

#### GET `/api/roulette/history`

**Query**：`page`, `limit`

**Response** `200`（型別：`RouletteHistoryRes`）

---

### 3.6 Jackpot

#### GET `/api/jackpot/pool`

> 公開路由（無需認證）。前端 JackpotTicker 連線後改由 Socket `jackpot:tick` 每 5 秒接收，不需持續輪詢此端點。

**Response** `200`（型別：`JackpotPoolRes`）
| 欄位 | 型別 |
|---|---|
| `pool` | string |
| `updatedAt` | string |

---

#### GET `/api/jackpot/history`

**Query**：`page`, `limit`

**Response** `200`（型別：`JackpotHistoryRes`）

---

### 3.7 Charm（護符）

#### GET `/api/charm/inventory`

**Response** `200`（型別：`CharmInventoryRes`）
| 欄位 | 型別 |
|---|---|
| `items[].id` | string（UserCharm.id） |
| `items[].charmId` | string |
| `items[].equipped` | boolean |
| `items[].slot` | number \| null |
| `items[].obtainedAt` | string |
| `items[].charm.id` | string |
| `items[].charm.code` | string |
| `items[].charm.name` | string |
| `items[].charm.description` | string |
| `items[].charm.type` | `CharmType` |
| `items[].charm.rarity` | `CharmRarity` |
| `items[].charm.effect` | object |
| `items[].charm.enabled` | boolean |

---

#### POST `/api/charm/equip`

**Request Body**（型別：`EquipCharmReq`）
| 欄位 | 型別 | 說明 |
|---|---|---|
| `userCharmId` | string | UserCharm.id |
| `slot` | number | 1–3 |

**Response** `200`（型別：`LoadoutRes`）：裝備後的最新 Loadout 狀態

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 404 | `NOT_FOUND` | 護符不存在或不屬於該玩家 |
| 409 | `SLOT_OCCUPIED` | 槽位已有其他護符（需先卸下） |

---

#### POST `/api/charm/unequip`

**Request Body**（型別：`UnequipCharmReq`）
| 欄位 | 型別 |
|---|---|
| `slot` | number（1–3） |

**Response** `200`（型別：`LoadoutRes`）

---

#### GET `/api/charm/loadout`

**Response** `200`（型別：`LoadoutRes`）
| 欄位 | 型別 |
|---|---|
| `equippedCharms[].slot` | number |
| `equippedCharms[].userCharmId` | string |
| `equippedCharms[].charmId` | string |
| `equippedCharms[].name` | string |
| `equippedCharms[].type` | `CharmType` |
| `equippedCharms[].rarity` | `CharmRarity` |
| `loadoutHash` | string |

---

### 3.8 Daily（每日系統）

#### POST `/api/daily/login`

> 冪等：若今日已領取，回 200 並附已領狀態，不重複發放。

**Response** `200`（型別：`DailyLoginRes`）
| 欄位 | 型別 |
|---|---|
| `reward` | string（Coin） |
| `streak` | number |
| `multiplier` | number（1.0–2.0） |
| `newBalance` | string |

---

#### GET `/api/daily/tasks`

**Response** `200`（型別：`DailyTasksRes`）
| 欄位 | 型別 |
|---|---|
| `tasks[].id` | string |
| `tasks[].taskId` | string |
| `tasks[].code` | string |
| `tasks[].name` | string |
| `tasks[].type` | `TaskType` |
| `tasks[].target` | number |
| `tasks[].progress` | number |
| `tasks[].claimed` | boolean |
| `tasks[].claimedAt` | string \| null |
| `tasks[].rewardCoin` | string |
| `tasks[].rewardCharm` | boolean |
| `luckySymbol` | `SlotSymbol` \| null |
| `dateKey` | string（YYYY-MM-DD） |

---

#### POST `/api/daily/tasks/:taskId/claim`

> `:taskId` 為 DailyTask.id（模板 ID）。

**Response** `200`（型別：`ClaimTaskRes`）
| 欄位 | 型別 |
|---|---|
| `taskId` | string |
| `coin` | string |
| `charmId` | string \| null |
| `newBalance` | string |

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 400 | `TASK_NOT_COMPLETED` | 任務進度未達標 |
| 409 | `TASK_ALREADY_CLAIMED` | 已領取過 |

---

### 3.9 Leaderboard（排行榜）

#### GET `/api/leaderboard/:kind`

`:kind` = `daily` | `weekly` | `total`

**Response** `200`（型別：`LeaderboardRes`）
| 欄位 | 型別 |
|---|---|
| `kind` | `LeaderboardKind` |
| `periodKey` | string \| null |
| `entries[].rank` | number |
| `entries[].userId` | string |
| `entries[].username` | string |
| `entries[].avatarId` | number |
| `entries[].score` | string（Coin） |
| `refreshedAt` | string |

---

### 3.10 Chat（聊天室）

> 聊天主要透過 Socket.IO；REST 僅提供歷史查詢。

#### GET `/api/chat/history`

**Response** `200`（型別：`ChatHistoryRes`）
| 欄位 | 型別 |
|---|---|
| `messages[].id` | string |
| `messages[].userId` | string \| null |
| `messages[].username` | string \| null |
| `messages[].avatarId` | number \| null |
| `messages[].content` | string（已過濾） |
| `messages[].system` | boolean |
| `messages[].createdAt` | string |

---

### 3.11 Gift Code

#### POST `/api/gift-code/redeem`

**Request Body**（型別：`RedeemGiftCodeReq`）
| 欄位 | 型別 |
|---|---|
| `code` | string |

**Response** `200`（型別：`RedeemGiftCodeRes`）
| 欄位 | 型別 |
|---|---|
| `coin` | string |
| `charmId` | string \| null |
| `newBalance` | string |

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 404 | `GIFT_CODE_NOT_FOUND` | 序號不存在 |
| 410 | `GIFT_CODE_EXPIRED` | 已過期 |
| 409 | `GIFT_CODE_ALREADY_USED` | 此帳號已兌換或已達上限 |

---

### 3.12 Admin（管理後台）

所有 `/api/admin/*` 路由需 Admin JWT（`role === 'ADMIN'`）。  
高危操作（手動加扣幣、封鎖、建 Gift Code）需在 request body 附 `totpCode`（6 位數字），  
並由 `totp-guard` preHandler 逐次驗證（驗過的 code 記 Redis 10 分鐘防重用）。

#### POST `/api/admin/auth/login`（第一步）

**Request Body**（型別：`AdminLoginReq`）：`{ username, password }`

**Response** `200`（型別：`AdminLoginStepOneRes`）
| 欄位 | 型別 |
|---|---|
| `tempToken` | string（短效，僅用於第二步） |
| `totpRequired` | boolean（首次未綁定 TOTP 時 false，導引至綁定流程） |

---

#### POST `/api/admin/auth/totp`（第二步）

**Request Body**（型別：`AdminTotpVerifyReq`）：`{ tempToken, totpCode }`

**Response** `200`（型別：`AdminLoginRes`）：`{ accessToken, refreshToken, tokenType, expiresIn }`

**錯誤碼**
| HTTP | code | 說明 |
|---|---|---|
| 401 | `TOTP_INVALID` | TOTP 驗證失敗 |

---

#### POST `/api/admin/totp/setup`

**Response** `200`（型別：`AdminTotpSetupRes`）：`{ qrUri, secret }`

---

#### POST `/api/admin/totp/confirm`

**Request Body**：`{ totpCode: string }`

**Response** `200`（型別：`AdminTotpConfirmRes`）：`{ enabled, recoveryCodes }` — 恢復碼僅顯示一次

---

#### GET `/api/admin/players`

**Query**：`q`, `banned`, `flagged`, `page`, `limit`

**Response** `200`（型別：`AdminPlayerListRes`）

---

#### GET `/api/admin/players/:id`

**Response** `200`（型別：`AdminPlayerItem`）

---

#### POST `/api/admin/players/:id/ban`

**Request Body**（型別：`BanUserReq`）：`{ banned: boolean, totpCode: string }`

**Response** `200` `{ banned: boolean }`

---

#### POST `/api/admin/players/:id/mute`

**Request Body**（型別：`MuteUserReq`）：`{ muted: boolean }`

**Response** `200` `{ muted: boolean }`

---

#### POST `/api/admin/players/:id/adjust-balance`

**Request Body**（型別：`AdjustBalanceReq`）：`{ delta: number, memo?: string, totpCode: string }`

**Response** `200`（型別：`AdjustBalanceRes`）：`{ newBalance: string, delta: string }`

---

#### GET `/api/admin/gift-codes`

**Query**：`page`, `limit`

**Response** `200`（型別：`AdminGiftCodeListRes`）  
> `code` 欄位建立後僅顯示一次，後續查詢遮蔽為 `'****'`。

---

#### POST `/api/admin/gift-codes`

**Request Body**（型別：`AdminCreateGiftCodeReq`）
| 欄位 | 型別 |
|---|---|
| `amount` | number（Coin） |
| `charmId` | string（選填） |
| `maxUses` | number（預設 1） |
| `expiresAt` | string（ISO 8601） |
| `totpCode` | string（6 位數字） |

**Response** `201`（型別：`AdminGiftCodeItem`，含明文 code，僅此次顯示）

---

#### GET `/api/admin/records/login`、`/bets`、`/transactions`、`/audit`

**Query**（共用基底）：`userId`, `page`, `limit`, `from`, `to`  
- `/bets` 額外：`gameType`  
- `/transactions` 額外：`type`（TxType）  
- `/audit` 額外：`adminId`, `action`, `targetUserId`

---

#### GET / POST / PATCH / DELETE `/api/admin/announcements[/:id]`

公告 CRUD，標準 REST 操作，無 TOTP 要求。  
DELETE 回 `204`，其他回 `200`（型別：`AnnouncementItem`）或 `201`。

---

### 3.13 Monitor（監控）

#### GET `/api/monitor/stats`

**Response** `200`（型別：`SystemStatsRes`）
| 欄位 | 型別 |
|---|---|
| `cpu.manufacturer` | string |
| `cpu.brand` | string |
| `cpu.physicalCores` | number |
| `cpu.currentLoad` | number（%） |
| `cpu.temperature` | number \| null（°C） |
| `memory.total` | number（bytes） |
| `memory.used` | number |
| `memory.free` | number |
| `memory.usedPercent` | number（%） |
| `disk[].fs` | string |
| `disk[].size` | number（bytes） |
| `disk[].used` | number |
| `disk[].use` | number（%） |
| `onlineUsers` | number |
| `activeRooms` | number |
| `uptime` | number（秒） |
| `sampledAt` | string（ISO 8601） |

---

## 4. Socket.IO 事件規格

### 4.1 連線與握手

- **命名空間**：`/`（預設）
- **transports**：`['polling', 'websocket']`（polling 需 Nginx ip_hash）
- **maxHttpBufferSize**：4 KB
- **連線數上限**：200；超過時伺服器拒絕並發送 `server_full` 事件（握手階段）

**握手認證**（前端 `socket({ auth: { token } })`）：
```json
{ "token": "<JWT access token>" }
```
中介層驗證 JWT，成功後綁定 `socket.data.userId`。Token 過期 → 握手拒絕，前端應先 refresh 再重連。

---

### 4.2 Client → Server 事件

| 事件名 | 是否需 HMAC | Payload 型別 | Ack 型別 |
|---|---|---|---|
| `slot:spin` | ✓ | `SlotSpinPayload` | `(err: string\|null, result?: SlotResultPayload)` |
| `roulette:bet` | ✓ | `RouletteBetPayload` | `(err: string\|null, result?: RouletteBetAckPayload)` |
| `roulette:cancel` | ✗ | `RouletteCancelPayload` | `(err: string\|null)` |
| `chat:send` | ✗ | `ChatSendPayload` | `(err: string\|null)` |

#### `slot:spin` Payload
```ts
{
  betAmount: 10 | 50 | 100;
  // HMAC 欄位
  sig: string;    // HMAC-SHA256 hex
  nonce: string;  // UUID v4
  ts: number;     // epoch ms
  seq: number;    // 嚴格遞增
}
```

**HMAC canonical**：`${userId}|SLOT|${betAmount}|${nonce}|${ts}`

#### `roulette:bet` Payload
```ts
{
  roundId: string;
  bets: Array<{
    type: RouletteBetType;
    amount: number;
    number?: number;    // STRAIGHT 時必填（0–36）
    column?: 1|2|3;    // COLUMN 時必填
    dozen?: 1|2|3;     // DOZEN 時必填
  }>;
  sig: string;
  nonce: string;
  ts: number;
  seq: number;
}
```

**HMAC canonical**：`${userId}|ROULETTE|${totalAmount}|${nonce}|${ts}`  
（`totalAmount` = bets 陣列所有 amount 的整數加總）

#### `roulette:cancel` Payload
```ts
{ roundId: string }
```

#### `chat:send` Payload
```ts
{ content: string }  // 長度 1–200
```

---

### 4.3 Server → Client 事件

| 事件名 | 廣播對象 | Payload 型別 |
|---|---|---|
| `slot:result` | 個人 | `SlotResultPayload` |
| `roulette:bet_ack` | 個人 | `RouletteBetAckPayload` |
| `roulette:phase` | 全服 | `RoulettePhasePayload` |
| `roulette:result` | 全服（含個人損益） | `RouletteResultPayload` |
| `roulette:bets_snapshot` | 全服 | `RouletteBetsSnapshotPayload` |
| `jackpot:tick` | 全服 | `JackpotTickPayload` |
| `jackpot:won` | 全服 | `JackpotWonPayload` |
| `chat:message` | 全服 | `ChatMessagePayload` |
| `chat:history` | 個人（連線後推送） | `ChatHistoryPayload` |
| `achievement:unlocked` | 個人 | `AchievementUnlockedPayload` |
| `daily:task_updated` | 個人 | `DailyTaskUpdatedPayload` |
| `system:announcement` | 全服 | `SystemAnnouncementPayload` |
| `server_full` | — | 無（握手拒絕時） |

#### `slot:result`
```ts
{
  betRecordId: string;
  betAmount: number;
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
  payout: number;
  newBalance: string;
  pityActive: boolean;
  pityCounter: number;
  jackpotTriggered: boolean;
  jackpotPoints: number;
  luckySymbol: SlotSymbol | null;
  serverSeedHash: string;
}
```

#### `roulette:phase`
```ts
{
  roundId: string;
  phase: 'BETTING' | 'LOCK' | 'RESULT' | 'COOLDOWN';
  phaseEndsAt: string; // ISO 8601
  participantCount: number;
}
```

#### `roulette:result`
```ts
{
  roundId: string;
  winningNumber: number;          // 0–36
  color: 'RED' | 'BLACK' | 'GREEN';
  totalPool: number;
  participantCount: number;
  hotBets: Array<{ type: RouletteBetType; totalAmount: number; count: number }>;
  personalPayout: number | null;  // null = 本回合未下注
  newBalance: string | null;
}
```

#### `jackpot:tick`（每 5 秒廣播）
```ts
{ pool: string }
```

#### `jackpot:won`
```ts
{
  userId: string;
  username: string;
  avatarId: number;
  payout: string;
  poolBefore: string;
}
```

#### `chat:message`
```ts
{
  id: string;
  userId: string | null;
  username: string | null;
  avatarId: number | null;
  content: string;
  system: boolean;
  createdAt: string;
}
```

#### `achievement:unlocked`
```ts
{
  achievementId: string;
  code: string;
  name: string;
  description: string;
  rewardCoin: string;
  newBalance: string;
}
```

#### `daily:task_updated`
```ts
{
  taskId: string;
  progress: number;
  target: number;
  claimed: boolean;
}
```

---

## 5. 錯誤碼總表

| HTTP | code | 觸發場景 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 請求欄位格式不符 |
| 400 | `ERR_BAD_SIGNATURE` | HMAC 簽章驗證失敗 |
| 400 | `ERR_NONCE_REPLAY` | nonce 已使用（重放攻擊） |
| 400 | `ERR_SEQ_REGRESSION` | seq 不嚴格遞增 |
| 400 | `ERR_STALE_REQUEST` | 時間戳超出 ±5000ms 容忍窗 |
| 400 | `TASK_NOT_COMPLETED` | 任務進度未達標即嘗試領取 |
| 401 | `UNAUTHORIZED` | 缺少或無效 JWT |
| 401 | `INVALID_CREDENTIALS` | 帳號或密碼錯誤（不洩漏存在性） |
| 401 | `TOKEN_EXPIRED` | refresh token 過期 |
| 401 | `TOTP_INVALID` | TOTP 驗證失敗 |
| 403 | `FORBIDDEN` | 角色權限不足 |
| 403 | `ACCOUNT_BANNED` | 帳號已封鎖 |
| 403 | `TOKEN_REUSE` | Refresh 重用偵測，已撤銷全家族 |
| 403 | `TOTP_CODE_REUSED` | TOTP code 在 10 分鐘內已被使用 |
| 404 | `NOT_FOUND` | 資源不存在 |
| 404 | `GIFT_CODE_NOT_FOUND` | Gift Code 不存在 |
| 409 | `USERNAME_TAKEN` | 使用者名稱已被使用 |
| 409 | `SLOT_OCCUPIED` | 護符槽位已有其他護符 |
| 409 | `TASK_ALREADY_CLAIMED` | 任務今日已領取 |
| 409 | `GIFT_CODE_ALREADY_USED` | Gift Code 已達使用上限 |
| 409 | `GIFT_CODE_ALREADY_REDEEMED` | Gift Code 已被此帳號兌換過（同人重複） |
| 409 | `GIFT_CODE_EXPIRED` | Gift Code 已過期 |
| 422 | `INSUFFICIENT_BALANCE` | 餘額不足（條件更新 affectedRows=0） |
| 422 | `ROULETTE_PHASE_CLOSED` | 輪盤非 BETTING 階段，不接受下注 |
| 422 | `BET_LIMIT_EXCEEDED` | 超過單注上限或單回合總注上限 |
| 422 | `JACKPOT_OPTIMISTIC_LOCK` | Jackpot 樂觀鎖衝突（≤3 次重試均失敗） |
| 422 | `CHAT_MUTED` | 帳號已被禁言 |
| 429 | `RATE_LIMIT_EXCEEDED` | API 頻率超限（HTTP 路由） |
| 429 | `RATE_LIMIT_BURST` | 聊天短爆發限流（≤ 1 則/2s；Socket ack 錯誤碼） |
| 429 | `RATE_LIMIT_MINUTE` | 聊天分鐘限流（≤ 10 則/min；Socket ack 錯誤碼） |
| 500 | `INTERNAL_ERROR` | 伺服器內部錯誤（不洩漏細節） |

---

*本文件由 Milestone M05 產出，規格自此凍結。後續變更請附 ADR（Architecture Decision Record）並更新版本號。*
