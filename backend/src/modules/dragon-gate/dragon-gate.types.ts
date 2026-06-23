import type { Card } from '../../shared/cards.js';
import type { DragonGateOddsMode } from '../../config/constants.js';

/** open 後存在 Redis `dragon-gate:round:{userId}` 的回合狀態（GETDEL 單步取用，見 service 註解） */
export interface DragonGateRoundState {
  roundId: string;
  doors: [Card, Card];
  gap: number;
  oddsMode: DragonGateOddsMode;
  multiplier: number;
  /** 開門時已抽掉 2 張門牌後剩餘的 50 張牌（第三張牌從這裡抽，機率公式才成立） */
  remainingDeck: Card[];
  /** provably-fair 預留（與 slot 同慣例）：開門時洗牌用的隨機性 sha256 hash */
  serverSeedHash: string;
}

export interface OpenDoorsResult {
  roundId: string;
  doors: [Card, Card];
  gap: number;
  oddsMode: DragonGateOddsMode;
  multiplier: number;
}

export type DragonGateOutcome = 'WIN' | 'DOOR_HIT' | 'LOSE';

export interface SettleResult {
  outcome: DragonGateOutcome;
  /** 中獎入帳金額（含本金）；未中獎為 0 */
  payout: number;
  /** 踩柱時額外再輸的一注；其餘情況為 0 */
  extraLoss: number;
}

export interface BetOutcome {
  betRecordId: string;
  outcome: DragonGateOutcome;
  thirdCard: Card;
  betAmount: number;
  payout: number;
  extraLossApplied: boolean;
  newBalance: bigint;
  doors: [Card, Card];
  gap: number;
  multiplier: number;
}
