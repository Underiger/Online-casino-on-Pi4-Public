/**
 * Roulette 型別、常數與請求 schema（01_GDD §4、05_MILESTONES M15）。
 *
 * ⚠ 鏡像 packages/shared（enums.ts / constants.ts / dto/roulette.dto.ts /
 * socket-events.ts）：backend tsconfig rootDir=src 暫無法 import shared 的 .ts
 * 入口（同 sockets/events.ts 檔頭說明），欄位以 docs/04_API_SPEC.md 為準。
 */
import { z } from 'zod';

// ─────────────────────────── 階段與時長 ───────────────────────────

export const ROULETTE_PHASES = ['BETTING', 'LOCK', 'RESULT', 'COOLDOWN'] as const;
export type RoulettePhase = (typeof ROULETTE_PHASES)[number];

/** 各階段時長（GDD §4.1 固定循環；鏡像 shared ROULETTE_PHASE_DURATION_MS） */
export const ROULETTE_PHASE_DURATION_MS: Record<RoulettePhase, number> = {
  BETTING: 15_000,
  LOCK: 2_000,
  RESULT: 8_000,
  COOLDOWN: 5_000,
};

// ─────────────────────────── 注限與盤面 ───────────────────────────

/** 單注上限（GDD §4.2；鏡像 shared ROULETTE_MAX_SINGLE_BET） */
export const ROULETTE_MAX_SINGLE_BET = 1_000;
/** 單回合單人總注上限（GDD §4.2；鏡像 shared ROULETTE_MAX_TOTAL_BET） */
export const ROULETTE_MAX_TOTAL_BET = 5_000;
/** 標準歐式輪盤號碼數（0–36） */
export const ROULETTE_NUMBERS = 37;
/** 單次請求最多注數（鏡像 shared RouletteBetReqSchema .max(20)） */
export const ROULETTE_MAX_BETS_PER_REQUEST = 20;

export type RouletteBetType =
  | 'STRAIGHT' // 單號 35:1
  | 'RED'      // 紅 1:1
  | 'BLACK'    // 黑 1:1
  | 'ODD'      // 奇 1:1
  | 'EVEN'     // 偶 1:1
  | 'HIGH'     // 大（19–36）1:1
  | 'LOW'      // 小（1–18）1:1
  | 'COLUMN'   // 直欄 2:1
  | 'DOZEN';   // 打 2:1

export type RouletteColor = 'RED' | 'BLACK' | 'GREEN';

/** 歐式輪盤紅色號碼（標準盤面，0 為綠） */
export const ROULETTE_RED_NUMBERS: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export function rouletteColorOf(n: number): RouletteColor {
  if (n === 0) return 'GREEN';
  return ROULETTE_RED_NUMBERS.has(n) ? 'RED' : 'BLACK';
}

/**
 * 中獎「總回收」倍率（含本金）：賠率 X:1 ⇒ 回收 (X+1) 倍。
 * 下注時已即時扣款，結算僅對中獎注 credit 回收額（GDD §4.2 賠率表）。
 */
export const ROULETTE_RETURN_MULTIPLIER: Record<RouletteBetType, number> = {
  STRAIGHT: 36, // 35:1
  RED: 2,       // 1:1
  BLACK: 2,
  ODD: 2,
  EVEN: 2,
  HIGH: 2,
  LOW: 2,
  COLUMN: 3,    // 2:1
  DOZEN: 3,
};

// ─────────────────────────── 請求 schema（鏡像 shared RouletteBetReqSchema） ───────────────────────────

/**
 * 單注 schema：amount 僅驗「正整數」——單注上限（1000）由 service 檢查並回
 * BET_LIMIT_EXCEEDED（docs/04_API_SPEC.md §5 凍結碼；zod 失敗統一 VALIDATION_ERROR）。
 */
