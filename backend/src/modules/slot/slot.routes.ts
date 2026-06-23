/**
 * Slot 路由（掛載於 /api/slot，見 app.ts；規格凍結於 docs/04_API_SPEC.md §3.4）。
 *
 * POST /spin      — 旋轉（authenticate + 全域 hmac-guard：x-sig/x-nonce/x-ts/x-seq）
 * GET  /paytable  — 賠率表 + 今日幸運符號
 * GET  /history   — 個人旋轉歷史分頁
 *
 * hmac-guard 為 app.ts 註冊的全域 preHandler（signedRoutes 含 POST /api/slot/spin），
 * 先於本路由的 authenticate 執行——本檔不需重複驗章。
 * 注額非法依凍結規格回 400 VALIDATION_ERROR（SpinReq zod schema）。
 * BigInt 欄位依 docs/04_API_SPEC.md §1.6 序列化為字串。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SLOT_BET_AMOUNTS } from '../../config/constants.js';
import { createAnomalyDetector } from '../../security/anomaly.js';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createJackpotService } from '../jackpot/jackpot.service.js';
import { createChatService } from '../chat/chat.service.js';
import { createSlotService, type SlotService } from './slot.service.js';
import { createDailyService } from '../daily/daily.service.js';
import { createAchievementService } from '../achievement/achievement.service.js';

// ── 請求 schema（鏡像 packages/shared dto/slot.dto.ts；backend 暫無法 import shared .ts 入口） ──

const SpinReqSchema = z.object({
  betAmount: z.union([
    z.literal(SLOT_BET_AMOUNTS[0]),
    z.literal(SLOT_BET_AMOUNTS[1]),
    z.literal(SLOT_BET_AMOUNTS[2]),
  ]),
});

const HistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface SlotRoutesOptions {
  /** 測試注入：覆寫整個 service（決定性 rng / fake 依賴） */
  service?: SlotService;
}

const slotRoutes: FastifyPluginAsync<SlotRoutesOptions> = async (app, opts) => {
  const wallet = createWalletService(app.prisma);
  const daily = createDailyService({ prisma: app.prisma, redis: app.redis, wallet, log: app.log });
  const achievement = createAchievementService({ prisma: app.prisma, wallet, log: app.log });
  const service =
    opts.service ??
    createSlotService({
      prisma: app.prisma,
      redis: app.redis,
      wallet,
      // M14：完整 jackpot service（累積 + 觸發判定 + 派彩 + 廣播 + 聊天室系統訊息）。
      // emit 延遲取用 app.io——io 於 server.ts 在 listen 前 decorate，請求期必存在；
      // hasDecorator 雙保險（整合測試可不掛 Socket）
      jackpot: createJackpotService({
        prisma: app.prisma,
        redis: app.redis,
        wallet,
        emit: (event, payload) => {
          if (app.hasDecorator('io')) app.io.emit(event, payload);
        },
        chat: createChatService({ prisma: app.prisma, redis: app.redis, log: app.log }),
        log: app.log,
      }),
      anomaly: createAnomalyDetector(app.redis, {
        log: app.log,
        onFlag: (userId, reason) => {
          // 寫入 User.flagged（fire-and-forget；失敗僅記日誌，不中斷下注流程）
          void app.prisma.user
            .updateMany({ where: { id: userId, flagged: false }, data: { flagged: true } })
            .catch((err: unknown) => {
              app.log.warn({ err, userId, reason }, 'anomaly: 標記 User.flagged 失敗');
            });
        },
      }),
      log: app.log,
    });

  app.post('/spin', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(SpinReqSchema, request.body);
    const outcome = await service.spin(request.user.sub, body.betAmount);

    // M18：任務進度更新（fire-and-forget；失敗不影響 spin 回應）
    const io = app.hasDecorator('io') ? app.io : undefined;
    const userId = request.user.sub;
    // M20：成就解鎖觸發（fire-and-forget）
    const achIo = io
      ? { to: (room: string) => ({ emit: (ev: string, d: unknown): void => void io.to(room).emit(ev, d) }) }
      : undefined;
    void daily.updateProgress(userId, 'SPIN_COUNT', 1, io).catch((err: unknown) => {
      app.log.warn({ err }, 'daily: SPIN_COUNT updateProgress 失敗');
    });
    // WIN_TRIPLE：三軸相同符號且有賠付
    const reels = outcome.reels as string[];
    if (reels[0] === reels[1] && reels[1] === reels[2] && outcome.payout > 0) {
      void daily.updateProgress(userId, 'WIN_TRIPLE', 1, io).catch((err: unknown) => {
        app.log.warn({ err }, 'daily: WIN_TRIPLE updateProgress 失敗');
      });
    }
    // NET_WIN：本局淨獲利（payout > betAmount）
    if (outcome.payout > body.betAmount) {
      void daily.updateProgress(userId, 'NET_WIN', outcome.payout - body.betAmount, io).catch(
        (err: unknown) => {
          app.log.warn({ err }, 'daily: NET_WIN updateProgress 失敗');
        },
      );
    }
    // M20 成就觸發（reels 已在上方宣告）
    const isTriple = reels[0] === reels[1] && reels[1] === reels[2];
    if (isTriple && outcome.payout > 0) {
      void achievement.tryUnlock(userId, 'FIRST_TRIPLE', achIo).catch(() => {});
      if (reels[0] === 'LUCKY7') {
        void achievement.tryUnlock(userId, 'LUCKY7_TRIPLE', achIo).catch(() => {});
      }
      if (reels[0] === 'DIAMOND') {
        void achievement.tryUnlock(userId, 'DIAMOND_TRIPLE', achIo).catch(() => {});
      }
      if (reels[0] === 'WILD') {
        void achievement.tryUnlock(userId, 'WILD_TRIPLE', achIo).catch(() => {});
      }
    }
    if (outcome.jackpotTriggered && outcome.jackpotPayout !== null) {
      void achievement.tryUnlock(userId, 'JACKPOT_WINNER', achIo).catch(() => {});
    }
    void achievement.checkSpinMilestone(userId, achIo).catch(() => {});
    void achievement.checkDailyNetWin(userId, achIo).catch(() => {});

    return {
      betRecordId: outcome.betRecordId,
      betAmount: outcome.betAmount,
      reels: outcome.reels,
      payout: outcome.payout,
      newBalance: outcome.newBalance.toString(),
      pityActive: outcome.pityActive,
      pityCounter: outcome.pityCounter,
      jackpotTriggered: outcome.jackpotTriggered,
      // M14 規格擴充（docs/04_API_SPEC.md §3.4）：觸發且派彩成功時的金額，否則 null
      jackpotPayout: outcome.jackpotPayout?.toString() ?? null,
      jackpotPoints: outcome.jackpotPoints,
      luckySymbol: outcome.luckySymbol,
      serverSeedHash: outcome.serverSeedHash,
    };
  });

  app.get('/paytable', { preHandler: [app.authenticate] }, async () => {
    return service.paytable();
  });

  app.get('/history', { preHandler: [app.authenticate] }, async (request) => {
    const query = parse(HistoryQuerySchema, request.query);
    const result = await service.history(request.user.sub, query);
    return {
      items: result.items.map((item) => ({
        id: item.id,
        betAmount: item.betAmount,
        reels: item.reels,
        payout: item.payout,
        jackpotTriggered: item.jackpotTriggered,
        createdAt: item.createdAt.toISOString(),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  });
};

export default slotRoutes;
