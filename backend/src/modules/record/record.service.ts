/**
 * 管理後台紀錄查詢服務（M22；02_TDD §5.7）。
 *
 * 職責：
 *   listLoginLogs      — 分頁查 LoginLog（過濾：userId / result / 時間範圍）
 *   listBetRecords     — 分頁查 BetRecord（過濾：userId / gameType / 時間範圍）
 *   listTransactions   — 分頁查 BalanceTransaction（過濾：userId / type / 時間範圍）
 *
 * 效能：各表均已在 prisma schema 建立 (userId, createdAt) 複合索引 + createdAt BRIN；
 * 分頁採 offset/limit + 平行 count，回傳 totalPages = ceil(total / limit)。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  BetRecordItem,
  BetRecordQuery,
  LoginLogItem,
  LoginRecordQuery,
  PaginatedResult,
  TxRecordItem,
  TxRecordQuery,
} from './record.types.js';

// ─── 型別 ─────────────────────────────────────────────────────────────────────

export interface RecordServiceDeps {
  prisma: PrismaClient;
}

// ─── 輔助 ─────────────────────────────────────────────────────────────────────

function dateRange(
  from: string | undefined,
  to: string | undefined,
): Prisma.DateTimeFilter | undefined {
  if (from === undefined && to === undefined) return undefined;
  const filter: Prisma.DateTimeFilter = {};
  if (from !== undefined) filter.gte = new Date(from);
  if (to !== undefined) filter.lte = new Date(to);
  return filter;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function createRecordService(deps: RecordServiceDeps) {
  const { prisma } = deps;

  // ── 登入紀錄 ────────────────────────────────────────────────────────────────

  async function listLoginLogs(
    query: LoginRecordQuery,
  ): Promise<PaginatedResult<LoginLogItem>> {
    const where: Prisma.LoginLogWhereInput = {};
    if (query.userId !== undefined) where.userId = query.userId;
    if (query.result !== undefined) where.result = query.result;
    const range = dateRange(query.from, query.to);
    if (range !== undefined) where.createdAt = range;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
      prisma.loginLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
        select: {
          id: true,
          userId: true,
          username: true,
          ip: true,
          userAgent: true,
          result: true,
          createdAt: true,
        },
      }),
      prisma.loginLog.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  // ── 下注紀錄 ────────────────────────────────────────────────────────────────

  async function listBetRecords(
    query: BetRecordQuery,
  ): Promise<PaginatedResult<BetRecordItem>> {
    const where: Prisma.BetRecordWhereInput = {};
    if (query.userId !== undefined) where.userId = query.userId;
    if (query.gameType !== undefined) where.gameType = query.gameType;
    const range = dateRange(query.from, query.to);
    if (range !== undefined) where.createdAt = range;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
      prisma.betRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
        select: {
          id: true,
          userId: true,
          gameType: true,
          amount: true,
          payout: true,
          detail: true,
          roundId: true,
          createdAt: true,
        },
      }),
      prisma.betRecord.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        gameType: r.gameType,
        amount: r.amount.toString(),
        payout: r.payout.toString(),
        detail: r.detail,
        roundId: r.roundId,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  // ── 交易紀錄 ────────────────────────────────────────────────────────────────

  async function listTransactions(
    query: TxRecordQuery,
  ): Promise<PaginatedResult<TxRecordItem>> {
    const where: Prisma.BalanceTransactionWhereInput = {};
    if (query.userId !== undefined) where.userId = query.userId;
    if (query.type !== undefined) where.type = query.type;
    const range = dateRange(query.from, query.to);
    if (range !== undefined) where.createdAt = range;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
      prisma.balanceTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
        select: {
          id: true,
          userId: true,
          type: true,
          delta: true,
          balanceBefore: true,
          balanceAfter: true,
          refId: true,
          memo: true,
          createdAt: true,
        },
      }),
      prisma.balanceTransaction.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        type: r.type,
        delta: r.delta.toString(),
        balanceBefore: r.balanceBefore.toString(),
        balanceAfter: r.balanceAfter.toString(),
        refId: r.refId,
        memo: r.memo,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  return { listLoginLogs, listBetRecords, listTransactions };
}

export type RecordService = ReturnType<typeof createRecordService>;
