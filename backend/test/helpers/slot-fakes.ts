/**
 * M11/M14 測試共用 fakes（slot.service / jackpot.service 單元測試與
 * slot-spin 整合測試共用）。
 *
 * fake prisma 三個關鍵語義與真 DB 同構：
 *   1. user.updateMany 的「條件檢查 + 變更」在單一同步區塊完成（無 await 切點）
 *      —— 重現 SQL 條件更新原子性（與 wallet.service.spec 同款）。
 *   2. jackpot.updateMany 同款：WHERE version = :v 條件更新 + 行數回報
 *      —— M14 派彩樂觀鎖語義（bumpJackpotVersionAfterRead 可注入競態）。
 *   3. $transaction 以「深拷貝快照 + 拋錯還原」模擬回滾——
 *      交易內任一步失敗（如餘額不足 / 樂觀鎖 STALE）時零落帳。
 *
 * fake redis：Map 後端，支援 get/set/del/incr/incrby/decrby/getset；
 * failOn 集合可注入單方法故障（驗證「Redis 失敗不影響交易」語義）。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { RngFn } from '../../src/modules/slot/sampler.js';

// ═════════════════ fake prisma ═════════════════

export interface FakeUser {
  id: string;
  username: string;
  avatarId: number;
  balance: bigint;
  version: number;
  jackpotPoints: number;
}

export interface FakeJackpotRow {
  id: number;
  pool: bigint;
  version: number;
  updatedAt: Date;
}

export interface FakeJackpotHistoryRow {
  id: string;
  jackpotId: number;
  userId: string;
  poolBefore: bigint;
  payout: bigint;
  remained: bigint;
  createdAt: Date;
}

export interface FakeBetRecord {
  id: string;
  userId: string;
  gameType: string;
  amount: bigint;
  payout: bigint;
  detail: Record<string, unknown>;
  serverSeedHash: string;
  /** M15：輪盤回合（slot 記錄無此欄） */
  roundId?: string;
  createdAt: Date;
}

export interface FakeTxRecord {
  id: string;
  userId: string;
  type: string;
  delta: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  refId: string | null;
  memo: string | null;
  createdAt: Date;
}

/** UserCharm JOIN Charm 的 select 形狀（slot.service compileLoadoutForUser 用） */
export interface FakeCharmRow {
  charm: { code: string; type: string; effect: unknown };
}

export interface FakeDbOptions {
  users: Array<{
    id: string;
    balance: bigint;
    jackpotPoints?: number;
    username?: string;
    avatarId?: number;
  }>;
  charmRows?: FakeCharmRow[];
  /** userCharm.findMany 拋錯（驗證 LOADOUT_COMPILE_FAILED） */
  charmFindManyThrows?: boolean;
  /** Jackpot 單行表初始值（缺省 pool=0n version=0，等同 migration 種子行） */
  jackpotPool?: bigint;
  /**
   * 注入樂觀鎖競態：jackpot.findUniqueOrThrow 讀取後立刻 version+1 N 次
   * （模擬讀取與條件更新之間被 flush / 併發派彩搶寫），供派彩重試路徑測試。
   */
  bumpJackpotVersionAfterRead?: number;
  /** jackpot.update（flush 落庫）拋錯（驗證增量放回 Redis） */
  jackpotUpdateThrows?: boolean;
  /** M15：betRecord.create 拋錯（驗證輪盤結算交易失敗 → 全額退款） */
  betRecordCreateThrows?: boolean;
}

