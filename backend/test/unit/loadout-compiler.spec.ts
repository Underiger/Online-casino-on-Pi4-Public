/**
 * loadout-compiler 單元測試（M10 DoD：基礎編譯、權重修正、條件變體、hash 穩定性）。
 * 全部純函式，無 DB / Redis。
 */
import { describe, expect, it } from 'vitest';
import {
  compileLoadout,
  computeLoadoutHash,
  toReelTable,
} from '../../src/modules/slot/loadout-compiler.js';
import {
  SLOT_BASE_WEIGHTS,
  SLOT_SYMBOLS,
  WEIGHT_PRECISION,
  WEIGHT_TABLE_VERSION,
  type SlotSymbol,
} from '../../src/config/constants.js';
import type { EquippedCharm } from '../../src/modules/slot/slot.types.js';

// ─────────────────────────── 工具 ───────────────────────────

/** seed.ts 對齊的護符定義（測試本地副本） */
const CLOVER_BOOST: EquippedCharm = {
  code: 'CLOVER_BOOST_30',
  type: 'WEIGHT',
  effect: { symbol: 'CLOVER', reels: [1, 2, 3], multiplier: 1.3 },
};
const CHERRY_RAIN: EquippedCharm = {
  code: 'CHERRY_RAIN_40',
  type: 'WEIGHT',
  effect: { symbol: 'CHERRY', reels: [1, 2, 3], multiplier: 1.4 },
};
const WILD_UNLOCK: EquippedCharm = {
  code: 'WILD_UNLOCK',
  type: 'RULE',
  effect: { wildSubstitute: true },
};
const LUCKY7_CHAIN: EquippedCharm = {
  code: 'LUCKY7_CHAIN',
  type: 'CONDITIONAL',
  effect: {
    trigger: { reel12: 'LUCKY7' },
    variant: { reel: 3, symbol: 'LUCKY7', multiplier: 3 },
  },
};
const PITY_10: EquippedCharm = {
  code: 'PITY_CHARM_10',
  type: 'PITY',
  effect: { threshold: 10, bonus: 0.5 },
};
const PITY_7: EquippedCharm = {
  code: 'PITY_CHARM_7',
  type: 'PITY',
  effect: { threshold: 7, bonus: 0.5 },
};
const JACKPOT_MAGNET: EquippedCharm = {
  code: 'JACKPOT_MAGNET',
  type: 'BONUS',
  effect: { onSymbol: 'DIAMOND', jackpotPoints: 100 },
};

function compile(charms: EquippedCharm[] = [], luckySymbol: SlotSymbol | null = null) {
  return compileLoadout({ userId: 'user-1', charms, luckySymbol });
}

/** 從 ReelTable 還原某符號的整數權重（cum 差分） */
function weightOf(table: { cum: number[]; symbols: SlotSymbol[] }, symbol: SlotSymbol): number {
  const i = table.symbols.indexOf(symbol);
  if (i < 0) return 0;
  return (table.cum[i] ?? 0) - (i > 0 ? (table.cum[i - 1] ?? 0) : 0);
}

// ═════════════════ 基礎編譯 ═════════════════

