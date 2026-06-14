/**
 * HMAC 簽章單元測試（M06 DoD）：
 * canonical 組裝、簽章往返、欄位竄改偵測、常數時間比較邊界、
 * 金鑰存放器生命週期（issue/rotate 寬限/revoke）——以 in-memory fake redis 驗證。
 */
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  HMAC_KEY_BYTES,
  HMAC_PREV_KEY_GRACE_SECONDS,
  buildCanonical,
  createHmacKeyStore,
  generateHmacKey,
  safeEqualHex,
  signCanonical,
  verifySignature,
} from '../../src/security/hmac.js';

// ═════════════════ 純函式 ═════════════════

describe('generateHmacKey', () => {
  it('為 base64url 編碼的 32 位元組且每次唯一', () => {
    const a = generateHmacKey();
    const b = generateHmacKey();
    expect(Buffer.from(a, 'base64url')).toHaveLength(HMAC_KEY_BYTES);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url 字元集
    expect(a).not.toBe(b);
  });
});

describe('buildCanonical', () => {
  it('依凍結格式 userId|gameType|betAmount|nonce|timestamp 組裝', () => {
    expect(
      buildCanonical({
        userId: 'user_1',
        gameType: 'SLOT',
        betAmount: 100,
        nonce: 'n-123',
        timestamp: 1765500000000,
      }),
    ).toBe('user_1|SLOT|100|n-123|1765500000000');
  });
});

describe('signCanonical / verifySignature', () => {
  const key = generateHmacKey();
  const parts = {
    userId: 'user_1',
    gameType: 'SLOT',
    betAmount: 50,
    nonce: 'aaaa-bbbb',
    timestamp: 1765500000000,
  };

  it('簽章為 64 hex 字元且可往返驗證', () => {
    const canonical = buildCanonical(parts);
    const sig = signCanonical(key, canonical);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature([key], canonical, sig)).toBe(true);
  });

  it('canonical 任一欄位被竄改即驗證失敗（完整性綁定）', () => {
    const sig = signCanonical(key, buildCanonical(parts));
    const tampered = [
      { ...parts, userId: 'user_2' },        // 換人
      { ...parts, gameType: 'ROULETTE' },    // 換遊戲
      { ...parts, betAmount: 5000 },         // 改注額
      { ...parts, nonce: 'cccc-dddd' },      // 換 nonce
      { ...parts, timestamp: 1765500000001 } // 改時間戳
    ];
    for (const t of tampered) {
      expect(verifySignature([key], buildCanonical(t), sig)).toBe(false);
    }
  });

  it('錯誤金鑰驗證失敗；prev 金鑰（輪換寬限）可通過', () => {
    const canonical = buildCanonical(parts);
    const sig = signCanonical(key, canonical);
    const otherKey = generateHmacKey();
    expect(verifySignature([otherKey], canonical, sig)).toBe(false);
    // current 已輪換為 otherKey，但 prev 仍為 key → 在途請求通過
    expect(verifySignature([otherKey, key], canonical, sig)).toBe(true);
  });
});

describe('safeEqualHex 邊界', () => {
  it('長度不同 / 空字串 / 非 hex 一律 false', () => {
    expect(safeEqualHex('aabb', 'aabbcc')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('zzzz', 'zzzz')).toBe(false); // 非 hex（Buffer.from 截斷）
    expect(safeEqualHex('aazz', 'aabb')).toBe(false);
  });

  it('相同 hex 為 true、不同為 false', () => {
    expect(safeEqualHex('deadbeef', 'deadbeef')).toBe(true);
    expect(safeEqualHex('deadbeef', 'deadbeee')).toBe(false);
  });
});

// ═════════════════ 金鑰存放器（fake redis） ═════════════════

function createFakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  const fake = {
    async get(key: string): Promise<string | null> {
      return store.get(key)?.value ?? null;
    },
    async set(key: string, value: string, _ex?: string, ttl?: number): Promise<'OK'> {
      store.set(key, { value, ttl: ttl ?? -1 });
      return 'OK';
    },
    async del(...keys: string[]): Promise<number> {
      let n = 0;
      for (const key of keys) {
        if (store.delete(key)) n += 1;
      }
      return n;
    },
    async mget(...keys: string[]): Promise<Array<string | null>> {
      return keys.map((key) => store.get(key)?.value ?? null);
    },
  };
  return { redis: fake as unknown as Redis, store };
}

describe('createHmacKeyStore', () => {
  const TTL = 7 * 86_400;

  it('首次 rotate 即發新金鑰，TTL 為 7 天，無 prev', async () => {
    const { redis, store } = createFakeRedis();
    const keyStore = createHmacKeyStore(redis, { ttlSeconds: TTL });

    const key = await keyStore.rotate('user_1');
    expect(Buffer.from(key, 'base64url')).toHaveLength(HMAC_KEY_BYTES);
    expect(store.get('hmac:user_1')?.ttl).toBe(TTL);
    expect(store.has('hmac:user_1:prev')).toBe(false);

    expect(await keyStore.getActiveKeys('user_1')).toEqual([key]);
  });

  it('再次 rotate：舊金鑰移至 prev（30s 寬限），getActiveKeys 回兩把', async () => {
    const { redis, store } = createFakeRedis();
    const keyStore = createHmacKeyStore(redis, { ttlSeconds: TTL });

    const first = await keyStore.rotate('user_1');
    const second = await keyStore.rotate('user_1');
    expect(second).not.toBe(first);
    expect(store.get('hmac:user_1:prev')?.ttl).toBe(HMAC_PREV_KEY_GRACE_SECONDS);

    expect(await keyStore.getActiveKeys('user_1')).toEqual([second, first]);
  });

  it('revoke 同時清除 current 與 prev', async () => {
    const { redis } = createFakeRedis();
    const keyStore = createHmacKeyStore(redis, { ttlSeconds: TTL });

    await keyStore.rotate('user_1');
    await keyStore.rotate('user_1');
    await keyStore.revoke('user_1');
    expect(await keyStore.getActiveKeys('user_1')).toEqual([]);
  });

  it('損毀的 JSON 視同無金鑰（強制重新協商），不拋例外', async () => {
    const { redis, store } = createFakeRedis();
    const keyStore = createHmacKeyStore(redis, { ttlSeconds: TTL });

    store.set('hmac:user_1', { value: 'not-json{{{', ttl: TTL });
    expect(await keyStore.getActiveKeys('user_1')).toEqual([]);
  });

  it('使用者之間互不干擾', async () => {
    const { redis } = createFakeRedis();
    const keyStore = createHmacKeyStore(redis, { ttlSeconds: TTL });

    const keyA = await keyStore.rotate('user_a');
    const keyB = await keyStore.rotate('user_b');
    expect(await keyStore.getActiveKeys('user_a')).toEqual([keyA]);
    expect(await keyStore.getActiveKeys('user_b')).toEqual([keyB]);
  });
});