export function createFakeDb(options: FakeDbOptions) {
  const users: FakeUser[] = options.users.map((u, i) => ({
    id: u.id,
    username: u.username ?? `player_${i + 1}`,
    avatarId: u.avatarId ?? 0,
    balance: u.balance,
    version: 0,
    jackpotPoints: u.jackpotPoints ?? 0,
  }));
  const betRecords: FakeBetRecord[] = [];
  const txRecords: FakeTxRecord[] = [];
  const charmRows: FakeCharmRow[] = options.charmRows ?? [];
  const jackpotRow: FakeJackpotRow = {
    id: 1,
    pool: options.jackpotPool ?? 0n,
    version: 0,
    updatedAt: new Date(),
  };
  const jackpotHistory: FakeJackpotHistoryRow[] = [];
  let bumpsRemaining = options.bumpJackpotVersionAfterRead ?? 0;
  let seq = 0;
  let charmFindManyCalls = 0;

  const client = {
    user: {
      // ★ 條件檢查與變更同步完成 ＝ SQL 條件更新原子性（wallet 走此路徑）
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; balance?: { gte: bigint } };
        data: {
          balance?: { decrement?: bigint; increment?: bigint };
          version?: { increment: number };
        };
      }) {
        const matched = users.filter(
          (u) =>
            u.id === where.id &&
            (where.balance?.gte === undefined || u.balance >= where.balance.gte),
        );
        for (const u of matched) {
          if (data.balance?.decrement !== undefined) u.balance -= data.balance.decrement;
          if (data.balance?.increment !== undefined) u.balance += data.balance.increment;
          if (data.version?.increment !== undefined) u.version += data.version.increment;
        }
        return { count: matched.length };
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: { jackpotPoints?: { increment: number } | number };
        select?: unknown;
      }) {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error('P2025: record not found');
        if (typeof data.jackpotPoints === 'number') {
          user.jackpotPoints = data.jackpotPoints; // M14 派彩後點數歸零（直接 SET）
        } else if (data.jackpotPoints?.increment !== undefined) {
          user.jackpotPoints += data.jackpotPoints.increment;
        }
        // 寬鬆回傳全欄位（呼叫方 select 取所需子集即可）
        return {
          jackpotPoints: user.jackpotPoints,
          username: user.username,
          avatarId: user.avatarId,
        };
      },
      async findUnique({ where }: { where: { id: string } }) {
        return users.find((u) => u.id === where.id) ?? null;
      },
      async findUniqueOrThrow({ where }: { where: { id: string } }) {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error('P2025: record not found');
        return user;
      },
    },
    betRecord: {
      async create({ data }: { data: Omit<FakeBetRecord, 'id' | 'createdAt'> }) {
        if (options.betRecordCreateThrows) throw new Error('PG connection lost');
        const record: FakeBetRecord = {
          id: `bet_${(seq += 1)}`,
          // 以 seq 錯開毫秒：同毫秒內連續 create 的 createdAt 排序保持確定性
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        betRecords.push(record);
        return record;
      },
      async findMany({
        where,
        skip = 0,
        take = betRecords.length,
      }: {
        where: { userId: string; gameType: string };
        orderBy?: unknown;
        skip?: number;
        take?: number;
        select?: unknown;
      }) {
        return betRecords
          .filter((b) => b.userId === where.userId && b.gameType === where.gameType)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(skip, skip + take);
      },
      async count({ where }: { where: { userId: string; gameType: string } }) {
        return betRecords.filter(
          (b) => b.userId === where.userId && b.gameType === where.gameType,
        ).length;
      },
    },
    balanceTransaction: {
      async create({ data }: { data: Omit<FakeTxRecord, 'id' | 'createdAt'> }) {
        const record: FakeTxRecord = {
          id: `tx_${(seq += 1)}`,
          createdAt: new Date(),
          ...data,
        };
        txRecords.push(record);
        return record;
      },
    },
    userCharm: {
      async findMany(_args: unknown) {
        charmFindManyCalls += 1;
        if (options.charmFindManyThrows) throw new Error('DB connection lost');
        return charmRows;
      },
    },
    // ═══ M14：Jackpot 單行表（id=1，migration 含種子行） ═══
    jackpot: {
      async findUnique({ where }: { where: { id: number }; select?: unknown }) {
        return where.id === jackpotRow.id ? { ...jackpotRow } : null;
      },
      async findUniqueOrThrow({ where }: { where: { id: number }; select?: unknown }) {
        if (where.id !== jackpotRow.id) throw new Error('P2025: record not found');
        const view = { ...jackpotRow };
        // 競態注入：讀取後被 flush / 併發派彩搶寫（呼叫方拿到的是舊 version）
        if (bumpsRemaining > 0) {
          bumpsRemaining -= 1;
          jackpotRow.version += 1;
        }
        return view;
      },
      // flush 落庫路徑：單行 increment（無條件）
      async update({
        where,
        data,
      }: {
        where: { id: number };
        data: { pool?: { increment: bigint }; version?: { increment: number } };
      }) {
        if (options.jackpotUpdateThrows) throw new Error('PG connection lost');
        if (where.id !== jackpotRow.id) throw new Error('P2025: record not found');
        if (data.pool?.increment !== undefined) jackpotRow.pool += data.pool.increment;
        if (data.version?.increment !== undefined) jackpotRow.version += data.version.increment;
        jackpotRow.updatedAt = new Date();
        return { ...jackpotRow };
      },
      // 派彩樂觀鎖路徑：條件檢查 + 變更同步完成 ＝ SQL 條件更新原子性
      async updateMany({
        where,
        data,
      }: {
        where: { id: number; version?: number };
        data: { pool?: bigint; version?: { increment: number } };
      }) {
        const matched =
          where.id === jackpotRow.id &&
          (where.version === undefined || jackpotRow.version === where.version);
        if (!matched) return { count: 0 };
        if (data.pool !== undefined) jackpotRow.pool = data.pool;
        if (data.version?.increment !== undefined) jackpotRow.version += data.version.increment;
        jackpotRow.updatedAt = new Date();
        return { count: 1 };
      },
    },
    jackpotHistory: {
      async create({ data }: { data: Omit<FakeJackpotHistoryRow, 'id' | 'createdAt'> }) {
        const record: FakeJackpotHistoryRow = {
          id: `jh_${(seq += 1)}`,
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        jackpotHistory.push(record);
        return record;
      },
      async findMany({
        skip = 0,
        take = jackpotHistory.length,
      }: {
        orderBy?: unknown;
        skip?: number;
        take?: number;
        select?: unknown;
      } = {}) {
        return jackpotHistory
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(skip, skip + take)
          .map((row) => ({
            ...row,
            user: (() => {
              const u = users.find((x) => x.id === row.userId);
              return { username: u?.username ?? '?', avatarId: u?.avatarId ?? 0 };
            })(),
          }));
      },
      async count() {
        return jackpotHistory.length;
      },
    },
    // 快照 + 還原 ＝ 回滾語義（structuredClone 支援 bigint / Date）
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const snapshot = structuredClone({
        users,
        betRecords,
        txRecords,
        jackpotRow,
        jackpotHistory,
      });
      try {
        return await fn(client);
      } catch (err) {
        users.splice(0, users.length, ...snapshot.users);
        betRecords.splice(0, betRecords.length, ...snapshot.betRecords);
        txRecords.splice(0, txRecords.length, ...snapshot.txRecords);
        jackpotHistory.splice(0, jackpotHistory.length, ...snapshot.jackpotHistory);
        Object.assign(jackpotRow, snapshot.jackpotRow);
        throw err;
      }
    },
  };

  return {
    prisma: client as unknown as PrismaClient,
    txClient: client as unknown as Prisma.TransactionClient,
    users,
    betRecords,
    txRecords,
    jackpotRow,
    jackpotHistory,
    charmFindManyCalls: () => charmFindManyCalls,
  };
}

