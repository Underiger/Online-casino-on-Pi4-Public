/**
 * Jackpot flush / tick repeatable jobs（02_TDD §6.3、GDD §3.4.1、05_MILESTONES M14）。
 *
 * 兩個 repeatable 任務掛在同一條 jackpotFlushQueue：
 *   - flush（每 10 秒）：GETSET jackpot:delta 0 原子取增量 → PG pool = pool + delta。
 *   - tick（每 5 秒）：
 *       1. 提前 flush 檢查：txcount ≥ 500 即先 flush（GDD「每 10 秒或 txcount ≥ 500」；
 *          放在 tick 而非 accumulate 熱路徑——下注主流程零額外 Redis 往返，
 *          提前 flush 延遲上限 5 秒，可接受）
 *       2. 廣播 jackpot:tick { pool }（讀 Redis 展示值；GDD §3.4.1「每 5 秒廣播一次，
 *          不開放查詢 API 輪詢」）——io.emit 經 redis adapter 跨 worker 送達全服。
 *
 * 失敗語義：processor 捕捉一切錯誤僅記日誌——Redis / PG 故障不可中斷其他服務
 * （flush() 內部已自吞錯誤並把增量放回 Redis；此處的 catch 是最後保險絲）。
 *
 * cluster ×2 workers 各自呼叫 registerJackpotJobs：repeatable spec 以 repeat key
 * 去重（同 spec 重複註冊冪等），每次迭代僅一個 Worker 取得執行權。
 */
