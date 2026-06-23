/**
 * Blackjack 純邏輯（不碰 Prisma/Redis，可單元測試直測；港自 pokergame
 * games/blackjack.py 上半部純函式，邏輯逐行對應，見 config/constants.ts 檔頭說明）。
 */
import {
  BLACKJACK_DEALER_HITS_SOFT_17,
  BLACKJACK_NATURAL_PAYOUT_DENOMINATOR,
  BLACKJACK_NATURAL_PAYOUT_NUMERATOR,
} from '../../config/constants.js';
import type { Card } from '../../shared/cards.js';
import type { BlackjackResultKey, SettleOutcome } from './blackjack.types.js';

/** 基礎點數：A 先算 11，軟硬調整在 handValue 做；J/Q/K（rank 11/12/13）算 10 */
export function cardBjValue(card: Card): number {
  if (card.rank === 14) return 11;
  return Math.min(card.rank, 10);
}

/** 回傳 [最佳點數, 是否為軟手牌]。軟手牌＝有一張 A 正以 11 計算（再拿牌爆了還能降 1 補救） */
export function handValue(cards: readonly Card[]): [total: number, isSoft: boolean] {
  let total = cards.reduce((sum, c) => sum + cardBjValue(c), 0);
  let acesAs11 = cards.filter((c) => c.rank === 14).length;
  while (total > 21 && acesAs11 > 0) {
    total -= 10;
    acesAs11 -= 1;
  }
  return [total, acesAs11 > 0];
}

/** 天生 Blackjack：恰好兩張且 21 點 */
export function isBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards)[0] === 21;
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards)[0] > 21;
}

/** 莊家補牌決策。S17：>=17 一律停；H17：軟 17 要補（由常數開關決定） */
export function dealerShouldHit(cards: readonly Card[]): boolean {
  const [total, soft] = handValue(cards);
  if (total < 17) return true;
  if (total === 17 && soft && BLACKJACK_DEALER_HITS_SOFT_17) return true;
  return false;
}

/**
 * 勝負判定。注金已在下注時扣除，payoutTotal 為「應收回的總金額」：
 *   贏 1:1   → bet*2（本金+彩金）
 *   BJ 3:2   → bet + bet*3/2（向下取整，對齊 pokergame 的整數除法）
 *   平手     → bet（退注）
 *   輸       → 0
 */
export function settle(
  playerCards: readonly Card[],
  dealerCards: readonly Card[],
  bet: number,
): SettleOutcome {
  const playerBj = isBlackjack(playerCards);
  const dealerBj = isBlackjack(dealerCards);

  if (playerBj && dealerBj) return result('PUSH', bet);
  if (playerBj) {
    return result(
      'BLACKJACK',
      bet + Math.floor((bet * BLACKJACK_NATURAL_PAYOUT_NUMERATOR) / BLACKJACK_NATURAL_PAYOUT_DENOMINATOR),
    );
  }
  if (dealerBj) return result('LOSE', 0);

  const [playerValue] = handValue(playerCards);
  const [dealerValue] = handValue(dealerCards);
  if (playerValue > 21) return result('BUST', 0);
  if (dealerValue > 21) return result('DEALER_BUST', bet * 2);
  if (playerValue > dealerValue) return result('WIN', bet * 2);
  if (playerValue < dealerValue) return result('LOSE', 0);
  return result('PUSH', bet);
}

function result(resultKey: BlackjackResultKey, payoutTotal: number): SettleOutcome {
  return { resultKey, payoutTotal };
}

export interface DealerTurnResult {
  dealerCards: Card[];
  deck: Card[];
}

/**
 * 莊家補牌迴圈一次跑完（伺服器端不需要像 pokergame 那樣逐張動畫延遲）。
 * 玩家天生 BJ 時莊家不補牌（pokergame 同款：只翻底牌看是否雙 BJ），由呼叫端
 * 判斷是否要呼叫本函式——本函式單純「補到 dealerShouldHit 回 false 為止」。
 */
export function resolveDealerTurn(dealerCards: readonly Card[], deck: readonly Card[]): DealerTurnResult {
  const cards = [...dealerCards];
  const remaining = [...deck];
  while (dealerShouldHit(cards)) {
    const next = remaining.shift();
    if (next === undefined) throw new Error('blackjack: 牌堆不應在莊家補牌階段耗盡');
    cards.push(next);
  }
  return { dealerCards: cards, deck: remaining };
}