// ═════════════════ fake redis ═════════════════

export function createFakeRedis() {
  const store = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  /** 加入方法名（get/set/del/incr/incrby/hincrby/rpush…）即令該方法拋錯 */
  const failOn = new Set<string>();

  function check(method: string): void {
    if (failOn.has(method)) throw new Error(`redis ${method} unavailable (injected)`);
  }

  function hashOf(key: string): Map<string, string> {
    let hash = hashes.get(key);
    if (hash === undefined) {
      hash = new Map();
      hashes.set(key, hash);
    }
    return hash;
  }

  function listOf(key: string): string[] {
    let list = lists.get(key);
    if (list === undefined) {
      list = [];
      lists.set(key, list);
    }
    return list;
  }

  const client = {
    async get(key: string): Promise<string | null> {
      check('get');
      return store.get(key) ?? null;
    },
    // 支援 SET key value [EX ttl] [NX]：NX 且鍵已存在 → null（leader lock 語義）
    async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
      check('set');
      const flags = args.map((a) => String(a).toUpperCase());
      if (flags.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async del(key: string): Promise<number> {
      check('del');
      const had = store.delete(key);
      const hadHash = hashes.delete(key);
      const hadList = lists.delete(key);
      return had || hadHash || hadList ? 1 : 0;
    },
    async incr(key: string): Promise<number> {
      check('incr');
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
    async incrby(key: string, n: number | string): Promise<number> {
      check('incrby');
      const next = Number(store.get(key) ?? '0') + Number(n);
      store.set(key, String(next));
      return next;
    },
    async decrby(key: string, n: number | string): Promise<number> {
      check('decrby');
      const next = Number(store.get(key) ?? '0') - Number(n);
      store.set(key, String(next));
      return next;
    },
    async getset(key: string, value: string): Promise<string | null> {
      check('getset');
      const prev = store.get(key) ?? null;
      store.set(key, value);
      return prev;
    },
    async expire(_key: string, _seconds: number): Promise<number> {
      check('expire');
      return 1; // fake 不模擬 TTL 到期（anomaly 偵測器整合路徑需要此命令存在）
    },

    // ═══ M15：hash / list（roulette 注額計數、注單事件、歷史） ═══
    async hincrby(key: string, field: string, n: number | string): Promise<number> {
      check('hincrby');
      const hash = hashOf(key);
      const next = Number(hash.get(field) ?? '0') + Number(n);
      hash.set(field, String(next));
      return next;
    },
    async hget(key: string, field: string): Promise<string | null> {
      check('hget');
      return hashes.get(key)?.get(field) ?? null;
    },
    async hvals(key: string): Promise<string[]> {
      check('hvals');
      return [...(hashes.get(key)?.values() ?? [])];
    },
    async rpush(key: string, ...values: string[]): Promise<number> {
      check('rpush');
      const list = listOf(key);
      list.push(...values);
      return list.length;
    },
    async lpush(key: string, ...values: string[]): Promise<number> {
      check('lpush');
      const list = listOf(key);
      list.unshift(...values.reverse());
      return list.length;
    },
    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      check('lrange');
      const list = lists.get(key) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    },
    async llen(key: string): Promise<number> {
      check('llen');
      return lists.get(key)?.length ?? 0;
    },
    async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
      check('ltrim');
      const list = lists.get(key) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      lists.set(key, list.slice(start, end));
      return 'OK';
    },
  };

  return {
    redis: client as unknown as Redis,
    store,
    hashes,
    lists,
    failOn,
  };
}

// ═════════════════ 決定性 rng ═════════════════

/**
 * 依序回吐預先排好的點位（與基礎權重表 cum 對照表見 spec 檔頭）。
 * 序列耗盡即拋錯——測試忘了餵點位時 fail loud 而非默默隨機。
 */
export function makeRng(points: number[]): RngFn & { feed: (...more: number[]) => void } {
  const queue = [...points];
  const rng = ((_maxExclusive: number): number => {
    const next = queue.shift();
    if (next === undefined) throw new Error('makeRng: 點位序列已耗盡');
    return next;
  }) as RngFn & { feed: (...more: number[]) => void };
  rng.feed = (...more: number[]) => queue.push(...more);
  return rng;
}
