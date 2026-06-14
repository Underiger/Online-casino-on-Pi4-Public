/**
 * Prisma plugin：PrismaClient 單例裝飾 + graceful shutdown。
 *
 * - 開發環境採惰性連線（首次查詢才連 DB），本機沒起 PG 也能啟動骨架；
 * - 生產環境啟動時即 $connect()，連不上直接 fail loud。
 */
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp(
  async (app) => {
    const prisma = new PrismaClient({
      log:
        env.NODE_ENV === 'development'
          ? [
              { emit: 'event', level: 'warn' },
              { emit: 'event', level: 'error' },
            ]
          : [{ emit: 'event', level: 'error' }],
    });

    prisma.$on('warn', (e) => app.log.warn({ prisma: e.message }, 'prisma warn'));
    prisma.$on('error', (e) => app.log.error({ prisma: e.message }, 'prisma error'));

    if (env.NODE_ENV === 'production') {
      await prisma.$connect(); // fail loud：生產連不上 DB 即拒啟動
      app.log.info('prisma: connected');
    } else {
      app.log.info('prisma: lazy connect（首次查詢時建立連線）');
    }

    app.decorate('prisma', prisma);

    app.addHook('onClose', async () => {
      await prisma.$disconnect();
      app.log.info('prisma: disconnected');
    });
  },
  { name: 'prisma' },
);
