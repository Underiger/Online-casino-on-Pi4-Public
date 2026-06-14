/**
 * payout 單元測試（M10 DoD：符號組合、wild 替代、pity、幸運符號、二連、邊界）
 * + 基礎 RTP 小規模蒙地卡羅（05_MILESTONES §4 風險緩衝：M10 即先跑小規模模擬）。
 */
import { describe, expect, it } from 'vitest';
import { evaluateLine, settlePayout } from '../../src/modules/slot/payout.js';
import { compileLoadout } from '../../src/modules/slot/loadout-compiler.js';
import { sampleSpin } from '../../src/modules/slot/sampler.js';
import {
  JACKPOT_POINTS_DIAMOND_TRIPLE,
  SLOT_PAYTABLE,
  SLOT_SYMBOLS,
  type SlotSymbol,
} from '../../src/config/constants.js';
import type {
  CompiledRules,
  PayoutInput,
  SlotReels,
} from '../../src/modules/slot/slot.types.js';

// ─────────────────────────── 工具 ───────────────────────────

const BASE_RULES: CompiledRules = {
  wildSubstitute: false,
  pityThreshold: null,
  pityMultiplier: 1,
  bonuses: [],
};

function settle(overrides: Partial<PayoutInput> & { reels: SlotReels }) {
  return settlePayout({
    betAmount: 10,
    rules: BASE_RULES,
    pityCounter: 0,
    luckySymbol: null,
    ...overrides,
  });
}

const triple = (s: SlotSymbol): SlotReels => [s, s, s];

// ═════════════════ 三連與二連（賠率表全覆蓋） ═════════════════

describe('settlePayout: 賠率表', () => {
  it('全部 8 種符號三連 = 表定倍率 × 注額', () => {
    for (const symbol of SLOT_SYMBOLS) {
      const result = settle({ reels: triple(symbol), betAmount: 50 });
      expect(result.lineKind).toBe('TRIPLE');
      expect(result.effectiveSymbol).toBe(symbol);
      expect(result.baseMultiplier).toBe(SLOT_PAYTABLE[symbol].triple);
      expect(result.winAmount).toBe(50 * SLOT_PAYTABLE[symbol].triple);
      expect(result.wildUsed).toBe(false);
      expect(result.pityCounterAfter).toBe(0);
    }
  });

  it('CHERRY 二連（左起兩格）×1；第三格非 CHERRY', () => {
    const result = settle({ reels: ['CHERRY', 'CHERRY', 'LEMON'], betAmount: 100 });
    expect(result.lineKind).toBe('DOUBLE');
    expect(result.effectiveSymbol).toBe('CHERRY');
    expect(result.winAmount).toBe(100);
  });

  it('二連僅左起有效：[LEMON,CHERRY,CHERRY] / [CHERRY,LEMON,CHERRY] 不中', () => {
    for (const reels of [
      ['LEMON', 'CHERRY', 'CHERRY'],
      ['CHERRY', 'LEMON', 'CHERRY'],
    ] as SlotReels[]) {
      const result = settle({ reels });
      expect(result.lineKind).toBe('NONE');
      expect(result.winAmount).toBe(0);
      expect(result.pityCounterAfter).toBe(1);
    }
  });

  it('無二連賠付的符號左起兩連不中（如 LEMON）', () => {
    const result = settle({ reels: ['LEMON', 'LEMON', 'CHERRY'] });
    expect(result.lineKind).toBe('NONE');
    expect(result.winAmount).toBe(0);
  });

  it('完全不成線：三格各異', () => {
    const result = settle({ reels: ['BELL', 'BAR', 'CLOVER'], pityCounter: 4 });
    expect(result).toMatchObject({
      winAmount: 0,
      lineKind: 'NONE',
      effectiveSymbol: null,
      baseMultiplier: 0,
      luckyApplied: false,
      pityApplied: false,
      pityCounterAfter: 5,
      jackpotPointsEarned: 0,
    });
  });
});

// ═════════════════ Wild 替代 ═════════════════

