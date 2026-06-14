/**
 * Charm 路由（掛載於 /api/charm；規格凍結於 docs/04_API_SPEC.md §3.5）。
 *
 * GET  /inventory  — 玩家護符庫存（authenticated）
 * POST /equip      — 裝備護符到指定槽位（authenticated）
 * POST /unequip    — 卸下指定槽位護符（authenticated）
 *
 * 注意：charm 操作不需 HMAC 簽章（非下注路徑），只需 JWT 驗證。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/validation.js';
import { createCharmService, type CharmService } from './charm.service.js';
import { createAchievementService } from '../achievement/achievement.service.js';
import { createWalletService } from '../wallet/wallet.service.js';

// ── 請求 schema（鏡像 packages/shared dto/charm.dto.ts）──

const CHARM_MAX_SLOTS = 3;

const EquipReqSchema = z.object({
  userCharmId: z.string().min(1),
  slot: z.number().int().min(1).max(CHARM_MAX_SLOTS),
});

const UnequipReqSchema = z.object({
  slot: z.number().int().min(1).max(CHARM_MAX_SLOTS),
});

export interface CharmRoutesOptions {
  /** 測試注入 */
  service?: CharmService;
}

const charmRoutes: FastifyPluginAsync<CharmRoutesOptions> = async (app, opts) => {
  const service =
    opts.service ??
    createCharmService({
      prisma: app.prisma,
      redis: app.redis,
      log: app.log,
    });
  const achievement = createAchievementService({
    prisma: app.prisma,
    wallet: createWalletService(app.prisma),
    log: app.log,
  });

  app.get('/inventory', { preHandler: [app.authenticate] }, async (request) => {
    const result = await service.getInventory(request.user.sub);
    return result;
  });

  app.post('/equip', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(EquipReqSchema, request.body);
    const result = await service.equip(request.user.sub, body.userCharmId, body.slot);
    // M20：CHARM_COLLECT_6 / CHARM_COLLECT_12 成就（fire-and-forget）
    const io = app.hasDecorator('io') ? app.io : null;
    const achIo = io
      ? { to: (room: string) => ({ emit: (ev: string, d: unknown): void => void io.to(room).emit(ev, d) }) }
      : undefined;
    void achievement.checkCharmMilestone(request.user.sub, achIo).catch(() => {});
    return result;
  });

  app.post('/unequip', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(UnequipReqSchema, request.body);
    const result = await service.unequip(request.user.sub, body.slot);
    return result;
  });
};

export default charmRoutes;
