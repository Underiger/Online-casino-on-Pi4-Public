/**
 * 令牌桶單元測試（M06 DoD）：
 * 突發允許、超限拒絕、時間補充恢復、容量封頂、retryAfter 估算、時鐘回撥。
 * consumeToken 為 TOKEN_BUCKET_LUA 的同義 TS 實作——
 * 純函式直接覆蓋演算法正確性（Lua 與真 Redis 的整合驗證屬 M26 壓測範圍）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE,
  consumeToken,
  type BucketState,
} from '../../src/plugins/rate-limit.js';

const RULE = { capacity: 5, refillPerSec: 2 };
const T0 = 1_765_500_000_000;

/** 連續取 n 次令牌（同一時刻），回傳每次結果 */
function drain(n: number, nowMs: number) {
  const results: boolean[] = [];
  let state: BucketState | null = null;
  for (let i = 0; i < n; i += 1) {
    const r = consumeToken(state, RULE, nowMs);
    results.push(r.allowed);
    state = r.state;
  }
  return { results, state };
}

describe('consumeToken（令牌桶）', () => {
  it('新桶滿載：容量內突發全數允許，第 capacity+1 次拒絕', () => {
    const { results } = drain(RULE.capacity + 1, T0);
    expect(results.slice(0, RULE.capacity)).toEqual(Array(RULE.capacity).fill(true));
    expect(results[RULE.capacity]).toBe(false);
  });

  it('拒絕時 retryAfterMs > 0 且估算合理（缺 1 枚、速率 2/s → 500ms）', () => {
    const { state } = drain(RULE.capacity, T0); // 桶空
    const rejected = consumeToken(state, RULE, T0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(500);
  });

  it('時間經過按速率補充：空桶 1 秒後可再取 2 枚', () => {
    let { state } = drain(RULE.capacity, T0); // 桶空
    const r1 = consumeToken(state, RULE, T0 + 1_000);
    expect(r1.allowed).toBe(true);
    state = r1.state;
    const r2 = consumeToken(state, RULE, T0 + 1_000);
    expect(r2.allowed).toBe(true);
    state = r2.state;
    expect(consumeToken(state, RULE, T0 + 1_000).allowed).toBe(false);
  });

  it('補充封頂於 capacity：閒置再久也不超發', () => {
    const { state } = drain(1, T0); // 用掉 1 枚
    // 閒置 1 小時 → 補滿至 capacity（而非 capacity + 7200）
    const refilled = consumeToken(state, RULE, T0 + 3_600_000);
    expect(refilled.allowed).toBe(true);
    expect(refilled.state.tokens).toBe(RULE.capacity - 1);
  });

  it('時鐘回撥視為 0 經過時間，不倒扣令牌', () => {
    const { state } = drain(2, T0);
    const before = state!.tokens;
    const r = consumeToken(state, RULE, T0 - 5_000); // now 早於 updatedAt
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBe(before - 1); // 僅扣本次 cost，無負補充
  });

  it('預設規則與 Nginx 對齊：10 req/s、burst 20', () => {
    expect(DEFAULT_RULE).toEqual({ capacity: 20, refillPerSec: 10 });
    let state: BucketState | null = null;
    for (let i = 0; i < 20; i += 1) {
      const r = consumeToken(state, DEFAULT_RULE, T0);
      expect(r.allowed).toBe(true);
      state = r.state;
    }
    expect(consumeToken(state, DEFAULT_RULE, T0).allowed).toBe(false);
  });

  it('穩態速率成立：空桶後每 500ms 恰好補 1 枚（2/s）', () => {
    let state: BucketState | null = drain(RULE.capacity, T0).state; // 桶空
    for (let i = 1; i <= 3; i += 1) {
      const r = consumeToken(state, RULE, T0 + i * 500);
      expect(r.allowed).toBe(true);
      state = r.state;
    }
    expect(consumeToken(state, RULE, T0 + 3 * 500).allowed).toBe(false);
  });
});
