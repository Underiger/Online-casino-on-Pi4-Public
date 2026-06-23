import { describe, expect, it } from 'vitest';
import { compareGuess, ensureDeckSize, isLegalGuess } from '../../src/modules/high-low/payout.js';
import type { Card } from '../../src/shared/cards.js';

function card(rank: Card['rank'], suit: Card['suit'] = 'SPADE'): Card {
  return { rank, suit };
}

describe('isLegalGuess', () => {
  it('基準牌是 A（14）時不可猜高', () => {
    expect(isLegalGuess(card(14), true)).toBe(false);
    expect(isLegalGuess(card(14), false)).toBe(true);
  });

  it('基準牌是 2 時不可猜低', () => {
    expect(isLegalGuess(card(2), false)).toBe(false);
    expect(isLegalGuess(card(2), true)).toBe(true);
  });

  it('其餘點數兩個方向都合法', () => {
    expect(isLegalGuess(card(8), true)).toBe(true);
    expect(isLegalGuess(card(8), false)).toBe(true);
  });
});

describe('compareGuess', () => {
  it('同點數 → PUSH', () => {
    expect(compareGuess(card(7, 'SPADE'), card(7, 'HEART'), true)).toBe('PUSH');
  });

  it('猜高且確實較高 → CORRECT', () => {
    expect(compareGuess(card(5), card(9), true)).toBe('CORRECT');
  });

  it('猜高但較低 → WRONG', () => {
    expect(compareGuess(card(5), card(3), true)).toBe('WRONG');
  });

  it('猜低且確實較低 → CORRECT', () => {
    expect(compareGuess(card(5), card(3), false)).toBe('CORRECT');
  });

  it('猜低但較高 → WRONG', () => {
    expect(compareGuess(card(5), card(9), false)).toBe('WRONG');
  });
});

describe('ensureDeckSize', () => {
  it('剩餘 >= 10 張時原樣回傳（不重洗）', () => {
    const deck = Array.from({ length: 15 }, () => card(7));
    const result = ensureDeckSize(deck);
    expect(result).toHaveLength(15);
  });

  it('剩餘 < 10 張時整副重新洗成 52 張新牌（不是補牌）', () => {
    const deck = Array.from({ length: 3 }, () => card(7));
    const result = ensureDeckSize(deck);
    expect(result).toHaveLength(52);
  });

  it('不修改輸入陣列', () => {
    const deck = Array.from({ length: 3 }, () => card(7));
    const copy = [...deck];
    ensureDeckSize(deck);
    expect(deck).toEqual(copy);
  });
});
