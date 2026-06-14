/**
 * Wallet service 單元測試（M07 DoD）。
 *
 * fake prisma 重點：updateMany 的「條件檢查 + 變更」在單一同步區塊內完成
 * （無 await 切點），忠實重現 SQL 條件更新的原子語義——
 * 併發 debit 的競態因此與真 DB 同構：兩個請求不可能都通過餘額檢查。
 *
 * 覆蓋：扣款/入帳正常流、餘額不足回滾、不存在使用者、金額驗證、
 * before/after 完整性、version 遞增、併發搶扣只成功正確數量、
 * 混合併發後全帳可回放（對帳不變量）、外部交易組合（tx 傳入不另開交易）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import {
  InsufficientBalanceError,
  NotFoundError,
  ValidationError,
} from '../../src/shared/errors.js';

// ═════════════════ in-memory fake prisma ═════════════════

interface FakeUser {
  id: string;
  balance: bigint;
  version: number;
}

interface FakeTxRecord {
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

function createFakeDb(initialUsers: Array<{ id: string; balance: bigint }>) {
  const users: FakeUser[] = initialUsers.map((u) => ({ ...u, version: 0 }));
  const txRecords: FakeTxRecord[] = [];
  let seq = 0;
  let transactionCalls = 0;

  const client = {
    user: {
      // ★ 條件檢查與變更同步完成（無 await 切點）＝ SQL 條件更新的原子性
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
      async findUnique({ where }: { where: { id: string } }) {
        return users.find((u) => u.id === where.id) ?? null;
      },
      async findUniqueOrThrow({ where }: { where: { id: string } }) {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error('NotFoundError(P2025)');
        return user;
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
      async findMany({
        where,
        skip = 0,
        take = txRecords.length,
      }: {
        where: { userId: string; type?: string };
        orderBy?: unknown;
        skip?: number;
        take?: number;
        select?: unknown;
      }) {
        return txRecords
          .filter(
            (t) =>
              t.userId === where.userId &&
              (where.type === undefined || t.type === where.type),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(skip, skip + take);
      },
      async count({ where }: { where: { userId: string; type?: string } }) {
        return txRecords.filter(
          (t) =>
            t.userId === where.userId &&
            (where.type === undefined || t.type === where.type),
        ).length;
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      transactionCalls += 1;
      return fn(client);
    },
  };

  return {
    prisma: client as unknown as PrismaClient,
    txClient: client as unknown as Prisma.TransactionClient,
    users,
    txRecords,
    transactionCalls: () => transactionCalls,
  };
}

const ALICE = 'user_alice';
const BOB = 'user_bob';

// ═════════════════ debit ═════════════════

describe('debit', () => {
  let db: ReturnType<typeof createFakeDb>;
  let wallet: ReturnType<typeof createWalletService>;

  beforeEach(() => {
    db = createFakeDb([
      { id: ALICE, balance: 500n },
      { id: BOB, balance: 0n },
    ]);
    wallet = createWalletService(db.prisma);
  });

  it('成功扣款：餘額遞減、version +1、Tx 紀錄 before/after/delta 正確', async () => {
    const result = await wallet.debit(ALICE, 100n, 'BET', { refId: 'bet_1' });

    expect(result.balance).toBe(400n);
    expect(result.version).toBe(1);
    expect(db.users[0]).toMatchObject({ balance: 400n, version: 1 });

    expect(db.txRecords).toHaveLength(1);
    expect(db.txRecords[0]).toMatchObject({
      userId: ALICE,
      type: 'BET',
      delta: -100n,
      balanceBefore: 500n,
      balanceAfter: 400n,
      refId: 'bet_1',
    });
    expect(result.transactionId).toBe(db.txRecords[0]!.id);
  });

  it('扣至剛好歸零允許（balance >= amount 含等於）', async () => {
    const result = await wallet.debit(ALICE, 500n, 'BET');
    expect(result.balance).toBe(0n);
  });

  it('餘額不足 → InsufficientBalanceError，餘額不變、無 Tx 紀錄', async () => {
    await expect(wallet.debit(ALICE, 501n, 'BET')).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(db.users[0]).toMatchObject({ balance: 500n, version: 0 });
    expect(db.txRecords).toHaveLength(0);
  });

  it('餘額 0 扣任何正數 → InsufficientBalanceError', async () => {
    await expect(wallet.debit(BOB, 1n, 'BET')).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  });

  it('使用者不存在 → NotFoundError（與餘額不足區分）', async () => {
    await expect(wallet.debit('user_ghost', 100n, 'BET')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('金額 0 或負數 → ValidationError（不碰 DB）', async () => {
    await expect(wallet.debit(ALICE, 0n, 'BET')).rejects.toBeInstanceOf(ValidationError);
    await expect(wallet.debit(ALICE, -100n, 'BET')).rejects.toBeInstanceOf(ValidationError);
    expect(db.txRecords).toHaveLength(0);
    expect(db.users[0]?.version).toBe(0);
  });
});

// ═════════════════ credit ═════════════════

describe('credit', () => {
  let db: ReturnType<typeof createFakeDb>;
  let wallet: ReturnType<typeof createWalletService>;

  beforeEach(() => {
    db = createFakeDb([{ id: ALICE, balance: 500n }]);
    wallet = createWalletService(db.prisma);
  });

  it('成功入帳：餘額遞增、version +1、Tx 紀錄 delta 為正', async () => {
    const result = await wallet.credit(ALICE, 250n, 'PAYOUT', { refId: 'bet_9' });

    expect(result.balance).toBe(750n);
    expect(result.version).toBe(1);
    expect(db.txRecords[0]).toMatchObject({
      type: 'PAYOUT',
      delta: 250n,
      balanceBefore: 500n,
      balanceAfter: 750n,
      refId: 'bet_9',
    });
  });

  it('memo 正確落帳（admin 手動調整場景）', async () => {
    await wallet.credit(ALICE, 1000n, 'ADMIN_ADJUST', { memo: '活動補償' });
    expect(db.txRecords[0]).toMatchObject({ type: 'ADMIN_ADJUST', memo: '活動補償' });
  });

  it('使用者不存在 → NotFoundError', async () => {
    await expect(wallet.credit('user_ghost', 100n, 'PAYOUT')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('金額 0 或負數 → ValidationError', async () => {
    await expect(wallet.credit(ALICE, 0n, 'PAYOUT')).rejects.toBeInstanceOf(ValidationError);
    await expect(wallet.credit(ALICE, -5n, 'PAYOUT')).rejects.toBeInstanceOf(ValidationError);
  });
});

// ═════════════════ 併發競態（M07 DoD 核心） ═════════════════

describe('併發競態', () => {
  it('10 個併發 debit(100) 搶餘額 500 → 恰好 5 成功 5 拒絕，最終餘額 0', async () => {
    const db = createFakeDb([{ id: ALICE, balance: 500n }]);
    const wallet = createWalletService(db.prisma);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => wallet.debit(ALICE, 100n, 'BET')),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientBalanceError);
    }

    expect(db.users[0]?.balance).toBe(0n);
    expect(db.users[0]?.version).toBe(5); // 只有成功者遞增
    expect(db.txRecords).toHaveLength(5); // 失敗者零落帳

    const sum = db.txRecords.reduce((acc, t) => acc + t.delta, 0n);
    expect(sum).toBe(-500n);
  });

  it('兩請求搶扣只夠一筆的餘額 → 恰好一個贏家（02_TDD §5.6 雙花防護）', async () => {
    const db = createFakeDb([{ id: ALICE, balance: 100n }]);
    const wallet = createWalletService(db.prisma);

    const results = await Promise.allSettled([
      wallet.debit(ALICE, 100n, 'BET'),
      wallet.debit(ALICE, 100n, 'BET'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(db.users[0]?.balance).toBe(0n);
    expect(db.txRecords).toHaveLength(1);
  });

  it('混合併發 debit/credit 後全帳可回放（對帳三不變量）', async () => {
    const initial = 1_000n;
    const db = createFakeDb([{ id: ALICE, balance: initial }]);
    const wallet = createWalletService(db.prisma);

    const ops = [
      ...Array.from({ length: 8 }, () => () => wallet.debit(ALICE, 300n, 'BET')),
      ...Array.from({ length: 4 }, () => () => wallet.credit(ALICE, 150n, 'PAYOUT')),
      () => wallet.credit(ALICE, 500n, 'DAILY_REWARD'),
    ];
    await Promise.allSettled(ops.map((op) => op()));

    const finalBalance = db.users[0]!.balance;
    const sum = db.txRecords.reduce((acc, t) => acc + t.delta, 0n);

    // 不變量 3（audit-balance 檢查 3）：初始 + SUM(delta) === 現值
    expect(initial + sum).toBe(finalBalance);
    // 不變量 1：每筆 delta === after - before
    for (const t of db.txRecords) {
      expect(t.delta).toBe(t.balanceAfter - t.balanceBefore);
    }
    // version 與成功異動數一致（version 跳號偵測的基準）
    expect(db.users[0]!.version).toBe(db.txRecords.length);
    // 餘額永不為負
    expect(finalBalance >= 0n).toBe(true);
  });
});

// ═════════════════ 交易組合與查詢 ═════════════════

describe('外部交易組合（tx 傳入）', () => {
  it('傳入 tx 時不另開 $transaction（單一交易內編排——slot spin 模式）', async () => {
    const db = createFakeDb([{ id: ALICE, balance: 500n }]);
    const wallet = createWalletService(db.prisma);

    await wallet.debit(ALICE, 100n, 'BET', { tx: db.txClient });
    await wallet.credit(ALICE, 400n, 'PAYOUT', { tx: db.txClient });
    expect(db.transactionCalls()).toBe(0); // 呼叫方的交易，wallet 不重複開

    await wallet.debit(ALICE, 100n, 'BET'); // 未傳 tx → 自行包一筆
    expect(db.transactionCalls()).toBe(1);
  });
});

describe('getBalance / listTransactions', () => {
  let db: ReturnType<typeof createFakeDb>;
  let wallet: ReturnType<typeof createWalletService>;

  beforeEach(() => {
    db = createFakeDb([{ id: ALICE, balance: 500n }]);
    wallet = createWalletService(db.prisma);
  });

  it('getBalance 回餘額與 version；不存在 → NotFoundError', async () => {
    // fake findUnique 不裁切 select 欄位，故用 toMatchObject 驗證關鍵欄位
    expect(await wallet.getBalance(ALICE)).toMatchObject({ balance: 500n, version: 0 });
    await expect(wallet.getBalance('user_ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listTransactions 分頁與型別篩選', async () => {
    await wallet.debit(ALICE, 100n, 'BET');
    await wallet.credit(ALICE, 50n, 'PAYOUT');
    await wallet.debit(ALICE, 100n, 'BET');

    const all = await wallet.listTransactions(ALICE, { page: 1, limit: 10 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);

    const betsOnly = await wallet.listTransactions(ALICE, {
      page: 1,
      limit: 10,
      type: 'BET',
    });
    expect(betsOnly.total).toBe(2);
    expect(betsOnly.items.every((t) => t.type === 'BET')).toBe(true);

    const page2 = await wallet.listTransactions(ALICE, { page: 2, limit: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.total).toBe(3);
  });
});