describe('compileLoadout: 基礎編譯（無護符、無幸運符號）', () => {
  it('三軸 cum 為基礎權重 × 精度的嚴格遞增累積，symbols 依定義序', () => {
    const loadout = compile();
    expect(loadout.reels).toHaveLength(3);
    for (let r = 0; r < 3; r += 1) {
      const table = loadout.reels[r as 0 | 1 | 2];
      expect(table.symbols).toEqual([...SLOT_SYMBOLS]);
      let running = 0;
      for (let i = 0; i < SLOT_SYMBOLS.length; i += 1) {
        const symbol = SLOT_SYMBOLS[i] as SlotSymbol;
        const base = SLOT_BASE_WEIGHTS[r]?.[symbol] ?? 0;
        running += base * WEIGHT_PRECISION;
        expect(table.cum[i]).toBe(running);
      }
      // 嚴格遞增
      for (let i = 1; i < table.cum.length; i += 1) {
        expect(table.cum[i] ?? 0).toBeGreaterThan(table.cum[i - 1] ?? 0);
      }
    }
  });

  it('預設規則：wild 不可替代、無保底、無 bonus；version = 表版本', () => {
    const loadout = compile();
    expect(loadout.rules).toEqual({
      wildSubstitute: false,
      pityThreshold: null,
      pityMultiplier: 1,
      bonuses: [],
    });
    expect(loadout.variants).toEqual({});
    expect(loadout.version).toBe(WEIGHT_TABLE_VERSION);
  });

  it('產物可 JSON 序列化往返（Redis 快取前置條件）', () => {
    const loadout = compile([CLOVER_BOOST, WILD_UNLOCK, LUCKY7_CHAIN, PITY_10], 'CLOVER');
    expect(JSON.parse(JSON.stringify(loadout))).toEqual(loadout);
  });
});

// ═════════════════ WEIGHT 權重修正 ═════════════════

describe('compileLoadout: WEIGHT 護符', () => {
  it('CLOVER +30%：全軸 CLOVER 權重 ×1.3，其他符號不動', () => {
    const loadout = compile([CLOVER_BOOST]);
    for (const table of loadout.reels) {
      expect(weightOf(table, 'CLOVER')).toBe(Math.round(8 * 1.3 * WEIGHT_PRECISION));
      expect(weightOf(table, 'CHERRY')).toBe(57 * WEIGHT_PRECISION);
      expect(weightOf(table, 'WILD')).toBe(4 * WEIGHT_PRECISION);
    }
  });

  it('僅指定軸生效：reels [3] 只改第三軸', () => {
    const singleReel: EquippedCharm = {
      code: 'TEST_REEL3_ONLY',
      type: 'WEIGHT',
      effect: { symbol: 'BAR', reels: [3], multiplier: 2 },
    };
    const loadout = compile([singleReel]);
    expect(weightOf(loadout.reels[0], 'BAR')).toBe(6 * WEIGHT_PRECISION);
    expect(weightOf(loadout.reels[1], 'BAR')).toBe(6 * WEIGHT_PRECISION);
    expect(weightOf(loadout.reels[2], 'BAR')).toBe(12 * WEIGHT_PRECISION);
  });

  it('多枚同符號疊乘：×1.3 再 ×1.4 = ×1.82', () => {
    const second: EquippedCharm = {
      code: 'TEST_CLOVER_40',
      type: 'WEIGHT',
      effect: { symbol: 'CLOVER', reels: [1, 2, 3], multiplier: 1.4 },
    };
    const loadout = compile([CLOVER_BOOST, second]);
    expect(weightOf(loadout.reels[0], 'CLOVER')).toBe(
      Math.round(8 * 1.3 * 1.4 * WEIGHT_PRECISION),
    );
  });

  it('effect 格式錯誤的護符被跳過（不影響其他護符、不拋錯）', () => {
    const broken: EquippedCharm = {
      code: 'BROKEN',
      type: 'WEIGHT',
      effect: { symbol: 'NOT_A_SYMBOL', reels: [9], multiplier: -1 },
    };
    const loadout = compile([broken, CHERRY_RAIN]);
    expect(weightOf(loadout.reels[0], 'CHERRY')).toBe(Math.round(57 * 1.4 * WEIGHT_PRECISION));
    // 其餘符號維持基礎值
    expect(weightOf(loadout.reels[0], 'LEMON')).toBe(8 * WEIGHT_PRECISION);
  });
});

// ═════════════════ 幸運符號 ═════════════════

describe('compileLoadout: 今日幸運符號', () => {
  it('幸運符號全軸權重 ×1.5', () => {
    const loadout = compile([], 'CLOVER');
    for (const table of loadout.reels) {
      expect(weightOf(table, 'CLOVER')).toBe(Math.round(8 * 1.5 * WEIGHT_PRECISION));
    }
  });

  it('與 WEIGHT 護符疊乘：8 × 1.3 × 1.5 = 15.6', () => {
    const loadout = compile([CLOVER_BOOST], 'CLOVER');
    expect(weightOf(loadout.reels[0], 'CLOVER')).toBe(
      Math.round(8 * 1.3 * 1.5 * WEIGHT_PRECISION),
    );
  });
});

