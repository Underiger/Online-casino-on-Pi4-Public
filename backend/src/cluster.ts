/**
 * node:cluster 入口（04_FOLDER_STRUCTURE §1 / 02_TDD：fork ≤2 workers）。
 *
 * - fork 數量由環境變數 WORKERS 決定（預設 2，env.ts 限制 1–4）；
 *   所有 workers 透過 cluster 共享同一個 :PORT 監聽 socket。
 * - M08 Socket.IO：每個 worker 於 server.ts → initSocketServer() 各自建立
 *   io 實例並附加到該 worker 的 HTTP server；跨 worker 廣播（roulette:phase、
 *   jackpot:won…）由 @socket.io/redis-adapter 經 Redis pub/sub 送達全部 worker。
 *   ⚠ polling 黏著注意：cluster 對新 TCP 連線採輪詢分派，Nginx ip_hash 只能
 *   黏住「client → 本機」，黏不住「本機 → 特定 worker」——long-polling 的後續
 *   請求可能落到不認得該 session 的 worker（Session ID unknown）。
 *   websocket transport 單一 TCP 連線全程同 worker，不受影響；
 *   M09 前端預設 websocket 優先即可規避，若需嚴格支援 polling 再導入
 *   @socket.io/sticky（primary 依 sid 轉發連線）。
 * - worker 崩潰自動重啟；30 秒內死亡 >5 次視為 crash-loop，primary 直接結束
 *   （交給 docker restart policy / systemd 處理，避免無限重啟循環吃滿 CPU）。
 * - primary 收到 SIGTERM/SIGINT 轉發給全部 workers（worker 內由 server.ts 優雅關閉）。
 */
import cluster from 'node:cluster';
import process from 'node:process';
import { pino } from 'pino';
import { env } from './config/env.js';

const CRASH_WINDOW_MS = 30_000;
const CRASH_LIMIT = 5;
const PRIMARY_EXIT_GRACE_MS = 15_000;

if (cluster.isPrimary) {
  const log = pino(
    env.NODE_ENV === 'development'
      ? {
          name: 'cluster',
          level: env.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : { name: 'cluster', level: env.LOG_LEVEL },
  );

  let shuttingDown = false;
  const recentDeaths: number[] = [];

  log.info(
    `primary ${process.pid}：fork ${env.WORKERS} workers，共同監聽 :${env.PORT}`,
  );
  for (let i = 0; i < env.WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    log.info(`worker ${worker.process.pid ?? '?'} online`);
  });

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;

    const now = Date.now();
    recentDeaths.push(now);
    while (recentDeaths.length > 0 && (recentDeaths[0] ?? 0) < now - CRASH_WINDOW_MS) {
      recentDeaths.shift();
    }
    if (recentDeaths.length > CRASH_LIMIT) {
      log.fatal(
        `worker crash-loop（${CRASH_WINDOW_MS / 1000}s 內死亡 ${recentDeaths.length} 次），primary 結束`,
      );
      process.exit(1);
    }

    log.warn(
      `worker ${worker.process.pid ?? '?'} 死亡（code=${code} signal=${signal ?? '-'}），重啟`,
    );
    cluster.fork();
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`primary 收到 ${signal}，轉發給全部 workers`);

    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.process.kill('SIGTERM');
    }

    // 全部 workers 退出後 primary 事件圈自然清空結束；保險絲防卡死
    const timer = setTimeout(() => {
      log.error('workers 未在時限內退出，primary 強制結束');
      process.exit(1);
    }, PRIMARY_EXIT_GRACE_MS);
    timer.unref();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
} else {
  // worker：動態 import 讓 fastify/prisma/redis/socket.io 只在 worker 進程載入；
  // 每個 worker 建立自己的 Socket.IO 實例（redis adapter 跨 worker 廣播）
  const { startServer } = await import('./server.js');
  await startServer();
}
