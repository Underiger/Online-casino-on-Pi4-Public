/**
 * 撲克牌共用工具（射龍門 / High-Low / Blackjack 共用；slot/roulette 不需要牌，
 * 這是這批新遊戲第一次引入「牌」的概念，故抽成 shared，不放進任一遊戲模組）。
 *
 * 洗牌一律透過注入的 RngFn（預設 `security/csprng.ts` 的 `rngInt`），
 * 與 slot 的 `sampler.ts` 同一慣例——嚴禁使用 Math.random（ESLint 全域禁用）。
 */
import { rngInt } from '../security/csprng.js';

export type Suit = 'SPADE' | 'HEART' | 'DIAMOND' | 'CLUB';

/** 2~10 為點數本身；11=J、12=Q、13=K、14=A（A 最大、2 最小，與多數撲克玩法一致） */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type RngFn = (maxExclusive: number) => number;

const SUITS: readonly Suit[] = ['SPADE', 'HEART', 'DIAMOND', 'CLUB'];
const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_LABEL: Readonly<Record<Rank, string>> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

export function rankLabel(rank: Rank): string {
  return RANK_LABEL[rank];
}

/** 建一副（或多副）未洗牌的標準 52 張牌（不含 Joker） */
export function freshDeck(numDecks = 1): Card[] {
  const deck: Card[] = [];
  for (let d = 0; d < numDecks; d += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ rank, suit });
      }
    }
  }
  return deck;
}

/** Fisher-Yates 洗牌；不修改輸入陣列，回傳新陣列 */
export function shuffle<T>(items: readonly T[], rng: RngFn = rngInt): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
  return arr;
}

/** 建一副已洗好的牌（freshDeck + shuffle 的常用組合） */
export function freshShuffledDeck(numDecks = 1, rng: RngFn = rngInt): Card[] {
  return shuffle(freshDeck(numDecks), rng);
}
