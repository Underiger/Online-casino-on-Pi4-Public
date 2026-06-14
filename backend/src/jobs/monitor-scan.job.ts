/**
 * Monitor Scan BullMQ Job（M24；02_TDD §5.7、05_MILESTONES M24）。
 *
 * 每 10 分鐘執行一次，負責：
 *   1. 計算全服今日 NET_WIN P99（SCAN anomaly:netwin:*:{today} → 排序 → P99 寫 Redis）
 *      供 anomaly.ts 規則 3（NET_WIN_OUTLIER）即時讀取。
 *   2. （可擴充）掃描異常 flag 使用者並通知 Admin（M24 暫不實作通知管道）。
 *
 * 處理器工廠（createMonitorScanProcessor）與 BullMQ 接線分離——
 * 單元測試以 fake redis 直接驅動，不需要真 Worker。
 *
 * cluster ×2 workers 各自呼叫 registerMonitorScanJob；BullMQ repeatable spec
 * 以 repeat key 去重，同一時刻只有一個 worker 取得執行。
 */
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { createJobConnection } from './queues.js';
import { createAnomalyDetector } from '../security/anomaly.js';

export const MONITOR_SCAN_QUEUE_NAME = 'monitor-scan';
export const MONITOR_SCAN_JOB = 'scan';

/** 掃描週期：10 分鐘 */
export const MONITOR_SCAN_INTERVAL_MS = 10 * 60 * 1_000;

export interface MonitorScanJobDeps {
  anomaly: Pick<ReturnType<typeof createAnomalyDetector>, 'updateNetWinP99'>;
  log?: { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
}

/** processor 工廠（單元測試直接呼叫此函式取得 processor，傳入 fake deps） */
export function createMonitorScanProcessor(deps: MonitorScanJobDeps) {
  return async (): Promise<void> => {
    try {
      await deps.anomaly.updateNetWinP99();
      deps.log?.info?.({}, 'monitor-scan: NET_WIN P99 掃描完成');
    } catch (err) {
      deps.log?.warn?.({ err: (err as Error).message }, 'monitor-scan: 任務執行失敗（下次迭代自動重試）');
    }
  };
}

/** 啟動時呼叫（server.ts 在 initSocketServer 之後）：建立 Queue + Worker + 註冊 repeatable */
export async function registerMonitorScanJob(app: FastifyInstance): Promise<void> {
  const anomaly = createAnomalyDetector(app.redis, { log: app.log });

  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();

  queueConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'monitor-scan: queue redis error'),
  );
  workerConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'monitor-scan: worker redis error'),
  );

  const queue = new Queue(MONITOR_SCAN_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 50,
    },
  });

  void queue
    .add(MONITOR_SCAN_JOB, {}, { repeat: { every: MONITOR_SCAN_INTERVAL_MS } })
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'monitor-scan: repeatable 註冊失敗');
    });

  const processor = createMonitorScanProcessor({ anomaly, log: app.log });

  const worker = new Worker(MONITOR_SCAN_QUEUE_NAME, processor, {
    connection: workerConnection,
  });

  worker.on('failed', (job, err) => {
    app.log.warn({ err: err.message, jobId: job?.id }, 'monitor-scan: worker 任務失敗');
  });

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  });
}
