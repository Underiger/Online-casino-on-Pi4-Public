/**
 * 射龍門純邏輯（不碰 Prisma/Redis，可單元測試 + Monte Carlo RTP 模擬直測）。
 * 賠率公式與兩種精細度的推導見 config/constants.ts 射龍門章節的註解。
 */
import {
  DRAGON_GATE_ODDS_TIER_3,
  DRAGON_GATE_ODDS_TIER_11,
  DRAGON_GATE_TIER_3_BUCKETS,
  type DragonGateOddsMode,
  type DragonGateTier3Bucket,
} from '../../config/constants.js';
import { freshShuffledDeck, type Card, type RngFn } from '../../shared/cards.js';
import { rngInt } from '../../security/csprng.js';
import type { DragonGateOutcome, SettleResult } from './dragon-gate.types.js';

/** 兩張門牌的「門寬」：介於兩門之間、不含門牌本身的點數個數。0=相鄰、負數=同點，皆需重開門 */
export function computeGap(doorA: Card, doorB: Card): number {
  return Math.abs(doorA.rank - doorB.rank) - 1;
}

export function gapToTier3Bucket(gap: number): DragonGateTier3Bucket {
  const found = DRAGON_GATE_TIER_3_BUCKETS.find((b) => gap >= b.minGap && gap <= b.maxGap);
  if (found === undefined) {
    throw new RangeError(`gap=${gap} 超出有效範圍（應為 1~11）`);
  }
  return found.bucket;
}

/** 依目前開關（TIER_11 / TIER_3）取得本局倍率；gap 必須 >= 1（呼叫前應已排除重開門情形） */
export function getMultiplier(gap: number, mode: DragonGateOddsMode): number {
  if (gap < 1) {
    throw new RangeError(`gap=${gap} 不應進入下注流程（相鄰或相同門牌應已重開門）`);
  }
  if (mode === 'TIER_11') {
    const m = DRAGON_GATE_ODDS_TIER_11[gap];
    if (m === undefined) throw new RangeError(`TIER_11 缺少 gap=${gap} 的賠率`);
    return m;
  }
  return DRAGON_GATE_ODDS_TIER_3[gapToTier3Bucket(gap)];
}

export interface ValidDoors {
  doors: [Card, Card];
  gap: number;
  /** 抽掉門牌後剩餘的 50 張牌（同一副新洗的牌，非跨嘗試累積消耗——見下方說明） */
  remainingDeck: Card[];
}

/**
 * 開出一組有效門牌（gap >= 1）。相鄰或相同點數（gap <= 0）視為無效，直接整副重新洗牌
 * 重抽——而不是從同一副牌接著抽兩張替補，這樣不管重試幾次，「成功那次」剩餘的牌永遠
 * 是「一副新牌減門牌 2 張＝50 張」，賠率公式（P(介於)=gap*4/50）才精確成立。
 */
export function drawValidDoors(rng: RngFn = rngInt, numDecks = 1): ValidDoors {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const deck = freshShuffledDeck(numDecks, rng);
    const doorA = deck[0] as Card;
    const doorB = deck[1] as Card;
    const gap = computeGap(doorA, doorB);
    if (gap >= 1) {
      return { doors: [doorA, doorB], gap, remainingDeck: deck.slice(2) };
    }
  }
  // 機率上幾乎不可能發生（單次有效率 ~78.7%），保底避免無限迴圈卡死請求
  throw new Error('射龍門開門重試次數過多，請重新嘗試');
}

/** 第三張牌相對兩門的結果：WIN=介於兩門之間；DOOR_HIT=剛好等於某張門牌點數；LOSE=門外 */
export function resolveOutcome(doors: [Card, Card], thirdCard: Card): DragonGateOutcome {
  const [doorA, doorB] = doors;
  const low = Math.min(doorA.rank, doorB.rank);
  const high = Math.max(doorA.rank, doorB.rank);
  if (thirdCard.rank === doorA.rank || thirdCard.rank === doorB.rank) return 'DOOR_HIT';
  if (thirdCard.rank > low && thirdCard.rank < high) return 'WIN';
  return 'LOSE';
}

/**
 * 結算金額：
 *   WIN      → payout = bet * (1 + multiplier)（含本金），extraLoss = 0
 *   DOOR_HIT → payout = 0，extraLoss = bet（再輸一注，service 層嘗試再扣一次）
 *   LOSE     → payout = 0，extraLoss = 0（已扣的單注就是全部損失）
 */
export function settle(betAmount: number, outcome: DragonGateOutcome, multiplier: number): SettleResult {
  if (outcome === 'WIN') {
    return { outcome, payout: Math.round(betAmount * (1 + multiplier)), extraLoss: 0 };
  }
  if (outcome === 'DOOR_HIT') {
    return { outcome, payout: 0, extraLoss: betAmount };
  }
  return { outcome, payout: 0, extraLoss: 0 };
}
