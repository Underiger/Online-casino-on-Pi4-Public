/**
 * Leaderboard refresh / snapshot BullMQ Jobs（02_TDD §6.2、05_MILESTONES M19）。
 *
 * leaderboard-refresh 隊列承載兩種任務：
 *   - refresh  — 每 5 分鐘 REFRESH MATERIALIZED VIEW CONCURRENTLY（所有三張視圖）
 *   - snapshot — 每日 00:00 Asia/Taipei，讀昨日 bet_records Top100 寫入 LeaderboardSnapshot
 *
 * cluster ×2 workers 各自呼叫 registerLeaderboardJobs：repeatable spec 以 repeat key
 * 去重，每次迭代僅一個 Worker 取得執行權（BullMQ 天然單執行）。
 */
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { createJobConnection } from './queues.js';
import { createLeaderboardService } from '../modules/leaderboard/leaderboard.service.js';

export const LEADERBOARD_QUEUE_NAME = 'leaderboard-refresh';
export const LEADERBOARD_REFRESH_JOB = 'refresh';
export const LEADERBOARD_SNAPSHOT_JOB = 'snapshot';

/** 視圖刷新週期：5 分鐘 */
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export async function registerLeaderboardJobs(app: FastifyInstance): Promise<void> {
  const service = createLeaderboardService({
    prisma: app.prisma,
    redis: app.redis,
    log: app.log,
  });

  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();

  queueConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'leaderboard-job: queue redis error'),
  );
  workerConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'leaderboard-job: worker redis error'),
  );

  const queue = new Queue(LEADERBOARD_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 50,
    },
  });

  // 每 5 分鐘刷新三張物化視圖（fire-and-forget 避免 Redis 未就緒時阻塞 listen）
  void queue
    .add(LEADERBOARD_REFRESH_JOB, {}, { repeat: { every: REFRESH_INTERVAL_MS } })
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'leaderboard-job: refresh repeatable 註冊失敗');
    });

  // 00:00 Asia/Taipei 每日快照（前一日 Top100 → LeaderboardSnapshot）
  void queue
    .add(
      LEADERBOARD_SNAPSHOT_JOB,
      {},
      { repeat: { pattern: '0 0 * * *', tz: 'Asia/Taipei' } },
    )
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'leaderboard-job: snapshot cron 註冊失敗');
    });

  const worker = new Worker(
    LEADERBOARD_QUEUE_NAME,
    async (job) => {
      try {
        if (job.name === LEADERBOARD_REFRESH_JOB) {
          await service.refreshViews();
        } else if (job.name === LEADERBOARD_SNAPSHOT_JOB) {
          await service.snapshotDailyTop100();
          app.log.info('leaderboard-job: 每日快照完成');
        } else {
          app.log.warn({ jobName: job.name }, 'leaderboard-job: 未知任務名稱，略過');
        }
      } catch (err) {
        app.log.warn({ err: (err as Error).message, jobName: job.name }, 'leaderboard-job: 任務失敗');
      }
    },
    { connection: workerConnection, concurrency: 1 },
  );

  worker.on('error', (err) =>
    app.log.debug({ err: err.message }, 'leaderboard-job: worker error'),
  );
  worker.on('failed', (job, err) =>
    app.log.warn({ jobName: job?.name, err: err.message }, 'leaderboard-job: job failed'),
  );

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    queueConnection.disconnect();
    workerConnection.disconnect();
    app.log.info('leaderboard-job: closed');
  });

  app.log.info('leaderboard-job: refresh(5m) / snapshot(00:00 TPE) 已註冊');
}
