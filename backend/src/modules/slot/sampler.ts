/**
 * 轉軸抽樣（01_GDD §3.3.2 步驟 5/6、02_TDD §5.1、04_FOLDER_STRUCTURE §1 slot/sampler.ts）。
 *
 * 熱路徑零機率計算：每軸一次 rngInt(totalWeight) + cum 陣列二分查找（O(log n)）。
 * 條件切換（CONDITIONAL 護符）：第三軸抽樣前比對前兩軸結果，
 * 命中 trigger 即改用預編譯 variant 表——仍是查表，不重算權重。
 *
 * LUCK 護符覆寫（三軸都抽完之後才套用）：自然結果（含 CONDITIONAL 結果）已是
 * 任意三連則不覆寫；否則依 loadout.luckRules 順序滾 rng(100) < triggerPercent，
 * 第一個命中即鎖定第三軸＝該護符 symbol、不再滾後續規則。
 *
 * rng 參數可注入（預設 security/csprng 的 rngInt）：
 * 單元測試以決定性序列驗證查找、條件切換與 LUCK 覆寫，不靠統計斷言。
 */
import { rngInt } from '../../security/csprng.js';
import type { CompiledLoadout, ReelTable, SlotReels, SlotSymbol } from './slot.types.js';

/** rng 介面：回傳 [0, maxExclusive) 均勻整數 */
export type RngFn = (maxExclusive: number) => number;

/**
 * 二分查找：最小 index 使 cum[index] > point。
 * 前置條件：cum 嚴格遞增、point ∈ [0, cum 最末值)。
 */
export function binarySearchCum(cum: readonly number[], point: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // cum[mid] 不可能 undefined（mid < length）；?? Infinity 僅滿足 noUncheckedIndexedAccess
    if ((cum[mid] ?? Infinity) > point) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/** 單軸抽樣：rngInt(totalWeight) → 二分查找 → 符號 */
export function sampleReel(table: ReelTable, rng: RngFn = rngInt): SlotSymbol {
  const total = table.cum[table.cum.length - 1] ?? 0;
  if (total <= 0) {
    throw new Error('sampler: 轉軸表總權重必須為正（CompiledLoadout 損毀？）');
  }
  const point = rng(total);
  if (!Number.isInteger(point) || point < 0 || point >= total) {
    throw new Error(`sampler: rng 回傳值 ${point} 超出 [0, ${total}) 範圍`);
  }
  const index = binarySearchCum(table.cum, point);
  const symbol = table.symbols[index];
  if (symbol === undefined) {
    throw new Error('sampler: cum 與 symbols 長度不一致（CompiledLoadout 損毀？）');
  }
  return symbol;
}

/**
 * 依前兩軸結果解析第三軸應使用的表（GDD §3.3.2 步驟 6）。
 * 前兩軸同符號且命中某 CONDITIONAL variant 的 trigger → 該 variant 表；
 * 否則基礎第三軸表。多枚命中時取第一枚（定義序），初版護符池無此重疊。
 */
export function resolveThirdReelTable(
  loadout: CompiledLoadout,
  first: SlotSymbol,
  second: SlotSymbol,
): ReelTable {
  if (first === second) {
    for (const variant of Object.values(loadout.variants)) {
      if (variant.reelIndex === 2 && variant.trigger.reel12 === first) {
        return variant.table;
      }
    }
  }
  return loadout.reels[2];
}

/**
 * 完整一次旋轉：軸 1 → 軸 2 → （條件切換）→ 軸 3。
 * variantReelOverride：外部（M11 service）已自行解析變體表時可直接傳入，
 * 跳過內建的 resolveThirdReelTable。
 */
export function sampleSpin(
  loadout: CompiledLoadout,
  rng: RngFn = rngInt,
  variantReelOverride?: ReelTable,
): SlotReels {
  const first = sampleReel(loadout.reels[0], rng);
  const second = sampleReel(loadout.reels[1], rng);
  const thirdTable = variantReelOverride ?? resolveThirdReelTable(loadout, first, second);
  let third = sampleReel(thirdTable, rng);

  // LUCK 護符：自然結果（含 CONDITIONAL）已是任意三連就不滾，保留既有中獎；
  // 否則依序滾機率，第一個命中即鎖定第三軸、停止往下滾。
  if (!(first === second && second === third)) {
    for (const rule of loadout.luckRules) {
      if (rng(100) < rule.triggerPercent) {
        third = rule.symbol;
        break;
      }
    }
  }

  return [first, second, third];
}
