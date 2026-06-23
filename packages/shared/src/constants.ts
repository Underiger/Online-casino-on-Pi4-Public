/** 前後端共用常數；後端在 config/constants.ts 可直接 re-export 或擴充。 */

// ─────────────────────────── 老虎機 ───────────────────────────

/** 可選注額（Coin），三檔固定值 */
export const SLOT_BET_AMOUNTS = [10, 50, 100] as const;
export type SlotBetAmount = (typeof SLOT_BET_AMOUNTS)[number];

/** 轉軸數量 */
export const SLOT_REEL_COUNT = 3;

/** 護符最大裝備槽位數 */
export const CHARM_MAX_SLOTS = 3;

/** Pity（保底）預設連輸觸發門檻（次） */
export const PITY_DEFAULT_THRESHOLD = 10;

/** Pity 觸發時的中獎倍率加成 */
export const PITY_BONUS_MULTIPLIER = 1.5;

/** 今日幸運符號賠率加成倍數 */
export const LUCKY_SYMBOL_MULTIPLIER = 1.5;

/** Jackpot 點數：Diamond 三連基礎給點 */
export const JACKPOT_POINTS_DIAMOND_HIT = 50;

/** Jackpot 每注貢獻比例（1%，整數 Coin） */
export const JACKPOT_CONTRIBUTION_RATE = 0.01;

/** Jackpot 派彩比例（中獎者得 80%，20% 留底繼續累積） */
export const JACKPOT_PAYOUT_RATE = 0.8;

/** Jackpot 基礎抽中分母（1/50_000） */
export const JACKPOT_BASE_ODDS = 50_000;

// ─────────────────────────── 輪盤 ───────────────────────────

/** 輪盤單注上限（Coin） */
export const ROULETTE_MAX_SINGLE_BET = 1_000;

/** 輪盤單回合單人總注上限（Coin） */
export const ROULETTE_MAX_TOTAL_BET = 5_000;

/** 輪盤各階段時長（毫秒） */
export const ROULETTE_PHASE_DURATION_MS = {
  BETTING: 15_000,
  LOCK: 2_000,
  RESULT: 8_000,
  COOLDOWN: 5_000,
} as const;

/** 標準歐式輪盤號碼數（0–36） */
export const ROULETTE_NUMBERS = 37;

// ─────────────────────────── 射龍門 ───────────────────────────

export const DRAGON_GATE_MIN_BET = 10;
export const DRAGON_GATE_MAX_BET = 1_000;

// ─────────────────────────── High-Low ───────────────────────────

export const HIGH_LOW_MIN_BET = 10;
export const HIGH_LOW_MAX_BET = 1_000;
export const HIGH_LOW_MAX_STREAK = 5;

// ─────────────────────────── Blackjack ───────────────────────────

export const BLACKJACK_MIN_BET = 10;
export const BLACKJACK_MAX_BET = 1_000;

// ─────────────────────────── 聊天室 ───────────────────────────

/** 聊天訊息最大字元數 */
export const CHAT_MAX_LENGTH = 200;

/** Redis List 保留最近幾則訊息 */
export const CHAT_HISTORY_SIZE = 200;

/** DB 保留天數（超過此天數的訊息由排程清理） */
export const CHAT_RETENTION_DAYS = 7;

/** 頻率：每 N 毫秒最多 1 則 */
export const CHAT_RATE_WINDOW_MS = 2_000;

/** 頻率：60 秒視窗最多 N 則 */
export const CHAT_RATE_PER_MINUTE_MAX = 10;

/** 違規累計 N 次後觸發禁言 */
export const CHAT_VIOLATION_MUTE_THRESHOLD = 5;

/** 禁言時長（毫秒） */
export const CHAT_MUTE_DURATION_MS = 10 * 60 * 1_000;

// ─────────────────────────── 帳號與經濟 ───────────────────────────

/** 新手禮包初始餘額（Coin，BigInt） */
export const NEW_PLAYER_BALANCE = 5_000n;

/** 破產保底門檻：餘額 < N 且當日未領才補發 */
export const BANKRUPT_THRESHOLD = 10n;

/** 破產保底補發金額（Coin，BigInt） */
export const BANKRUPT_RELIEF = 300n;

/** 每日登入基礎獎勵（Coin，BigInt） */
export const DAILY_LOGIN_BASE_REWARD = 500n;

/** 連續登入天數上限（達到後係數不再提升，固定 ×2.0） */
export const DAILY_LOGIN_MAX_STREAK = 7;

/** Gift Code 最短字元數 */
export const GIFT_CODE_MIN_LENGTH = 16;

// ─────────────────────────── Socket / 連線 ───────────────────────────

/** Socket.IO 最大同時連線數 */
export const SOCKET_MAX_CONNECTIONS = 200;

/** Socket.IO maxHttpBufferSize（位元組） */
export const SOCKET_MAX_HTTP_BUFFER = 4 * 1_024;

// ─────────────────────────── 安全 ───────────────────────────

/** HMAC 時間窗容忍（毫秒） */
export const HMAC_TIMESTAMP_TOLERANCE_MS = 5_000;

/** Refresh Token 隨機位元組數（hex 後為 128 字元） */
export const REFRESH_TOKEN_BYTES = 64;

/** HMAC 輪換後舊金鑰保留寬限（毫秒） */
export const HMAC_PREV_KEY_GRACE_MS = 30_000;

/** AdminAuditLog.action 欄位字元上限 */
export const AUDIT_ACTION_MAX_LENGTH = 40;