import { Worker, type Job, type Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { SOCKET_EVENTS } from '../sockets/events.js';
import { createJackpotService, JACKPOT_TXCOUNT_KEY, type JackpotService } from '../modules/jackpot/jackpot.service.js';
import { createWalletService } from '../modules/wallet/wallet.service.js';
import { createJackpotFlushQueue, createJobConnection, JACKPOT_FLUSH_QUEUE_NAME } from './queues.js';

export const JACKPOT_FLUSH_JOB = 'flush';
export const JACKPOT_TICK_JOB = 'tick';

/** flush 週期：10 秒（GDD §3.4.1） */
export const JACKPOT_FLUSH_INTERVAL_MS = 10_000;
/** tick 廣播週期：5 秒（GDD §3.4.1） */
export const JACKPOT_TICK_INTERVAL_MS = 5_000;
/** 提前 flush 門檻：自上次 flush 起的下注筆數（GDD §3.4.1） */
export const JACKPOT_FLUSH_TXCOUNT_THRESHOLD = 500;

export interface JackpotJobLog {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface JackpotJobDeps {
  jackpot: Pick<JackpotService, 'flush' | 'getLivePool'>;
  /** tick 讀 txcount 判斷提前 flush */
  redis: Redis;
  /** 全服廣播出口（app.io.emit） */
  emit: (event: string, payload: unknown) => void;
  log?: JackpotJobLog;
}

/**
 * processor 工廠（與 BullMQ 接線分離——單元測試以 fake deps 直接驅動，
 * 不需要真 Redis / Worker）。
 */
export function createJackpotJobProcessor(deps: JackpotJobDeps) {
  const log: JackpotJobLog = deps.log ?? { warn: () => {} };

  return async (job: Pick<Job, 'name'>): Promise<void> => {
    try {
      if (job.name === JACKPOT_FLUSH_JOB) {
        await deps.jackpot.flush();
        return;
      }

      if (job.name === JACKPOT_TICK_JOB) {
        // 提前 flush：txcount ≥ 500（讀取失敗視為 0，僅依賴 10s 週期 flush）
        let txcount = 0;
        try {
          const raw = await deps.redis.get(JACKPOT_TXCOUNT_KEY);
          const parsed = Number(raw ?? '0');
          txcount = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'jackpot-job: txcount 讀取失敗，跳過提前 flush 檢查');
        }
        if (txcount >= JACKPOT_FLUSH_TXCOUNT_THRESHOLD) {
          await deps.jackpot.flush();
        }

        const pool = await deps.jackpot.getLivePool();
        deps.emit(SOCKET_EVENTS.JACKPOT_TICK, { pool: pool.toString() });
        return;
      }

      log.warn({ jobName: job.name }, 'jackpot-job: 未知任務名稱，略過');
    } catch (err) {
      // 最後保險絲：job 失敗只記日誌，永不讓例外外溢中斷 Worker
      (log.error ?? log.warn)(
        { err: (err as Error).message, jobName: job.name },
        'jackpot-job: 任務執行失敗（下次迭代自動重試）',
      );
    }
  };
}

export interface JackpotJobsHandle {
  queue: Queue;
  worker: Worker;
  jackpot: JackpotService;
}

/**
 * 啟動時註冊（server.ts 於 initSocketServer 之後呼叫——emit 依賴 app.io）：
 *   1. 開機校準展示值 jackpot:pool = pool(DB) + delta(Redis)
 *   2. 註冊 repeatable flush(10s) / tick(5s)（fire-and-forget——開發環境 Redis
 *      未起時不可阻塞 listen，BullMQ 連上後自動補註冊）
 *   3. 建立 Worker 消費；onClose 收尾（Worker → Queue → 專用連線）
 */
export async function registerJackpotJobs(app: FastifyInstance): Promise<JackpotJobsHandle> {
  const jackpot = createJackpotService({
    prisma: app.prisma,
    redis: app.redis,
    wallet: createWalletService(app.prisma),
    log: app.log,
  });

  // 開機校準（GDD §3.4.1 重啟恢復：pool(DB) + delta(Redis)）；失敗自吞、不阻啟動
  void jackpot.restoreLivePool();

  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();
  // 未掛 error listener 時 ioredis 會把連線錯誤拋成 unhandled error
  queueConnection.on('error', (err) => app.log.debug({ err: err.message }, 'jackpot-job: queue redis error'));
  workerConnection.on('error', (err) => app.log.debug({ err: err.message }, 'jackpot-job: worker redis error'));

  const queue = createJackpotFlushQueue(queueConnection);

  // repeatable 註冊不可 await：開發環境 Redis 未起時 add() 會掛在 offline queue，
  // await 會無限期阻塞 listen。連線恢復後自動送達；同 spec 重複註冊冪等。
  void queue
    .add(JACKPOT_FLUSH_JOB, {}, { repeat: { every: JACKPOT_FLUSH_INTERVAL_MS } })
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'jackpot-job: flush repeatable 註冊失敗');
    });
  void queue
    .add(JACKPOT_TICK_JOB, {}, { repeat: { every: JACKPOT_TICK_INTERVAL_MS } })
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'jackpot-job: tick repeatable 註冊失敗');
    });

  const processor = createJackpotJobProcessor({
    jackpot,
    redis: app.redis,
    emit: (event, payload) => {
      // io 於 server.ts 中先於本函式 decorate；雙保險防整合測試未掛 Socket
      if (app.hasDecorator('io')) app.io.emit(event, payload);
    },
    log: app.log,
  });

  const worker = new Worker(JACKPOT_FLUSH_QUEUE_NAME, processor, {
    connection: workerConnection,
    // 同進程跑 BullMQ（02_TDD §8 取捨）：單併發即可，flush/tick 皆輕量
    concurrency: 1,
  });
  worker.on('error', (err) => app.log.debug({ err: err.message }, 'jackpot-job: worker error'));
  worker.on('failed', (job, err) => {
    app.log.warn({ jobName: job?.name, err: err.message }, 'jackpot-job: job failed');
  });

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    queueConnection.disconnect();
    workerConnection.disconnect();
    app.log.info('jackpot-job: closed');
  });

  app.log.info('jackpot-job: flush(10s) / tick(5s) repeatable jobs 已註冊');
  return { queue, worker, jackpot };
}
