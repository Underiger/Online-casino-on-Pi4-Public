/**
 * Wallet 模組（02_TDD §5.6、03_DATABASE_DESIGN §0 核心約束）。
 *
 * ★ 全專案唯一允許修改 users.balance 的位置 ★
 * （ESLint no-restricted-syntax 攔截其他模組的 prisma.user.update*；
 *   本目錄為唯一 override 放行區——見 backend/eslint.config.js）
 *
 * 一致性設計：
 * - 扣款 = 條件更新：`UPDATE users SET balance = balance - :amt, version = version + 1
 *   WHERE id = :id AND balance >= :amt`，受影響行數 ≠ 1 即拋錯回滾——
 *   READ COMMITTED 下兩個併發扣款不可能都通過餘額檢查（檢查與扣減同一條原子語句）。
 * - 每次異動同交易寫入 BalanceTransaction(before/after/delta/type/refId)，可全帳回放；
 *   對帳腳本 scripts/audit-balance.ts 驗證 SUM(delta) 與現值。
 * - version 樂觀鎖：條件更新已消滅超扣競態，version 仍隨每次異動 +1，
 *   供異常偵測（版本跳號＝有人繞過 wallet）與 Jackpot 派彩等高風險路徑複用。
 * - balanceBefore 推導：updateMany 後同交易內讀回 balance——PG 的行級鎖
 *   自 UPDATE 起持有至 commit，併發寫者會阻塞於 updateMany，故讀回值
 *   必為「本次異動後」的值，before = after ∓ amount 恆成立。
 */
import type { Prisma, PrismaClient, TxType } from '@prisma/client';
import {
  InsufficientBalanceError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import type {
  BalanceResult,
  TxListQuery,
  TxListResult,
  WalletMutateOptions,
  WalletMutationResult,
} from './wallet.types.js';

export function createWalletService(prisma: PrismaClient) {
  /** 在呼叫方交易內執行，或自行開一筆（debit/credit 與 Tx 落帳必須原子） */
  function withTx<T>(
    tx: Prisma.TransactionClient | undefined,
    fn: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return tx !== undefined ? fn(tx) : prisma.$transaction(fn);
  }

  function assertPositiveAmount(amount: bigint): void {
    if (amount <= 0n) {
      throw new ValidationError('金額必須為正整數 Coin');
    }
  }

  /** 條件更新後讀回現值（同交易；見檔頭 balanceBefore 推導說明） */
  async function readBack(
    client: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ balance: bigint; version: number }> {
    return client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { balance: true, version: true },
    });
  }

  return {
    /**
     * 扣款（下注、消費）。餘額不足拋 InsufficientBalanceError（422），
     * 整筆交易回滾、不留任何 BalanceTransaction。
     */
    async debit(
      userId: string,
      amount: bigint,
      type: TxType,
      options: WalletMutateOptions = {},
    ): Promise<WalletMutationResult> {
      assertPositiveAmount(amount);

      return withTx(options.tx, async (client) => {
        // ★ 核心約束：條件更新 + 行數檢查（03_DATABASE_DESIGN §0）
        const { count } = await client.user.updateMany({
          where: { id: userId, balance: { gte: amount } },
          data: { balance: { decrement: amount }, version: { increment: 1 } },
        });
        if (count !== 1) {
          // 區分「使用者不存在」與「餘額不足」——錯誤碼語義不同
          const exists = await client.user.findUnique({
            where: { id: userId },
            select: { id: true },
          });
          if (exists === null) throw new NotFoundError('使用者不存在');
          throw new InsufficientBalanceError();
        }

        const after = await readBack(client, userId);
        const record = await client.balanceTransaction.create({
          data: {
            userId,
            type,
            delta: -amount,
            balanceBefore: after.balance + amount,
            balanceAfter: after.balance,
            refId: options.refId ?? null,
            memo: options.memo ?? null,
          },
        });
        return { balance: after.balance, version: after.version, transactionId: record.id };
      });
    },

    /**
     * 入帳（賠付、獎勵、兌換、管理員加幣）。
     * 同樣走 updateMany + 行數檢查：使用者不存在回 404 而非 P2025 例外。
     */
    async credit(
      userId: string,
      amount: bigint,
      type: TxType,
      options: WalletMutateOptions = {},
    ): Promise<WalletMutationResult> {
      assertPositiveAmount(amount);

      return withTx(options.tx, async (client) => {
        const { count } = await client.user.updateMany({
          where: { id: userId },
          data: { balance: { increment: amount }, version: { increment: 1 } },
        });
        if (count !== 1) {
          throw new NotFoundError('使用者不存在');
        }

        const after = await readBack(client, userId);
        const record = await client.balanceTransaction.create({
          data: {
            userId,
            type,
            delta: amount,
            balanceBefore: after.balance - amount,
            balanceAfter: after.balance,
            refId: options.refId ?? null,
            memo: options.memo ?? null,
          },
        });
        return { balance: after.balance, version: after.version, transactionId: record.id };
      });
    },

    /** 餘額查詢（含樂觀鎖版本，前端顯示一律以伺服器回傳覆蓋） */
    async getBalance(userId: string): Promise<BalanceResult> {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { balance: true, version: true },
      });
      if (user === null) throw new NotFoundError('使用者不存在');
      return user;
    },

    /** 交易紀錄分頁查詢（個人帳目，docs/04_API_SPEC.md §3.3） */
    async listTransactions(userId: string, query: TxListQuery): Promise<TxListResult> {
      const where = {
        userId,
        ...(query.type !== undefined ? { type: query.type } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.balanceTransaction.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          select: {
            id: true,
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
      return { items, total, page: query.page, limit: query.limit };
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
