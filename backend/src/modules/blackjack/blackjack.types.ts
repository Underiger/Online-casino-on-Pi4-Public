import type { Card } from '../../shared/cards.js';

/** 沒有 DEALER_TURN 狀態：莊家補牌迴圈在伺服器內一次跑完，不需要在多個請求間暫停 */
export type BlackjackState = 'PLAYER_TURN';

export interface BlackjackRoundState {
  roundId: string;
  state: BlackjackState;
  /** 目前注額（加倍後會變成原始注額的兩倍，settle 用這個算賠付） */
  betAmount: number;
  doubled: boolean;
  playerCards: Card[];
  /** 含底牌；PLAYER_TURN 期間回應只回傳 dealerCards[0]，底牌不外流 */
  dealerCards: Card[];
  deck: Card[];
  serverSeedHash: string;
}

export type BlackjackResultKey = 'BLACKJACK' | 'WIN' | 'DEALER_BUST' | 'PUSH' | 'LOSE' | 'BUST';

export interface SettleOutcome {
  resultKey: BlackjackResultKey;
  /** 總回收金額（含本金；push=退回原注、輸=0），對齊 pokergame settle() 語義 */
  payoutTotal: number;
}

/** PLAYER_TURN 期間的回應形狀（底牌隱藏）。settled 為 discriminant，方便呼叫端 narrow 型別 */
export interface InProgressView {
  settled: false;
  roundId: string;
  playerCards: Card[];
  dealerUpCard: Card;
  betAmount: number;
  doubled: boolean;
}

/** 回合終局回應形狀（底牌揭露 + 結算結果） */
export interface SettledView {
  settled: true;
  roundId: string;
  resultKey: BlackjackResultKey;
  playerCards: Card[];
  dealerCards: Card[];
  betAmount: number;
  payout: number;
  newBalance: bigint;
}

export type DealResult = InProgressView | SettledView;
export type ActionResult = InProgressView | SettledView;
