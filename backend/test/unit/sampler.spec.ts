/**
 * sampler 單元測試（M10 DoD：二分查找正確性、邊界值、條件切換、rng 注入）。
 *
 * 決定性測試以注入 rng 驗證精確行為；最後一組以真 rngInt 做分布冒煙
 * （寬鬆斷言，不做嚴格統計檢定——CSPRNG 統計性質由 node:crypto 保證）。
 */
import { describe, expect, it } from 'vitest';
import {
  binarySearchCum,
  resolveThirdReelTable,
  sampleReel,
  sampleSpin,
  type RngFn,
} from '../../src/modules/slot/sampler.js';
import { compileLoadout } from '../../src/modules/slot/loadout-compiler.js';
import { SLOT_SYMBOLS } from '../../src/config/constants.js';
import type {
  CompiledLoadout,
  ReelTable,
  SlotSymbol,
} from '../../src/modules/slot/slot.types.js';

// ─────────────────────────── 工具 ───────────────────────────

/** 依序回傳預設值的決定性 rng；耗盡即拋錯 */
function seqRng(values: number[]): RngFn {
  let i = 0;
  return (max: number) => {
    const v = values[i];
    i += 1;
    if (v === undefined) throw new Error('seqRng 值耗盡');
    if (v >= max) throw new Error(`seqRng 測試配置錯誤：${v} >= ${max}`);
    return v;
  };
}

/** 手工迷你 loadout：三軸同表 [LUCKY7 w1 | CHERRY w1]，變體第三軸全 DIAMOND */
function miniLoadout(): CompiledLoadout {
  const table: ReelTable = { cum: [1, 2], symbols: ['LUCKY7', 'CHERRY'] };
  return {
    loadoutHash: 'x'.repeat(64),
    reels: [structuredClone(table), structuredClone(table), structuredClone(table)],
    variants: {
      TEST_CHAIN: {
        trigger: { reel12: 'LUCKY7' },
        reelIndex: 2,
        table: { cum: [1], symbols: ['DIAMOND'] },
      },
    },
    rules: { wildSubstitute: false, pityThreshold: null, pityMultiplier: 1, bonuses: [] },
    version: 1,
  };
}

// ═════════════════ binarySearchCum ═════════════════

describe('binarySearchCum', () => {
  it('對 cum [3,5,6] 全點位窮舉：0–2→0、3–4→1、5→2', () => {
    const cum = [3, 5, 6];
    const expected = [0, 0, 0, 1, 1, 2];
    for (let point = 0; point < 6; point += 1) {
      expect(binarySearchCum(cum, point)).toBe(expected[point]);
    }
  });

  it('單元素 cum：任何合法點位 → index 0', () => {
    expect(binarySearchCum([7], 0)).toBe(0);
    expect(binarySearchCum([7], 6)).toBe(0);
  });

  it('長陣列窮舉與線性掃描結果一致', () => {
    const cum: number[] = [];
    let running = 0;
    for (let i = 0; i < 50; i += 1) {
      running += (i % 7) + 1;
      cum.push(running);
    }
    for (let point = 0; point < running; point += 1) {
      const linear = cum.findIndex((c) => c > point);
      expect(binarySearchCum(cum, point)).toBe(linear);
    }
  });
});

// ═════════════════ sampleReel ═════════════════

describe('sampleReel', () => {
  const table: ReelTable = { cum: [3, 5, 6], symbols: ['CHERRY', 'LEMON', 'BELL'] };

  it('以 totalWeight 呼叫 rng，依點位映射符號（全點位窮舉）', () => {
    const calls: number[] = [];
    const expected: SlotSymbol[] = ['CHERRY', 'CHERRY', 'CHERRY', 'LEMON', 'LEMON', 'BELL'];
    for (let point = 0; point < 6; point += 1) {
      const rng: RngFn = (max) => {
        calls.push(max);
        return point;
      };
      expect(sampleReel(table, rng)).toBe(expected[point]);
    }
    expect(calls).toEqual([6, 6, 6, 6, 6, 6]);
  });

  it('邊界：總權重 1 的單符號表，point 0 → 該符號', () => {
    const single: ReelTable = { cum: [1], symbols: ['WILD'] };
    expect(sampleReel(single, seqRng([0]))).toBe('WILD');
  });

  it('rng 回傳超界或非整數 → 拋錯（防呆）', () => {
    expect(() => sampleReel(table, () => 6)).toThrow(/超出/);
    expect(() => sampleReel(table, () => -1)).toThrow(/超出/);
    expect(() => sampleReel(table, () => 1.5)).toThrow(/超出/);
  });

  it('空表 / 總權重非正 → 拋錯（CompiledLoadout 損毀防護）', () => {
    expect(() => sampleReel({ cum: [], symbols: [] }, seqRng([0]))).toThrow(/總權重/);
    expect(() => sampleReel({ cum: [0], symbols: ['CHERRY'] }, seqRng([0]))).toThrow(/總權重/);
  });

  it('cum 與 symbols 長度不一致 → 拋錯', () => {
    expect(() => sampleReel({ cum: [1, 2], symbols: ['CHERRY'] }, seqRng([1]))).toThrow(
      /長度不一致/,
    );
  });
});