// ═════════════════ CONDITIONAL 變體 ═════════════════

describe('compileLoadout: CONDITIONAL 護符', () => {
  it('以護符 code 為 key，trigger / reelIndex / 變體表正確', () => {
    const loadout = compile([LUCKY7_CHAIN]);
    const variant = loadout.variants['LUCKY7_CHAIN'];
    expect(variant).toBeDefined();
    expect(variant?.trigger).toEqual({ reel12: 'LUCKY7' });
    expect(variant?.reelIndex).toBe(2);
    // 變體表：LUCKY7 ×3，其他符號與基礎第三軸相同
    expect(weightOf(variant!.table, 'LUCKY7')).toBe(Math.round(5 * 3 * WEIGHT_PRECISION));
    expect(weightOf(variant!.table, 'CHERRY')).toBe(57 * WEIGHT_PRECISION);
  });

  it('變體以「最終表」為底：WEIGHT 與幸運符號修正先生效，再施變體乘數', () => {
    const sevenBoost: EquippedCharm = {
      code: 'SEVEN_CALLER_25',
      type: 'WEIGHT',
      effect: { symbol: 'LUCKY7', reels: [1, 2, 3], multiplier: 1.25 },
    };
    const loadout = compile([sevenBoost, LUCKY7_CHAIN], 'LUCKY7');
    // 最終第三軸：5 × 1.25 × 1.5 = 9.375；變體再 ×3 = 28.125 → 2813（先 round 浮點 28.125×100）
    expect(weightOf(loadout.variants['LUCKY7_CHAIN']!.table, 'LUCKY7')).toBe(
      Math.round(5 * 1.25 * 1.5 * 3 * WEIGHT_PRECISION),
    );
    // 基礎第三軸不含變體乘數
    expect(weightOf(loadout.reels[2], 'LUCKY7')).toBe(
      Math.round(5 * 1.25 * 1.5 * WEIGHT_PRECISION),
    );
  });

  it('effect 格式錯誤的 CONDITIONAL 跳過、不產生 variant', () => {
    const broken: EquippedCharm = { code: 'BROKEN_COND', type: 'CONDITIONAL', effect: {} };
    const loadout = compile([broken]);
    expect(loadout.variants).toEqual({});
  });
});

// ═════════════════ RULE / PITY / BONUS 規則 ═════════════════

describe('compileLoadout: 規則類護符', () => {
  it('RULE：wildSubstitute 解鎖', () => {
    expect(compile([WILD_UNLOCK]).rules.wildSubstitute).toBe(true);
  });

  it('PITY 單枚：threshold 10、multiplier 1.5（= 1 + bonus 0.5）', () => {
    const rules = compile([PITY_10]).rules;
    expect(rules.pityThreshold).toBe(10);
    expect(rules.pityMultiplier).toBe(1.5);
  });

  it('PITY 多枚：取最低門檻、最高加成（不疊加）', () => {
    const rules = compile([PITY_10, PITY_7]).rules;
    expect(rules.pityThreshold).toBe(7);
    expect(rules.pityMultiplier).toBe(1.5);

    const strongBonus: EquippedCharm = {
      code: 'TEST_PITY_STRONG',
      type: 'PITY',
      effect: { threshold: 12, bonus: 0.8 },
    };
    const mixed = compile([PITY_7, strongBonus]).rules;
    expect(mixed.pityThreshold).toBe(7);
    expect(mixed.pityMultiplier).toBeCloseTo(1.8);
  });

  it('BONUS：寫入 bonuses 陣列（可多枚）', () => {
    const cloverBonus: EquippedCharm = {
      code: 'TEST_CLOVER_BONUS',
      type: 'BONUS',
      effect: { onSymbol: 'CLOVER', jackpotPoints: 20 },
    };
    const rules = compile([JACKPOT_MAGNET, cloverBonus]).rules;
    expect(rules.bonuses).toEqual([
      { onSymbol: 'DIAMOND', jackpotPoints: 100 },
      { onSymbol: 'CLOVER', jackpotPoints: 20 },
    ]);
  });

  it('RULE / PITY effect 格式錯誤 → 維持預設', () => {
    const badRule: EquippedCharm = { code: 'BAD_RULE', type: 'RULE', effect: 'nope' };
    const badPity: EquippedCharm = { code: 'BAD_PITY', type: 'PITY', effect: { threshold: -1 } };
    const rules = compile([badRule, badPity]).rules;
    expect(rules.wildSubstitute).toBe(false);
    expect(rules.pityThreshold).toBeNull();
    expect(rules.pityMultiplier).toBe(1);
  });
});

