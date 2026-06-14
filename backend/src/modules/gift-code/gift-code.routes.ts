/**
 * Gift Code 路由（M22）。
 *
 * 掛載於 /api/gift-codes。
 * 唯一端點：POST /redeem（一般認證玩家；僅需 JWT，不需管理員角色）。
 * 管理員建立 Gift Code 的路由在 M21 admin.routes.ts（POST /api/admin/gift-codes 高危）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createGiftCodeService, type GiftCodeService } from './gift-code.service.js';
import { RedeemGiftCodeReqSchema } from './gift-code.types.js';

export interface GiftCodeRoutesOptions {
  /** 測試注入：覆寫整個 service */
  service?: GiftCodeService;
}

const giftCodeRoutes: FastifyPluginAsync<GiftCodeRoutesOptions> = async (app, opts) => {
  const service =
    opts.service ??
    createGiftCodeService({
      prisma: app.prisma,
      wallet: createWalletService(app.prisma),
    });

  /** POST /api/gift-codes/redeem — 認證玩家兌換禮物碼 */
  app.post('/redeem', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(RedeemGiftCodeReqSchema, request.body);
    return service.redeemGiftCode(request.user.sub, body.code);
  });
};

export default giftCodeRoutes;