describe('settlePayout: Wild 替代（RULE 護符）', () => {
  const wildRules: CompiledRules = { ...BASE_RULES, wildSubstitute: true };

  it('預設（無護符）Wild 不可替代：[LUCKY7,WILD,LUCKY7] 不中', () => {
    const result = settle({ reels: ['LUCKY7', 'WILD', 'LUCKY7'] });
    expect(result.lineKind).toBe('NONE');
  });

  it('解鎖後 [LUCKY7,WILD,LUCKY7] → LUCKY7 三連 ×40、標記 wildUsed', () => {
    const result = settle({ reels: ['LUCKY7', 'WILD', 'LUCKY7'], rules: wildRules });
    expect(result.lineKind).toBe('TRIPLE');
    expect(result.effectiveSymbol).toBe('LUCKY7');
    expect(result.winAmount).toBe(10 * 40);
    expect(result.wildUsed).toBe(true);
  });

  it('WILD 三連在兩種模式下都是自然三連 ×100（不靠替代）', () => {
    for (const rules of [BASE_RULES, wildRules]) {
      const result = settle({ reels: triple('WILD'), rules });
      expect(result.winAmount).toBe(10 * 100);
      expect(result.wildUsed).toBe(false);
    }
  });

  it('[WILD,WILD,CHERRY] 解鎖後 → CHERRY 三連（雙 Wild 替代）', () => {
    const result = settle({ reels: ['WILD', 'WILD', 'CHERRY'], rules: wildRules });
    expect(result.lineKind).toBe('TRIPLE');
    expect(result.effectiveSymbol).toBe('CHERRY');
    expect(result.winAmount).toBe(10 * 4);
  });

  it('[WILD,CHERRY,LEMON] 解鎖後 → CHERRY 二連 ×1（Wild 補位）', () => {
    const result = settle({ reels: ['WILD', 'CHERRY', 'LEMON'], rules: wildRules });
    expect(result.lineKind).toBe('DOUBLE');
    expect(result.effectiveSymbol).toBe('CHERRY');
    expect(result.winAmount).toBe(10);
    expect(result.wildUsed).toBe(true);
  });

  it('[CHERRY,CHERRY,WILD] 解鎖後 → 取較高賠的三連（×4 > 二連 ×1）', () => {
    const result = settle({ reels: ['CHERRY', 'CHERRY', 'WILD'], rules: wildRules });
    expect(result.lineKind).toBe('TRIPLE');
    expect(result.baseMultiplier).toBe(4);
  });

  it('evaluateLine：未解鎖時 [WILD,CHERRY,LEMON] 無任何連線', () => {
    expect(evaluateLine(['WILD', 'CHERRY', 'LEMON'], false)).toBeNull();
  });
});

// ═════════════════ 幸運符號 ═════════════════

describe('settlePayout: 今日幸運符號 ×1.5', () => {
  it('連線符號 = 幸運符號 → 賠率 ×1.5', () => {
    const result = settle({ reels: triple('CLOVER'), luckySymbol: 'CLOVER' });
    expect(result.luckyApplied).toBe(true);
    expect(result.winAmount).toBe(Math.floor(10 * 16 * 1.5)); // 240
  });

  it('連線符號 ≠ 幸運符號 → 無加成（即使幸運符號出現在盤面）', () => {
    // 盤面有 LEMON（幸運），但連線是 CHERRY 二連
    const result = settle({ reels: ['CHERRY', 'CHERRY', 'LEMON'], luckySymbol: 'LEMON' });
    expect(result.luckyApplied).toBe(false);
    expect(result.winAmount).toBe(10);
  });

  it('Wild 替代形成的幸運符號連線同樣享加成', () => {
    const result = settle({
      reels: ['WILD', 'CLOVER', 'CLOVER'],
      rules: { ...BASE_RULES, wildSubstitute: true },
      luckySymbol: 'CLOVER',
    });
    expect(result.luckyApplied).toBe(true);
    expect(result.winAmount).toBe(Math.floor(10 * 16 * 1.5));
  });

  it('未中獎時幸運符號無作用', () => {
    const result = settle({ reels: ['CLOVER', 'BELL', 'CLOVER'], luckySymbol: 'CLOVER' });
    expect(result.luckyApplied).toBe(false);
    expect(result.winAmount).toBe(0);
  });
});

// ═════════════════ 保底（PITY） ═════════════════

