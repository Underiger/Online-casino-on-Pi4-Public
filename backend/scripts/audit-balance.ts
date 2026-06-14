/**
 * 全帳對帳腳本（02_TDD §5.6：「提供 scripts/audit-balance.ts 比對 SUM(delta) 與現值」）。
 *
 * 逐使用者執行三項檢查（任何一項不符即列為差異，結束碼 1）：
 *   1. 單筆完整性：每筆 BalanceTransaction 的 delta === balanceAfter - balanceBefore
 *   2. 期末一致：最後一筆（createdAt 最新）的 balanceAfter === users.balance 現值
 *   3. 總和一致：第一筆的 balanceBefore + SUM(delta) === users.balance 現值
 *      （balanceBefore 作基線——新手禮包 5000 為 schema default，不產生 Tx 紀錄）
 *
 * 無任何交易紀錄的使用者跳過（無帳可對，僅計入統計）。
 *
 * 用法：
 *   npm run audit:balance          # backend workspace
 *   npx tsx scripts/audit-balance.ts
 */
import process from 'node:process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Discrepancy {
  userId: string;
  username: string;
  check: string;
  detail: string;
}

async function auditUser(user: {
  id: string;
  username: string;
  balance: bigint;
}): Promise<{ discrepancies: Discrepancy[]; txCount: number }> {
  const discrepancies: Discrepancy[] = [];

  // 200 人規模直接全撈；之後玩家數成長改為游標分批
  const records = await prisma.balanceTransaction.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      delta: true,
      balanceBefore: true,
      balanceAfter: true,
      createdAt: true,
    },
  });

  if (records.length === 0) {
    return { discrepancies, txCount: 0 };
  }

  // ── 檢查 1：單筆完整性 ──
  for (const record of records) {
    if (record.delta !== record.balanceAfter - record.balanceBefore) {
      discrepancies.push({
        userId: user.id,
        username: user.username,
        check: '單筆完整性',
        detail:
          `tx ${record.id}: delta=${record.delta} ≠ ` +
          `after(${record.balanceAfter}) - before(${record.balanceBefore})`,
      });
    }
  }

  // ── 檢查 2：期末一致 ──
  const last = records[records.length - 1]!;
  if (last.balanceAfter !== user.balance) {
    discrepancies.push({
      userId: user.id,
      username: user.username,
      check: '期末一致',
      detail: `最後一筆 balanceAfter=${last.balanceAfter} ≠ users.balance=${user.balance}`,
    });
  }

  // ── 檢查 3：總和一致 ──
  const first = records[0]!;
  let sum = 0n;
  for (const record of records) sum += record.delta;
  const expected = first.balanceBefore + sum;
  if (expected !== user.balance) {
    discrepancies.push({
      userId: user.id,
      username: user.username,
      check: '總和一致',
      detail:
        `基線(${first.balanceBefore}) + SUM(delta)(${sum}) = ${expected} ` +
        `≠ users.balance=${user.balance}`,
    });
  }

  return { discrepancies, txCount: records.length };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const users = await prisma.user.findMany({
    select: { id: true, username: true, balance: true },
    orderBy: { createdAt: 'asc' },
  });

  const allDiscrepancies: Discrepancy[] = [];
  let audited = 0;
  let skipped = 0;
  let totalTx = 0;

  for (const user of users) {
    const { discrepancies, txCount } = await auditUser(user);
    if (txCount === 0) {
      skipped += 1;
    } else {
      audited += 1;
      totalTx += txCount;
    }
    allDiscrepancies.push(...discrepancies);
  }

  console.log('═══════════════ 餘額對帳報告 ═══════════════');
  console.log(`使用者總數：${users.length}（有帳 ${audited}、無交易跳過 ${skipped}）`);
  console.log(`交易紀錄總數：${totalTx}`);
  console.log(`耗時：${Date.now() - startedAt}ms`);

  if (allDiscrepancies.length === 0) {
    console.log('✅ 全帳一致：所有使用者 SUM(delta) 與現值吻合，單筆完整性無誤。');
    return;
  }

  console.error(`❌ 發現 ${allDiscrepancies.length} 筆差異：`);
  for (const d of allDiscrepancies) {
    console.error(`  [${d.check}] ${d.username}（${d.userId}）：${d.detail}`);
  }
  process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error('對帳腳本執行失敗：', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
