/**
 * anomaly.ts 單元測試（M24）。
 *
 * 以 in-memory fake redis 驅動所有三條規則，驗證：
 *   1. BET_RATE：同一秒視窗第 3 筆起標記
 *   2. WIN_RATE：連續 3 個 5 分鐘視窗勝率 > 99%（且 ≥ MIN_BETS）才標記；
 *      視窗不足時不標記
 *   3. NET_WIN_OUTLIER：單日淨贏超過 P99 × 10 才標記；P99 未設定時不標記
 *   4. Redis 失敗時靜默略過（不拋例外、返回 []）
 *   5. onFlag 回呼正確觸發（每條命中規則各呼叫一次）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  createAnomalyDetector,
  BET_RATE_WINDOW_SECONDS,
  WIN_RATE_BUCKET_SECONDS,
  WIN_RATE_MIN_BETS,
  WIN_RATE_CONSEC_WINDOWS,
  NET_WIN_OUTLIER_MULTIPLIER,
  netwinKey,
  p99Key,
} from '../../src/security/anomaly.js';

// ═════════════════ fake redis ═════════════════

function createFakeRedis() {
  const store = new Map<string, string>();

  const redis = {
    async incr(key: string): Promise<number> {
      const val = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(val));
      return val;
    },
    async incrby(key: string, delta: number): Promise<number> {
      const val = parseInt(store.get(key) ?? '0', 10) + delta;
      store.set(key, String(val));
      return val;
    },
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, val: string | number, ..._args: unknown[]): Promise<'OK'> {
      store.set(key, String(val));
      return 'OK';
    },
    async expire(_key: string, _ttl: number): Promise<number> {
      return 1;
    },
    async scan(
      cursor: string,
      _matchOpt: string,
      pattern: string,
      _countOpt: string,
      _count: number,
    ): Promise<[string, string[]]> {
      // 簡化：一次掃完（cursor '0' → '0'）
      const glob = new RegExp(
        '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      );
      const keys = [...store.keys()].filter((k) => glob.test(k));
      return ['0', keys];
    },
    async mget(...keys: string[]): Promise<(string | null)[]> {
      return keys.map((k) => store.get(k) ?? null);
    },
  } as unknown as Redis & { store: Map<string, string> };

  return { redis, store };
}

// ═════════════════ 時間控制 helpers ═════════════════

/** 傳回 DateNow stub 使目前位於指定 1s bucket 的開頭（毫秒） */
function inBucket1s(bucket: number): number {
  return bucket * BET_RATE_WINDOW_SECONDS * 1_000;
}

/** 傳回 DateNow stub 使目前位於指定 5m bucket 的開頭（毫秒） */
function inBucket5m(bucket: number): number {
  return bucket * WIN_RATE_BUCKET_SECONDS * 1_000;
}

// ═════════════════ 測試 ═════════════════

