import { z } from 'zod';
import { RouletteBetType, RoulettePhase } from '../enums';
import type { HotBetStat } from '../socket-events';

// ── Shared sub-types ──────────────────────────────────────────────────────────

export const RouletteSingleBetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(RouletteBetType.STRAIGHT),
    amount: z.number().int().positive(),
    number: z.number().int().min(0).max(36),
  }),
  z.object({
    type: z.literal(RouletteBetType.COLUMN),
    amount: z.number().int().positive(),
    column: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.object({
    type: z.literal(RouletteBetType.DOZEN),
    amount: z.number().int().positive(),
    dozen: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.object({
    type: z.enum([
      RouletteBetType.RED,
      RouletteBetType.BLACK,
      RouletteBetType.ODD,
      RouletteBetType.EVEN,
      RouletteBetType.HIGH,
      RouletteBetType.LOW,
    ]),
    amount: z.number().int().positive(),
  }),
]);
export type RouletteSingleBet = z.infer<typeof RouletteSingleBetSchema>;

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * POST /api/roulette/bet 請求 body（REST 輪盤下注）。
 * 也是 Socket 事件 roulette:bet 的 payload（含額外 HMAC 欄位由中介層驗證）。
 */
export const RouletteBetReqSchema = z.object({
  roundId: z.string().min(1),
  bets: z.array(RouletteSingleBetSchema).min(1).max(20),
});
export type RouletteBetReq = z.infer<typeof RouletteBetReqSchema>;

export const RouletteCancelReqSchema = z.object({
  roundId: z.string().min(1),
});
export type RouletteCancelReq = z.infer<typeof RouletteCancelReqSchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface RouletteRoundStateRes {
  roundId: string;
  phase: RoulettePhase;
  phaseEndsAt: string;   // ISO 8601
  participantCount: number;
  totalPool: number;
}

export interface RouletteBetRes {
  accepted: boolean;
  roundId: string;
  totalBet: number;
  remaining: number; // 本回合剩餘可下注額（MAX_TOTAL_BET - 已下）
}

export interface RouletteCancelRes {
  cancelled: boolean;
  refunded: number;
}

export type { HotBetStat };

export interface RouletteResultRes {
  roundId: string;
  winningNumber: number;
  color: 'RED' | 'BLACK' | 'GREEN';
  totalPool: number;
  participantCount: number;
  hotBets: HotBetStat[];
  personalPayout: number | null;   // null 表示本回合未下注
  newBalance: string | null;
}

export interface RouletteHistoryItem {
  roundId: string;
  winningNumber: number;
  color: 'RED' | 'BLACK' | 'GREEN';
  totalPool: number;
  participantCount: number;
  resolvedAt: string;
}

export interface RouletteHistoryRes {
  items: RouletteHistoryItem[];
  total: number;
  page: number;
  limit: number;
}
