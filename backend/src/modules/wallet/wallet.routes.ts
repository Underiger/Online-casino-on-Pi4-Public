/**
 * Wallet 路由（掛載於 /api/wallet，見 app.ts）。
 *
 * GET /balance       — 餘額查詢（含樂觀鎖 version）
 * GET /transactions  — 個人交易紀錄分頁（可依 TxType 篩選）
 *
 * 注意：本模組「不」提供任何寫入端點——debit/credit 僅供其他模組
 * （slot/roulette/daily/admin…）以 service 呼叫，外部無直接 API。
 * BigInt 欄位依 docs/04_API_SPEC.md §1.6 序列化為字串。
 */
import type { FastifyPluginAsync } from 'fastify';
import { parse } from '../../shared/validation.js';
import { createWalletService } from './wallet.service.js';
import { TxListQuerySchema } from './wallet.types.js';

const walletRoutes: FastifyPluginAsync = async (app) => {
  const service = createWalletService(app.prisma);

  app.get('/balance', { preHandler: [app.authenticate] }, async (request) => {
    const { balance, version } = await service.getBalance(request.user.sub);
    return { balance: balance.toString(), version };
  });

  app.get('/transactions', { preHandler: [app.authenticate] }, async (request) => {
    const query = parse(TxListQuerySchema, request.query);
    const result = await service.listTransactions(request.user.sub, query);
    return {
      items: result.items.map((item) => ({
        id: item.id,
        type: item.type,
        delta: item.delta.toString(),
        balanceBefore: item.balanceBefore.toString(),
        balanceAfter: item.balanceAfter.toString(),
        refId: item.refId,
        memo: item.memo,
        createdAt: item.createdAt.toISOString(),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  });
};

export default walletRoutes;
