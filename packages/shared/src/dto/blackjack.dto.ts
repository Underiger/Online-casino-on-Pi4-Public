import { z } from 'zod';
import type { Card } from '../cards';
import { BLACKJACK_MAX_BET, BLACKJACK_MIN_BET } from '../constants';

// ── Requests ─────────────────────────────────────────────────────────────────

/** POST /api/blackjack/deal 請求 body（HMAC 簽章；betAmount 即注額） */
export const BlackjackDealReqSchema = z.object({
  betAmount: z.number().int().min(BLACKJACK_MIN_BET).max(BLACKJACK_MAX_BET),
});
export type BlackjackDealReq = z.infer<typeof BlackjackDealReqSchema>;

/** POST /api/blackjack/hit、/stand、/double 共用（不需要 HMAC） */
export const BlackjackRoundReqSchema = z.object({
  roundId: z.string().min(1),
});
export type BlackjackRoundReq = z.infer<typeof BlackjackRoundReqSchema>;

// ── Response types ───────────────────────────────────────────────────────────

export type BlackjackResultKey = 'BLACKJACK' | 'WIN' | 'DEALER_BUST' | 'PUSH' | 'LOSE' | 'BUST';

/** PLAYER_TURN 期間的回應形狀（底牌隱藏）。settled 為 discriminant。 */
export interface BlackjackInProgressRes {
  settled: false;
  roundId: string;
  playerCards: Card[];
  dealerUpCard: Card;
  betAmount: number;
  doubled: boolean;
}

/** 回合終局回應形狀（底牌揭露 + 結算結果） */
export interface BlackjackSettledRes {
  settled: true;
  roundId: string;
  resultKey: BlackjackResultKey;
  playerCards: Card[];
  dealerCards: Card[];
  betAmount: number;
  payout: number;
  newBalance: string; // BigInt → string
}

export type BlackjackActionRes = BlackjackInProgressRes | BlackjackSettledRes;
