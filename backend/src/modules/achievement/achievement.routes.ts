/**
 * Achievement & Profile 路由（M20；docs/04_API_SPEC.md §3.10）。
 *
 * 掛載點（app.ts 以 prefix '/api' 注冊）：
 *   GET /api/achievements           — 全部成就含解鎖狀態（authenticated）
 *   GET /api/achievements/unlocked  — 已解鎖成就清單（authenticated）
 *   GET /api/user/profile           — 個人統計 + 排行榜歷史（authenticated）
 */
import type { FastifyPluginAsync } from 'fastify';
import { createAchievementService } from './achievement.service.js';
import { createWalletService } from '../wallet/wallet.service.js';

export interface ProfileStats {
  totalSpins: number;
  /** BigInt → string */
  maxSingleWin: string;
  jackpotWins: number;
  charmsOwned: number;
  totalCharms: number;
}

export interface ProfileSnapshotEntry {
  kind: string;
  periodKey: string | null;
  rank: number;
  /** BigInt → string */
  score: string;
}

export interface ProfileRes {
  userId: string;
  username: string;
  avatarId: number;
  /** BigInt → string */
  balance: string;
  stats: ProfileStats;
  leaderboardHistory: ProfileSnapshotEntry[];
}

const achievementRoutes: FastifyPluginAsync = async (app) => {
  const wallet = createWalletService(app.prisma);
  const svc = createAchievementService({ prisma: app.prisma, wallet, log: app.log });

  // GET /achievements — 全部成就（含解鎖狀態）
  app.get('/achievements', { preHandler: [app.authenticate] }, async (request) => {
    return svc.getUserAchievements(request.user.sub);
  });

  // GET /achievements/unlocked — 僅已解鎖成就
  app.get('/achievements/unlocked', { preHandler: [app.authenticate] }, async (request) => {
    const { items } = await svc.getUserAchievements(request.user.sub);
    return { items: items.filter((a) => a.unlockedAt !== null) };
  });

  // GET /user/profile — 個人資料統計
  app.get('/user/profile', { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.user.sub;

    const [user, totalSpins, maxWinAgg, jackpotWins, charmsOwned, totalCharms, snapshots] =
      await Promise.all([
        app.prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, avatarId: true, balance: true },
        }),
        app.prisma.betRecord.count({ where: { userId, gameType: 'SLOT' } }),
        app.prisma.betRecord.aggregate({
          where: { userId, gameType: 'SLOT' },
          _max: { payout: true },
        }),
        app.prisma.jackpotHistory.count({ where: { userId } }),
        app.prisma.userCharm.count({ where: { userId } }),
        app.prisma.charm.count({ where: { enabled: true } }),
        app.prisma.leaderboardSnapshot.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { kind: true, periodKey: true, rank: true, score: true },
        }),
      ]);

    if (user === null) {
      throw new Error('使用者不存在');
    }

    const res: ProfileRes = {
      userId,
      username: user.username,
      avatarId: user.avatarId,
      balance: user.balance.toString(),
      stats: {
        totalSpins,
        maxSingleWin: (maxWinAgg._max.payout ?? 0n).toString(),
        jackpotWins,
        charmsOwned,
        totalCharms,
      },
      leaderboardHistory: snapshots.map((s) => ({
        kind: s.kind,
        periodKey: s.periodKey,
        rank: s.rank,
        score: s.score.toString(),
      })),
    };

    return res;
  });
};

export default achievementRoutes;