describe('settlePayout: 保底', () => {
  const pityRules: CompiledRules = { ...BASE_RULES, pityThreshold: 10, pityMultiplier: 1.5 };

  it('計數 < 門檻：中獎無加成，計數歸零', () => {
    const result = settle({ reels: triple('BELL'), rules: pityRules, pityCounter: 9 });
    expect(result.pityApplied).toBe(false);
    expect(result.winAmount).toBe(10 * 8);
    expect(result.pityCounterAfter).toBe(0);
  });

  it('計數 = 門檻且中獎：倍率 ×1.5、計數歸零', () => {
    const result = settle({ reels: triple('BELL'), rules: pityRules, pityCounter: 10 });
    expect(result.pityApplied).toBe(true);
    expect(result.winAmount).toBe(Math.floor(10 * 8 * 1.5)); // 120
    expect(result.pityCounterAfter).toBe(0);
  });

  it('計數 > 門檻但未中獎：加成持續武裝、計數續增', () => {
    const result = settle({ reels: ['BELL', 'BAR', 'CLOVER'], rules: pityRules, pityCounter: 15 });
    expect(result.pityApplied).toBe(false);
    expect(result.pityCounterAfter).toBe(16);
  });

  it('未裝備 PITY 護符（threshold null）：計數再高也無加成', () => {
    const result = settle({ reels: triple('BELL'), pityCounter: 100 });
    expect(result.pityApplied).toBe(false);
    expect(result.winAmount).toBe(80);
  });

  it('保底 + 幸運疊乘：10 × 4 × 1.5 × 1.5 = 90', () => {
    const result = settle({
      reels: triple('CHERRY'),
      rules: pityRules,
      pityCounter: 12,
      luckySymbol: 'CHERRY',
    });
    expect(result.pityApplied).toBe(true);
    expect(result.luckyApplied).toBe(true);
    expect(result.winAmount).toBe(90);
  });

  it('winAmount 向下取整：10 × 1（二連）× 1.25 = 12.5 → 12', () => {
    const result = settle({
      reels: ['CHERRY', 'CHERRY', 'LEMON'],
      rules: { ...BASE_RULES, pityThreshold: 5, pityMultiplier: 1.25 },
      pityCounter: 5,
    });
    expect(result.winAmount).toBe(12);
  });
});

// ═════════════════ Jackpot 點數 ═════════════════

describe('settlePayout: Jackpot 點數', () => {
  it('Diamond 三連 → 基礎 50 點', () => {
    const result = settle({ reels: triple('DIAMOND') });
    expect(result.jackpotPointsEarned).toBe(JACKPOT_POINTS_DIAMOND_TRIPLE);
  });

  it('BONUS 護符（獎池磁石）疊加：Diamond 三連 50 + 100 = 150', () => {
    const result = settle({
      reels: triple('DIAMOND'),
      rules: { ...BASE_RULES, bonuses: [{ onSymbol: 'DIAMOND', jackpotPoints: 100 }] },
    });
    expect(result.jackpotPointsEarned).toBe(150);
  });

  it('Wild 替代形成的 Diamond 三連同樣給點', () => {
    const result = settle({
      reels: ['WILD', 'DIAMOND', 'DIAMOND'],
      rules: {
        ...BASE_RULES,
        wildSubstitute: true,
        bonuses: [{ onSymbol: 'DIAMOND', jackpotPoints: 100 }],
      },
    });
    expect(result.jackpotPointsEarned).toBe(150);
  });

  it('BONUS onSymbol 未命中連線符號 → 不給點', () => {
    const result = settle({
      reels: triple('BELL'),
      rules: { ...BASE_RULES, bonuses: [{ onSymbol: 'DIAMOND', jackpotPoints: 100 }] },
    });
    expect(result.jackpotPointsEarned).toBe(0);
  });

  it('未中獎 → 0 點（即使盤面有 Diamond）', () => {
    const result = settle({ reels: ['DIAMOND', 'DIAMOND', 'CHERRY'] });
    expect(result.jackpotPointsEarned).toBe(0);
  });
});

// ═════════════════ 輸入驗證 ═════════════════

describe('settlePayout: 輸入驗證', () => {
  it('注額非正整數 → 拋錯', () => {
    for (const bad of [0, -10, 1.5, Number.NaN]) {
      expect(() => settle({ reels: triple('CHERRY'), betAmount: bad })).toThrow(/注額/);
    }
  });

  it('保底計數為負或非整數 → 拋錯', () => {
    for (const bad of [-1, 0.5]) {
      expect(() => settle({ reels: triple('CHERRY'), pityCounter: bad })).toThrow(/保底計數/);
    }
  });
});

// ═════════════════ RTP 小規模蒙地卡羅 ═════════════════

describe('RTP 小規模模擬（05_MILESTONES §4：M10 先跑，M26 一千萬次複核）', () => {
  it('基礎 Build（無護符、無幸運）100,000 次旋轉：RTP 落於 [0.82, 1.02]', () => {
    // 解析值 ≈ 0.915（config/constants.ts 檔頭計算）；
    // 100k 樣本下標準誤 ≈ 0.006，±0.10 容忍帶 >15σ，不會閃爍。
    const loadout = compileLoadout({ userId: 'rtp-sim', charms: [], luckySymbol: null });
    const bet = 10;
    let wagered = 0;
    let returned = 0;
    for (let i = 0; i < 100_000; i += 1) {
      const reels = sampleSpin(loadout);
      const result = settlePayout({
        reels,
        betAmount: bet,
        rules: loadout.rules,
        pityCounter: 0,
        luckySymbol: null,
      });
      wagered += bet;
      returned += result.winAmount;
    }
    const rtp = returned / wagered;
    expect(rtp).toBeGreaterThan(0.82);
    expect(rtp).toBeLessThan(1.02);
  });
});
