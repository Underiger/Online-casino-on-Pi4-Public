/**
 * Admin 路由（掛載於 /api/admin；M21）。另導出 publicAnnouncementRoutes（公開）。
 *
 * 安全分層（preHandler 由左至右依序執行）：
 *   - 一般 admin 路由：[authenticate, requireAdminRole]（JWT + role===ADMIN，否則 403）
 *   - 高危路由（調幣 / 封鎖 / Gift Code）：再加 requireReverify
 *     （`x-reverify-token` 標頭須為有效且屬於該 admin 的 reverifyToken）
 *   - TOTP setup/verify/validate/reverify：僅 [authenticate, requireAdminRole]
 *     （此時尚無法持有 reverifyToken，且這些端點本身即在建立/驗證 2FA）
 *
 * 所有敏感操作於 service 內寫 AdminAuditLog（before/after/ip 來自 request.ip）。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { SOCKET_EVENTS } from '../../sockets/events.js';
import { ForbiddenError } from '../../shared/errors.js';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createAdminService, type AdminService } from './admin.service.js';
import {
  AdjustBalanceReqSchema,
  AnnouncementCreateReqSchema,
  AnnouncementUpdateReqSchema,
  AuditQuerySchema,
  BanReqSchema,
  CreateGiftCodeReqSchema,
  GiftCodeListQuerySchema,
  MuteReqSchema,
  PlayerSearchQuerySchema,
  TotpConfirmReqSchema,
  TotpReverifyReqSchema,
  TotpValidateReqSchema,
} from './admin.types.js';

export interface AdminRoutesOptions {
  /** 測試注入：覆寫整個 service */
  service?: AdminService;
}

function reverifyHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers['x-reverify-token'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function userIdParam(request: FastifyRequest): string {
  const params = request.params as { userId?: string };
  return params.userId ?? '';
}

function idParam(request: FastifyRequest): string {
  const params = request.params as { id?: string };
  return params.id ?? '';
}

const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, opts) => {
  const io = app.hasDecorator('io') ? app.io : null;

  const service =
    opts.service ??
    createAdminService({
      prisma: app.prisma,
      redis: app.redis,
      wallet: createWalletService(app.prisma),
      hmacKeys: app.hmacKeys,
      // 限時禁言到期自動解除：惰性引用 app.scheduleTimedUnmute（moderation job 於
      // server.ts 較晚註冊；setMute 於請求時呼叫，屆時 decorator 已就緒）
      scheduleTimedUnmute: (userId: string, mutedUntil: string, delayMs: number): void => {
        if (app.hasDecorator('scheduleTimedUnmute')) {
          app.scheduleTimedUnmute(userId, mutedUntil, delayMs);
        }
      },
      ...(io !== null
        ? {
            disconnectUser: (userId: string): void => {
              void io.in(`user:${userId}`).disconnectSockets(true);
            },
            emitAnnouncement: (payload): void => {
              io.emit(SOCKET_EVENTS.SYSTEM_ANNOUNCEMENT, payload);
            },
          }
        : {}),
      log: app.log,
    });

  // ── 守衛 ──────────────────────────────────────────────────────────────────────

  async function requireAdminRole(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (request.user.role !== 'ADMIN') {
      throw new ForbiddenError('需要管理員權限');
    }
  }

  async function requireReverify(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const ok = await service.checkReverifyToken(request.user.sub, reverifyHeader(request));
    if (!ok) {
      throw new ForbiddenError('需要 2FA 重新驗證（reverifyToken 無效或已過期）');
    }
  }

  const adminOnly = { preHandler: [app.authenticate, requireAdminRole] };
  const highRisk = { preHandler: [app.authenticate, requireAdminRole, requireReverify] };

  // ── 2FA / TOTP ────────────────────────────────────────────────────────────────

  app.get('/me', adminOnly, async (request) => service.getMe(request.user.sub));

  app.post('/totp/setup', adminOnly, async (request) => {
    // username 取自 JWT 對應使用者（otpauth label）
    const user = await app.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { username: true },
    });
    return service.setupTotp(request.user.sub, user?.username ?? request.user.sub);
  });

  app.post('/totp/verify', adminOnly, async (request) => {
    const body = parse(TotpConfirmReqSchema, request.body);
    return service.confirmTotp(request.user.sub, body.totpCode, request.ip);
  });

  app.post('/totp/validate', adminOnly, async (request) => {
    const body = parse(TotpValidateReqSchema, request.body);
    return service.validate2fa(request.user.sub, body.code);
  });

  app.post('/totp/reverify', adminOnly, async (request) => {
    const body = parse(TotpReverifyReqSchema, request.body);
    return service.reverify(request.user.sub, body.totpCode);
  });

  // ── 玩家管理 ──────────────────────────────────────────────────────────────────

  app.get('/users', adminOnly, async (request) => {
    const query = parse(PlayerSearchQuerySchema, request.query);
    return service.listPlayers(query);
  });

  app.get('/users/:userId', adminOnly, async (request) => {
    return service.getPlayer(userIdParam(request));
  });

  app.post('/users/:userId/ban', highRisk, async (request) => {
    const body = parse(BanReqSchema, request.body ?? {});
    return service.setBan(request.user.sub, userIdParam(request), true, request.ip, body.reason);
  });

  app.post('/users/:userId/unban', highRisk, async (request) => {
    const body = parse(BanReqSchema, request.body ?? {});
    return service.setBan(request.user.sub, userIdParam(request), false, request.ip, body.reason);
  });

  app.post('/users/:userId/mute', adminOnly, async (request) => {
    const body = parse(MuteReqSchema, request.body ?? {});
    return service.setMute(request.user.sub, userIdParam(request), true, request.ip, {
      ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
  });

  app.post('/users/:userId/unmute', adminOnly, async (request) => {
    const body = parse(MuteReqSchema, request.body ?? {});
    return service.setMute(request.user.sub, userIdParam(request), false, request.ip, {
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
  });

  app.post('/users/:userId/adjust-balance', highRisk, async (request) => {
    const body = parse(AdjustBalanceReqSchema, request.body);
    return service.adjustBalance(
      request.user.sub,
      userIdParam(request),
      body.delta,
      body.reason,
      request.ip,
    );
  });

  // ── Gift Code（高危產生 / 一般列表） ──────────────────────────────────────────

  app.post('/gift-codes', highRisk, async (request) => {
    const body = parse(CreateGiftCodeReqSchema, request.body);
    return service.createGiftCode(request.user.sub, body, request.ip);
  });

  app.get('/gift-codes', adminOnly, async (request) => {
    const query = parse(GiftCodeListQuerySchema, request.query);
    return service.listGiftCodes(query);
  });

  // ── 公告管理 ──────────────────────────────────────────────────────────────────

  app.get('/announcements', adminOnly, async () => service.listAnnouncements());

  app.post('/announcements', adminOnly, async (request) => {
    const body = parse(AnnouncementCreateReqSchema, request.body);
    return service.createAnnouncement(request.user.sub, body, request.ip);
  });

  app.put('/announcements/:id', adminOnly, async (request) => {
    const body = parse(AnnouncementUpdateReqSchema, request.body);
    return service.updateAnnouncement(request.user.sub, idParam(request), body, request.ip);
  });

  app.delete('/announcements/:id', adminOnly, async (request, reply) => {
    await service.deleteAnnouncement(request.user.sub, idParam(request), request.ip);
    return reply.code(204).send();
  });

  // ── 稽核日誌 ──────────────────────────────────────────────────────────────────

  app.get('/audit-logs', adminOnly, async (request) => {
    const query = parse(AuditQuerySchema, request.query);
    return service.listAuditLogs(query);
  });
};

export default adminRoutes;

/**
 * 公開公告路由（掛載於 /api/announcements；無需認證）。
 * 與 admin 共用 service，但僅暴露唯讀的有效公告查詢。
 */
export const publicAnnouncementRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
  app,
  opts,
) => {
  const service =
    opts.service ??
    createAdminService({
      prisma: app.prisma,
      redis: app.redis,
      wallet: createWalletService(app.prisma),
      log: app.log,
    });

  app.get('/active', async () => service.getActiveAnnouncements());
};
