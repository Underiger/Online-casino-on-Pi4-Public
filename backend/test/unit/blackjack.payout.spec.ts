import { describe, expect, it } from 'vitest';
import {
  cardBjValue,
  dealerShouldHit,
  handValue,
  isBlackjack,
  isBust,
  resolveDealerTurn,
  settle,
} from '../../src/modules/blackjack/payout.js';
import type { Card } from '../../src/shared/cards.js';

function card(rank: Card['rank'], suit: Card['suit'] = 'SPADE'): Card {
  return { rank, suit };
}

describe('cardBjValue', () => {
  it('A 算 11（軟硬調整在 handValue 做）', () => {
    expect(cardBjValue(card(14))).toBe(11);
  });
  it('J/Q/K 都算 10', () => {
    expect(cardBjValue(card(11))).toBe(10);
    expect(cardBjValue(card(12))).toBe(10);
    expect(cardBjValue(card(13))).toBe(10);
  });
  it('數字牌算面值', () => {
    expect(cardBjValue(card(7))).toBe(7);
  });
});

describe('handValue', () => {
  it('A+K = 21（軟手牌）', () => {
    const [total, soft] = handValue([card(14), card(13)]);
    expect(total).toBe(21);
    expect(soft).toBe(true);
  });

  it('A+A+9 = 21（一張 A 降為 1：11+1+9）', () => {
    const [total, soft] = handValue([card(14), card(14), card(9)]);
    expect(total).toBe(21);
    expect(soft).toBe(true); // 還有一張 A 仍以 11 計
  });

  it('A+8+5 = 14（A 從 11 降為 1：1+8+5），非軟手牌', () => {
    const [total, soft] = handValue([card(14), card(8), card(5)]);
    expect(total).toBe(14);
    expect(soft).toBe(false);
  });

  it('10+9+5 = 24（爆牌，不調整非 A 牌）', () => {
    const [total] = handValue([card(10), card(9), card(5)]);
    expect(total).toBe(24);
  });

  it('硬手牌（無 A）正常加總', () => {
    const [total, soft] = handValue([card(10), card(6)]);
    expect(total).toBe(16);
    expect(soft).toBe(false);
  });
});

describe('isBlackjack', () => {
  it('恰好兩張且 21 點 → true', () => {
    expect(isBlackjack([card(14), card(13)])).toBe(true);
  });
  it('三張湊 21 點不算天生 BJ', () => {
    expect(isBlackjack([card(7), card(7), card(7)])).toBe(false);
  });
  it('兩張但不是 21 點 → false', () => {
    expect(isBlackjack([card(10), card(9)])).toBe(false);
  });
});

describe('isBust', () => {
  it('> 21 → true', () => {
    expect(isBust([card(10), card(9), card(5)])).toBe(true);
  });
  it('= 21 → false', () => {
    expect(isBust([card(10), card(11)])).toBe(false);
  });
  it('有 A 時降軟手牌避免誤判爆牌', () => {
    expect(isBust([card(14), card(9), card(5)])).toBe(false); // 11→1+9+5=15
  });
});

describe('dealerShouldHit（S17，常數開關預設）', () => {
  it('< 17 一律補牌', () => {
    expect(dealerShouldHit([card(10), card(6)])).toBe(true); // 16
  });
  it('硬 17 停牌', () => {
    expect(dealerShouldHit([card(10), card(7)])).toBe(false);
  });
  it('軟 17（A+6）S17 規則下也停牌', () => {
    expect(dealerShouldHit([card(14), card(6)])).toBe(false);
  });
  it('>= 18 停牌', () => {
    expect(dealerShouldHit([card(10), card(9)])).toBe(false);
  });
});

describe('resolveDealerTurn', () => {
  it('補牌到 dealerShouldHit 回 false 為止，回傳更新後的牌堆', () => {
    const dealer = [card(10), card(2)]; // 12，必須補
    const deck = [card(5), card(9)]; // 補到 17 就停（10+2+5=17）
    const result = resolveDealerTurn(dealer, deck);

    expect(handValue(result.dealerCards)[0]).toBe(17);
    expect(result.dealerCards).toHaveLength(3);
    expect(result.deck).toEqual([card(9)]); // 只消耗了一張
  });

  it('莊家已 >= 17 時完全不補牌', () => {
    const dealer = [card(10), card(9)];
    const deck = [card(2)];
    const result = resolveDealerTurn(dealer, deck);
    expect(result.dealerCards).toEqual(dealer);
    expect(result.deck).toEqual(deck);
  });
});

describe('settle', () => {
  const BET = 100;

  it('雙方都天生 BJ → push，退回原注', () => {
    const r = settle([card(14), card(13)], [card(14), card(12)], BET);
    expect(r.resultKey).toBe('PUSH');
    expect(r.payoutTotal).toBe(100);
  });

  it('只有玩家天生 BJ → 賠 3:2（100 贏 150，共拿回 250）', () => {
    const r = settle([card(14), card(13)], [card(10), card(9)], BET);
    expect(r.resultKey).toBe('BLACKJACK');
    expect(r.payoutTotal).toBe(250);
  });

  it('只有莊家天生 BJ → 玩家輸（即使玩家點數也很高）', () => {
    const r = settle([card(10), card(9)], [card(14), card(13)], BET);
    expect(r.resultKey).toBe('LOSE');
    expect(r.payoutTotal).toBe(0);
  });

  it('玩家爆牌 → BUST，輸光（不看莊家牌）', () => {
    const r = settle([card(10), card(9), card(5)], [card(10), card(2)], BET);
    expect(r.resultKey).toBe('BUST');
    expect(r.payoutTotal).toBe(0);
  });

  it('莊家爆牌（玩家未爆）→ DEALER_BUST，玩家贏 1:1（拿回 200）', () => {
    const r = settle([card(10), card(8)], [card(10), card(9), card(5)], BET);
    expect(r.resultKey).toBe('DEALER_BUST');
    expect(r.payoutTotal).toBe(200);
  });

  it('點數比較：玩家較高 → WIN', () => {
    const r = settle([card(10), card(9)], [card(10), card(7)], BET);
    expect(r.resultKey).toBe('WIN');
    expect(r.payoutTotal).toBe(200);
  });

  it('點數比較：莊家較高 → LOSE', () => {
    const r = settle([card(10), card(7)], [card(10), card(9)], BET);
    expect(r.resultKey).toBe('LOSE');
    expect(r.payoutTotal).toBe(0);
  });

  it('點數相同（皆非天生 BJ）→ PUSH，退回原注', () => {
    const r = settle([card(10), card(8)], [card(9), card(9)], BET);
    expect(r.resultKey).toBe('PUSH');
    expect(r.payoutTotal).toBe(100);
  });

  it('加倍後的注額直接代入 bet 參數計算（settle 本身不知道有沒有加倍）', () => {
    const r = settle([card(10), card(9)], [card(10), card(7)], BET * 2);
    expect(r.payoutTotal).toBe(400); // 200 注額 WIN 1:1 → 400
  });
});