export const RouletteSingleBetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('STRAIGHT'),
    amount: z.number().int().positive(),
    number: z.number().int().min(0).max(36),
  }),
  z.object({
    type: z.literal('COLUMN'),
    amount: z.number().int().positive(),
    column: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.object({
    type: z.literal('DOZEN'),
    amount: z.number().int().positive(),
    dozen: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.object({
    type: z.enum(['RED', 'BLACK', 'ODD', 'EVEN', 'HIGH', 'LOW']),
    amount: z.number().int().positive(),
  }),
]);
export type RouletteSingleBet = z.infer<typeof RouletteSingleBetSchema>;

export const RouletteBetReqSchema = z.object({
  roundId: z.string().min(1),
  bets: z.array(RouletteSingleBetSchema).min(1).max(ROULETTE_MAX_BETS_PER_REQUEST),
});
export type RouletteBetReq = z.infer<typeof RouletteBetReqSchema>;

export const RouletteCancelReqSchema = z.object({
  roundId: z.string().min(1),
});
export type RouletteCancelReq = z.infer<typeof RouletteCancelReqSchema>;

// ─────────────────────────── Socket payload（鏡像 shared socket-events.ts） ───────────────────────────

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

/** roulette:result 的全服共通部分（個人欄位由 gateway 對房間個別補上） */
export interface RouletteResultCommon {
  roundId: string;
  winningNumber: number; // 0–36
  color: RouletteColor;
  totalPool: number;
  participantCount: number;
  hotBets: HotBetStat[];
}

/** roulette:result — 完整 payload（personalPayout null = 本回合未下注） */
export interface RouletteResultPayload extends RouletteResultCommon {
  personalPayout: number | null;
  newBalance: string | null; // BigInt → string
}

/** roulette:bet_ack — 下注確認（個人） */
export interface RouletteBetAckPayload {
  accepted: boolean;
  roundId: string;
  totalBet: number;   // 本回合累計已下注額
  remaining: number;  // MAX_TOTAL_BET − totalBet
}

/** roulette:bets_snapshot — COOLDOWN 階段全服下注統計（全服廣播） */
export interface RouletteBetsSnapshotPayload {
  roundId: string;
  totalPool: number;
  betsCount: number;
  hotBets: HotBetStat[];
}

// ─────────────────────────── REST 回應（docs/04_API_SPEC.md §3.5） ───────────────────────────

export interface RouletteRoundStateRes {
  roundId: string;
  phase: RoulettePhase;
  phaseEndsAt: string; // ISO 8601
  participantCount: number;
  totalPool: number;
}

export interface RouletteHistoryItem {
  roundId: string;
  winningNumber: number;
  color: RouletteColor;
  totalPool: number;
  participantCount: number;
  resolvedAt: string; // ISO 8601
}

// ─────────────────────────── 內部儲存與結算型別 ───────────────────────────

/**
 * Redis 下注事件（append-only list `roulette:round:{id}:entries`）：
 * RPUSH 永不讀改寫，杜絕同使用者併發下注的覆寫競態；
 * cancel 為「事件標記」——結算時序列回放：遇 cancel 清空該使用者先前累積，
 * 取消後的再下注照常生效。
 */
export type RouletteStoredEntry =
  | { userId: string; bets: RouletteSingleBet[] }
  | { userId: string; cancel: true };

/** 結算後的個人結果（payout = 中獎總回收，0 = 全輸；newBalance 為結算後餘額） */
export interface RoulettePersonalResult {
  totalBet: number;
  payout: number;
  newBalance: bigint;
}

export interface RouletteRoundSettlement {
  common: RouletteResultCommon;
  perUser: Map<string, RoulettePersonalResult>;
}

/** placeBets / cancelBets 的錯誤碼（docs/04_API_SPEC.md §5 凍結） */
export type RouletteBetErrorCode =
  | 'VALIDATION_ERROR'
  | 'ROULETTE_PHASE_CLOSED'
  | 'BET_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_BALANCE'
  | 'INTERNAL_ERROR';

export type PlaceBetsResult =
  | { ok: true; ack: RouletteBetAckPayload }
  | { ok: false; code: RouletteBetErrorCode; message: string };

export type CancelBetsResult =
  | { ok: true; cancelled: boolean; refunded: number }
  | { ok: false; code: RouletteBetErrorCode; message: string };
