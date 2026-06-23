/**
 * 射龍門 RTP Monte Carlo 模擬（仿 slot M26 RTP 驗證精神，CI 友善的縮小版迭代數）。
 *
 * 驗證 TIER_3 與 TIER_11 兩種賠率模式都收斂到 config/constants.ts 設定的目標 RTP
 * （92% ± 容忍區間）。容忍區間故意放寬（±4pp）以避免 CI 偶發抽樣誤差造成 flaky test；
 * 真正精細的校準（逼近個別 gap 機率）屬離線一次性分析，不在這支快速回歸測試的範圍。
 */
import { describe, expect, it } from 'vitest';
import { DRAGON_GATE_TARGET_RTP } from '../../src/config/constants.js';
import { drawValidDoors, getMultiplier, resolveOutcome, settle } from '../../src/modules/dragon-gate/payout.js';
import type { DragonGateOddsMode } from '../../src/config/constants.js';

const ITERATIONS = 300_000;
const RTP_TOLERANCE = 0.04; // ±4 個百分點
const BET = 100;

function simulateRtp(mode: DragonGateOddsMode, iterations: number): number {
  let totalWagered = 0;
  let totalReturned = 0;

  for (let i = 0; i < iterations; i += 1) {
    const { doors, gap, remainingDeck } = drawValidDoors();
    const multiplier = getMultiplier(gap, mode);
    const thirdCard = remainingDeck[0];
    if (thirdCard === undefined) throw new Error('remainingDeck 不應為空');
    const outcome = resolveOutcome(doors, thirdCard);
    const result = settle(BET, outcome, multiplier);

    totalWagered += BET;
    // 玩家總回收 = 中獎入帳 +（若未踩柱）保住的本金 0（本金已算進 payout 裡）
    // 踩柱多輸一注：等同從「回收」中再扣一個 BET（用負回收表示）
    totalReturned += result.payout - result.extraLoss;
  }

  return totalReturned / totalWagered;
}

describe('射龍門 RTP Monte Carlo', () => {
  it(
    `TIER_11 模式：${ITERATIONS} 局模擬 RTP 落在 ${DRAGON_GATE_TARGET_RTP * 100}% ± ${RTP_TOLERANCE * 100}pp`,
    () => {
      const rtp = simulateRtp('TIER_11', ITERATIONS);
      expect(rtp).toBeGreaterThan(DRAGON_GATE_TARGET_RTP - RTP_TOLERANCE);
      expect(rtp).toBeLessThan(DRAGON_GATE_TARGET_RTP + RTP_TOLERANCE);
    },
    30_000,
  );

  it(
    `TIER_3 模式：${ITERATIONS} 局模擬 RTP 落在 ${DRAGON_GATE_TARGET_RTP * 100}% ± ${RTP_TOLERANCE * 100}pp`,
    () => {
      const rtp = simulateRtp('TIER_3', ITERATIONS);
      expect(rtp).toBeGreaterThan(DRAGON_GATE_TARGET_RTP - RTP_TOLERANCE);
      expect(rtp).toBeLessThan(DRAGON_GATE_TARGET_RTP + RTP_TOLERANCE);
    },
    30_000,
  );
});
