/**
 * Daily Reset BullMQ Job（05_MILESTONES M18）。
 *
 * 每日 00:00 Asia/Taipei 執行：
 *   - 隨機設定新幸運符號（Redis daily:lucky-symbol）
 *   - 清除全部 slot:loadout:* 快取（幸運符號變動 → 舊 compiled loadout 失效）
 *
 * cluster ×2 workers 各自呼叫 registerDailyJobs：cron spec 以 repeat key 去重，
 * 每次迭代僅一個 Worker 取得執行權（BullMQ 天然單執行）。
 */
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { createJobConnection } from '../../jobs/queues.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createDailyService } from './daily.service.js';

export const DAILY_RESET_QUEUE_NAME = 'daily-reset';
export const DAILY_RESET_JOB = 'reset';

export async function registerDailyJobs(app: FastifyInstance): Promise<void> {
  const daily = createDailyService({
    prisma: app.prisma,
    redis: app.redis,
    wallet: createWalletService(app.prisma),
    log: app.log,
  });

  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();

  queueConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'daily-job: queue redis error'),
  );
  workerConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'daily-job: worker redis error'),
  );

  const queue = new Queue(DAILY_RESET_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 50,
    },
  });

  // 00:00 Asia/Taipei 每日重設（fire-and-forget 避免 Redis 未就緒時阻塞 listen）
  void queue
    .add(
      DAILY_RESET_JOB,
      {},
      {
        repeat: { pattern: '0 0 * * *', tz: 'Asia/Taipei' },
      },
    )
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'daily-job: reset cron 註冊失敗');
    });

  const worker = new Worker(
    DAILY_RESET_QUEUE_NAME,
    async (job) => {
      if (job.name !== DAILY_RESET_JOB) return;
      try {
        await daily.resetDailyTasks();
        app.log.info('daily-job: 每日重設完成');
      } catch (err) {
        app.log.error({ err: (err as Error).message }, 'daily-job: 重設失敗');
      }
    },
    {
      connection: workerConnection,
      concurrency: 1,
    },
  );

  worker.on('error', (err) =>
    app.log.debug({ err: err.message }, 'daily-job: worker error'),
  );
  worker.on('failed', (job, err) =>
    app.log.warn({ jobName: job?.name, err: err.message }, 'daily-job: job failed'),
  );

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    queueConnection.disconnect();
    workerConnection.disconnect();
    app.log.info('daily-job: closed');
  });

  app.log.info('daily-job: 每日 00:00 Asia/Taipei reset cron 已註冊');
}
