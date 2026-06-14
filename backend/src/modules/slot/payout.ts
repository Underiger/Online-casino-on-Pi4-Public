/**
 * 賠付結算（01_GDD §3.2 賠率表、04_FOLDER_STRUCTURE §1 slot/payout.ts）。純函式。
 *
 * 判定順序：
 *   1. 連線評估：列舉所有候選（自然三連 / Wild 替代三連 / 二連），取倍率最高者。
 *      - Wild 預設「不可」替代（GDD §3.2）：無 RULE 護符時 Wild 僅是普通高賠符號。
 *      - 二連僅左起兩格、且僅賠率表 double 非 null 的符號（初版只有 CHERRY）。
 *   2. 幸運符號：形成連線的「有效符號」＝今日幸運符號 → 賠率 ×1.5。
 *      （GDD §3.2「該符號賠率 ×1.5」——綁定連線符號，而非盤面任一格。）
 *   3. 保底（PITY 護符）：進場計數 ≥ 門檻且本次中獎 → 倍率 × pityMultiplier。
 *      計數器語義：中獎（任何贏分）→ 歸零；未中獎 → +1。
 *   4. Jackpot 點數：Diamond 三連 +50（GDD §3.2）＋ BONUS 護符（onSymbol 命中疊加）。
 *
 * winAmount = floor(注額 × 基礎倍率 × 幸運係數 × 保底係數)，整數 Coin。
 */
import {
  JACKPOT_POINTS_DIAMOND_TRIPLE,
  LUCKY_SYMBOL_PAYOUT_MULTIPLIER,
  SLOT_PAYTABLE,
} from '../../config/constants.js';
import type {
  CompiledRules,
  PayoutInput,
  PayoutResult,
  SlotReels,
  SlotSymbol,
} from './slot.types.js';

// ─────────────────────────── 連線評估 ───────────────────────────

interface LineWin {
  kind: 'TRIPLE' | 'DOUBLE';
  symbol: SlotSymbol;
  multiplier: number;
  wildUsed: boolean;
}

/**
 * 列舉所有可成立的連線並取倍率最高者；無連線回 null。
 * 同時涵蓋：自然三連（含 WILD×3）、Wild 替代三連、左起二連（含 Wild 替代）。
 */
export function evaluateLine(reels: SlotReels, wildSubstitute: boolean): LineWin | null {
  const candidates: LineWin[] = [];
  const [a, b, c] = reels;

  // ── 自然三連（含 WILD 三連——WILD 作為普通符號自我成線） ──
  if (a === b && b === c) {
    candidates.push({
      kind: 'TRIPLE',
      symbol: a,
      multiplier: SLOT_PAYTABLE[a].triple,
      wildUsed: false,
    });
  }

  // ── Wild 替代三連：非 Wild 符號全相同，且至少各有一枚 Wild / 非 Wild ──
  if (wildSubstitute) {
    const nonWild = reels.filter((s) => s !== 'WILD');
    const wildCount = reels.length - nonWild.length;
    const firstNonWild = nonWild[0];
    if (
      wildCount > 0 &&
      firstNonWild !== undefined &&
      nonWild.every((s) => s === firstNonWild)
    ) {
      candidates.push({
        kind: 'TRIPLE',
        symbol: firstNonWild,
        multiplier: SLOT_PAYTABLE[firstNonWild].triple,
        wildUsed: true,
      });
    }
  }

  // ── 左起二連：僅賠率表 double 非 null 的符號（初版 CHERRY） ──
  for (const [symbol, row] of Object.entries(SLOT_PAYTABLE) as Array<
    [SlotSymbol, (typeof SLOT_PAYTABLE)[SlotSymbol]]
  >) {
    if (row.double === null) continue;
    const matches = (s: SlotSymbol): boolean =>
      s === symbol || (wildSubstitute && s === 'WILD');
    // 至少一格是本尊（兩格全 Wild 不構成「該符號」二連——Wild 替代三連已涵蓋更高賠）
    if (matches(a) && matches(b) && (a === symbol || b === symbol)) {
      candidates.push({
        kind: 'DOUBLE',
        symbol,
        multiplier: row.double,
        wildUsed: a === 'WILD' || b === 'WILD',
      });
    }
  }

  if (candidates.length === 0) return null;
  // 取倍率最高；同倍率時偏好三連（排序穩定：先比倍率再比 kind）
  candidates.sort((x, y) =>
    y.multiplier !== x.multiplier
      ? y.multiplier - x.multiplier
      : (y.kind === 'TRIPLE' ? 1 : 0) - (x.kind === 'TRIPLE' ? 1 : 0),
  );
  return candidates[0] ?? null;
}

// ─────────────────────────── Jackpot 點數 ───────────────────────────

function jackpotPointsFor(win: LineWin, rules: CompiledRules): number {
  let points = 0;
  if (win.kind === 'TRIPLE' && win.symbol === 'DIAMOND') {
    points += JACKPOT_POINTS_DIAMOND_TRIPLE;
  }
  for (const bonus of rules.bonuses) {
    if (bonus.onSymbol === win.symbol) points += bonus.jackpotPoints;
  }
  return points;
}

// ─────────────────────────── 結算主函式 ───────────────────────────

export function settlePayout(input: PayoutInput): PayoutResult {
  if (!Number.isSafeInteger(input.betAmount) || input.betAmount <= 0) {
    throw new Error(`payout: 注額必須為正整數（收到 ${input.betAmount}）`);
  }
  if (!Number.isSafeInteger(input.pityCounter) || input.pityCounter < 0) {
    throw new Error(`payout: 保底計數必須為非負整數（收到 ${input.pityCounter}）`);
  }

  const win = evaluateLine(input.reels, input.rules.wildSubstitute);

  // ── 未中獎：計數 +1，無任何加成 ──
  if (win === null) {
    return {
      winAmount: 0,
      lineKind: 'NONE',
      effectiveSymbol: null,
      baseMultiplier: 0,
      wildUsed: false,
      luckyApplied: false,
      pityApplied: false,
      pityCounterAfter: input.pityCounter + 1,
      jackpotPointsEarned: 0,
    };
  }

  // ── 幸運符號：連線有效符號 = 今日幸運符號 → ×1.5 ──
  const luckyApplied = input.luckySymbol !== null && win.symbol === input.luckySymbol;
  const luckyFactor = luckyApplied ? LUCKY_SYMBOL_PAYOUT_MULTIPLIER : 1;

  // ── 保底：計數達門檻且本次中獎 → × pityMultiplier，計數歸零 ──
  const pityApplied =
    input.rules.pityThreshold !== null && input.pityCounter >= input.rules.pityThreshold;
  const pityFactor = pityApplied ? input.rules.pityMultiplier : 1;

  const winAmount = Math.floor(input.betAmount * win.multiplier * luckyFactor * pityFactor);

  return {
    winAmount,
    lineKind: win.kind,
    effectiveSymbol: win.symbol,
    baseMultiplier: win.multiplier,
    wildUsed: win.wildUsed,
    luckyApplied,
    pityApplied,
    pityCounterAfter: 0, // 中獎（任何贏分）即重置連續未中獎計數
    jackpotPointsEarned: jackpotPointsFor(win, input.rules),
  };
}
