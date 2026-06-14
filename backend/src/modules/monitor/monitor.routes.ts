/**
 * Monitor 路由（掛載於 /api/admin；M24）。
 *
 * GET /monitor — adminOnly（[authenticate, requireAdminRole]）；
 *   回傳 SystemStatsRes：CPU / 記憶體 / 磁碟 / 線上人數 / 活躍房間 / 行程 uptime。
 *
 * 依 admin.routes.ts 分層慣例：高危路由需 requireReverify，本端點僅唯讀，
 * 不操作資料，adminOnly 即足夠。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../../shared/errors.js';
import { createMonitorService, type MonitorService } from './monitor.service.js';

export interface MonitorRoutesOptions {
  /** 測試注入：覆寫整個 service */
  service?: MonitorService;
}

const monitorRoutes: FastifyPluginAsync<MonitorRoutesOptions> = async (app, opts) => {
  const service =
    opts.service ??
    createMonitorService({
      redis: app.redis,
      log: app.log,
    });

  async function requireAdminRole(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (request.user.role !== 'ADMIN') {
      throw new ForbiddenError('需要管理員權限');
    }
  }

  const adminOnly = { preHandler: [app.authenticate, requireAdminRole] };

  app.get('/monitor', adminOnly, async () => service.getStats());
};

export default monitorRoutes;
