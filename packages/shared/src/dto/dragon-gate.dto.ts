import { z } from 'zod';
import type { Card } from '../cards';
import { DRAGON_GATE_MAX_BET, DRAGON_GATE_MIN_BET } from '../constants';

// ── Requests ─────────────────────────────────────────────────────────────────

/** POST /api/dragon-gate/bet 請求 body（HMAC 簽章；betAmount 即注額） */
export const DragonGateBetReqSchema = z.object({
  roundId: z.string().min(1),
  betAmount: z.number().int().min(DRAGON_GATE_MIN_BET).max(DRAGON_GATE_MAX_BET),
});
export type DragonGateBetReq = z.infer<typeof DragonGateBetReqSchema>;

// ── Response types ───────────────────────────────────────────────────────────

export type DragonGateOddsMode = 'TIER_3' | 'TIER_11';
export type DragonGateOutcome = 'WIN' | 'DOOR_HIT' | 'LOSE';

export interface DragonGateOpenRes {
  roundId: string;
  doors: [Card, Card];
  gap: number;
  oddsMode: DragonGateOddsMode;
  multiplier: number;
}

export interface DragonGateBetRes {
  betRecordId: string;
  outcome: DragonGateOutcome;
  thirdCard: Card;
  betAmount: number;
  /** 0 表示未中獎 */
  payout: number;
  /** 踩柱（DOOR_HIT）時是否成功扣到第二注（罕見併發競態下可能為 false） */
  extraLossApplied: boolean;
  newBalance: string; // BigInt → string
  doors: [Card, Card];
  gap: number;
  multiplier: number;
}
