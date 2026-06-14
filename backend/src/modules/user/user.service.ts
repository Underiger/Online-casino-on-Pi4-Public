/**
 * User 模組 service（M04 最小集：查詢與建立，供 auth 模組使用）。
 *
 * 注意：本模組「不」提供任何餘額修改方法——balance 唯一出入口是 wallet 模組（M07），
 * ESLint no-restricted-syntax 會攔截其他位置的 prisma.user.update*。
 */
import type { PrismaClient, User } from '@prisma/client';

export interface CreatePlayerInput {
  username: string;
  passwordHash: string;
}

export function createUserService(prisma: PrismaClient) {
  return {
    findById(id: string): Promise<User | null> {
      return prisma.user.findUnique({ where: { id } });
    },

    findByUsername(username: string): Promise<User | null> {
      return prisma.user.findUnique({ where: { username } });
    },

    /** 建立玩家帳號：balance 5000（schema default 新手禮包）、role PLAYER */
    createPlayer({ username, passwordHash }: CreatePlayerInput): Promise<User> {
      return prisma.user.create({ data: { username, passwordHash } });
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
