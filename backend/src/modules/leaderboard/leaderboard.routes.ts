/**
 * Leaderboard 路由（掛載於 /api/leaderboard；docs/04_API_SPEC.md §3.9）。
 *
 * GET /:kind — 公開（無需認證），回傳指定類型排行榜（daily/weekly/total）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/validation.js';
import { createLeaderboardService } from './leaderboard.service.js';

const KindParamsSchema = z.object({
  kind: z.enum(['daily', 'weekly', 'total']),
});

const leaderboardRoutes: FastifyPluginAsync = async (app) => {
  const service = createLeaderboardService({
    prisma: app.prisma,
    redis: app.redis,
    log: app.log,
  });

  app.get('/:kind', async (request) => {
    const { kind } = parse(KindParamsSchema, request.params);
    return service.getLeaderboard(kind);
  });
};

export default leaderboardRoutes;
