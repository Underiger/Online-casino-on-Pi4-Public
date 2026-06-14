/**
 * record.service 單元測試（M22）。
 *
 * 採 in-memory fake prisma，聚焦：
 *   - 分頁（skip/take 計算、totalPages）
 *   - 過濾條件組裝（userId / result / gameType / type / 時間範圍）
 *   - BigInt 序列化（amount/payout/delta 等欄位以 toString 輸出）
 *   - 邊界：空結果集 totalPages=0
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createRecordService } from '../../src/modules/record/record.service.js';

// ═══════════════════════════════════ fake prisma ═══════════════════════════════

type WhereArg = Record<string, unknown>;
type SelectArg = Record<string, boolean>;
type QueryArg = {
  where?: WhereArg;
  orderBy?: unknown;
  skip?: number;
  take?: number;
  select?: SelectArg;
};

function matchesWhere(row: Record<string, unknown>, where?: WhereArg): boolean {
  if (where === undefined) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === null || v === undefined) continue;
    const cell = row[k];
    if (typeof v === 'object' && !Array.isArray(v)) {
      // DateTimeFilter or range
      const filter = v as { gte?: Date; lte?: Date; gt?: Date; lt?: Date };
      if (cell instanceof Date || typeof cell === 'string') {
        const d = cell instanceof Date ? cell : new Date(cell);
        if (filter.gte !== undefined && d < filter.gte) return false;
        if (filter.lte !== undefined && d > filter.lte) return false;
        if (filter.gt !== undefined && d <= filter.gt) return false;
        if (filter.lt !== undefined && d >= filter.lt) return false;
      }
    } else {
      if (cell !== v) return false;
    }
  }
  return true;
}

function buildFakeTable<T extends Record<string, unknown>>(rows: T[]) {
  return {
    findMany({ where, skip = 0, take }: QueryArg): Promise<T[]> {
      const filtered = rows.filter((r) => matchesWhere(r, where));
      const sliced = take !== undefined ? filtered.slice(skip, skip + take) : filtered.slice(skip);
      return Promise.resolve(sliced);
    },
    count({ where }: { where?: WhereArg } = {}): Promise<number> {
      return Promise.resolve(rows.filter((r) => matchesWhere(r, where)).length);
    },
  };
}

function createFakePrisma(seed: {
  loginLogs?: Record<string, unknown>[];
  betRecords?: Record<string, unknown>[];
  balanceTransactions?: Record<string, unknown>[];
}) {
  return {
    loginLog: buildFakeTable(seed.loginLogs ?? []),
    betRecord: buildFakeTable(seed.betRecords ?? []),
    balanceTransaction: buildFakeTable(seed.balanceTransactions ?? []),
  } as unknown as PrismaClient;
}

// ═══════════════════════════════════ test data ═════════════════════════════════

const NOW = new Date('2026-06-01T12:00:00Z');
const BEFORE = new Date('2026-05-31T00:00:00Z');
const AFTER = new Date('2026-06-02T00:00:00Z');

const loginLogs = [
  { id: 'l-1', userId: 'u-1', username: 'alice', ip: '1.1.1.1', userAgent: 'chrome', result: 'SUCCESS', createdAt: NOW },
  { id: 'l-2', userId: 'u-2', username: 'bob', ip: '2.2.2.2', userAgent: 'safari', result: 'WRONG_PASSWORD', createdAt: BEFORE },
  { id: 'l-3', userId: null, username: 'ghost', ip: '3.3.3.3', userAgent: 'bot', result: 'BANNED', createdAt: AFTER },
];

const betRecords = [
  { id: 'b-1', userId: 'u-1', gameType: 'SLOT', amount: 100n, payout: 0n, detail: {}, roundId: null, createdAt: NOW },
  { id: 'b-2', userId: 'u-2', gameType: 'ROULETTE', amount: 50n, payout: 100n, detail: {}, roundId: 'r-1', createdAt: BEFORE },
];

const balanceTransactions = [
  { id: 't-1', userId: 'u-1', type: 'BET', delta: -100n, balanceBefore: 1000n, balanceAfter: 900n, refId: 'b-1', memo: null, createdAt: NOW },
  { id: 't-2', userId: 'u-1', type: 'PAYOUT', delta: 200n, balanceBefore: 900n, balanceAfter: 1100n, refId: null, memo: 'win', createdAt: BEFORE },
  { id: 't-3', userId: 'u-2', type: 'ADMIN_ADJUST', delta: 500n, balanceBefore: 0n, balanceAfter: 500n, refId: null, memo: null, createdAt: AFTER },
];

// ═══════════════════════════════════ tests ════════════════════════════════════

describe('record.service：listLoginLogs', () => {
  let service: ReturnType<typeof createRecordService>;

  beforeEach(() => {
    service = createRecordService({ prisma: createFakePrisma({ loginLogs }) });
  });

  it('預設分頁（page=1, limit=20）回傳全部 3 筆', async () => {
    const res = await service.listLoginLogs({ page: 1, limit: 20 });
    expect(res.total).toBe(3);
    expect(res.page).toBe(1);
    expect(res.totalPages).toBe(1);
    expect(res.data).toHaveLength(3);
  });

  it('limit=1, page=2 回傳第 2 筆', async () => {
    const res = await service.listLoginLogs({ page: 2, limit: 1 });
    expect(res.data).toHaveLength(1);
    expect(res.total).toBe(3);
    expect(res.totalPages).toBe(3);
  });

  it('過濾 userId=u-1 → 1 筆', async () => {
    const res = await service.listLoginLogs({ page: 1, limit: 20, userId: 'u-1' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.userId).toBe('u-1');
  });

  it('過濾 result=SUCCESS → 1 筆', async () => {
    const res = await service.listLoginLogs({ page: 1, limit: 20, result: 'SUCCESS' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.result).toBe('SUCCESS');
  });

  it('時間範圍過濾（from/to）→ 只含窗口內紀錄', async () => {
    const res = await service.listLoginLogs({
      page: 1,
      limit: 20,
      from: new Date('2026-05-30T00:00:00Z').toISOString(),
      to: new Date('2026-06-01T23:59:59Z').toISOString(),
    });
    // NOW 與 BEFORE 都在範圍內，AFTER 不在
    expect(res.total).toBe(2);
  });

  it('createdAt 以 ISO 字串輸出', async () => {
    const res = await service.listLoginLogs({ page: 1, limit: 20 });
    expect(typeof res.data[0]!.createdAt).toBe('string');
  });

  it('空結果集 → totalPages=0', async () => {
    const svc = createRecordService({ prisma: createFakePrisma({ loginLogs: [] }) });
    const res = await svc.listLoginLogs({ page: 1, limit: 20 });
    expect(res.total).toBe(0);
    expect(res.totalPages).toBe(0);
  });
});

describe('record.service：listBetRecords', () => {
  let service: ReturnType<typeof createRecordService>;

  beforeEach(() => {
    service = createRecordService({ prisma: createFakePrisma({ betRecords }) });
  });

  it('回傳全部 2 筆，BigInt 序列化為 string', async () => {
    const res = await service.listBetRecords({ page: 1, limit: 20 });
    expect(res.total).toBe(2);
    expect(typeof res.data[0]!.amount).toBe('string');
    expect(typeof res.data[0]!.payout).toBe('string');
    expect(res.data[0]!.amount).toBe('100');
  });

  it('過濾 gameType=SLOT → 1 筆', async () => {
    const res = await service.listBetRecords({ page: 1, limit: 20, gameType: 'SLOT' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.gameType).toBe('SLOT');
  });

  it('過濾 userId=u-2 → 1 筆，payout 正確', async () => {
    const res = await service.listBetRecords({ page: 1, limit: 20, userId: 'u-2' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.payout).toBe('100');
    expect(res.data[0]!.roundId).toBe('r-1');
  });
});

describe('record.service：listTransactions', () => {
  let service: ReturnType<typeof createRecordService>;

  beforeEach(() => {
    service = createRecordService({ prisma: createFakePrisma({ balanceTransactions }) });
  });

  it('回傳全部 3 筆，BigInt 欄位序列化', async () => {
    const res = await service.listTransactions({ page: 1, limit: 20 });
    expect(res.total).toBe(3);
    const first = res.data[0]!;
    expect(typeof first.delta).toBe('string');
    expect(typeof first.balanceBefore).toBe('string');
    expect(typeof first.balanceAfter).toBe('string');
  });

  it('過濾 type=ADMIN_ADJUST → 1 筆', async () => {
    const res = await service.listTransactions({ page: 1, limit: 20, type: 'ADMIN_ADJUST' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.type).toBe('ADMIN_ADJUST');
    expect(res.data[0]!.delta).toBe('500');
  });

  it('過濾 userId=u-1 → 2 筆', async () => {
    const res = await service.listTransactions({ page: 1, limit: 20, userId: 'u-1' });
    expect(res.total).toBe(2);
  });

  it('totalPages 計算正確（3 筆, limit=2 → 2 頁）', async () => {
    const res = await service.listTransactions({ page: 1, limit: 2 });
    expect(res.totalPages).toBe(2);
    expect(res.data).toHaveLength(2);
  });

  it('page=2, limit=2 → 回傳第 3 筆', async () => {
    const res = await service.listTransactions({ page: 2, limit: 2 });
    expect(res.data).toHaveLength(1);
  });

  it('memo null 保留、refId 正確透傳', async () => {
    const res = await service.listTransactions({ page: 1, limit: 20, type: 'BET' });
    expect(res.data[0]!.refId).toBe('b-1');
    expect(res.data[0]!.memo).toBeNull();
  });
});
