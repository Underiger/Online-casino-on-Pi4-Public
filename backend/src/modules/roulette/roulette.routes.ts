/**
 * Roulette REST 路由（掛載於 /api/roulette，見 app.ts；docs/04_API_SPEC.md §3.5）。
 *
 * 下注/取消走 Socket（§4）；REST 僅提供狀態查詢：
 *   GET /state    — 當前回合（讀 Redis 鏡像 + 計數器，任何 worker 可答，
 *                   不依賴狀態機實例——機器於 initSocketServer 內、本路由之後才建立）
 *   GET /history  — 近 100 回合結果分頁（Redis list）
 *
 * 依凍結路由總表（§2）皆需玩家 JWT（認證 ✓）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../../shared/errors.js';
import { parse } from '../../shared/validation.js';
import { readRouletteHistory, readRouletteState } from './roulette.service.js';

const HistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const rouletteRoutes: FastifyPluginAsync = async (app) => {
  app.get('/state', { preHandler: [app.authenticate] }, async () => {
    const state = await readRouletteState(app.redis);
    if (state === null) {
      // 機器尚未開局（啟動瞬間）或 Redis 鏡像不可用——客戶端退回等待 phase 廣播
      throw new NotFoundError('輪盤回合尚未開始');
    }
    return state;
  });

  app.get('/history', { preHandler: [app.authenticate] }, async (request) => {
    const query = parse(HistoryQuerySchema, request.query);
    return readRouletteHistory(app.redis, query);
  });
};

export default rouletteRoutes;
