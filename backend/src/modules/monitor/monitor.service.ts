/**
 * Monitor Service（M24；02_TDD §5.7、GDD §6）：
 *   以 systeminformation 採集 CPU / 記憶體 / 磁碟資訊，
 *   並從 Redis 讀取跨 worker 線上人數（CONN_KEY_PREFIX 計數鍵加總）。
 *
 * 設計原則：
 * - CPU 品牌 / 核心數為靜態資料，開機時快取；負載 / 溫度每次查詢即時採樣。
 * - systeminformation 失敗時提供合理降級回應（不拋例外，以 N/A 值填充）。
 * - online count 讀取失敗時回 -1（表示不可用）。
 * - activeRooms：讀取 roulette:round:current 鍵是否存在（0 或 1）。
 */
import { hostname } from 'node:os';
import process from 'node:process';
import si from 'systeminformation';
import type { Redis } from 'ioredis';

/** 跨 worker Socket.IO 連線計數鍵前綴（鏡像 sockets/middleware.ts） */
const CONN_KEY_PREFIX = 'socket:conns';
/** 輪盤當前回合快照鍵（鏡像 roulette.service.ts） */
const ROULETTE_ROUND_KEY = 'roulette:round:current';

export interface SystemStatsRes {
  cpu: {
    manufacturer: string;
    brand: string;
    physicalCores: number;
    currentLoad: number;
    temperature: number | null;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usedPercent: number;
  };
  disk: { fs: string; size: number; used: number; use: number }[];
  onlineUsers: number;
  activeRooms: number;
  /** Node.js 行程運行秒數（跨重啟不累積） */
  uptime: number;
  sampledAt: string;
}

export interface MonitorServiceDeps {
  redis: Redis;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

// CPU 靜態資訊快取（每次重啟取一次，不隨採樣刷新）
let cpuStatic: { manufacturer: string; brand: string; physicalCores: number } | null = null;

async function getCpuStatic(): Promise<{ manufacturer: string; brand: string; physicalCores: number }> {
  if (cpuStatic !== null) return cpuStatic;
  try {
    const info = await si.cpu();
    cpuStatic = {
      manufacturer: info.manufacturer || 'Unknown',
      brand: info.brand || 'Unknown',
      physicalCores: info.physicalCores || 1,
    };
  } catch {
    cpuStatic = { manufacturer: 'Unknown', brand: 'Unknown', physicalCores: 1 };
  }
  return cpuStatic;
}

export function createMonitorService(deps: MonitorServiceDeps) {
  const { redis, log } = deps;

  async function getOnlineUsers(): Promise<number> {
    try {
      // SCAN 所有 worker 計數鍵後加總（鏡像 middleware.ts globalCount()）
      let total = 0;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${CONN_KEY_PREFIX}:*`, 'COUNT', 50);
        cursor = nextCursor;
        if (keys.length > 0) {
          const vals = await redis.mget(...keys);
          for (const v of vals) {
            const n = parseInt(v ?? '0', 10);
            if (!isNaN(n)) total += n;
          }
        }
      } while (cursor !== '0');
      return total;
    } catch (err) {
      log?.warn({ err: (err as Error).message }, 'monitor: 讀取線上人數失敗');
      return -1;
    }
  }

  async function getActiveRooms(): Promise<number> {
    try {
      const exists = await redis.exists(ROULETTE_ROUND_KEY);
      return exists ? 1 : 0;
    } catch {
      return 0;
    }
  }

  return {
    async getStats(): Promise<SystemStatsRes> {
      const [cpuInfo, loadInfo, tempInfo, memInfo, diskInfo, onlineUsers, activeRooms] =
        await Promise.allSettled([
          getCpuStatic(),
          si.currentLoad(),
          si.cpuTemperature(),
          si.mem(),
          si.fsSize(),
          getOnlineUsers(),
          getActiveRooms(),
        ]);

      const cpu = cpuInfo.status === 'fulfilled' ? cpuInfo.value : { manufacturer: 'Unknown', brand: 'Unknown', physicalCores: 1 };
      const load = loadInfo.status === 'fulfilled' ? loadInfo.value.currentLoad : 0;
      const temp = tempInfo.status === 'fulfilled' ? (tempInfo.value.main > 0 ? tempInfo.value.main : null) : null;
      const mem = memInfo.status === 'fulfilled' ? memInfo.value : null;
      const disks = diskInfo.status === 'fulfilled'
        ? diskInfo.value
            .filter((d) => d.size > 0)
            .map((d) => ({ fs: d.fs, size: d.size, used: d.used, use: d.use }))
        : [];

      const memTotal = mem?.total ?? 0;
      const memUsed = mem?.used ?? 0;
      const memFree = mem?.free ?? 0;
      const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

      return {
        cpu: {
          manufacturer: cpu.manufacturer,
          brand: cpu.brand,
          physicalCores: cpu.physicalCores,
          currentLoad: Math.round(load * 10) / 10,
          temperature: temp !== null ? Math.round(temp * 10) / 10 : null,
        },
        memory: {
          total: memTotal,
          used: memUsed,
          free: memFree,
          usedPercent: Math.round(memPct * 10) / 10,
        },
        disk: disks,
        onlineUsers: onlineUsers.status === 'fulfilled' ? onlineUsers.value : -1,
        activeRooms: activeRooms.status === 'fulfilled' ? activeRooms.value : 0,
        uptime: Math.floor(process.uptime()),
        sampledAt: new Date().toISOString(),
      };
    },

    /** hostname：用於多 worker 辨識，日誌可用 */
    hostname(): string {
      return hostname();
    },
  };
}

export type MonitorService = ReturnType<typeof createMonitorService>;