// ═════════════════ 條件切換 ═════════════════

describe('resolveThirdReelTable / sampleSpin 條件切換', () => {
  it('前兩軸命中 trigger → 使用 variant 表', () => {
    const loadout = miniLoadout();
    const table = resolveThirdReelTable(loadout, 'LUCKY7', 'LUCKY7');
    expect(table.symbols).toEqual(['DIAMOND']);
  });

  it('前兩軸不同或未命中 → 基礎第三軸表', () => {
    const loadout = miniLoadout();
    expect(resolveThirdReelTable(loadout, 'LUCKY7', 'CHERRY')).toBe(loadout.reels[2]);
    expect(resolveThirdReelTable(loadout, 'CHERRY', 'CHERRY')).toBe(loadout.reels[2]);
  });

  it('reelIndex ≠ 2 的 variant 不參與第三軸解析', () => {
    const loadout = miniLoadout();
    loadout.variants['TEST_CHAIN']!.reelIndex = 1;
    expect(resolveThirdReelTable(loadout, 'LUCKY7', 'LUCKY7')).toBe(loadout.reels[2]);
  });

  it('sampleSpin：[LUCKY7, LUCKY7] → 第三軸走 variant（全 DIAMOND）', () => {
    const loadout = miniLoadout();
    // 軸1 point 0 → LUCKY7；軸2 point 0 → LUCKY7；variant 表總權重 1 → point 0 → DIAMOND
    expect(sampleSpin(loadout, seqRng([0, 0, 0]))).toEqual(['LUCKY7', 'LUCKY7', 'DIAMOND']);
  });

  it('sampleSpin：前兩軸未命中 → 第三軸走基礎表', () => {
    const loadout = miniLoadout();
    // 軸1 → LUCKY7；軸2 point 1 → CHERRY；基礎表 point 1 → CHERRY
    expect(sampleSpin(loadout, seqRng([0, 1, 1]))).toEqual(['LUCKY7', 'CHERRY', 'CHERRY']);
  });

  it('sampleSpin：variantReelOverride 直接覆寫第三軸表', () => {
    const loadout = miniLoadout();
    const override: ReelTable = { cum: [1], symbols: ['BAR'] };
    // 前兩軸即使命中 trigger，override 優先
    expect(sampleSpin(loadout, seqRng([0, 0, 0]), override)).toEqual(['LUCKY7', 'LUCKY7', 'BAR']);
  });
});

// ═════════════════ 與 compiler 串接 + 真 rngInt 分布冒煙 ═════════════════

describe('真實 rngInt 分布冒煙（與 compileLoadout 串接）', () => {
  it('20,000 次抽樣：全部符號出現，CHERRY 為最高頻（權重 57%）', () => {
    const loadout = compileLoadout({ userId: 'u', charms: [], luckySymbol: null });
    const counts = new Map<SlotSymbol, number>();
    for (let i = 0; i < 20_000; i += 1) {
      const s = sampleReel(loadout.reels[0]);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    for (const symbol of SLOT_SYMBOLS) {
      expect(counts.get(symbol) ?? 0).toBeGreaterThan(0);
    }
    const cherry = counts.get('CHERRY') ?? 0;
    for (const symbol of SLOT_SYMBOLS) {
      if (symbol === 'CHERRY') continue;
      expect(cherry).toBeGreaterThan(counts.get(symbol) ?? 0);
    }
    // 寬鬆頻率帶：57% ± 10pp（20k 樣本下 >20σ，永不誤報）
    expect(cherry / 20_000).toBeGreaterThan(0.47);
    expect(cherry / 20_000).toBeLessThan(0.67);
  });

  it('sampleSpin 回傳三元素 tuple，皆為合法符號', () => {
    const loadout = compileLoadout({ userId: 'u', charms: [], luckySymbol: null });
    const reels = sampleSpin(loadout);
    expect(reels).toHaveLength(3);
    for (const s of reels) {
      expect(SLOT_SYMBOLS).toContain(s);
    }
  });
});
