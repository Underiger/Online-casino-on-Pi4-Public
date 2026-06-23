import type { Card } from '../../shared/cards.js';

/**
 * GUESSING：已有基準牌，等待玩家猜高/低（deal 後、push 後、continue 後都會回到這裡；
 *           這個狀態沒有零成本的安全選項——猜高/猜低都是賭一個新結果，逾時規則見
 *           high-low.service.ts 的孤兒回合說明，永遠是沒收，不是退款）。
 * RESULT  ：剛猜對、彩池已翻倍，等待玩家選擇收手或繼續（這個狀態「收手」本身就是
 *           零成本的合法選項，逾時規則是強制視為收手，不是沒收）。
 */
export type HighLowState = 'GUESSING' | 'RESULT';

export interface HighLowRoundState {
  roundId: string;
  state: HighLowState;
  /** 原始注額（稽核用；彩池輸光或收手後即結算，不會再改變這個值） */
  betAmount: number;
  /** 目前彩池（GUESSING：尚未翻倍的彩池；RESULT：剛翻倍、等待收手或繼續的彩池） */
  pot: number;
  streak: number;
  /** GUESSING 時：目前用於比較的基準牌 */
  baseCard: Card;
  /** RESULT 時：剛才猜對翻出的那張牌，continue 時會成為下一輪的基準牌 */
  pendingNextCard: Card | null;
  /** 剩餘牌堆（<10 張時重洗，見 payout.ts ensureDeckSize） */
  deck: Card[];
  serverSeedHash: string;
}

export type HighLowGuessOutcome = 'PUSH' | 'WIN_CONTINUE' | 'WIN_MAX_STREAK' | 'LOSE';

export interface DealResult {
  roundId: string;
  baseCard: Card;
  pot: number;
}

export interface GuessResult {
  outcome: HighLowGuessOutcome;
  /** PUSH：新的基準牌；WIN_*：剛翻出的牌；LOSE：剛翻出（讓玩家看清楚輸在哪）的牌 */
  revealedCard: Card;
  pot: number;
  streak: number;
  /** WIN_MAX_STREAK / LOSE 時，回合已結算完畢的最終餘額 */
  newBalance: bigint | null;
  /** WIN_MAX_STREAK 時的入帳金額 */
  payout: number;
}

export interface ContinueResult {
  baseCard: Card;
  pot: number;
  streak: number;
}

export interface CashOutResult {
  payout: number;
  newBalance: bigint;
}
