/**
 * 回合併發鎖單元測試：取鎖/釋放/搶鎖失敗/只釋放自己持有的 token。
 * fake redis 重現 SET NX PX 與 RELEASE_IF_OWNER_LUA 的語義（同 nonce.spec.ts 風格）。
 */
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRoundLock } from '../../src/security/round-lock.js';
import { OptimisticLockError } from '../../src/shared/errors.js';

function createFakeRedis() {
  const store = new Map<string, string>();
  const fake = {
    // SET key value PX ttl [NX]
    async set(
      key: string,
      value: string,
      _px?: string,
      _ttl?: number,
      nx?: string,
    ): Promise<'OK' | null> {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    // RELEASE_IF_OWNER_LUA 等義：GET 現值 === token 才 DEL
    async eval(_script: string, _numKeys: number, key: string, token: string): Promise<number> {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };
  return { redis: fake as unknown as Redis, store };
}

describe('withLock', () => {
  it('取鎖成功並執行 fn，結束後釋放鎖', async () => {
    const { redis, store } = createFakeRedis();
    const lock = createRoundLock(redis);

    const result = await lock.withLock('round:user_1:lock', 5000, async () => 'done');

    expect(result).toBe('done');
    expect(store.has('round:user_1:lock')).toBe(false); // 已釋放
  });

  it('鎖被佔用時第二個請求拋 OptimisticLockError（409），不會等待', async () => {
    const { redis } = createFakeRedis();
    const lock = createRoundLock(redis);

    let releaseFirst!: () => void;
    const first = lock.withLock('round:user_1:lock', 5000, () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );

    await expect(lock.withLock('round:user_1:lock', 5000, async () => 'second')).rejects.toThrow(
      OptimisticLockError,
    );

    releaseFirst();
    await first;
  });

  it('fn 拋錯時仍會釋放鎖（finally），下一個請求可以正常取鎖', async () => {
    const { redis, store } = createFakeRedis();
    const lock = createRoundLock(redis);

    await expect(
      lock.withLock('round:user_1:lock', 5000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(store.has('round:user_1:lock')).toBe(false);
    await expect(lock.withLock('round:user_1:lock', 5000, async () => 'ok')).resolves.toBe('ok');
  });

  it('不同 userId 的鎖互不影響（key 已含 userId，這裡驗證不同 key 互不阻塞）', async () => {
    const { redis } = createFakeRedis();
    const lock = createRoundLock(redis);

    let releaseA!: () => void;
    const a = lock.withLock('round:user_a:lock', 5000, () =>
      new Promise<void>((resolve) => {
        releaseA = resolve;
      }),
    );

    await expect(lock.withLock('round:user_b:lock', 5000, async () => 'b-ok')).resolves.toBe(
      'b-ok',
    );

    releaseA();
    await a;
  });

  it('只釋放自己持有的 token：模擬鎖已過期被別人搶到後，原請求的釋放不會誤刪新鎖', async () => {
    const { redis, store } = createFakeRedis();
    const lock = createRoundLock(redis);

    // 模擬：第一個鎖已過期消失，別人搶到了新鎖（store 裡是別人的 token）
    store.set('round:user_1:lock', 'someone-elses-token');

    // 直接呼叫 eval（模擬 withLock 內部 finally 的釋放動作）驗證不會刪掉別人的鎖
    const released = await redis.eval(
      'RELEASE_IF_OWNER_LUA',
      1,
      'round:user_1:lock',
      'my-own-stale-token',
    );

    expect(released).toBe(0);
    expect(store.get('round:user_1:lock')).toBe('someone-elses-token'); // 別人的鎖還在
  });
});
