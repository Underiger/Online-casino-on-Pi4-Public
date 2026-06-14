/**
 * 管理後台紀錄查詢路由（M22）。
 *
 * 掛載於 /api/admin/records（app.ts 另設 prefix）。
 * 所有路由：[authenticate, requireAdminRole]（JWT + role===ADMIN）。
 *
 * GET /login        — 分頁查 LoginLog
 * GET /bets         — 分頁查 BetRecord
 * GET /transactions — 分頁查 BalanceTransaction
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../../shared/errors.js';
import { parse } from '../../shared/validation.js';
import { createRecordService, type RecordService } from './record.service.js';
import {
  BetRecordQuerySchema,
  LoginRecordQuerySchema,
  TxRecordQuerySchema,
} from './record.types.js';

export interface RecordRoutesOptions {
  /** 測試注入：覆寫整個 service */
  service?: RecordService;
}

const recordRoutes: FastifyPluginAsync<RecordRoutesOptions> = async (app, opts) => {
  const service =
    opts.service ??
    createRecordService({ prisma: app.prisma });

  async function requireAdminRole(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (request.user.role !== 'ADMIN') {
      throw new ForbiddenError('需要管理員權限');
    }
  }

  const adminOnly = { preHandler: [app.authenticate, requireAdminRole] };

  /** GET /api/admin/records/login */
  app.get('/login', adminOnly, async (request) => {
    const query = parse(LoginRecordQuerySchema, request.query);
    return service.listLoginLogs(query);
  });

  /** GET /api/admin/records/bets */
  app.get('/bets', adminOnly, async (request) => {
    const query = parse(BetRecordQuerySchema, request.query);
    return service.listBetRecords(query);
  });

  /** GET /api/admin/records/transactions */
  app.get('/transactions', adminOnly, async (request) => {
    const query = parse(TxRecordQuerySchema, request.query);
    return service.listTransactions(query);
  });
};

export default recordRoutes;
