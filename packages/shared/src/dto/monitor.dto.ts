// ── Response types ────────────────────────────────────────────────────────────

export interface CpuStats {
  manufacturer: string;
  brand: string;
  physicalCores: number;
  currentLoad: number; // %
  temperature: number | null; // °C，部分平台無法讀取時為 null
}

export interface MemoryStats {
  total: number;   // bytes
  used: number;
  free: number;
  usedPercent: number; // %
}

export interface DiskStats {
  fs: string;
  size: number;   // bytes
  used: number;
  use: number;    // %
}

export interface SystemStatsRes {
  cpu: CpuStats;
  memory: MemoryStats;
  disk: DiskStats[];
  onlineUsers: number;
  /** 目前活躍的輪盤房間數（初版固定 1） */
  activeRooms: number;
  uptime: number; // 秒
  sampledAt: string; // ISO 8601
}
