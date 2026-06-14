/**
 * 防重放單元測試（M06 DoD）：
 * nonce 首見/重放、seq 嚴格遞增/倒退/重複、使用者隔離。
 * fake redis 以 JS 重現 SET NX EX 與 SEQ_GUARD_LUA 的語義
 * （Lua 本體與真 Redis 的整合驗證屬 M27 攻擊演練範圍）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { NONCE_TTL_SECONDS, createReplayGuard } from '../../src/security/nonce.js';

// ═════════════════ fake redis（重現 nonce.ts 用到的命令語義） ═════════════════

function createFakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  const fake = {
    // SET key value EX ttl [NX]
    async set(
      key: string,
      value: string,
      _ex?: string,
      ttl?: number,
      nx?: string,
    ): Promise<'OK' | null> {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, { value, ttl: ttl ?? -1 });
      return 'OK';
    },
    // SEQ_GUARD_LUA 等義：GET 現值（缺省 -1）→ 候選嚴格大於才 SET 並回 1
    async eval(
      _script: string,
      _numKeys: number,
      key: string,
      candidateArg: string,
      ttlArg: string,
    ): Promise<number> {
      const current = Number(store.get(key)?.value ?? '-1');
      const candidate = Number(candidateArg);
      if (Number.isNaN(candidate)) return 0;
      if (candidate > current) {
        store.set(key, { value: candidateArg, ttl: Number(ttlArg) });
        return 1;
      }
      return 0;
    },
    async del(...keys: string[]): Promise<number> {
      let n = 0;
      for (const key of keys) {
        if (store.delete(key)) n += 1;
      }
      return n;
    },
  };
  return { redis: fake as unknown as Redis, store };
}

// ═════════════════ nonce ═════════════════

describe('checkNonce', () => {
  let guard: ReturnType<typeof createReplayGuard>;
  let store: Map<string, { value: string; ttl: number }>;

  beforeEach(() => {
    const fake = createFakeRedis();
    guard = createReplayGuard(fake.redis);
    store = fake.store;
  });

  it('首見 nonce 接受並設 10 秒 TTL', async () => {
    expect(await guard.checkNonce('user_1', 'nonce-aaa')).toBe(true);
    expect(store.get('nonce:user_1:nonce-aaa')?.ttl).toBe(NONCE_TTL_SECONDS);
  });

  it('同一 nonce 重放被拒（SET NX 失敗）', async () => {
    await guard.checkNonce('user_1', 'nonce-aaa');
    expect(await guard.checkNonce('user_1', 'nonce-aaa')).toBe(false);
  });

  it('不同 nonce 各自接受', async () => {
    expect(await guard.checkNonce('user_1', 'nonce-aaa')).toBe(true);
    expect(await guard.checkNonce('user_1', 'nonce-bbb')).toBe(true);
  });

  it('nonce 以使用者隔離：A 用過的 nonce 不影響 B', async () => {
    await guard.checkNonce('user_a', 'shared-nonce');
    expect(await guard.checkNonce('user_b', 'shared-nonce')).toBe(true);
  });
});

// ═════════════════ seq ═════════════════

describe('checkSeq', () => {
  let guard: ReturnType<typeof createReplayGuard>;

  beforeEach(() => {
    guard = createReplayGuard(createFakeRedis().redis);
  });

  it('嚴格遞增接受：0 → 1 → 2', async () => {
    expect(await guard.checkSeq('user_1', 0)).toBe(true);
    expect(await guard.checkSeq('user_1', 1)).toBe(true);
    expect(await guard.checkSeq('user_1', 2)).toBe(true);
  });

  it('重複 seq 拒絕（重放）', async () => {
    await guard.checkSeq('user_1', 5);
    expect(await guard.checkSeq('user_1', 5)).toBe(false);
  });

  it('倒退 seq 拒絕（舊封包）', async () => {
    await guard.checkSeq('user_1', 10);
    expect(await guard.checkSeq('user_1', 3)).toBe(false);
  });

  it('跳號允許（只要求嚴格遞增，不要求連續）', async () => {
    await guard.checkSeq('user_1', 1);
    expect(await guard.checkSeq('user_1', 100)).toBe(true);
  });

  it('被拒的 seq 不影響現值：拒絕後仍以最高值為準', async () => {
    await guard.checkSeq('user_1', 10);
    await guard.checkSeq('user_1', 3); // 拒絕，不覆寫
    expect(await guard.checkSeq('user_1', 10)).toBe(false); // 仍須 > 10
    expect(await guard.checkSeq('user_1', 11)).toBe(true);
  });

  it('seq 以使用者隔離', async () => {
    await guard.checkSeq('user_a', 100);
    expect(await guard.checkSeq('user_b', 1)).toBe(true);
  });

  it('resetSeq 後可從頭計數', async () => {
    await guard.checkSeq('user_1', 50);
    await guard.resetSeq('user_1');
    expect(await guard.checkSeq('user_1', 1)).toBe(true);
  });
});
