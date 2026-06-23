import { describe, expect, it } from 'vitest';
import { freshDeck, freshShuffledDeck, rankLabel, shuffle } from '../../src/shared/cards.js';

describe('freshDeck', () => {
  it('一副牌是 52 張，4 種花色各 13 個點數，無重複', () => {
    const deck = freshDeck();
    expect(deck).toHaveLength(52);
    const keys = new Set(deck.map((c) => `${c.suit}-${c.rank}`));
    expect(keys.size).toBe(52);
  });

  it('每個點數恰好 4 張（每花色一張）', () => {
    const deck = freshDeck();
    const countOfRank7 = deck.filter((c) => c.rank === 7).length;
    expect(countOfRank7).toBe(4);
  });

  it('numDecks=4 是 208 張，每個點數 16 張', () => {
    const deck = freshDeck(4);
    expect(deck).toHaveLength(208);
    expect(deck.filter((c) => c.rank === 14).length).toBe(16);
  });
});

describe('shuffle', () => {
  it('不修改輸入陣列，回傳新陣列', () => {
    const original = freshDeck();
    const copy = [...original];
    shuffle(original, () => 0);
    expect(original).toEqual(copy);
  });

  it('注入固定 rng 時結果具確定性（可重現）', () => {
    const deck = freshDeck();
    const a = shuffle(deck, () => 0);
    const b = shuffle(deck, () => 0);
    expect(a).toEqual(b);
  });

  it('洗牌後仍是同一組牌，只是順序不同（用真實 CSPRNG 預設值跑一次）', () => {
    const deck = freshShuffledDeck();
    expect(deck).toHaveLength(52);
    const keys = new Set(deck.map((c) => `${c.suit}-${c.rank}`));
    expect(keys.size).toBe(52);
  });
});

describe('rankLabel', () => {
  it('數字牌回傳字串本身、人頭牌回傳對應字母', () => {
    expect(rankLabel(2)).toBe('2');
    expect(rankLabel(10)).toBe('10');
    expect(rankLabel(11)).toBe('J');
    expect(rankLabel(12)).toBe('Q');
    expect(rankLabel(13)).toBe('K');
    expect(rankLabel(14)).toBe('A');
  });
});
