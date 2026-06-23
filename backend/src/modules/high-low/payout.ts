/**
 * High-Low 純邏輯（不碰 Prisma/Redis，可單元測試直測；港自 pokergame
 * games/high_low.py 的 _guess/_resolve/_ensure_deck，邏輯逐行對應）。
 */
import { HIGH_LOW_DECK_RESHUFFLE_THRESHOLD } from '../../config/constants.js';
import { freshShuffledDeck, type Card, type RngFn } from '../../shared/cards.js';
import { rngInt } from '../../security/csprng.js';

export type GuessComparison = 'PUSH' | 'CORRECT' | 'WRONG';

/** A（14）不可猜高、2 不可猜低——機率上必輸，伺服器端硬性擋下（不只是 UI 層） */
export function isLegalGuess(baseCard: Card, guessHigh: boolean): boolean {
  if (guessHigh && baseCard.rank === 14) return false;
  if (!guessHigh && baseCard.rank === 2) return false;
  return true;
}

/** 同點 push；其餘依猜測方向與實際高低比對 */
export function compareGuess(baseCard: Card, nextCard: Card, guessHigh: boolean): GuessComparison {
  if (nextCard.rank === baseCard.rank) return 'PUSH';
  const actualHigher = nextCard.rank > baseCard.rank;
  return actualHigher === guessHigh ? 'CORRECT' : 'WRONG';
}

/** 牌堆 < 10 張時整副重新洗牌（不是補牌，是整副換新——防止記牌必勝） */
export function ensureDeckSize(deck: readonly Card[], rng: RngFn = rngInt): Card[] {
  if (deck.length < HIGH_LOW_DECK_RESHUFFLE_THRESHOLD) {
    return freshShuffledDeck(1, rng);
  }
  return [...deck];
}
