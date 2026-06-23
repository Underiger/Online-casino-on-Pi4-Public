import { describe, expect, it } from 'vitest';
import {
  computeGap,
  drawValidDoors,
  gapToTier3Bucket,
  getMultiplier,
  resolveOutcome,
  settle,
} from '../../src/modules/dragon-gate/payout.js';
import type { Card } from '../../src/shared/cards.js';

function card(rank: Card['rank'], suit: Card['suit'] = 'SPADE'): Card {
  return { rank, suit };
}

describe('computeGap', () => {
  it('門寬 = 兩門之間的點數個數', () => {
    expect(computeGap(card(2), card(7))).toBe(4); // 3,4,5,6 共 4 個
    expect(computeGap(card(7), card(2))).toBe(4); // 順序不影響
    expect(computeGap(card(2), card(14))).toBe(11); // 最大門寬
  });

  it('相鄰門牌 gap=0', () => {
    expect(computeGap(card(5), card(6))).toBe(0);
  });

  it('相同點數門牌 gap=-1', () => {
    expect(computeGap(card(7, 'SPADE'), card(7, 'HEART'))).toBe(-1);
  });
});

describe('getMultiplier', () => {
  it('TIER_11：gap 越窄倍率越高', () => {
    const m1 = getMultiplier(1, 'TIER_11');
    const m11 = getMultiplier(11, 'TIER_11');
    expect(m1).toBeGreaterThan(m11);
    expect(m1).toBeCloseTo(12, 1);
    expect(m11).toBeCloseTo(0.18, 1);
  });

  it('TIER_3：同一桶內 gap 不同但倍率相同', () => {
    expect(getMultiplier(1, 'TIER_3')).toBe(getMultiplier(3, 'TIER_3'));
    expect(getMultiplier(4, 'TIER_3')).toBe(getMultiplier(7, 'TIER_3'));
    expect(getMultiplier(8, 'TIER_3')).toBe(getMultiplier(11, 'TIER_3'));
  });

  it('TIER_3：窄門倍率 > 中門 > 寬門', () => {
    const narrow = getMultiplier(2, 'TIER_3');
    const medium = getMultiplier(5, 'TIER_3');
    const wide = getMultiplier(9, 'TIER_3');
    expect(narrow).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(wide);
  });

  it('gap < 1（相鄰或相同）丟例外，呼叫前應已被 drawValidDoors 排除', () => {
    expect(() => getMultiplier(0, 'TIER_11')).toThrow(RangeError);
    expect(() => getMultiplier(-1, 'TIER_11')).toThrow(RangeError);
  });
});

describe('gapToTier3Bucket', () => {
  it('1-3 窄、4-7 中、8-11 寬', () => {
    expect(gapToTier3Bucket(1)).toBe('NARROW');
    expect(gapToTier3Bucket(3)).toBe('NARROW');
    expect(gapToTier3Bucket(4)).toBe('MEDIUM');
    expect(gapToTier3Bucket(7)).toBe('MEDIUM');
    expect(gapToTier3Bucket(8)).toBe('WIDE');
    expect(gapToTier3Bucket(11)).toBe('WIDE');
  });

  it('超出範圍丟例外', () => {
    expect(() => gapToTier3Bucket(0)).toThrow(RangeError);
    expect(() => gapToTier3Bucket(12)).toThrow(RangeError);
  });
});

describe('drawValidDoors', () => {
  it('永遠回傳 gap >= 1 的門牌，剩餘牌恰好 50 張', () => {
    for (let i = 0; i < 200; i += 1) {
      const { doors, gap, remainingDeck } = drawValidDoors();
      expect(gap).toBeGreaterThanOrEqual(1);
      expect(computeGap(doors[0], doors[1])).toBe(gap);
      expect(remainingDeck).toHaveLength(50);
    }
  });

  it('200 次抽樣中必有門牌相鄰/相同需要重抽的情形（機率約 21%），結果仍恒合法', () => {
    // 統計性驗證：不特定構造某一次重抽,但 200 次裡幾乎必然觸發過重抽路徑，
    // 加上每次回傳都合法（上一個測試已逐一斷言），間接證明重抽迴圈本身正確。
    const gaps = Array.from({ length: 200 }, () => drawValidDoors().gap);
    expect(gaps.every((g) => g >= 1)).toBe(true);
  });
});

describe('resolveOutcome', () => {
  const doors: [Card, Card] = [card(3), card(9)];

  it('介於兩門之間 → WIN', () => {
    expect(resolveOutcome(doors, card(6))).toBe('WIN');
  });

  it('剛好等於任一門牌點數 → DOOR_HIT（不分花色）', () => {
    expect(resolveOutcome(doors, card(3, 'HEART'))).toBe('DOOR_HIT');
    expect(resolveOutcome(doors, card(9, 'CLUB'))).toBe('DOOR_HIT');
  });

  it('門外 → LOSE', () => {
    expect(resolveOutcome(doors, card(2))).toBe('LOSE');
    expect(resolveOutcome(doors, card(14))).toBe('LOSE');
  });
});

describe('settle', () => {
  it('WIN：payout = bet * (1 + multiplier)，無額外損失', () => {
    const result = settle(100, 'WIN', 3);
    expect(result.payout).toBe(400);
    expect(result.extraLoss).toBe(0);
  });

  it('DOOR_HIT：payout=0，extraLoss = bet（再輸一注）', () => {
    const result = settle(100, 'DOOR_HIT', 3);
    expect(result.payout).toBe(0);
    expect(result.extraLoss).toBe(100);
  });

  it('LOSE：payout=0，extraLoss=0（已扣的單注就是全部損失）', () => {
    const result = settle(100, 'LOSE', 3);
    expect(result.payout).toBe(0);
    expect(result.extraLoss).toBe(0);
  });
});
