/**
 * Auth 路由（掛載於 /api/auth，見 app.ts）。
 *
 * POST /register — 註冊（201）
 * POST /login    — 登入 → access + refresh token，落 LoginLog
 * POST /refresh  — 旋轉式換發；重用偵測 → 403 全家族撤銷
 * POST /logout   — 撤銷 refresh token 家族（冪等）
 * GET  /me       — authenticate preHandler 示範（回 JWT payload）
 */
import type { FastifyPluginAsync } from 'fastify';
import { parse } from '../../shared/validation.js';
import { createAuthService } from './auth.service.js';
import {
  LoginSchema,
  LogoutSchema,
  RefreshSchema,
  RegisterSchema,
  type ClientMeta,
} from './auth.types.js';

const authRoutes: FastifyPluginAsync = async (app) => {
  const service = createAuthService({
    prisma: app.prisma,
    signAccessToken: (payload) => app.jwt.sign(payload),
    hmacKeys: app.hmacKeys, // M06：登入/refresh 協商輪換、logout 撤銷
  });

  const metaOf = (ip: string, userAgent: string | undefined): ClientMeta => ({
    ip,
    userAgent: userAgent ?? '',
  });

  app.post('/register', async (request, reply) => {
    const body = parse(RegisterSchema, request.body);
    const result = await service.register(body);
    return reply.code(201).send(result);
  });

  app.post('/login', async (request) => {
    const body = parse(LoginSchema, request.body);
    return service.login(body, metaOf(request.ip, request.headers['user-agent']));
  });

  app.post('/refresh', async (request) => {
    const body = parse(RefreshSchema, request.body);
    return service.refresh(body.refreshToken);
  });

  app.post('/logout', async (request) => {
    const body = parse(LogoutSchema, request.body);
    await service.logout(body.refreshToken);
    return { ok: true };
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (request) => ({
    user: request.user,
  }));
};

export default authRoutes;
