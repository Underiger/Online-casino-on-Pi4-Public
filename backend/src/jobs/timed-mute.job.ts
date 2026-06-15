/**
 * Moderation 延遲任務：限時禁言到期自動解除（05_MILESTONES backlog）。
 *
 * 背景：User 無 mutedUntil 欄位——admin.setMute 的「限時禁言」僅設 muted=true +
 * Redis 期限標記，本身不會把 muted 改回 false。本檔補上「到期自動解除」：
 *   - admin.setMute（限時）/ 聊天洗頻自動禁言 → app.scheduleTimedUnmute(userId,
 *     mutedUntil, delayMs) → 於 moderation queue 排一個 delay=duration 的任務。
 *   - 任務到期 → admin.releaseTimedMute(userId, mutedUntil)：以 Redis 期限標記做
 *     supersession 防護（值不符＝已被新禁言/解禁/永久禁言取代，跳過），相符才解除。
 *
 * 與 jackpot-flush.job 同款：processor 工廠與 BullMQ 接線分離（單元測試以 fake
 * deps 直接驅動，不需真 Redis / Worker）；cluster ×2 各自註冊，delay 任務由
 * BullMQ 內部派發（同一 jobId 去重，每個到期任務僅一個 worker 執行）。
 *
 * 失敗語義：processor 捕捉一切錯誤僅記日誌——禁言解除失敗不可中斷 Worker；
 * releaseTimedMute 內部對 Redis 不確定採 fail-safe（不誤解永久禁言）。
 */
import { Worker, type Job, type Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { createAdminService } from '../modules/admin/admin.service.js';
import { createWalletService } from '../modules/wallet/wallet.service.js';
import { createJobConnection, createModerationQueue, MODERATION_QUEUE_NAME } from './queues.js';

/** 限時禁言到期任務名稱 */
export const TIMED_UNMUTE_JOB = 'timed-unmute';

export interface TimedUnmuteJobData {
  userId: string;
  /** 排程當下的禁言到期時間（ISO）；解除前比對 Redis 標記，不符代表已被取代 */
  mutedUntil: string;
}

export interface ModerationJobLog {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface ModerationJobDeps {
  releaseTimedMute: (userId: string, mutedUntil: string) => Promise<{ released: boolean }>;
  log?: ModerationJobLog;
}

/**
 * processor 工廠（與 BullMQ 接線分離——單元測試以 fake deps 直接驅動）。
 */
export function createModerationJobProcessor(deps: ModerationJobDeps) {
  const log: ModerationJobLog = deps.log ?? { warn: () => {} };

  return async (job: Pick<Job<TimedUnmuteJobData>, 'name' | 'data'>): Promise<void> => {
    try {
      if (job.name === TIMED_UNMUTE_JOB) {
        await deps.releaseTimedMute(job.data.userId, job.data.mutedUntil);
        return;
      }
      log.warn({ jobName: job.name }, 'moderation-job: 未知任務名稱，略過');
    } catch (err) {
      // 最後保險絲：job 失敗只記日誌，永不讓例外外溢中斷 Worker
      (log.error ?? log.warn)(
        { err: (err as Error).message, jobName: job.name },
        'moderation-job: 任務執行失敗',
      );
    }
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * 排程一個限時禁言到期解除任務（registerModerationJobs 後可用）。
     * admin.routes / chat.gateway 於請求時以 app.hasDecorator 惰性引用——
     * 兩者在 buildApp/initSocketServer 階段建立，早於本 job 註冊。
     */
    scheduleTimedUnmute: (userId: string, mutedUntil: string, delayMs: number) => void;
  }
}

export interface ModerationJobsHandle {
  queue: Queue;
  worker: Worker;
}

/**
 * 啟動時註冊（server.ts，於 buildApp/initSocketServer 之後）：
 *   1. 建 moderation queue + decorate app.scheduleTimedUnmute（對外排程出口）。
 *   2. 建 Worker 消費 timed-unmute；processor 呼叫 admin.releaseTimedMute
 *      （worker 自建所需 admin service，與 registerJackpotJobs 同款）。
 */
export async function registerModerationJobs(app: FastifyInstance): Promise<ModerationJobsHandle> {
  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();
  // 未掛 error listener 時 ioredis 會把連線錯誤拋成 unhandled error
  queueConnection.on('error', (err) => app.log.debug({ err: err.message }, 'moderation-job: queue redis error'));
  workerConnection.on('error', (err) => app.log.debug({ err: err.message }, 'moderation-job: worker redis error'));

  const queue = createModerationQueue(queueConnection);

  // 對外排程出口：admin.setMute（限時）/ 聊天洗頻自動禁言於請求時呼叫。
  // delay 任務開發環境 Redis 未起時掛 offline queue，故 add 不可 await（自吞錯誤）。
  app.decorate('scheduleTimedUnmute', (userId: string, mutedUntil: string, delayMs: number): void => {
    void queue
      .add(TIMED_UNMUTE_JOB, { userId, mutedUntil }, { delay: Math.max(0, delayMs) })
      .catch((err: unknown) => {
        app.log.warn({ err: (err as Error).message, userId }, 'moderation-job: 排程自動解除失敗');
      });
  });

  // 消費端 admin service（setMute 不用，但 releaseTimedMute 共用同一 closure 的 writeAudit）
  const admin = createAdminService({
    prisma: app.prisma,
    redis: app.redis,
    wallet: createWalletService(app.prisma),
    log: app.log,
  });

  const processor = createModerationJobProcessor({
    releaseTimedMute: admin.releaseTimedMute,
    log: app.log,
  });

  const worker = new Worker(MODERATION_QUEUE_NAME, processor, {
    connection: workerConnection,
    // 同進程跑 BullMQ（02_TDD §8 取捨）：單併發即可，解除任務輕量
    concurrency: 1,
  });
  worker.on('error', (err) => app.log.debug({ err: err.message }, 'moderation-job: worker error'));
  worker.on('failed', (job, err) => {
    app.log.warn({ jobName: job?.name, err: err.message }, 'moderation-job: job failed');
  });

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    queueConnection.disconnect();
    workerConnection.disconnect();
    app.log.info('moderation-job: closed');
  });

  app.log.info('moderation-job: timed-unmute worker 已註冊');
  return { queue, worker };
}
