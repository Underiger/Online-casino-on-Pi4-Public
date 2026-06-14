/**
 * Loadout 編譯器（01_GDD §3.3.2、04_FOLDER_STRUCTURE §1 slot/loadout-compiler.ts）。
 *
 * 護符 + 今日幸運符號 → CompiledLoadout。純函式、冪等：
 * 同輸入必得同 loadoutHash 與同數值（Redis miss 重編譯安全）。
 *
 * 編譯管線（GDD §3.3.2 步驟 2）：
 *   基礎表（constants.ts，每軸獨立）
 *     × 所有 WEIGHT 型護符乘數（多枚同符號疊乘）
 *     × 今日幸運符號 ×1.5（全軸）
 *   = 最終浮點權重 → 以 WEIGHT_PRECISION 取整 → cum 累積陣列
 *   另對每枚 CONDITIONAL 護符：以「最終表」為底再施變體乘數，編譯 variant 表。
 *
 * 防呆：effect JSON 以 zod 逐型別解析，格式不符的護符直接跳過（不拋錯）——
 * 旋轉路徑的快取 miss 重編譯不可因單枚髒資料癱瘓；M13 裝備 API 會在入口先驗證。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  LUCKY_SYMBOL_WEIGHT_MULTIPLIER,
  SLOT_BASE_WEIGHTS,
  SLOT_REEL_COUNT,
  SLOT_SYMBOLS,
  WEIGHT_PRECISION,
  WEIGHT_TABLE_VERSION,
  type SlotSymbol,
} from '../../config/constants.js';
import type {
  CompiledBonus,
  CompiledLoadout,
  CompiledVariant,
  CompiledRules,
  EquippedCharm,
  ReelTable,
  ReelTables,
} from './slot.types.js';

// ─────────────────────────── effect schemas（對齊 prisma/seed.ts） ───────────────────────────

const symbolSchema = z.enum(SLOT_SYMBOLS);

/** WEIGHT：{ symbol, reels: [1,2,3], multiplier } */
const weightEffectSchema = z.object({
  symbol: symbolSchema,
  reels: z.array(z.number().int().min(1).max(SLOT_REEL_COUNT)).min(1),
  multiplier: z.number().positive(),
});

/** RULE：{ wildSubstitute: true } */
const ruleEffectSchema = z.object({
  wildSubstitute: z.boolean(),
});

/** CONDITIONAL：{ trigger: { reel12 }, variant: { reel, symbol, multiplier } } */
const conditionalEffectSchema = z.object({
  trigger: z.object({ reel12: symbolSchema }),
  variant: z.object({
    reel: z.number().int().min(1).max(SLOT_REEL_COUNT),
    symbol: symbolSchema,
    multiplier: z.number().positive(),
  }),
});

/** PITY：{ threshold, bonus }（bonus 0.5 = 中獎倍率 +50%） */
const pityEffectSchema = z.object({
  threshold: z.number().int().positive(),
  bonus: z.number().positive(),
});

/** BONUS：{ onSymbol, jackpotPoints } */
const bonusEffectSchema = z.object({
  onSymbol: symbolSchema,
  jackpotPoints: z.number().int().positive(),
});

// ─────────────────────────── 內部：浮點權重 → ReelTable ───────────────────────────

type FloatWeights = Record<SlotSymbol, number>;

function cloneBaseWeights(reelIndex: number): FloatWeights {
  const base = SLOT_BASE_WEIGHTS[reelIndex];
  if (base === undefined) {
    throw new Error(`SLOT_BASE_WEIGHTS 缺少第 ${reelIndex + 1} 軸（constants.ts 配置錯誤）`);
  }
  return { ...base };
}

/**
 * 浮點權重 → 整數 cum 表。
 * 取整以 WEIGHT_PRECISION 放大（×1.3 等乘數不失真）；
 * 原權重 > 0 但取整為 0 時保底 1（護符不可能把符號「乘到消失」）。
 */
export function toReelTable(weights: Readonly<FloatWeights>): ReelTable {
  const cum: number[] = [];
  const symbols: SlotSymbol[] = [];
  let running = 0;
  for (const symbol of SLOT_SYMBOLS) {
    const w = weights[symbol];
    if (w <= 0) continue; // 權重 0 的符號不進表（防呆；基礎表不會出現）
    const scaled = Math.max(1, Math.round(w * WEIGHT_PRECISION));
    running += scaled;
    cum.push(running);
    symbols.push(symbol);
  }
  if (running <= 0) {
    throw new Error('權重表總和必須為正（constants.ts 配置錯誤）');
  }
  return { cum, symbols };
}

// ─────────────────────────── loadoutHash ───────────────────────────

/**
 * sha256(userId | 排序後護符 codes | luckySymbol | 表版本) → hex。
 * 護符順序無關（排序）；數值調參 bump 版本即自然換 hash。
 */
