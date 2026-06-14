/**
 * M27 端對端整合測試共用 fakes（in-memory，無需 PG / Redis）。
 *
 * 與 slot-fakes.ts 的分工：
 *   - slot-fakes.ts：M11/M14 slot & jackpot 單元/整合測試（jackpot 單行表、競態注入）。
 *   - e2e-fakes.ts（本檔）：M27 跨模組「全流程」整合測試——需要 auth（註冊/登入）、
 *     HMAC 簽章鏈（hmacKeys.rotate / getActiveKeys）、防重放（nonce / seq）、
 *     限流令牌桶、禮物碼兌換、IllegalPacketLog 落庫等更大表面積。
 *
 * 設計重點（與真 DB / Redis 同構的關鍵語義）：
 *   1. user.updateMany 的「條件檢查 + 變更」在單一同步區塊完成 ＝ SQL 條件更新原子性
 *      （wallet 扣款的超扣競態防護依賴此語義；雙花測試靠它）。
 *   2. $transaction 以深拷貝快照 + 拋錯還原模擬回滾——交易內任一步失敗即零落帳。
 *   3. 唯一索引（username / refreshToken.tokenHash / giftCode.code /
 *      giftCodeRedemption[giftCodeId,userId]）以掃描檢查；衝突拋 Prisma P2002 形狀錯誤。
 *   4. fake redis 的 eval 以「腳本字串參考相等」分派至 SEQ_GUARD_LUA / TOKEN_BUCKET_LUA
 *      的等義 JS 實作（直接重用 production 的 consumeToken 純函式）——
 *      讓真 hmac-guard / rate-limit / nonce 防線在測試中完整跑過，而非被跳過。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { SEQ_GUARD_LUA } from '../../src/security/nonce.js';
import { TOKEN_BUCKET_LUA, consumeToken, type BucketState } from '../../src/plugins/rate-limit.js';

// ═══════════════════════════════════════════════════════════════════════════
// 共用工具
// ═══════════════════════════════════════════════════════════════════════════

/** P2002（unique 約束違反）——真 Prisma 錯誤實例，讓 `instanceof` 檢查（auth.register）通過 */
function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target})`,
    { code: 'P2002', clientVersion: 'fake', meta: { target: [target] } },
  );
}

/** P2025（record not found）——形狀近似，供 findUniqueOrThrow / update 缺記錄時拋出 */
function notFound(): Error {
  return Object.assign(new Error('P2025: record not found'), { code: 'P2025' });
}

// ═══════════════════════════════════════════════════════════════════════════
// fake prisma
// ═══════════════════════════════════════════════════════════════════════════

export interface FakeE2EUser {
  id: string;
  username: string;
  passwordHash: string;
  role: 'PLAYER' | 'ADMIN';
  balance: bigint;
  version: number;
  banned: boolean;
  muted: boolean;
  flagged: boolean;
  avatarId: number;
  jackpotPoints: number;
  createdAt: Date;
}

export interface FakeRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  revoked: boolean;
  expiresAt: Date;
  createdAt: Date;
}

export interface FakeLoginLog {
  id: string;
  userId: string | null;
  username: string;
  ip: string;
  userAgent: string;
  result: string;
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
  roundId?: string;
  createdAt: Date;
}

export interface FakeBalanceTx {
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

export interface FakeGiftCode {
  id: string;
  code: string;
  amount: bigint;
  charmId: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  createdById: string;
  createdAt: Date;
}

export interface FakeGiftCodeRedemption {
  id: string;
  giftCodeId: string;
  userId: string;
  createdAt: Date;
}

export interface FakeUserCharm {
  id: string;
  userId: string;
  charmId: string;
  equipped: boolean;
  slot: number | null;
  createdAt: Date;
}

export interface FakeCharm {
  id: string;
  code: string;
  name: string;
  type: string;
  effect: unknown;
  enabled: boolean;
}

export interface FakeAdminAuditLog {
  id: string;
  adminId: string;
  action: string;
  targetUserId: string | null;
  before: unknown;
  after: unknown;
  ip: string;
  createdAt: Date;
}

export interface FakeIllegalPacketLog {
  id: string;
  userId: string | null;
  ip: string;
  violation: string;
  endpoint: string;
  rawSample: string | null;
  createdAt: Date;
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

export interface FakeSeedUser {
  username: string;
  passwordHash?: string;
  role?: 'PLAYER' | 'ADMIN';
  balance?: bigint;
  banned?: boolean;
  muted?: boolean;
}

export interface FakeE2EDbOptions {
  /** 預先植入的使用者（例如 admin、預設玩家）；註冊測試可留空由 user.create 產生 */
  users?: FakeSeedUser[];
  /** 護符目錄（gift code 附贈護符時 charm.findUnique 用） */
  charms?: FakeCharm[];
  /** Jackpot 單行表初始池量（缺省 0n，等同 migration 種子行） */
  jackpotPool?: bigint;
  /**
   * 注入樂觀鎖競態：jackpot.findUniqueOrThrow 讀取後立即 version+1 N 次
   * （模擬讀取與條件更新之間被併發派彩 / flush 搶寫），驗證派彩重試路徑。
   */
  bumpJackpotVersionAfterRead?: number;
}

export function createE2EDb(options: FakeE2EDbOptions = {}) {
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}_${(seq += 1)}`;

  const users: FakeE2EUser[] = (options.users ?? []).map((u) => ({
    id: nextId('usr'),
    username: u.username,
    passwordHash: u.passwordHash ?? 'seed-hash',
    role: u.role ?? 'PLAYER',
    balance: u.balance ?? 5_000n,
    version: 0,
    banned: u.banned ?? false,
    muted: u.muted ?? false,
    flagged: false,
    avatarId: 0,
    jackpotPoints: 0,
    createdAt: new Date(Date.now() + seq),
  }));
  const refreshTokens: FakeRefreshToken[] = [];
  const loginLogs: FakeLoginLog[] = [];
  const betRecords: FakeBetRecord[] = [];
  const balanceTxs: FakeBalanceTx[] = [];
  const giftCodes: FakeGiftCode[] = [];
  const giftCodeRedemptions: FakeGiftCodeRedemption[] = [];
  const userCharms: FakeUserCharm[] = [];
  const charms: FakeCharm[] = options.charms ?? [];
  const adminAuditLogs: FakeAdminAuditLog[] = [];
  const illegalPacketLogs: FakeIllegalPacketLog[] = [];
  const jackpotRow: FakeJackpotRow = {
    id: 1,
    pool: options.jackpotPool ?? 0n,
    version: 0,
    updatedAt: new Date(),
  };
  const jackpotHistory: FakeJackpotHistoryRow[] = [];
  let bumpsRemaining = options.bumpJackpotVersionAfterRead ?? 0;
  /** $transaction 序列化鏈（見 $transaction 檔頭 mutex 說明） */
  let txChain: Promise<unknown> = Promise.resolve();

  const findUserById = (id: string): FakeE2EUser | undefined => users.find((u) => u.id === id);
  const findUserByUsername = (username: string): FakeE2EUser | undefined =>
    users.find((u) => u.username === username);

  function resolveUser(where: { id?: string; username?: string }): FakeE2EUser | undefined {
    if (where.id !== undefined) return findUserById(where.id);
    if (where.username !== undefined) return findUserByUsername(where.username);
    return undefined;
  }

  const client = {
    // ─────────────────────────── user ───────────────────────────
    user: {
      async create({
        data,
      }: {
        data: { username: string; passwordHash: string; role?: 'PLAYER' | 'ADMIN' };
      }) {
        if (findUserByUsername(data.username) !== undefined) throw uniqueViolation('username');
        const user: FakeE2EUser = {
          id: nextId('usr'),
          username: data.username,
          passwordHash: data.passwordHash,
          role: data.role ?? 'PLAYER',
          balance: 5_000n, // schema default 新手禮包
          version: 0,
          banned: false,
          muted: false,
          flagged: false,
          avatarId: 0,
          jackpotPoints: 0,
          createdAt: new Date(Date.now() + seq),
        };
        users.push(user);
        return { ...user };
      },

      async findUnique({ where }: { where: { id?: string; username?: string }; select?: unknown }) {
        const user = resolveUser(where);
        return user ? { ...user } : null;
      },

      async findUniqueOrThrow({
        where,
      }: {
        where: { id?: string; username?: string };
        select?: unknown;
      }) {
        const user = resolveUser(where);
        if (!user) throw notFound();
        return { ...user };
      },

      // ★ 條件檢查與變更同步完成 ＝ SQL 條件更新原子性（wallet 唯一寫餘額入口）
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; balance?: { gte: bigint }; flagged?: boolean };
        data: {
          balance?: { decrement?: bigint; increment?: bigint };
          version?: { increment: number };
          flagged?: boolean;
        };
      }) {
        const matched = users.filter(
          (u) =>
            u.id === where.id &&
            (where.balance?.gte === undefined || u.balance >= where.balance.gte) &&
            (where.flagged === undefined || u.flagged === where.flagged),
        );
        for (const u of matched) {
          if (data.balance?.decrement !== undefined) u.balance -= data.balance.decrement;
          if (data.balance?.increment !== undefined) u.balance += data.balance.increment;
          if (data.version?.increment !== undefined) u.version += data.version.increment;
          if (data.flagged !== undefined) u.flagged = data.flagged;
        }
        return { count: matched.length };
      },

      // 非餘額欄位（jackpotPoints 等）；餘額鐵律不適用
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: { jackpotPoints?: number | { increment: number }; muted?: boolean };
        select?: unknown;
      }) {
        const user = findUserById(where.id);
        if (!user) throw notFound();
        if (typeof data.jackpotPoints === 'number') user.jackpotPoints = data.jackpotPoints;
        else if (data.jackpotPoints?.increment !== undefined)
          user.jackpotPoints += data.jackpotPoints.increment;
        if (data.muted !== undefined) user.muted = data.muted;
        return { ...user };
      },
    },

    // ─────────────────────────── refreshToken ───────────────────────────
    refreshToken: {
      async create({
        data,
      }: {
        data: { userId: string; tokenHash: string; familyId: string; expiresAt: Date };
      }) {
        if (refreshTokens.some((t) => t.tokenHash === data.tokenHash))
          throw uniqueViolation('token_hash');
        const row: FakeRefreshToken = {
          id: nextId('rt'),
          userId: data.userId,
          tokenHash: data.tokenHash,
          familyId: data.familyId,
          revoked: false,
          expiresAt: data.expiresAt,
          createdAt: new Date(Date.now() + seq),
        };
        refreshTokens.push(row);
        return { ...row };
      },
      async findUnique({ where }: { where: { tokenHash: string } }) {
        const row = refreshTokens.find((t) => t.tokenHash === where.tokenHash);
        return row ? { ...row } : null;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id?: string; userId?: string; familyId?: string; revoked?: boolean };
        data: { revoked: boolean };
      }) {
        const matched = refreshTokens.filter(
          (t) =>
            (where.id === undefined || t.id === where.id) &&
            (where.userId === undefined || t.userId === where.userId) &&
            (where.familyId === undefined || t.familyId === where.familyId) &&
            (where.revoked === undefined || t.revoked === where.revoked),
        );
        for (const t of matched) t.revoked = data.revoked;
        return { count: matched.length };
      },
    },

    // ─────────────────────────── loginLog ───────────────────────────
    loginLog: {
      async create({
        data,
      }: {
        data: {
          userId: string | null;
          username: string;
          ip: string;
          userAgent: string;
          result: string;
        };
      }) {
        const row: FakeLoginLog = { id: nextId('login'), createdAt: new Date(), ...data };
        loginLogs.push(row);
        return { ...row };
      },
    },

    // ─────────────────────────── betRecord ───────────────────────────
    betRecord: {
      async create({ data }: { data: Omit<FakeBetRecord, 'id' | 'createdAt'> }) {
        const row: FakeBetRecord = {
          id: nextId('bet'),
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        betRecords.push(row);
        return { ...row };
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
          .slice(skip, skip + take)
          .map((b) => ({ ...b }));
      },
      async count({ where }: { where: { userId: string; gameType: string } }) {
        return betRecords.filter(
          (b) => b.userId === where.userId && b.gameType === where.gameType,
        ).length;
      },
    },

    // ─────────────────────────── balanceTransaction ───────────────────────────
    balanceTransaction: {
      async create({ data }: { data: Omit<FakeBalanceTx, 'id' | 'createdAt'> }) {
        const row: FakeBalanceTx = {
          id: nextId('tx'),
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        balanceTxs.push(row);
        return { ...row };
      },
    },

    // ─────────────────────────── giftCode ───────────────────────────
    giftCode: {
      async create({
        data,
      }: {
        data: {
          code: string;
          amount: bigint;
          charmId: string | null;
          maxUses: number;
          expiresAt: Date;
          createdById: string;
        };
        select?: unknown;
      }) {
        if (giftCodes.some((g) => g.code === data.code)) throw uniqueViolation('code');
        const row: FakeGiftCode = {
          id: nextId('gc'),
          usedCount: 0,
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        giftCodes.push(row);
        return { ...row };
      },
      async findUnique({ where }: { where: { code: string }; select?: unknown }) {
        const row = giftCodes.find((g) => g.code === where.code);
        return row ? { ...row } : null;
      },
      // 原子條件更新：WHERE usedCount < maxUses AND expiresAt > now （防超用競態）
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; usedCount?: { lt: number }; expiresAt?: { gt: Date } };
        data: { usedCount: { increment: number } };
      }) {
        const matched = giftCodes.filter(
          (g) =>
            g.id === where.id &&
            (where.usedCount?.lt === undefined || g.usedCount < where.usedCount.lt) &&
            (where.expiresAt?.gt === undefined || g.expiresAt > where.expiresAt.gt),
        );
        for (const g of matched) g.usedCount += data.usedCount.increment;
        return { count: matched.length };
      },
    },

    // ─────────────────────────── giftCodeRedemption ───────────────────────────
    giftCodeRedemption: {
      async create({
        data,
      }: {
        data: { giftCodeId: string; userId: string };
        select?: unknown;
      }) {
        // @@unique([giftCodeId, userId])：同人重複兌換同一碼 → P2002
        if (
          giftCodeRedemptions.some(
            (r) => r.giftCodeId === data.giftCodeId && r.userId === data.userId,
          )
        ) {
          throw uniqueViolation('gift_code_id_user_id');
        }
        const row: FakeGiftCodeRedemption = {
          id: nextId('gcr'),
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        giftCodeRedemptions.push(row);
        return { ...row };
      },
    },

    // ─────────────────────────── userCharm ───────────────────────────
    userCharm: {
      async upsert({
        where,
        create,
      }: {
        where: { userId_charmId: { userId: string; charmId: string } };
        create: { userId: string; charmId: string };
        update: Record<string, unknown>;
      }) {
        const { userId, charmId } = where.userId_charmId;
        let row = userCharms.find((c) => c.userId === userId && c.charmId === charmId);
        if (row === undefined) {
          row = {
            id: nextId('uc'),
            userId: create.userId,
            charmId: create.charmId,
            equipped: false,
            slot: null,
            createdAt: new Date(Date.now() + seq),
          };
          userCharms.push(row);
        }
        return { ...row };
      },
      async findMany(_args: unknown) {
        // slot loadout 編譯路徑：本測試使用者皆未裝備護符
        return [];
      },
    },

    // ─────────────────────────── charm ───────────────────────────
    charm: {
      async findUnique({ where }: { where: { id: string }; select?: unknown }) {
        const row = charms.find((c) => c.id === where.id);
        return row ? { ...row } : null;
      },
    },

    // ─────────────────────────── adminAuditLog ───────────────────────────
    adminAuditLog: {
      async create({ data }: { data: Omit<FakeAdminAuditLog, 'id' | 'createdAt'> }) {
        const row: FakeAdminAuditLog = {
          id: nextId('audit'),
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        adminAuditLogs.push(row);
        return { ...row };
      },
    },

    // ─────────────────────────── illegalPacketLog ───────────────────────────
    illegalPacketLog: {
      async create({ data }: { data: Omit<FakeIllegalPacketLog, 'id' | 'createdAt'> }) {
        const row: FakeIllegalPacketLog = {
          id: nextId('ipl'),
          createdAt: new Date(),
          ...data,
        };
        illegalPacketLogs.push(row);
        return { ...row };
      },
    },

    // ═══ Jackpot 單行表（id=1，migration 含種子行；併發派彩樂觀鎖測試用） ═══
    jackpot: {
      async findUnique({ where }: { where: { id: number }; select?: unknown }) {
        return where.id === jackpotRow.id ? { ...jackpotRow } : null;
      },
      async findUniqueOrThrow({ where }: { where: { id: number }; select?: unknown }) {
        if (where.id !== jackpotRow.id) throw notFound();
        const view = { ...jackpotRow };
        // 競態注入：讀取後被併發派彩 / flush 搶寫（呼叫方拿到的是舊 version）
        if (bumpsRemaining > 0) {
          bumpsRemaining -= 1;
          jackpotRow.version += 1;
        }
        return view;
      },
      // flush 落庫路徑：無條件 increment
      async update({
        where,
        data,
      }: {
        where: { id: number };
        data: { pool?: { increment: bigint }; version?: { increment: number } };
      }) {
        if (where.id !== jackpotRow.id) throw notFound();
        if (data.pool?.increment !== undefined) jackpotRow.pool += data.pool.increment;
        if (data.version?.increment !== undefined) jackpotRow.version += data.version.increment;
        jackpotRow.updatedAt = new Date();
        return { ...jackpotRow };
      },
      // 派彩樂觀鎖路徑：WHERE version=:v 條件更新（行數 0 → 競態，呼叫方重試）
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
        const row: FakeJackpotHistoryRow = {
          id: nextId('jh'),
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        jackpotHistory.push(row);
        return { ...row };
      },
    },

    // ─────────────────────────── $transaction（快照 + 還原 ＝ 回滾；mutex 序列化） ───────────────────────────
    //
    // ★ mutex：真 PG 以列鎖序列化衝突交易；本 fake 的全域陣列快照在「併發」下
    //   會互相覆蓋（A 提交後 B 回滾還原 B 開始時的舊快照 → 抹掉 A）。以 promise
    //   chain 序列化所有 $transaction，模擬列鎖：快照於前一筆交易提交後才擷取，
    //   雙花/派彩併發測試得到與真 DB 一致的結果（讀取仍在交易外，樂觀鎖競態照常成立）。
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const run = txChain.then(async () => {
        const snapshot = structuredClone({
          users,
          refreshTokens,
          loginLogs,
          betRecords,
          balanceTxs,
          giftCodes,
          giftCodeRedemptions,
          userCharms,
          adminAuditLogs,
          illegalPacketLogs,
          jackpotRow,
          jackpotHistory,
        });
        try {
          return await fn(client);
        } catch (err) {
          users.splice(0, users.length, ...snapshot.users);
          refreshTokens.splice(0, refreshTokens.length, ...snapshot.refreshTokens);
          loginLogs.splice(0, loginLogs.length, ...snapshot.loginLogs);
          betRecords.splice(0, betRecords.length, ...snapshot.betRecords);
          balanceTxs.splice(0, balanceTxs.length, ...snapshot.balanceTxs);
          giftCodes.splice(0, giftCodes.length, ...snapshot.giftCodes);
          giftCodeRedemptions.splice(0, giftCodeRedemptions.length, ...snapshot.giftCodeRedemptions);
          userCharms.splice(0, userCharms.length, ...snapshot.userCharms);
          adminAuditLogs.splice(0, adminAuditLogs.length, ...snapshot.adminAuditLogs);
          illegalPacketLogs.splice(0, illegalPacketLogs.length, ...snapshot.illegalPacketLogs);
          Object.assign(jackpotRow, snapshot.jackpotRow);
          jackpotHistory.splice(0, jackpotHistory.length, ...snapshot.jackpotHistory);
          throw err;
        }
      });
      // 無論成敗都延續鏈（避免一筆失敗卡住後續交易）
      txChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  return {
    prisma: client as unknown as PrismaClient,
    users,
    refreshTokens,
    loginLogs,
    betRecords,
    balanceTxs,
    giftCodes,
    giftCodeRedemptions,
    userCharms,
    charms,
    adminAuditLogs,
    illegalPacketLogs,
    jackpotRow,
    jackpotHistory,
  };
}

export type E2EDb = ReturnType<typeof createE2EDb>;

// ═══════════════════════════════════════════════════════════════════════════
// fake redis（支援 hmac 金鑰 / nonce / seq / 令牌桶所需的全部命令）
// ═══════════════════════════════════════════════════════════════════════════

export function createE2ERedis() {
  const store = new Map<string, string>();
  /** 令牌桶狀態（與 store 分離，避免鍵名碰撞） */
  const buckets = new Map<string, BucketState>();
  const failOn = new Set<string>();

  function check(method: string): void {
    if (failOn.has(method)) throw new Error(`redis ${method} unavailable (injected)`);
  }

  const client = {
    async get(key: string): Promise<string | null> {
      check('get');
      return store.get(key) ?? null;
    },

    /** SET key value [EX ttl] [NX]：NX 且鍵已存在 → null（nonce 防重放語義） */
    async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
      check('set');
      const flags = args.map((a) => String(a).toUpperCase());
      if (flags.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },

    async del(...keys: string[]): Promise<number> {
      check('del');
      let n = 0;
      for (const key of keys) if (store.delete(key)) n += 1;
      return n;
    },

    async mget(...keys: string[]): Promise<(string | null)[]> {
      check('mget');
      return keys.map((k) => store.get(k) ?? null);
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
      return 1; // fake 不模擬 TTL 到期
    },

    /**
     * eval：以「腳本字串參考相等」分派至 production 對應的 JS 實作。
     *   - SEQ_GUARD_LUA：嚴格遞增才寫入（防 seq 倒退/重複）
     *   - TOKEN_BUCKET_LUA：令牌桶（重用 production consumeToken 純函式）
     */
    async eval(script: string, _numKeys: number, ...args: string[]): Promise<unknown> {
      check('eval');

      if (script === SEQ_GUARD_LUA) {
        const key = args[0]!;
        const candidate = Number(args[1]);
        const ttl = args[2]; // 不模擬 TTL，僅保留語義
        void ttl;
        const current = Number(store.get(key) ?? '-1');
        if (Number.isNaN(candidate)) return 0;
        if (candidate > current) {
          store.set(key, String(candidate));
          return 1;
        }
        return 0;
      }

      if (script === TOKEN_BUCKET_LUA) {
        const key = args[0]!;
        const capacity = Number(args[1]);
        const rate = Number(args[2]);
        const now = Number(args[3]);
        const cost = Number(args[4]);
        const state = buckets.get(key) ?? null;
        const result = consumeToken(state, { capacity, refillPerSec: rate }, now, cost);
        buckets.set(key, result.state);
        return [result.allowed ? 1 : 0, result.retryAfterMs];
      }

      throw new Error('fake redis eval: 未知腳本（請在 e2e-fakes 補上對應實作）');
    },
  };

  return {
    redis: client as unknown as Redis,
    store,
    buckets,
    failOn,
  };
}

export type E2ERedis = ReturnType<typeof createE2ERedis>;
