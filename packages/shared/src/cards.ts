/** 與 backend/src/shared/cards.ts 對齊的牌面型別（前端顯示用，不含洗牌邏輯）。 */

export type Suit = 'SPADE' | 'HEART' | 'DIAMOND' | 'CLUB';

/** 2~10 為點數本身；11=J、12=Q、13=K、14=A（A 最大、2 最小） */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}
