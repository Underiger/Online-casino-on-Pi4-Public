/**
 * Auth plugin：註冊 @fastify/jwt、提供 `authenticate` preHandler decorator，
 * 並掛載 HMAC 會話金鑰存放器（M06，02_TDD §5.2）。
 *
 * - authenticate：驗證 Authorization: Bearer <JWT>，成功後 request.user = { sub, role }
 *   （@fastify/jwt 的 jwtVerify 解碼 payload 掛載至 request.user）。
 * - hmacKeys：Redis 金鑰生命週期（rotate/revoke/getActiveKeys）——
 *   登入/refresh 時由 auth.service 協商輪換，hmac-guard 驗章時讀取。
 *
 * 用法（路由層）：
 *   app.get('/api/me', { preHandler: [app.authenticate] }, handler);
 */
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../shared/errors.js';
import { createHmacKeyStore, type HmacKeyStore } from '../security/hmac.js';

/** Access Token payload（M04 簽發時固定此形狀） */
export interface JwtPayload {
  sub: string; // userId
  role: 'PLAYER' | 'ADMIN';
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    hmacKeys: HmacKeyStore;
  }
}

export default fp(
  async (app) => {
    await app.register(fastifyJwt, {
      secret: env.JWT_SECRET,
      sign: { expiresIn: env.JWT_ACCESS_TTL }, // 15m（02_TDD §5.2）
    });

    app.decorate(
      'authenticate',
      async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        const header = request.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
          throw new UnauthorizedError('缺少 Bearer 存取權杖');
        }
        try {
          // 驗證簽章與過期時間，成功後 payload 掛載至 request.user
          await request.jwtVerify();
        } catch {
          // 統一轉為 AppError，避免 @fastify/jwt 原始錯誤訊息洩漏內部細節
          throw new UnauthorizedError('存取權杖無效或已過期');
        }
      },
    );

    // HMAC 會話金鑰：TTL 與 refresh token 同壽命（7d），輪換寬限 30s
    app.decorate(
      'hmacKeys',
      createHmacKeyStore(app.redis, {
        ttlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 86_400,
      }),
    );
  },
  { name: 'auth', dependencies: ['redis'] },
);
