import { z } from 'zod';
import type { Card } from '../cards';
import { HIGH_LOW_MAX_BET, HIGH_LOW_MIN_BET } from '../constants';

// ── Requests ─────────────────────────────────────────────────────────────────

/** POST /api/high-low/deal 請求 body（HMAC 簽章；betAmount 即注額） */
export const HighLowDealReqSchema = z.object({
  betAmount: z.number().int().min(HIGH_LOW_MIN_BET).max(HIGH_LOW_MAX_BET),
});
export type HighLowDealReq = z.infer<typeof HighLowDealReqSchema>;

/** POST /api/high-low/guess 請求 body（不需要 HMAC） */
export const HighLowGuessReqSchema = z.object({
  roundId: z.string().min(1),
  guessHigh: z.boolean(),
});
export type HighLowGuessReq = z.infer<typeof HighLowGuessReqSchema>;

/** POST /api/high-low/continue、POST /api/high-low/cash-out 共用（不需要 HMAC） */
export const HighLowRoundReqSchema = z.object({
  roundId: z.string().min(1),
});
export type HighLowRoundReq = z.infer<typeof HighLowRoundReqSchema>;

// ── Response types ───────────────────────────────────────────────────────────

export type HighLowGuessOutcome = 'PUSH' | 'WIN_CONTINUE' | 'WIN_MAX_STREAK' | 'LOSE';

export interface HighLowDealRes {
  roundId: string;
  baseCard: Card;
  pot: number;
}

export interface HighLowGuessRes {
  outcome: HighLowGuessOutcome;
  revealedCard: Card;
  pot: number;
  streak: number;
  /** 僅 WIN_MAX_STREAK / LOSE（回合終局）才非 null；BigInt → string */
  newBalance: string | null;
  /** 僅 WIN_MAX_STREAK 時非 0 */
  payout: number;
}

export interface HighLowContinueRes {
  baseCard: Card;
  pot: number;
  streak: number;
}

export interface HighLowCashOutRes {
  payout: number;
  newBalance: string;
}
