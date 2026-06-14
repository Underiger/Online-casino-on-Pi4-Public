/**
 * IllegalPacketLog 落庫（02_TDD §5.7）：
 * 簽章失敗、nonce 重放、seq 倒退、逾時請求、超窗下注、限流命中全量記錄
 * （含 IP、endpoint、原始 payload 截斷 1KB）。
 *
 * record() 為 fire-and-forget——安全日誌永不阻塞、永不影響請求回應；
 * 落庫失敗只進應用日誌。需要等待結果的測試/批次場景用 write()。
 */
import type { PacketViolation, PrismaClient } from '@prisma/client';

export interface IllegalPacketEntry {
  /** 未通過 JWT 驗證的請求可能拿不到 userId */
  userId?: string | null;
  ip: string;
  violation: PacketViolation;
  /** 例："POST /api/slot/spin" */
  endpoint: string;
  /** 原始 payload（JSON 字串），自動截斷 1KB */
  rawSample?: string | null;
}

export interface IllegalPacketLogger {
  error: (obj: unknown, msg?: string) => void;
}

export function createIllegalPacketService(prisma: PrismaClient, log?: IllegalPacketLogger) {
  async function write(entry: IllegalPacketEntry): Promise<void> {
    await prisma.illegalPacketLog.create({
      data: {
        userId: entry.userId ?? null,
        ip: entry.ip.slice(0, 45),
        violation: entry.violation,
        endpoint: entry.endpoint.slice(0, 80),
        rawSample:
          entry.rawSample !== null && entry.rawSample !== undefined
            ? entry.rawSample.slice(0, 1_024)
            : null,
      },
    });
  }

  return {
    write,

    /** fire-and-forget：呼叫後立即返回，落庫失敗僅記日誌 */
    record(entry: IllegalPacketEntry): void {
      void write(entry).catch((err: unknown) => {
        log?.error(
          { err: err instanceof Error ? err.message : String(err), entry },
          'illegal-packet: 落庫失敗',
        );
      });
    },
  };
}

export type IllegalPacketService = ReturnType<typeof createIllegalPacketService>;