// ═════════════════ loadoutHash ═════════════════

describe('loadoutHash 穩定性', () => {
  it('同輸入 → 同 hash（冪等；Redis miss 重編譯安全）', () => {
    const a = compile([CLOVER_BOOST, WILD_UNLOCK], 'CLOVER');
    const b = compile([CLOVER_BOOST, WILD_UNLOCK], 'CLOVER');
    expect(a.loadoutHash).toBe(b.loadoutHash);
    expect(a).toEqual(b);
  });

  it('護符順序無關（排序後雜湊）', () => {
    const a = compile([CLOVER_BOOST, WILD_UNLOCK, PITY_10]);
    const b = compile([PITY_10, CLOVER_BOOST, WILD_UNLOCK]);
    expect(a.loadoutHash).toBe(b.loadoutHash);
  });

  it('userId / 護符組合 / 幸運符號 / 表版本 任一不同 → hash 不同', () => {
    const base = compileLoadout({ userId: 'u1', charms: [CLOVER_BOOST], luckySymbol: 'CLOVER' });
    expect(
      compileLoadout({ userId: 'u2', charms: [CLOVER_BOOST], luckySymbol: 'CLOVER' }).loadoutHash,
    ).not.toBe(base.loadoutHash);
    expect(
      compileLoadout({ userId: 'u1', charms: [], luckySymbol: 'CLOVER' }).loadoutHash,
    ).not.toBe(base.loadoutHash);
    expect(
      compileLoadout({ userId: 'u1', charms: [CLOVER_BOOST], luckySymbol: null }).loadoutHash,
    ).not.toBe(base.loadoutHash);
    expect(computeLoadoutHash('u1', ['CLOVER_BOOST_30'], 'CLOVER', WEIGHT_TABLE_VERSION + 1)).not.toBe(
      computeLoadoutHash('u1', ['CLOVER_BOOST_30'], 'CLOVER', WEIGHT_TABLE_VERSION),
    );
  });

  it('hash 為 64 字元 hex（sha256）', () => {
    expect(compile().loadoutHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ═════════════════ toReelTable 邊界 ═════════════════

describe('toReelTable 邊界', () => {
  const zeroWeights = Object.fromEntries(SLOT_SYMBOLS.map((s) => [s, 0])) as Record<
    SlotSymbol,
    number
  >;

  it('權重極小但 > 0 → 取整保底 1（符號不會被乘到消失）', () => {
    const table = toReelTable({ ...zeroWeights, CHERRY: 0.0001, LEMON: 5 });
    expect(weightOf(table, 'CHERRY')).toBe(1);
    expect(weightOf(table, 'LEMON')).toBe(5 * WEIGHT_PRECISION);
  });

  it('權重 0 的符號不進表', () => {
    const table = toReelTable({ ...zeroWeights, BELL: 3 });
    expect(table.symbols).toEqual(['BELL']);
    expect(table.cum).toEqual([3 * WEIGHT_PRECISION]);
  });

  it('全零權重 → 拋錯（配置錯誤 fail loud）', () => {
    expect(() => toReelTable(zeroWeights)).toThrow();
  });
});
