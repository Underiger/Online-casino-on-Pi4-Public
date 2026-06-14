/**
 * Socket.IO 事件名稱常數與 payload 型別。
 * 後端 sockets/events.ts 直接從此匯入；前端 socket/client.ts 同步使用。
 */
import type { SlotSymbol, RoulettePhase, RouletteBetType } from './enums';

// ─────────────────────────── 事件名稱常數 ───────────────────────────

export const SOCKET_EVENTS = {
  // Client → Server
  SLOT_SPIN: 'slot:spin',
  ROULETTE_BET: 'roulette:bet',
  ROULETTE_CANCEL: 'roulette:cancel',
  CHAT_SEND: 'chat:send',

  // Server → Client（個人）
  SLOT_RESULT: 'slot:result',
  ROULETTE_BET_ACK: 'roulette:bet_ack',

  // Server → Client（全服廣播）
  ROULETTE_PHASE: 'roulette:phase',
  ROULETTE_RESULT: 'roulette:result',
  ROULETTE_BETS_SNAPSHOT: 'roulette:bets_snapshot',
  JACKPOT_TICK: 'jackpot:tick',
  JACKPOT_WON: 'jackpot:won',
  CHAT_MESSAGE: 'chat:message',
  CHAT_HISTORY: 'chat:history',
  ACHIEVEMENT_UNLOCKED: 'achievement:unlocked',
  DAILY_TASK_UPDATED: 'daily:task_updated',
  SYSTEM_ANNOUNCEMENT: 'system:announcement',
  SERVER_FULL: 'server_full',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

// ─────────────────────────── 共用 HMAC 欄位 ───────────────────────────

/**
 * 嵌入所有遊戲類 Socket 事件的簽章欄位。
 * canonical = `${userId}|${gameType}|${betAmount}|${nonce}|${timestamp}`
 */
export interface SignatureFields {
  sig: string;    // HMAC-SHA256（hex）
  nonce: string;  // UUID v4，防重放
  ts: number;     // epoch ms，時間窗 ±5000ms
  seq: number;    // 嚴格遞增序號
}

// ─────────────────────────── Client → Server Payloads ───────────────────────────

export interface SlotSpinPayload extends SignatureFields {
  betAmount: 10 | 50 | 100;
}

export interface RouletteSingleBetPayload {
  type: RouletteBetType;
  amount: number;
  /** STRAIGHT 時必填（0–36） */
  number?: number;
  /** COLUMN 時必填 */
  column?: 1 | 2 | 3;
  /** DOZEN 時必填 */
  dozen?: 1 | 2 | 3;
}

export interface RouletteBetPayload extends SignatureFields {
  roundId: string;
  bets: RouletteSingleBetPayload[];
}

export interface RouletteCancelPayload {
  roundId: string;
}

export interface ChatSendPayload {
  content: string;
}

// ─────────────────────────── Server → Client Payloads ───────────────────────────

/** slot:result — 旋轉結果（個人，伺服器 ack 或主動推送） */
export interface SlotResultPayload {
  betRecordId: string;
  betAmount: number;
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
  payout: number;
  newBalance: string;       // BigInt → string
  pityActive: boolean;
  pityCounter: number;
  jackpotTriggered: boolean;
  jackpotPoints: number;
  luckySymbol: SlotSymbol | null;
  serverSeedHash: string;
}

/** roulette:bet_ack — 下注確認（個人） */
export interface RouletteBetAckPayload {
  accepted: boolean;
  roundId: string;
  totalBet: number;
  remaining: number;
}

/** roulette:phase — 回合階段切換（全服廣播） */
export interface RoulettePhasePayload {
  roundId: string;
  phase: RoulettePhase;
  phaseEndsAt: string; // ISO 8601
  participantCount: number;
}

export interface HotBetStat {
  type: RouletteBetType;
  totalAmount: number;
  count: number;
}

/** roulette:result — 回合結算（全服廣播；個人損益 personalPayout 僅自己看得到） */
export interface RouletteResultPayload {
  roundId: string;
  winningNumber: number; // 0–36
  color: 'RED' | 'BLACK' | 'GREEN';
  totalPool: number;
  participantCount: number;
  hotBets: HotBetStat[];
  /** 本回合未下注時為 null */
  personalPayout: number | null;
  newBalance: string | null; // BigInt → string
}

/** roulette:bets_snapshot — COOLDOWN 階段全服下注統計（全服廣播） */
export interface RouletteBetsSnapshotPayload {
  roundId: string;
  totalPool: number;
  betsCount: number;
  hotBets: HotBetStat[];
}

/** jackpot:tick — 獎池即時值（每 5 秒全服廣播） */
export interface JackpotTickPayload {
  pool: string; // BigInt → string
}

/** jackpot:won — 有人中了 Jackpot（全服廣播） */
export interface JackpotWonPayload {
  userId: string;
  username: string;
  avatarId: number;
  payout: string;     // BigInt → string
  poolBefore: string;
}

/** chat:message — 新聊天訊息（全服廣播） */
export interface ChatMessagePayload {
  id: string;
  userId: string | null;   // null = 系統訊息
  username: string | null;
  avatarId: number | null;
  content: string;
  system: boolean;
  createdAt: string;
}

/** chat:history — 連線後伺服器推送近期訊息（個人） */
export interface ChatHistoryPayload {
  messages: ChatMessagePayload[];
}

/** achievement:unlocked — 成就解鎖（個人通知） */
export interface AchievementUnlockedPayload {
  achievementId: string;
  code: string;
  name: string;
  description: string;
  rewardCoin: string; // BigInt → string
  newBalance: string;
}

/** daily:task_updated — 任務進度推送（個人通知） */
export interface DailyTaskUpdatedPayload {
  taskId: string;
  progress: number;
  target: number;
  claimed: boolean;
}

/** system:announcement — 新公告推播（全服廣播） */
export interface SystemAnnouncementPayload {
  id: string;
  title: string;
  content: string;
}

// ─────────────────────────── Typed Events（Socket.IO v4 泛型用） ───────────────────────────

export interface ServerToClientEvents {
  [SOCKET_EVENTS.SLOT_RESULT]: (payload: SlotResultPayload) => void;
  [SOCKET_EVENTS.ROULETTE_BET_ACK]: (payload: RouletteBetAckPayload) => void;
  [SOCKET_EVENTS.ROULETTE_PHASE]: (payload: RoulettePhasePayload) => void;
  [SOCKET_EVENTS.ROULETTE_RESULT]: (payload: RouletteResultPayload) => void;
  [SOCKET_EVENTS.ROULETTE_BETS_SNAPSHOT]: (payload: RouletteBetsSnapshotPayload) => void;
  [SOCKET_EVENTS.JACKPOT_TICK]: (payload: JackpotTickPayload) => void;
  [SOCKET_EVENTS.JACKPOT_WON]: (payload: JackpotWonPayload) => void;
  [SOCKET_EVENTS.CHAT_MESSAGE]: (payload: ChatMessagePayload) => void;
  [SOCKET_EVENTS.CHAT_HISTORY]: (payload: ChatHistoryPayload) => void;
  [SOCKET_EVENTS.ACHIEVEMENT_UNLOCKED]: (payload: AchievementUnlockedPayload) => void;
  [SOCKET_EVENTS.DAILY_TASK_UPDATED]: (payload: DailyTaskUpdatedPayload) => void;
  [SOCKET_EVENTS.SYSTEM_ANNOUNCEMENT]: (payload: SystemAnnouncementPayload) => void;
  [SOCKET_EVENTS.SERVER_FULL]: () => void;
}

export interface ClientToServerEvents {
  [SOCKET_EVENTS.SLOT_SPIN]: (
    payload: SlotSpinPayload,
    ack: (err: string | null, result?: SlotResultPayload) => void,
  ) => void;
  [SOCKET_EVENTS.ROULETTE_BET]: (
    payload: RouletteBetPayload,
    ack: (err: string | null, result?: RouletteBetAckPayload) => void,
  ) => void;
  [SOCKET_EVENTS.ROULETTE_CANCEL]: (
    payload: RouletteCancelPayload,
    ack: (err: string | null) => void,
  ) => void;
  [SOCKET_EVENTS.CHAT_SEND]: (
    payload: ChatSendPayload,
    ack: (err: string | null) => void,
  ) => void;
}

/** Socket.IO 握手 auth 資料（前端 socket.auth 設定） */
export interface SocketAuth {
  /** JWT access token */
  token: string;
}
