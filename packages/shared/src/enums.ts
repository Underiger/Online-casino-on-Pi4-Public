/** 與 backend/prisma/schema.prisma enum 對齊；任何改動需同步更新 Prisma schema。 */

export enum Role {
  PLAYER = 'PLAYER',
  ADMIN = 'ADMIN',
}

export enum GameType {
  SLOT = 'SLOT',
  ROULETTE = 'ROULETTE',
}

/** BalanceTransaction.type — 每筆餘額異動的原因分類 */
export enum TxType {
  BET = 'BET',
  PAYOUT = 'PAYOUT',
  DAILY_REWARD = 'DAILY_REWARD',
  TASK_REWARD = 'TASK_REWARD',
  GIFT_CODE = 'GIFT_CODE',
  ADMIN_ADJUST = 'ADMIN_ADJUST',
  JACKPOT = 'JACKPOT',
  REFUND = 'REFUND',
}

export enum CharmType {
  WEIGHT = 'WEIGHT',
  RULE = 'RULE',
  CONDITIONAL = 'CONDITIONAL',
  PITY = 'PITY',
  BONUS = 'BONUS',
}

export enum CharmRarity {
  COMMON = 'COMMON',
  RARE = 'RARE',
  EPIC = 'EPIC',
  LEGENDARY = 'LEGENDARY',
}

export enum TaskType {
  SPIN_COUNT = 'SPIN_COUNT',
  ROULETTE_ROUNDS = 'ROULETTE_ROUNDS',
  WIN_TRIPLE = 'WIN_TRIPLE',
  NET_WIN = 'NET_WIN',
  CHAT_COUNT = 'CHAT_COUNT',
}

export enum LeaderboardKind {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  TOTAL = 'TOTAL',
}

export enum LoginResult {
  SUCCESS = 'SUCCESS',
  WRONG_PASSWORD = 'WRONG_PASSWORD',
  BANNED = 'BANNED',
  TOTP_FAILED = 'TOTP_FAILED',
}

export enum PacketViolation {
  BAD_SIGNATURE = 'BAD_SIGNATURE',
  NONCE_REPLAY = 'NONCE_REPLAY',
  SEQ_REGRESSION = 'SEQ_REGRESSION',
  STALE_TIMESTAMP = 'STALE_TIMESTAMP',
  OUT_OF_WINDOW = 'OUT_OF_WINDOW',
  RATE_LIMIT = 'RATE_LIMIT',
}

/** 老虎機 8 種符號 */
export enum SlotSymbol {
  CHERRY = 'CHERRY',
  LEMON = 'LEMON',
  BELL = 'BELL',
  BAR = 'BAR',
  CLOVER = 'CLOVER',
  LUCKY7 = 'LUCKY7',
  DIAMOND = 'DIAMOND',
  WILD = 'WILD',
}

/** 輪盤下注類型（初版 8 種；Phase 2 擴充 Split/Street/Corner） */
export enum RouletteBetType {
  STRAIGHT = 'STRAIGHT', // 單號 35:1
  RED = 'RED',           // 紅 1:1
  BLACK = 'BLACK',       // 黑 1:1
  ODD = 'ODD',           // 奇 1:1
  EVEN = 'EVEN',         // 偶 1:1
  HIGH = 'HIGH',         // 大（19–36）1:1
  LOW = 'LOW',           // 小（1–18）1:1
  COLUMN = 'COLUMN',     // 直欄 2:1
  DOZEN = 'DOZEN',       // 打 2:1
}

/** 輪盤回合四階段狀態機 */
export enum RoulettePhase {
  BETTING = 'BETTING',
  LOCK = 'LOCK',
  RESULT = 'RESULT',
  COOLDOWN = 'COOLDOWN',
}
