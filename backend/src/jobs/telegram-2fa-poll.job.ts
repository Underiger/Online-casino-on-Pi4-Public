/**
 * Telegram 2FA 推播短輪詢 repeatable job。
 *
 * 背景：admin 高危操作 2FA 重驗可改用 Telegram 推播核准（取代手動輸入 TOTP）；
 * Telegram 的 getUpdates 長輪詢不可被同一 bot token 的多個進程同時呼叫（會
 * 409 Conflict），cluster ×2 workers 不能各自起一個輪詢迴圈。
 *
 * 注意：單靠 BullMQ repeat key 去重「不夠」——repeat 排程只保證同一個 tick
 * 不會被重複加入佇列，但下一個 tick 仍會準時（每 2s）加入，若上一個 tick
 * 因網路延遲跑超過 2 秒，兩個 tick 可能同時各被一個 cluster worker 的 Worker
 * 實例領走、同時呼叫 getUpdates → 409。實測已驗證會發生。真正的解法是只讓
 * cluster worker#1 註冊這個 Queue/Worker（見 registerTelegramPollJob 開頭的
 * workerId 檢查）——其餘 worker 完全不建立連線，從根本上避免多進程併發。
 *
 * 短輪詢（每 2 秒一次 getUpdates(timeout=0)）而非長輪詢：job 執行時間可控、
 * 不佔用 Worker concurrency=1 的執行緒太久，與既有 tick(5s)/flush(10s) 的
 * 輕量 tick 風格一致。offset 存 Redis（admin.service 的 tg2faOffsetKey）——
 * 不可用 JS 模組變數，因為下一輪可能由另一個 cluster worker 進程執行。
 *
 * 功能未設定（TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID 任一空）時
 * registerTelegramPollJob 直接 no-op return，不建立任何 Queue/Worker/連線。
 *
 * 失敗語義：processor 捕捉一切錯誤僅記日誌——Telegram API 故障不可中斷其他
 * 服務，下一次 2 秒後的迭代自動重試。
 */
import cluster from 'node:cluster';
import { Worker, type Job, type Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { telegramEnabled } from '../integrations/telegram.js';
import { createAdminService } from '../modules/admin/admin.service.js';
import { createWalletService } from '../modules/wallet/wallet.service.js';
import { createJobConnection, createTelegramPollQueue, TELEGRAM_2FA_QUEUE_NAME } from './queues.js';

export const TELEGRAM_POLL_JOB = 'poll';

/** 短輪詢週期：2 秒 */
export const TELEGRAM_POLL_INTERVAL_MS = 2_000;

export interface TelegramPollJobLog {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface TelegramPollJobDeps {
  pollTelegramUpdates: () => Promise<void>;
  log?: TelegramPollJobLog;
}

/**
 * processor 工廠（與 BullMQ 接線分離——單元測試以 fake deps 直接驅動，
 * 不需要真 Redis / Worker / Telegram API）。
 */
export function createTelegramPollProcessor(deps: TelegramPollJobDeps) {
  const log: TelegramPollJobLog = deps.log ?? { warn: () => {} };

  return async (job: Pick<Job, 'name'>): Promise<void> => {
    try {
      if (job.name === TELEGRAM_POLL_JOB) {
        await deps.pollTelegramUpdates();
        return;
      }
      log.warn({ jobName: job.name }, 'telegram-2fa-job: 未知任務名稱，略過');
    } catch (err) {
      // 最後保險絲：job 失敗只記日誌，永不讓例外外溢中斷 Worker。
      // 注意：真實 pino instance 的 error/warn 方法依賴內部 this 綁定——
      // 取出函式參考後脫離 this 呼叫會拋 TypeError，必須維持 log.xxx(...) 呼叫形式。
      const entry = { err: (err as Error).message, jobName: job.name };
      const msg = 'telegram-2fa-job: 任務執行失敗（下次迭代自動重試）';
      if (log.error) {
        log.error(entry, msg);
      } else {
        log.warn(entry, msg);
      }
    }
  };
}

export interface TelegramPollJobsHandle {
  queue: Queue;
  worker: Worker;
}

/**
 * 啟動時註冊（server.ts，與其他 register*Jobs 同層）：
 *   1. 未設定 Telegram 2FA → log info 後直接 return（零開銷，不建立連線）。
 *   2. 非 cluster worker#1 → log info 後直接 return（避免多進程同時呼叫
 *      getUpdates 導致 409，見檔頭說明）。單進程／非 cluster 環境（測試、
 *      WORKERS=1）下 cluster.worker 為 undefined，視為 worker#1 正常註冊。
 *   3. 註冊 repeatable poll(2s)；建立 Worker 消費（呼叫 admin.pollTelegramUpdates）；
 *      onClose 收尾（Worker → Queue → 專用連線）。
 */
export async function registerTelegramPollJob(
  app: FastifyInstance,
): Promise<TelegramPollJobsHandle | null> {
  if (!telegramEnabled) {
    app.log.info('telegram-2fa-job: 未設定 TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID，略過註冊');
    return null;
  }

  const workerId = cluster.worker?.id ?? 1;
  if (workerId !== 1) {
    app.log.info(
      `telegram-2fa-job: cluster worker#${workerId} 非 worker#1，略過註冊（避免多進程同時呼叫 Telegram getUpdates 導致 409）`,
    );
    return null;
  }

  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();
  // 未掛 error listener 時 ioredis 會把連線錯誤拋成 unhandled error
  queueConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'telegram-2fa-job: queue redis error'),
  );
  workerConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'telegram-2fa-job: worker redis error'),
  );

  const queue = createTelegramPollQueue(queueConnection);

  // repeatable 註冊不可 await：開發環境 Redis 未起時 add() 會掛在 offline queue，
  // await 會無限期阻塞 listen。連線恢復後自動送達；同 spec 重複註冊冪等。
  void queue
    .add(TELEGRAM_POLL_JOB, {}, { repeat: { every: TELEGRAM_POLL_INTERVAL_MS } })
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'telegram-2fa-job: poll repeatable 註冊失敗');
    });

  // 消費端自建 admin service（與 registerModerationJobs 對 releaseTimedMute 同款手法——
  // job 不共用 route 那份 service 實例，狀態全靠 Redis/DB 共享，重建實例零成本）
  const admin = createAdminService({
    prisma: app.prisma,
    redis: app.redis,
    wallet: createWalletService(app.prisma),
    log: app.log,
  });

  const processor = createTelegramPollProcessor({
    pollTelegramUpdates: admin.pollTelegramUpdates,
    log: app.log,
  });

  const worker = new Worker(TELEGRAM_2FA_QUEUE_NAME, processor, {
    connection: workerConnection,
    // 同進程跑 BullMQ（02_TDD §8 取捨）：單併發即可，短輪詢任務輕量
    concurrency: 1,
  });
  worker.on('error', (err) =>
    app.log.debug({ err: err.message }, 'telegram-2fa-job: worker error'),
  );
  worker.on('failed', (job, err) => {
    app.log.warn({ jobName: job?.name, err: err.message }, 'telegram-2fa-job: job failed');
  });

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    queueConnection.disconnect();
    workerConnection.disconnect();
    app.log.info('telegram-2fa-job: closed');
  });

  app.log.info('telegram-2fa-job: poll(2s) repeatable job 已註冊');
  return { queue, worker };
}
