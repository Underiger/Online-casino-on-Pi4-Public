/**
 * Monitor 路由整合測試（M24）：真 Fastify + 真 auth plugin + stub MonitorService。
 *
 * 聚焦安全邊界（route guard 接線）：
 *   - 無 token → 401
 *   - PLAYER 角色 → 403
 *   - ADMIN 角色 → 200 並回傳 SystemStatsRes
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import authPlugin from '../../src/plugins/auth.js';
import monitorRoutes from '../../src/modules/monitor/monitor.routes.js';
import type { MonitorService } from '../../src/modules/monitor/monitor.service.js';
import { AppError } from '../../src/shared/errors.js';

const MOCK_STATS = {
  cpu: { manufacturer: 'Broadcom', brand: 'BCM2711', physicalCores: 4, currentLoad: 12.5, temperature: 52 },
  memory: { total: 4_294_967_296, used: 1_288_490_189, free: 3_006_477_107, usedPercent: 30.0 },
  disk: [{ fs: '/dev/mmcblk0p2', size: 34_359_738_368, used: 8_589_934_592, use: 25.0 }],
  onlineUsers: 3,
  activeRooms: 1,
  uptime: 86400,
  sampledAt: '2026-06-14T12:00:00.000Z',
};

function makeStubService(): MonitorService {
  return {
    getStats: vi.fn(async () => MOCK_STATS),
    hostname: vi.fn(() => 'test-host'),
  };
}

async function buildTestApp(service: MonitorService) {
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
  await app.register(monitorRoutes, { prefix: '/api/admin', service });
  await app.ready();

  return {
    app,
    adminToken: app.jwt.sign({ sub: 'admin1', role: 'ADMIN' }),
    playerToken: app.jwt.sign({ sub: 'p1', role: 'PLAYER' }),
  };
}

describe('GET /api/admin/monitor 路由守衛', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('無 token → 401', async () => {
    const { app: a } = await buildTestApp(makeStubService());
    app = a;
    const res = await app.inject({ method: 'GET', url: '/api/admin/monitor' });
    expect(res.statusCode).toBe(401);
  });

  it('PLAYER 角色 → 403', async () => {
    const { app: a, playerToken } = await buildTestApp(makeStubService());
    app = a;
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/monitor',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN 角色 → 200 並回傳 SystemStatsRes', async () => {
    const service = makeStubService();
    const { app: a, adminToken } = await buildTestApp(service);
    app = a;

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/monitor',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cpu).toBeDefined();
    expect(body.memory).toBeDefined();
    expect(body.disk).toBeInstanceOf(Array);
    expect(typeof body.onlineUsers).toBe('number');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.sampledAt).toBe('string');
    expect(service.getStats).toHaveBeenCalledOnce();
  });
});
