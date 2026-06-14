/**
 * gift-code.service 單元測試（M22）。
 *
 * 採 in-memory fake prisma（$transaction 以深拷貝快照 + 拋錯還原，與 admin.service.spec 同款）
 * + 真實 wallet.service（餘額鐵律；credit 走 BalanceTransaction 落帳）。
 *
 * 覆蓋：
 *   - 正常兌換（無護符 / 有護符）→ 餘額增加、GiftCodeRedemption 建立
 *   - 碼不存在      → GIFT_CODE_NOT_FOUND
 *   - 碼已過期      → GIFT_CODE_EXPIRED
 *   - 碼已用完      → GIFT_CODE_ALREADY_USED
 *   - 同人重複兌換  → GIFT_CODE_ALREADY_REDEEMED（P2002 捕捉）
 *   - 條件更新競態  → GIFT_CODE_ALREADY_USED（count === 0 路徑）
 *   - 大小寫不敏感  → 正常兌換
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createGiftCodeService } from '../../src/modules/gift-code/gift-code.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { AppError } from '../../src/shared/errors.js';

// ═══════════════════════════════════ fake prisma ═══════════════════════════════

interface FakeGiftCode {
  id: string;
  code: string;
  amount: bigint;
  charmId: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  createdAt: Date;
}

interface FakeUser {
  id: string;
  balance: bigint;
  version: number;
}

interface FakeRedemption {
  id: string;
  giftCodeId: string;
  userId: string;
  createdAt: Date;
}

interface FakeTx {
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

interface FakeCharm {
  id: string;
  name: string;
}

interface FakeUserCharm {
  userId: string;
  charmId: string;
}

function createFakeDb(opts?: {
  bumpUsedCountAfterRead?: boolean;
}) {
  const giftCodes: FakeGiftCode[] = [];
  const users: FakeUser[] = [];
  const redemptions: FakeRedemption[] = [];
  const txs: FakeTx[] = [];
  const charms: FakeCharm[] = [];
  const userCharms: FakeUserCharm[] = [];

  const state = { giftCodes, users, redemptions, txs, charms, userCharms };

  let idCounter = 0;
  function nextId(): string {
    idCounter += 1;
    return `id-${idCounter}`;
  }

  // $transaction: deep-clone snapshot → restore on error
  async function $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const snapshot = {
      giftCodes: structuredClone(state.giftCodes),
      users: structuredClone(state.users),
      redemptions: structuredClone(state.redemptions),
      txs: structuredClone(state.txs),
      userCharms: structuredClone(state.userCharms),
    };
    try {
      return await fn(buildClient());
    } catch (err) {
      state.giftCodes.splice(0, Infinity, ...snapshot.giftCodes);
      state.users.splice(0, Infinity, ...snapshot.users);
      state.redemptions.splice(0, Infinity, ...snapshot.redemptions);
      state.txs.splice(0, Infinity, ...snapshot.txs);
      state.userCharms.splice(0, Infinity, ...snapshot.userCharms);
      throw err;
    }
  }

  // Shared Prisma client builder (used both for top-level and inside tx)
  function buildClient() {
    return {
      giftCode: {
        findUnique({ where }: { where: { code?: string; id?: string } }) {
          const gc = state.giftCodes.find(
            (g) => (where.code !== undefined ? g.code === where.code : g.id === where.id),
          );
          // Simulate external bump AFTER initial read (for race condition test)
          if (opts?.bumpUsedCountAfterRead === true && gc !== undefined) {
            gc.usedCount = gc.maxUses; // exhaust before tx runs
          }
          return Promise.resolve(gc ?? null);
        },
        updateMany({
          where,
          data,
        }: {
          where: { id: string; usedCount: { lt: number }; expiresAt: { gt: Date } };
          data: { usedCount: { increment: number } };
        }) {
          const gc = state.giftCodes.find((g) => g.id === where.id);
          if (
            gc === undefined ||
            gc.usedCount >= where.usedCount.lt ||
            gc.expiresAt <= where.expiresAt.gt
          ) {
            return Promise.resolve({ count: 0 });
          }
          gc.usedCount += data.usedCount.increment;
          return Promise.resolve({ count: 1 });
        },
      },
      giftCodeRedemption: {
        create({ data }: { data: { giftCodeId: string; userId: string } }) {
          const dup = state.redemptions.find(
            (r) => r.giftCodeId === data.giftCodeId && r.userId === data.userId,
          );
          if (dup !== undefined) {
            const err = new Error('Unique constraint failed');
            (err as unknown as Record<string, string>)['code'] = 'P2002';
            throw err;
          }
          const rec: FakeRedemption = {
            id: nextId(),
            giftCodeId: data.giftCodeId,
            userId: data.userId,
            createdAt: new Date(),
          };
          state.redemptions.push(rec);
          return Promise.resolve({ id: rec.id });
        },
      },
      user: {
        findUniqueOrThrow({ where }: { where: { id: string } }) {
          const u = state.users.find((u) => u.id === where.id);
          if (u === undefined) throw new Error('User not found');
          return Promise.resolve({ balance: u.balance, version: u.version });
        },
        updateMany({
          where,
          data,
        }: {
          where: { id: string; balance?: { gte: bigint } };
          data: { balance: { increment?: bigint; decrement?: bigint }; version: { increment: number } };
        }) {
          const u = state.users.find((uu) => uu.id === where.id);
          if (u === undefined) return Promise.resolve({ count: 0 });
          if (where.balance?.gte !== undefined && u.balance < where.balance.gte) {
            return Promise.resolve({ count: 0 });
          }
          if (data.balance.increment !== undefined) u.balance += data.balance.increment;
          if (data.balance.decrement !== undefined) u.balance -= data.balance.decrement;
          u.version += data.version.increment;
          return Promise.resolve({ count: 1 });
        },
        findUnique({ where }: { where: { id: string } }) {
          const u = state.users.find((uu) => uu.id === where.id);
          return Promise.resolve(u ?? null);
        },
      },
      balanceTransaction: {
        create({ data }: { data: Record<string, unknown> }) {
          const rec: FakeTx = {
            id: nextId(),
            userId: data['userId'] as string,
            type: data['type'] as string,
            delta: data['delta'] as bigint,
            balanceBefore: data['balanceBefore'] as bigint,
            balanceAfter: data['balanceAfter'] as bigint,
            refId: (data['refId'] as string | null) ?? null,
            memo: (data['memo'] as string | null) ?? null,
            createdAt: new Date(),
          };
          state.txs.push(rec);
          return Promise.resolve(rec);
        },
      },
      userCharm: {
        upsert({
          where,
          create,
        }: {
          where: { userId_charmId: { userId: string; charmId: string } };
          create: { userId: string; charmId: string };
          update: Record<string, unknown>;
        }) {
          const existing = state.userCharms.find(
            (uc) =>
              uc.userId === where.userId_charmId.userId &&
              uc.charmId === where.userId_charmId.charmId,
          );
          if (existing === undefined) {
            state.userCharms.push({ userId: create.userId, charmId: create.charmId });
          }
          return Promise.resolve({});
        },
      },
      charm: {
        findUnique({ where }: { where: { id: string } }) {
          return Promise.resolve(state.charms.find((c) => c.id === where.id) ?? null);
        },
      },
      $transaction,
    };
  }

  return { state, db: buildClient() as unknown as PrismaClient };
}

// ═══════════════════════════════════ helpers ═══════════════════════════════════

function futureDate(daysFromNow = 7): Date {
  return new Date(Date.now() + daysFromNow * 86400_000);
}

function pastDate(daysAgo = 1): Date {
  return new Date(Date.now() - daysAgo * 86400_000);
}

// ═══════════════════════════════════ tests ════════════════════════════════════

describe('gift-code.service：redeemGiftCode', () => {
  let state: ReturnType<typeof createFakeDb>['state'];
  let db: PrismaClient;
  let service: ReturnType<typeof createGiftCodeService>;

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    db = fake.db;
    service = createGiftCodeService({ prisma: db, wallet: createWalletService(db) });

    // Seed a valid gift code
    state.giftCodes.push({
      id: 'gc-1',
      code: 'TESTCODE1234ABCD',
      amount: 500n,
      charmId: null,
      maxUses: 1,
      usedCount: 0,
      expiresAt: futureDate(),
      createdAt: new Date(),
    });
    // Seed a player
    state.users.push({ id: 'user-1', balance: 1000n, version: 0 });
  });

  it('成功兌換：餘額增加 500、建立 Redemption、回傳正確 response', async () => {
    const res = await service.redeemGiftCode('user-1', 'TESTCODE1234ABCD');

    expect(res).toMatchObject({
      success: true,
      amount: '500',
      charmId: null,
      charmName: null,
    });
    expect(BigInt(res.newBalance)).toBe(1500n);
    expect(state.users[0]!.balance).toBe(1500n);
    expect(state.redemptions).toHaveLength(1);
    expect(state.txs).toHaveLength(1);
    expect(state.giftCodes[0]!.usedCount).toBe(1);
  });

  it('大小寫不敏感：小寫輸入正常兌換', async () => {
    const res = await service.redeemGiftCode('user-1', 'testcode1234abcd');
    expect(res.success).toBe(true);
  });

  it('含護符的兌換：授予護符並回傳 charmName', async () => {
    state.giftCodes[0]!.charmId = 'charm-1';
    state.charms.push({ id: 'charm-1', name: '幸運四葉草' });

    const res = await service.redeemGiftCode('user-1', 'TESTCODE1234ABCD');

    expect(res.charmId).toBe('charm-1');
    expect(res.charmName).toBe('幸運四葉草');
    expect(state.userCharms).toHaveLength(1);
  });

  it('碼不存在 → GIFT_CODE_NOT_FOUND', async () => {
    await expect(service.redeemGiftCode('user-1', 'NOEXIST')).rejects.toMatchObject({
      code: 'GIFT_CODE_NOT_FOUND',
    });
    expect(state.redemptions).toHaveLength(0);
    expect(state.txs).toHaveLength(0);
  });

  it('碼已過期 → GIFT_CODE_EXPIRED', async () => {
    state.giftCodes[0]!.expiresAt = pastDate();

    await expect(service.redeemGiftCode('user-1', 'TESTCODE1234ABCD')).rejects.toMatchObject({
      code: 'GIFT_CODE_EXPIRED',
    });
    expect(state.txs).toHaveLength(0);
  });

  it('碼已用完（usedCount >= maxUses）→ GIFT_CODE_ALREADY_USED', async () => {
    state.giftCodes[0]!.usedCount = 1;

    await expect(service.redeemGiftCode('user-1', 'TESTCODE1234ABCD')).rejects.toMatchObject({
      code: 'GIFT_CODE_ALREADY_USED',
    });
    expect(state.txs).toHaveLength(0);
  });

  it('同人重複兌換（P2002）→ GIFT_CODE_ALREADY_REDEEMED、交易回滾', async () => {
    // 先兌換一次
    await service.redeemGiftCode('user-1', 'TESTCODE1234ABCD');
    const balanceAfterFirst = state.users[0]!.balance;

    // 重置 usedCount 讓其通過快速前置檢查（只測 P2002 路徑）
    state.giftCodes[0]!.usedCount = 0;

    await expect(service.redeemGiftCode('user-1', 'TESTCODE1234ABCD')).rejects.toMatchObject({
      code: 'GIFT_CODE_ALREADY_REDEEMED',
    });
    // 回滾：餘額不再增加
    expect(state.users[0]!.balance).toBe(balanceAfterFirst);
  });

  it('條件更新 count=0（競態）→ GIFT_CODE_ALREADY_USED、完整回滾', async () => {
    const fake = createFakeDb({ bumpUsedCountAfterRead: true });
    const svc = createGiftCodeService({
      prisma: fake.db,
      wallet: createWalletService(fake.db),
    });
    fake.state.giftCodes.push({
      id: 'gc-race',
      code: 'RACECODE123456AB',
      amount: 100n,
      charmId: null,
      maxUses: 1,
      usedCount: 0,
      expiresAt: futureDate(),
      createdAt: new Date(),
    });
    fake.state.users.push({ id: 'user-race', balance: 0n, version: 0 });

    await expect(svc.redeemGiftCode('user-race', 'RACECODE123456AB')).rejects.toMatchObject({
      code: 'GIFT_CODE_ALREADY_USED',
    });
    // 回滾確認：餘額不變，tx 與 redemption 清零
    expect(fake.state.users[0]!.balance).toBe(0n);
    expect(fake.state.txs).toHaveLength(0);
    expect(fake.state.redemptions).toHaveLength(0);
  });

  it('兌換失敗時 usedCount 回滾', async () => {
    // 移除玩家讓 wallet.credit 失敗（NotFoundError）
    state.users.length = 0;

    await expect(service.redeemGiftCode('user-1', 'TESTCODE1234ABCD')).rejects.toThrow();
    // usedCount 應回滾至 0
    expect(state.giftCodes[0]!.usedCount).toBe(0);
  });
});
