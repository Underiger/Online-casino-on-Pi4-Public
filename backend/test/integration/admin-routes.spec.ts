/**
 * Admin 路由整合測試（M21）：真 Fastify + 真 auth plugin（JWT）+ 注入 stub AdminService。
 *
 * 聚焦安全邊界（route guard 接線），不碰 DB：
 *   - 認證：無 token → 401
 *   - 角色：PLAYER 觸 admin 路由 → 403
 *   - 高危：ADMIN 無 / 錯誤 reverifyToken → 403；正確 → 放行
 *   - 公開：/api/announcements/active 無需認證
 * service 內部業務邏輯由 admin.service.spec 單元測試覆蓋。
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import authPlugin from '../../src/plugins/auth.js';
import adminRoutes, { publicAnnouncementRoutes } from '../../src/modules/admin/admin.routes.js';
import type { AdminService } from '../../src/modules/admin/admin.service.js';
import { AppError } from '../../src/shared/errors.js';

/** stub service：只實作受測路由會呼叫的方法 */
function makeStubService(overrides: Partial<AdminService> = {}): AdminService {
  const base = {
    getMe: vi.fn(async (userId: string) => ({
      userId,
      username: 'admin',
      role: 'ADMIN' as const,
      totpEnabled: true,
    })),
    // 僅 'good-token' 視為有效
    checkReverifyToken: vi.fn(async (_userId: string, token: string | undefined) =>
      token === 'good-token',
    ),
    adjustBalance: vi.fn(async () => ({ newBalance: '1500', delta: '500' })),
    setBan: vi.fn(async (_a: string, userId: string) => ({ userId, banned: true })),
    getActiveAnnouncements: vi.fn(async () => ({ items: [] })),
    requestTelegramReverify: vi.fn(async () => ({ requestId: 'req-1', expiresIn: 120 })),
    getTelegramReverifyStatus: vi.fn(async () => ({ status: 'pending' as const })),
  };
  return { ...base, ...overrides } as unknown as AdminService;
}

async function buildTestApp(service: AdminService) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' } });
  });

  // 以名稱 'redis' 滿足 auth plugin 的 fp dependencies（hmacKeys 需 app.redis）
  await app.register(
    fp(
      async (instance) => {
        instance.decorate('prisma', {} as never);
        instance.decorate('redis', {} as never);
      },
      { name: 'redis' },
    ),
  );
  await app.register(authPlugin);
  await app.register(adminRoutes, { prefix: '/api/admin', service });
  await app.register(publicAnnouncementRoutes, { prefix: '/api/announcements', service });
  await app.ready();

  return {
    app,
    adminToken: app.jwt.sign({ sub: 'admin1', role: 'ADMIN' }),
    playerToken: app.jwt.sign({ sub: 'p1', role: 'PLAYER' }),
  };
}

describe('admin routes：認證與角色守衛', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('無 token → 401', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({ method: 'GET', url: '/api/admin/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('PLAYER 角色 → 403 FORBIDDEN', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/me',
      headers: { authorization: `Bearer ${ctx.playerToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('ADMIN → 200', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/me',
      headers: { authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'ADMIN', totpEnabled: true });
  });
});

describe('admin routes：高危操作 reverifyToken 守衛', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('ADMIN 但無 reverifyToken 標頭 → 403', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/u1/adjust-balance',
      headers: { authorization: `Bearer ${ctx.adminToken}` },
      payload: { delta: 500, reason: '補償' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('ADMIN + 錯誤 reverifyToken → 403', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/u1/adjust-balance',
      headers: { authorization: `Bearer ${ctx.adminToken}`, 'x-reverify-token': 'wrong' },
      payload: { delta: 500, reason: '補償' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN + 正確 reverifyToken → 200 並執行調幣', async () => {
    const service = makeStubService();
    const ctx = await buildTestApp(service);
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/u1/adjust-balance',
      headers: { authorization: `Bearer ${ctx.adminToken}`, 'x-reverify-token': 'good-token' },
      payload: { delta: 500, reason: '補償' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ newBalance: '1500', delta: '500' });
    expect(service.adjustBalance).toHaveBeenCalledWith('admin1', 'u1', 500, '補償', expect.any(String));
  });

  it('調幣 body 缺 reason → 400 VALIDATION_ERROR（即使持 reverifyToken）', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/u1/adjust-balance',
      headers: { authorization: `Bearer ${ctx.adminToken}`, 'x-reverify-token': 'good-token' },
      payload: { delta: 0 }, // delta=0 違規 + 缺 reason
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('admin routes：Telegram 2FA 推播路由', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('POST reverify-telegram：無 token → 401', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({ method: 'POST', url: '/api/admin/totp/reverify-telegram' });
    expect(res.statusCode).toBe(401);
  });

  it('POST reverify-telegram：PLAYER 角色 → 403', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/totp/reverify-telegram',
      headers: { authorization: `Bearer ${ctx.playerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST reverify-telegram：ADMIN → 200，轉發至 service', async () => {
    const service = makeStubService();
    const ctx = await buildTestApp(service);
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/totp/reverify-telegram',
      headers: { authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requestId: 'req-1', expiresIn: 120 });
    expect(service.requestTelegramReverify).toHaveBeenCalledWith('admin1', expect.any(String));
  });

  it('GET reverify-telegram/:requestId：PLAYER 角色 → 403', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/totp/reverify-telegram/req-1',
      headers: { authorization: `Bearer ${ctx.playerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET reverify-telegram/:requestId：ADMIN → 200，轉發至 service', async () => {
    const service = makeStubService();
    const ctx = await buildTestApp(service);
    app = ctx.app;
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/totp/reverify-telegram/req-1',
      headers: { authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending' });
    expect(service.getTelegramReverifyStatus).toHaveBeenCalledWith('admin1', 'req-1');
  });
});

describe('admin routes：公開有效公告', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('GET /api/announcements/active 無需認證 → 200', async () => {
    const ctx = await buildTestApp(makeStubService());
    app = ctx.app;
    const res = await app.inject({ method: 'GET', url: '/api/announcements/active' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [] });
  });
});