describe('anomaly detector', () => {
  let fakeRedis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    fakeRedis = createFakeRedis();
    vi.restoreAllMocks();
  });

  // ─── 規則 1：BET_RATE ──────────────────────────────────────────────────────

  describe('BET_RATE', () => {
    it('同一 1s 視窗前 2 筆不標記，第 3 筆起標記', async () => {
      const t = inBucket1s(1000);
      vi.setSystemTime(t);

      const detector = createAnomalyDetector(fakeRedis.redis);
      const r1 = await detector.recordBet('u1', 100n, 0n);
      const r2 = await detector.recordBet('u1', 100n, 0n);
      const r3 = await detector.recordBet('u1', 100n, 0n);

      expect(r1).not.toContain('BET_RATE');
      expect(r2).not.toContain('BET_RATE');
      expect(r3).toContain('BET_RATE');
    });

    it('不同 1s 視窗不累計', async () => {
      const t = inBucket1s(2000);
      vi.setSystemTime(t);
      const detector = createAnomalyDetector(fakeRedis.redis);
      await detector.recordBet('u2', 100n, 0n);
      await detector.recordBet('u2', 100n, 0n);

      // 下一個 bucket
      vi.setSystemTime(t + BET_RATE_WINDOW_SECONDS * 1_000);
      const r = await detector.recordBet('u2', 100n, 0n);
      expect(r).not.toContain('BET_RATE');
    });

    it('onFlag 在 BET_RATE 標記時觸發', async () => {
      vi.setSystemTime(inBucket1s(3000));
      const onFlag = vi.fn();
      const detector = createAnomalyDetector(fakeRedis.redis, { onFlag });
      await detector.recordBet('u3', 100n, 0n);
      await detector.recordBet('u3', 100n, 0n);
      await detector.recordBet('u3', 100n, 0n);
      expect(onFlag).toHaveBeenCalledWith('u3', 'BET_RATE');
    });
  });

  // ─── 規則 2：WIN_RATE ──────────────────────────────────────────────────────

  describe('WIN_RATE', () => {
    it('連續 3 個 5m 視窗勝率 > 99% 且 ≥ MIN_BETS 才標記', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);

      // 直接在 Redis 預填過去 3 個視窗的資料（win/total = 10/10 = 100%）
      const now = Date.now();
      const currentBucket = Math.floor(now / (WIN_RATE_BUCKET_SECONDS * 1_000));
      for (let i = 0; i < WIN_RATE_CONSEC_WINDOWS; i++) {
        const b = currentBucket - i;
        fakeRedis.store.set(`anomaly:wr:win:userA:${b}`, '10');
        fakeRedis.store.set(`anomaly:wr:total:userA:${b}`, '10');
      }

      // 再記錄一筆（讓 currentBucket total 超過 MIN_BETS 以觸發檢查）
      // 預填後再記錄，total 從 10 變 11
      const result = await detector.recordBet('userA', 100n, 200n);
      expect(result).toContain('WIN_RATE');
    });

    it('未達 MIN_BETS 不標記（即使勝率 100%）', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      const now = Date.now();
      const currentBucket = Math.floor(now / (WIN_RATE_BUCKET_SECONDS * 1_000));

      // 只有 9 筆 total（< MIN_BETS=10）
      for (let i = 0; i < WIN_RATE_CONSEC_WINDOWS; i++) {
        const b = currentBucket - i;
        fakeRedis.store.set(`anomaly:wr:win:userB:${b}`, '9');
        fakeRedis.store.set(`anomaly:wr:total:userB:${b}`, '9');
      }

      const result = await detector.recordBet('userB', 100n, 200n);
      expect(result).not.toContain('WIN_RATE');
    });

    it('只有 2 個視窗高勝率不標記', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      const now = Date.now();
      const currentBucket = Math.floor(now / (WIN_RATE_BUCKET_SECONDS * 1_000));

      // 只填 2 個視窗（差 1 個）
      for (let i = 0; i < 2; i++) {
        const b = currentBucket - i;
        fakeRedis.store.set(`anomaly:wr:win:userC:${b}`, '20');
        fakeRedis.store.set(`anomaly:wr:total:userC:${b}`, '20');
      }
      // 第 3 個視窗沒有資料（total=0 < MIN_BETS）

      const result = await detector.recordBet('userC', 100n, 200n);
      expect(result).not.toContain('WIN_RATE');
    });
  });

  // ─── 規則 3：NET_WIN_OUTLIER ───────────────────────────────────────────────

  describe('NET_WIN_OUTLIER', () => {
    it('淨贏超過 P99 × 10 時標記', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);

      // 設置 P99 = 1000（今日）
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(
        new Date(),
      );
      fakeRedis.store.set(p99Key(dateKey), '1000');

      // 淨贏 = payout - amount = 10001 - 0 = 10001 > 1000 × 10 = 10000
      const result = await detector.recordBet('userD', 0n, BigInt(10001));
      expect(result).toContain('NET_WIN_OUTLIER');
    });

    it('淨贏等於 P99 × 10 不標記（嚴格大於）', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(
        new Date(),
      );
      fakeRedis.store.set(p99Key(dateKey), '1000');

      const result = await detector.recordBet('userE', 0n, BigInt(10000));
      expect(result).not.toContain('NET_WIN_OUTLIER');
    });

    it('P99 未設定時不標記', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      // 沒有設置 P99 鍵
      const result = await detector.recordBet('userF', 0n, BigInt(999_999));
      expect(result).not.toContain('NET_WIN_OUTLIER');
    });

    it('淨贏為負（虧損）不標記', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(
        new Date(),
      );
      fakeRedis.store.set(p99Key(dateKey), '100');

      // 下注 500，贏 0 → 淨虧 500（< 0）
      const result = await detector.recordBet('userG', 500n, 0n);
      expect(result).not.toContain('NET_WIN_OUTLIER');
    });
  });

  // ─── updateNetWinP99 ───────────────────────────────────────────────────────

  describe('updateNetWinP99', () => {
    it('正確計算 P99 並寫入 Redis', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(
        new Date(),
      );

      // 放入 100 位使用者的今日淨贏（1 ~ 100）
      for (let i = 1; i <= 100; i++) {
        fakeRedis.store.set(netwinKey(`user${i}`, dateKey), String(i));
      }

      await detector.updateNetWinP99();

      const p99 = fakeRedis.store.get(p99Key(dateKey));
      expect(p99).toBeTruthy();
      // P99 應為 99（100 個值排序後 idx = floor(100 × 0.99) = 99，值為 100；但 idx 被 clamp 到 99）
      const p99Num = parseInt(p99!, 10);
      expect(p99Num).toBeGreaterThanOrEqual(99);
      expect(p99Num).toBeLessThanOrEqual(100);
    });

    it('無資料時不寫入', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      await detector.updateNetWinP99();

      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(
        new Date(),
      );
      expect(fakeRedis.store.has(p99Key(dateKey))).toBe(false);
    });

    it('忽略負淨贏（虧損使用者不納入 P99 計算）', async () => {
      const detector = createAnomalyDetector(fakeRedis.redis);
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(
        new Date(),
      );
      // 放入 1 位正淨贏、1 位負淨贏
      fakeRedis.store.set(netwinKey('winner', dateKey), '5000');
      fakeRedis.store.set(netwinKey('loser', dateKey), '-3000');

      await detector.updateNetWinP99();

      const p99 = fakeRedis.store.get(p99Key(dateKey));
      // 只有 1 個正值，P99 = 5000
      expect(p99).toBe('5000');
    });
  });

  // ─── Redis 失敗處理 ────────────────────────────────────────────────────────

  describe('Redis 失敗', () => {
    it('Redis incr 拋錯時靜默返回空陣列', async () => {
      const brokenRedis = {
        incr: async () => { throw new Error('connection refused'); },
        incrby: async () => { throw new Error('connection refused'); },
        get: async () => null,
        set: async () => 'OK',
        expire: async () => 1,
        scan: async () => ['0', []],
        mget: async () => [],
      } as unknown as Redis;

      const detector = createAnomalyDetector(brokenRedis);
      const result = await detector.recordBet('user', 100n, 0n);
      expect(result).toEqual([]);
    });
  });
});
