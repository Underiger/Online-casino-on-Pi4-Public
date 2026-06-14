/**
 * 單 worker 啟動（04_FOLDER_STRUCTURE §1）：Fastify + M08 Socket.IO + M14 BullMQ consumer。
 *
 * Socket.IO 於 listen 之前附加至 app.server（Fastify 實例化時即建立 HTTP server）；
 * 每個 worker 各持一個 io 實例，跨 worker 廣播由 redis adapter 處理（sockets/index.ts）。
 *
 * M14 BullMQ：registerJackpotJobs 於 initSocketServer 之後呼叫（tick 廣播依賴
 * app.io）——每 worker 各建一個 BullMQ Worker，repeatable spec 以 repeat key 去重，
 * 每次 flush(10s)/tick(5s) 僅一個 worker 執行（02_TDD §8 同進程跑 BullMQ 取捨）。
 *
 * 優雅關閉：SIGTERM / SIGINT → app.close()（觸發各 plugin onClose：
 * BullMQ worker/queue close、socket.io close、prisma $disconnect、redis quit）
 * → 正常退出；10 秒未完成則強制退出。
 */
import process from 'node:process';
import { buildApp } from './app.js';
import { initSocketServer } from './sockets/index.js';
import { registerJackpotJobs } from './jobs/jackpot-flush.job.js';
import { registerDailyJobs } from './modules/daily/daily.jobs.js';
import { registerLeaderboardJobs } from './jobs/leaderboard-refresh.job.js';
import { registerMonitorScanJob } from './jobs/monitor-scan.job.js';
import { env } from './config/env.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function startServer(): Promise<void> {
  const app = await buildApp();

  // M08：Socket.IO 附加至 Fastify 的 HTTP server（redis adapter、握手 JWT、
  // 連線上限、遊戲事件 HMAC 中介層皆在 initSocketServer 內完成）
  initSocketServer(app);

  // M14：Jackpot flush(10s)/tick(5s) repeatable jobs + 開機展示值校準
  // （必須在 initSocketServer 之後——tick 廣播經 app.io）
  await registerJackpotJobs(app);

  // M18：Daily Reset cron（00:00 Asia/Taipei）— 幸運符號更換 + loadout 快取清除
  await registerDailyJobs(app);

  // M19：Leaderboard refresh(5m) + snapshot(00:00 TPE) repeatable jobs
  await registerLeaderboardJobs(app);

  // M24：Monitor scan（每 10 分鐘更新 NET_WIN P99）
  await registerMonitorScanJob(app);

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'graceful shutdown 開始');

    // 保險絲：onClose hooks 卡住時強制退出
    const timer = setTimeout(() => {
      app.log.error('graceful shutdown 逾時，強制退出');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    app
      .close()
      .then(() => {
        app.log.info('graceful shutdown 完成');
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'graceful shutdown 失敗');
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  // cluster primary 消失（IPC 斷線）時自我優雅關閉，
  // 避免孤兒 worker 佔住端口（Windows 上殺 primary 不會帶走子進程）
  process.once('disconnect', () => shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
