/**
 * Daily System REST 路由（掛載於 /api/daily，見 app.ts；docs/04_API_SPEC.md §3.7）。
 *
 * POST /login              — 每日首次登入獎勵（認證 ✓）
 * GET  /tasks              — 查詢今日任務進度（認證 ✓）
 * POST /tasks/:progressId/claim — 領取完成任務獎勵（認證 ✓）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createDailyService } from './daily.service.js';
import { createAchievementService } from '../achievement/achievement.service.js';

const ClaimParamsSchema = z.object({
  progressId: z.string().min(1),
});

const dailyRoutes: FastifyPluginAsync = async (app) => {
  const wallet = createWalletService(app.prisma);
  const daily = createDailyService({
    prisma: app.prisma,
    redis: app.redis,
    wallet,
    log: app.log,
  });
  const achievement = createAchievementService({ prisma: app.prisma, wallet, log: app.log });

  // 每日登入獎勵
  app.post('/login', { preHandler: [app.authenticate] }, async (request) => {
    const result = await daily.claimDailyLogin(request.user.sub);
    // M20：LOGIN_STREAK_7 成就（fire-and-forget）
    if (result.streak >= 7) {
      const io = app.hasDecorator('io') ? app.io : null;
      const achIo = io
        ? { to: (room: string) => ({ emit: (ev: string, d: unknown): void => void io.to(room).emit(ev, d) }) }
        : undefined;
      void achievement.tryUnlock(request.user.sub, 'LOGIN_STREAK_7', achIo).catch(() => {});
    }
    return result;
  });

  // 今日任務進度查詢
  app.get('/tasks', { preHandler: [app.authenticate] }, async (request) => {
    return daily.getDailyTasks(request.user.sub);
  });

  // 領取完成任務獎勵
  app.post('/tasks/:progressId/claim', { preHandler: [app.authenticate] }, async (request) => {
    const { progressId } = parse(ClaimParamsSchema, request.params);
    return daily.claimTask(request.user.sub, progressId);
  });
};

export default dailyRoutes;
