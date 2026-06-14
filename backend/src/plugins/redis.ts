/**
 * Redis plugin（04_FOLDER_STRUCTURE §1）：ioredis 主連線 + pub/sub 訂閱連線。
 *
 * - 主連線（app.redis）：一般命令（jackpot INCRBY、loadout 快取、nonce、令牌桶…）
 * - 訂閱連線（app.redisSub）：ioredis 進入 subscribe 模式後不能下一般命令，
 *   故為 Socket.IO redis-adapter（M08）與 pub/sub 預留獨立連線。
 * - 生產環境連不上即 fail loud；開發環境警告後繼續（指令將於 Redis 起來後自動恢復）。
 */
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    redisSub: Redis;
  }
}

function createClient(): Redis {
  return new Redis(env.REDIS_URL, {
    lazyConnect: true, // 由本 plugin 控制連線時機
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => {
      // 生產：指數退避無限重連（容忍 Redis 重啟）；開發：20 次後放棄，避免日誌洗版
      if (env.NODE_ENV !== 'production' && times > 20) return null;
      return Math.min(times * 200, 2_000);
    },
  });
}

export default fp(
  async (app) => {
    const redis = createClient();
    const redisSub = createClient();

    // 不掛 error listener 時 ioredis 會把連線錯誤拋成 unhandled error
    redis.on('error', (err) => app.log.debug({ err: err.message }, 'redis error'));
    redisSub.on('error', (err) => app.log.debug({ err: err.message }, 'redis sub error'));
    redis.on('ready', () => app.log.info('redis: ready'));

    try {
      await Promise.all([redis.connect(), redisSub.connect()]);
      await redis.ping();
    } catch (err) {
      if (env.NODE_ENV === 'production') {
        throw err; // fail loud
      }
      app.log.warn(
        { err: (err as Error).message },
        'redis: 連線失敗（開發模式繼續啟動；請 docker compose up -d）',
      );
    }

    app.decorate('redis', redis);
    app.decorate('redisSub', redisSub);

    app.addHook('onClose', async () => {
      // quit() 等待佇列中的命令送完；連線已斷時直接 disconnect()
      await Promise.allSettled([redis.quit(), redisSub.quit()]);
      redis.disconnect();
      redisSub.disconnect();
      app.log.info('redis: closed');
    });
  },
  { name: 'redis' },
);
