/**
 * LUCK 護符 RTP Monte Carlo（仿 dragon-gate.rtp-monte-carlo.spec.ts 模式，
 * CI 友善的縮小版迭代數）。
 *
 * 背景：LUCK 護符取代了舊版 WEIGHT 乘數機制（CLOVER_BOOST_30 等 5 顆）——
 * 乘數會稀釋櫻桃權重，三連又是 p³ 關係，乘數一拉高裝備時 RTP 就崩盤
 * （離線分析：luck=1 顆鎖軸即可讓 RTP 從 91.5% 崩到 15~26%，詳見對應 PR 說明）。
 * 改成「機率鎖第3軸＝目標符號，但自然結果已是任意三連就不覆寫」之後，
 * 此機制只會把原本會摃龜的轉動轉成可能中獎，理論上 RTP 必然 ≥ baseline。
 *
 * 這支測試只守住「機制沒有跑壞」的回歸防線（例如不小心把 skip-if-natural-triple
 * 邏輯改掉、或 luck 數值打錯造成暴衝）；實際 luck 點數的數值校準屬離線一次性分析。
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { compileLoadout } from '../../src/modules/slot/loadout-compiler.js';
import { sampleSpin } from '../../src/modules/slot/sampler.js';
import { settlePayout } from '../../src/modules/slot/payout.js';
import type { EquippedCharm } from '../../src/modules/slot/slot.types.js';

const ITERATIONS = 300_000;
const BET = 100;

function simulateRtp(charms: EquippedCharm[], iterations: number): number {
  const loadout = compileLoadout({ userId: 'mc-user', charms, luckySymbol: null });
  let totalWagered = 0;
  let totalReturned = 0;
  let pityCounter = 0;
  for (let i = 0; i < iterations; i += 1) {
    const reels = sampleSpin(loadout);
    const result = settlePayout({
      reels,
      betAmount: BET,
      rules: loadout.rules,
      pityCounter,
      luckySymbol: null,
    });
    totalWagered += BET;
    totalReturned += result.winAmount;
    pityCounter = result.pityCounterAfter;
  }
  return totalReturned / totalWagered;
}

/** seed.ts 對齊的 5 顆 LUCK 護符（測試本地副本） */
const LUCK_CHARMS: ReadonlyArray<{ name: string; charm: EquippedCharm }> = [
  { name: 'CLOVER_BOOST_30', charm: { code: 'CLOVER_BOOST_30', type: 'LUCK', effect: { symbol: 'CLOVER', luck: 30 } } },
  { name: 'BELL_TUNER_30', charm: { code: 'BELL_TUNER_30', type: 'LUCK', effect: { symbol: 'BELL', luck: 80 } } },
  { name: 'BAR_MAGNET_35', charm: { code: 'BAR_MAGNET_35', type: 'LUCK', effect: { symbol: 'BAR', luck: 65 } } },
  { name: 'SEVEN_CALLER_25', charm: { code: 'SEVEN_CALLER_25', type: 'LUCK', effect: { symbol: 'LUCKY7', luck: 30 } } },
  { name: 'DIAMOND_DUST_20', charm: { code: 'DIAMOND_DUST_20', type: 'LUCK', effect: { symbol: 'DIAMOND', luck: 20 } } },
];

describe('LUCK 護符 RTP Monte Carlo', () => {
  let baselineRtp = 0;

  beforeAll(() => {
    baselineRtp = simulateRtp([], ITERATIONS);
  });

  it('baseline（無護符）RTP 落在 GDD 目標 92% 附近（90%~93%）', () => {
    expect(baselineRtp).toBeGreaterThan(0.9);
    expect(baselineRtp).toBeLessThan(0.93);
  });

  for (const { name, charm } of LUCK_CHARMS) {
    it(
      `${name} 單獨裝備：RTP ≥ baseline（不犧牲既有中獎）且漲幅 < 10 點（沒有暴衝）`,
      () => {
        const rtp = simulateRtp([charm], ITERATIONS);
        expect(rtp).toBeGreaterThanOrEqual(baselineRtp - 0.01); // 容忍 MC 抽樣誤差
        expect(rtp).toBeLessThan(baselineRtp + 0.1);
      },
      30_000,
    );
  }
});