export function computeLoadoutHash(
  userId: string,
  charmCodes: readonly string[],
  luckySymbol: SlotSymbol | null,
  version: number = WEIGHT_TABLE_VERSION,
): string {
  const canonical = [
    userId,
    [...charmCodes].sort().join(','),
    luckySymbol ?? '-',
    `v${version}`,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

// ─────────────────────────── 編譯主流程 ───────────────────────────

export interface CompileLoadoutInput {
  userId: string;
  /** 已裝備護符（順序無關；effect 為 DB Json 原樣） */
  charms: readonly EquippedCharm[];
  /** 今日幸運符號（null = 未設定） */
  luckySymbol: SlotSymbol | null;
}

export function compileLoadout(input: CompileLoadoutInput): CompiledLoadout {
  // ── 1. 三軸浮點權重：基礎表深拷貝 ──
  const floatReels: FloatWeights[] = [];
  for (let i = 0; i < SLOT_REEL_COUNT; i += 1) {
    floatReels.push(cloneBaseWeights(i));
  }

  // ── 2. WEIGHT 護符：目標符號 × 乘數（多枚疊乘） ──
  for (const charm of input.charms) {
    if (charm.type !== 'WEIGHT') continue;
    const parsed = weightEffectSchema.safeParse(charm.effect);
    if (!parsed.success) continue; // 髒資料跳過（檔頭說明）
    for (const reelNo of parsed.data.reels) {
      const reel = floatReels[reelNo - 1];
      if (reel === undefined) continue;
      reel[parsed.data.symbol] *= parsed.data.multiplier;
    }
  }

  // ── 3. 今日幸運符號：全軸權重 ×1.5（GDD §3.3.2 步驟 2） ──
  if (input.luckySymbol !== null) {
    for (const reel of floatReels) {
      reel[input.luckySymbol] *= LUCKY_SYMBOL_WEIGHT_MULTIPLIER;
    }
  }

  // ── 4. CONDITIONAL 護符：以最終表為底編譯 variant ──
  const variants: Record<string, CompiledVariant> = {};
  for (const charm of input.charms) {
    if (charm.type !== 'CONDITIONAL') continue;
    const parsed = conditionalEffectSchema.safeParse(charm.effect);
    if (!parsed.success) continue;
    const { trigger, variant } = parsed.data;
    const baseReel = floatReels[variant.reel - 1];
    if (baseReel === undefined) continue;
    const variantWeights: FloatWeights = { ...baseReel };
    variantWeights[variant.symbol] *= variant.multiplier;
    variants[charm.code] = {
      trigger: { reel12: trigger.reel12 },
      reelIndex: variant.reel - 1,
      table: toReelTable(variantWeights),
    };
  }

  // ── 5. RULE / PITY / BONUS → rules 物件 ──
  let wildSubstitute = false;
  let pityThreshold: number | null = null;
  let pityBonus = 0;
  const bonuses: CompiledBonus[] = [];

  for (const charm of input.charms) {
    switch (charm.type) {
      case 'RULE': {
        const parsed = ruleEffectSchema.safeParse(charm.effect);
        if (parsed.success && parsed.data.wildSubstitute) wildSubstitute = true;
        break;
      }
      case 'PITY': {
        const parsed = pityEffectSchema.safeParse(charm.effect);
        if (!parsed.success) break;
        // 多枚 PITY：取最低門檻、最高加成（對玩家最有利的組合，不疊加）
        pityThreshold =
          pityThreshold === null
            ? parsed.data.threshold
            : Math.min(pityThreshold, parsed.data.threshold);
        pityBonus = Math.max(pityBonus, parsed.data.bonus);
        break;
      }
      case 'BONUS': {
        const parsed = bonusEffectSchema.safeParse(charm.effect);
        if (!parsed.success) break;
        bonuses.push({ onSymbol: parsed.data.onSymbol, jackpotPoints: parsed.data.jackpotPoints });
        break;
      }
      default:
        break; // WEIGHT / CONDITIONAL 已於上方處理
    }
  }

  const rules: CompiledRules = {
    wildSubstitute,
    pityThreshold,
    pityMultiplier: pityThreshold === null ? 1 : 1 + pityBonus,
    bonuses,
  };

  // ── 6. 整數化 + 組裝 ──
  const reelTables = floatReels.map((w) => toReelTable(w));
  const reels: ReelTables = [
    reelTables[0] as ReelTable,
    reelTables[1] as ReelTable,
    reelTables[2] as ReelTable,
  ];

  return {
    loadoutHash: computeLoadoutHash(
      input.userId,
      input.charms.map((c) => c.code),
      input.luckySymbol,
    ),
    reels,
    variants,
    rules,
    version: WEIGHT_TABLE_VERSION,
  };
}
