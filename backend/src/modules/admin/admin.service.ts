/**
 * Admin 模組 service（M21；01_GDD §6、02_TDD §5.5/§5.7）。
 *
 * 職責：
 *   1. 2FA（TOTP）綁定 / 確認 / 登入後驗證 / 高危步進重驗（reverifyToken）
 *   2. 玩家管理：查詢、詳情、封鎖/解封（踢線 + 撤銷會話）、禁言、手動調幣（走 wallet）
 *   3. 稽核日誌：所有敏感操作寫 AdminAuditLog（before/after/ip），可分頁查詢
 *   4. 公告 CRUD + 對外有效公告查詢（公開）
 *   5. Gift Code 產生（高危）+ 列表（碼遮蔽）
 *
 * 安全設計：
 * - 餘額調整一律經 wallet.credit/debit（type=ADMIN_ADJUST）——餘額鐵律不破例；
 *   調幣與其 AdminAuditLog 於同一 $transaction，要嘛全成、要嘛全回滾。
 * - 封鎖/禁言/啟用 TOTP 與其稽核同 $transaction（tx.user.update + tx.adminAuditLog.create）。
 * - 高危操作以 reverifyToken（短效、Redis 存）授權：reverify 端點驗證即時 TOTP（防重用）後簽發。
 * - TOTP secret 以 AES-256-GCM 加密落 User.totpSecretEnc；備用碼 sha256 雜湊、一次性消耗。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { rngToken } from '../../security/csprng.js';
import {
  buildOtpAuthUri,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  matchRecoveryCode,
  verifyTotp,
} from '../../security/totp.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors.js';
import { GIFT_CODE_CHARSET, GIFT_CODE_LENGTH } from './admin.constants.js';
import type { WalletService } from '../wallet/wallet.service.js';
import type {
  AdjustBalanceRes,
  AdminMeRes,
  AdminPlayerDetailRes,
  AdminPlayerItem,
  AdminPlayerListRes,
  AnnouncementCreateReq,
  AnnouncementItem,
  AnnouncementListRes,
  AnnouncementUpdateReq,
  AuditItem,
  AuditListRes,
  AuditQuery,
  BanUserRes,
  CreateGiftCodeReq,
  GiftCodeItem,
  GiftCodeListQuery,
  GiftCodeListRes,
  MuteUserRes,
  PlayerSearchQuery,
  ReverifyRes,
  TotpConfirmRes,
  TotpSetupRes,
  ValidateRes,
} from './admin.types.js';

// ─── 常數 ─────────────────────────────────────────────────────────────────────

/** reverifyToken 壽命（秒）：高危操作步進憑證 */
const REVERIFY_TTL_SECONDS = 600;
/** TOTP code 防重用記錄壽命（秒） */
const TOTP_REUSE_TTL_SECONDS = 600;

/** 稽核動作碼（AdminAuditLog.action；≤ AUDIT_ACTION_MAX_LENGTH 字元） */
export const AUDIT_ACTIONS = {
  ENABLE_TOTP: 'ENABLE_TOTP',
  ADJUST_BALANCE: 'ADJUST_BALANCE',
  BAN_USER: 'BAN_USER',
  UNBAN_USER: 'UNBAN_USER',
  MUTE_USER: 'MUTE_USER',
  UNMUTE_USER: 'UNMUTE_USER',
  CREATE_GIFT_CODE: 'CREATE_GIFT_CODE',
  CREATE_ANNOUNCEMENT: 'CREATE_ANNOUNCEMENT',
  UPDATE_ANNOUNCEMENT: 'UPDATE_ANNOUNCEMENT',
  DELETE_ANNOUNCEMENT: 'DELETE_ANNOUNCEMENT',
} as const;

// ─── Redis 鍵 ─────────────────────────────────────────────────────────────────

const reverifyKey = (token: string): string => `admin:reverify:${token}`;
const totpUsedKey = (userId: string, code: string): string => `admin:totp:used:${userId}:${code}`;
const muteUntilKey = (userId: string): string => `admin:mute:until:${userId}`;

// ─── 型別 ─────────────────────────────────────────────────────────────────────

export interface AdminServiceLog {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export interface AdminServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: Pick<WalletService, 'credit' | 'debit'>;
  /** 封鎖時撤銷會話 HMAC 金鑰（app.hmacKeys）；缺省則略過 */
  hmacKeys?: { revoke: (userId: string) => Promise<void> };
  /** 封鎖時踢除在線連線（包裝 app.io）；缺省則略過 */
  disconnectUser?: (userId: string) => void;
  /** 建立有效公告時全服廣播（包裝 app.io.emit system:announcement）；缺省則略過 */
  emitAnnouncement?: (payload: { id: string; title: string; content: string }) => void;
  log?: AdminServiceLog;
}

// ─── 輔助函式 ─────────────────────────────────────────────────────────────────

function parseRecoveryCodes(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toPlayerItem(u: {
  id: string;
  username: string;
  role: AdminPlayerItem['role'];
  balance: bigint;
  avatarId: number;
  banned: boolean;
  muted: boolean;
  flagged: boolean;
  jackpotPoints: number;
  loginStreak: number;
  createdAt: Date;
}): AdminPlayerItem {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    balance: u.balance.toString(),
    avatarId: u.avatarId,
    banned: u.banned,
    muted: u.muted,
    flagged: u.flagged,
    jackpotPoints: u.jackpotPoints,
    loginStreak: u.loginStreak,
    createdAt: u.createdAt.toISOString(),
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function createAdminService(deps: AdminServiceDeps) {
  const { prisma, redis, wallet } = deps;
  const log: AdminServiceLog = deps.log ?? { warn: () => {} };

  // ── 稽核 ────────────────────────────────────────────────────────────────────

  /** 在交易內寫一筆稽核（敏感操作必須與其主變更同 tx；before/after 為小型 JSON 摘要） */
  async function writeAudit(
    tx: Prisma.TransactionClient,
    params: {
      adminId: string;
      action: string;
      targetUserId?: string | null;
      before?: Prisma.InputJsonValue;
      after?: Prisma.InputJsonValue;
      ip: string;
    },
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        adminId: params.adminId,
        action: params.action,
        targetUserId: params.targetUserId ?? null,
        before: params.before ?? {},
        after: params.after ?? {},
        ip: params.ip.slice(0, 45),
      },
    });
  }

  // ── 2FA / TOTP ───────────────────────────────────────────────────────────────

  /** 簽發短效 reverifyToken（Redis 存 token→userId） */
  async function issueReverifyToken(userId: string): Promise<ReverifyRes> {
    const token = rngToken(32);
    await redis.set(reverifyKey(token), userId, 'EX', REVERIFY_TTL_SECONDS);
    return { reverifyToken: token, expiresIn: REVERIFY_TTL_SECONDS };
  }

  /** 高危 preHandler 用：reverifyToken 是否有效且屬於該 admin（窗口內可重用） */
  async function checkReverifyToken(userId: string, token: string | undefined): Promise<boolean> {
    if (token === undefined || token.length === 0) return false;
    try {
      const owner = await redis.get(reverifyKey(token));
      return owner === userId;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'admin: reverifyToken 讀取失敗，拒絕（fail-closed）');
      return false;
    }
  }

  /** 驗證即時 TOTP（含防重用）；失敗拋錯。成功後將該 code 標記為已用。 */
  async function assertTotpValid(userId: string, secretEnc: string, code: string): Promise<void> {
    // 防重用（best-effort：Redis 故障不阻斷正確碼，僅留警告）
    try {
      const used = await redis.get(totpUsedKey(userId, code));
      if (used !== null) throw new UnauthorizedError('驗證碼已使用，請待下一組');
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      log.warn({ err: (err as Error).message }, 'admin: TOTP 防重用檢查失敗，略過');
    }

    let secret: string;
    try {
      secret = decryptSecret(secretEnc);
    } catch {
      throw new UnauthorizedError('2FA 設定異常，請重新綁定');
    }
    if (!verifyTotp(secret, code)) throw new UnauthorizedError('驗證碼錯誤');

    try {
      await redis.set(totpUsedKey(userId, code), '1', 'EX', TOTP_REUSE_TTL_SECONDS);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'admin: TOTP 已用標記寫入失敗');
    }
  }

  /** POST /totp/setup：產生並加密 secret（尚未啟用），回 QR URI + secret（僅此一次） */
  async function setupTotp(adminId: string, username: string): Promise<TotpSetupRes> {
    const user = await prisma.user.findUnique({
      where: { id: adminId },
      select: { totpEnabled: true },
    });
    if (user === null) throw new NotFoundError('使用者不存在');
    if (user.totpEnabled) throw new ConflictError('2FA 已啟用，請先停用後再重新綁定');

    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: adminId },
      data: { totpSecretEnc: encryptSecret(secret) },
    });
    return { qrUri: buildOtpAuthUri(username, secret), secret };
  }

  /** POST /totp/verify：驗證綁定碼 → 啟用 2FA + 產生備用碼（雜湊落庫） */
  async function confirmTotp(adminId: string, code: string, ip: string): Promise<TotpConfirmRes> {
    const user = await prisma.user.findUnique({
      where: { id: adminId },
      select: { totpSecretEnc: true, totpEnabled: true },
    });
    if (user === null) throw new NotFoundError('使用者不存在');
    if (user.totpSecretEnc === null) throw new ForbiddenError('請先呼叫 setup 取得綁定密鑰');
    if (user.totpEnabled) throw new ConflictError('2FA 已啟用');

    let secret: string;
    try {
      secret = decryptSecret(user.totpSecretEnc);
    } catch {
      throw new UnauthorizedError('2FA 設定異常，請重新綁定');
    }
    if (!verifyTotp(secret, code)) throw new UnauthorizedError('驗證碼錯誤');

    const { plain, hashed } = generateRecoveryCodes();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: adminId },
        data: { totpEnabled: true, recoveryCodes: JSON.stringify(hashed) },
      });
      await writeAudit(tx, {
        adminId,
        action: AUDIT_ACTIONS.ENABLE_TOTP,
        targetUserId: adminId,
        before: { totpEnabled: false },
        after: { totpEnabled: true },
        ip,
      });
    });
    return { enabled: true, recoveryCodes: plain };
  }

  /** POST /totp/validate：登入後 2FA——接受 TOTP 或備用碼，簽發 reverifyToken */
  async function validate2fa(adminId: string, code: string): Promise<ValidateRes> {
    const user = await prisma.user.findUnique({
      where: { id: adminId },
      select: { totpSecretEnc: true, totpEnabled: true, recoveryCodes: true },
    });
    if (user === null) throw new NotFoundError('使用者不存在');
    if (!user.totpEnabled || user.totpSecretEnc === null) {
      throw new ForbiddenError('尚未啟用 2FA');
    }

    // 6 位純數字 → 走 TOTP；其餘 → 視為備用碼
    if (/^\d{6}$/.test(code)) {
      await assertTotpValid(adminId, user.totpSecretEnc, code);
      return issueReverifyToken(adminId);
    }

    const hashed = parseRecoveryCodes(user.recoveryCodes);
    const matched = matchRecoveryCode(code, hashed);
    if (matched === null) throw new UnauthorizedError('驗證碼或備用碼錯誤');

    // 一次性消耗：移除命中的備用碼
    const remaining = hashed.filter((h) => h !== matched);
    await prisma.user.update({
      where: { id: adminId },
      data: { recoveryCodes: JSON.stringify(remaining) },
    });
    return issueReverifyToken(adminId);
  }

  /** POST /totp/reverify：高危步進——僅即時 TOTP（防重用），簽發 reverifyToken */
  async function reverify(adminId: string, code: string): Promise<ReverifyRes> {
    const user = await prisma.user.findUnique({
      where: { id: adminId },
      select: { totpSecretEnc: true, totpEnabled: true },
    });
    if (user === null) throw new NotFoundError('使用者不存在');
    if (!user.totpEnabled || user.totpSecretEnc === null) {
      throw new ForbiddenError('尚未啟用 2FA');
    }
    await assertTotpValid(adminId, user.totpSecretEnc, code);
    return issueReverifyToken(adminId);
  }

  /** GET /me：回傳當前管理員概要（前端據此決定顯示綁定或驗證流程） */
  async function getMe(adminId: string): Promise<AdminMeRes> {
    const user = await prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, username: true, role: true, totpEnabled: true },
    });
    if (user === null) throw new NotFoundError('使用者不存在');
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      totpEnabled: user.totpEnabled,
    };
  }

  // ── 玩家管理 ──────────────────────────────────────────────────────────────────

  async function listPlayers(query: PlayerSearchQuery): Promise<AdminPlayerListRes> {
    const where: Prisma.UserWhereInput = {};
    if (query.q !== undefined && query.q.length > 0) {
      where.OR = [
        { username: { contains: query.q, mode: 'insensitive' } },
        { id: query.q },
      ];
    }
    if (query.banned !== undefined) where.banned = query.banned;
    if (query.flagged !== undefined) where.flagged = query.flagged;

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          username: true,
          role: true,
          balance: true,
          avatarId: true,
          banned: true,
          muted: true,
          flagged: true,
          jackpotPoints: true,
          loginStreak: true,
          createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);

    return {
      items: rows.map(toPlayerItem),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async function getPlayer(userId: string): Promise<AdminPlayerDetailRes> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        balance: true,
        avatarId: true,
        banned: true,
        muted: true,
        flagged: true,
        jackpotPoints: true,
        loginStreak: true,
        createdAt: true,
        totpEnabled: true,
        lastDailyAt: true,
        updatedAt: true,
      },
    });
    if (user === null) throw new NotFoundError('使用者不存在');

    const logs = await prisma.loginLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { result: true, ip: true, createdAt: true },
    });

    return {
      ...toPlayerItem(user),
      totpEnabled: user.totpEnabled,
      lastDailyAt: user.lastDailyAt?.toISOString() ?? null,
      updatedAt: user.updatedAt.toISOString(),
      recentLogins: logs.map((l) => ({
        result: l.result,
        ip: l.ip,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /** 封鎖時撤銷所有 refresh 會話 + HMAC 金鑰 + 踢線（best-effort，失敗僅記日誌） */
  async function revokeAllSessions(userId: string): Promise<void> {
    try {
      await prisma.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'admin: 撤銷 refresh token 失敗');
    }
    if (deps.hmacKeys !== undefined) {
      try {
        await deps.hmacKeys.revoke(userId);
      } catch (err) {
        log.warn({ err: (err as Error).message, userId }, 'admin: 撤銷 HMAC 金鑰失敗');
      }
    }
    try {
      deps.disconnectUser?.(userId);
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'admin: 踢除連線失敗');
    }
  }

  async function setBan(
    adminId: string,
    targetUserId: string,
    banned: boolean,
    ip: string,
    reason?: string,
  ): Promise<BanUserRes> {
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, banned: true, role: true },
    });
    if (target === null) throw new NotFoundError('使用者不存在');
    if (target.role === 'ADMIN') throw new ForbiddenError('不可封鎖管理員帳號');
    if (target.id === adminId) throw new ForbiddenError('不可封鎖自己');

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetUserId }, data: { banned } });
      await writeAudit(tx, {
        adminId,
        action: banned ? AUDIT_ACTIONS.BAN_USER : AUDIT_ACTIONS.UNBAN_USER,
        targetUserId,
        before: { banned: target.banned },
        after: { banned, ...(reason !== undefined ? { reason } : {}) },
        ip,
      });
    });

    // 封鎖後即時失效會話並踢線（解封不需要）
    if (banned) await revokeAllSessions(targetUserId);

    return { userId: targetUserId, banned };
  }

  async function setMute(
    adminId: string,
    targetUserId: string,
    muted: boolean,
    ip: string,
    opts: { durationMinutes?: number; reason?: string } = {},
  ): Promise<MuteUserRes> {
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, muted: true },
    });
    if (target === null) throw new NotFoundError('使用者不存在');

    let mutedUntil: string | null = null;
    if (muted && opts.durationMinutes !== undefined) {
      mutedUntil = new Date(Date.now() + opts.durationMinutes * 60_000).toISOString();
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetUserId }, data: { muted } });
      await writeAudit(tx, {
        adminId,
        action: muted ? AUDIT_ACTIONS.MUTE_USER : AUDIT_ACTIONS.UNMUTE_USER,
        targetUserId,
        before: { muted: target.muted },
        after: {
          muted,
          ...(mutedUntil !== null ? { mutedUntil } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        },
        ip,
      });
    });

    // 時長為純記錄（Redis 留痕；自動解除由後續排程實作，無 mutedUntil 欄位）
    try {
      if (mutedUntil !== null && opts.durationMinutes !== undefined) {
        await redis.set(muteUntilKey(targetUserId), mutedUntil, 'EX', opts.durationMinutes * 60);
      } else if (!muted) {
        await redis.del(muteUntilKey(targetUserId));
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, targetUserId }, 'admin: mute 期限標記寫入失敗');
    }

    return { userId: targetUserId, muted, mutedUntil };
  }

  /** 手動調幣（高危）：走 wallet（type=ADMIN_ADJUST）+ 稽核，同一 $transaction 原子 */
  async function adjustBalance(
    adminId: string,
    targetUserId: string,
    delta: number,
    reason: string,
    ip: string,
  ): Promise<AdjustBalanceRes> {
    if (delta === 0) throw new ValidationError('調整量不可為零');

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (target === null) throw new NotFoundError('使用者不存在');

    const amount = BigInt(Math.abs(delta));
    const deltaBig = BigInt(delta);
    const memo = `管理員調整：${reason}`.slice(0, 200);

    const result = await prisma.$transaction(async (tx) => {
      const w =
        delta > 0
          ? await wallet.credit(targetUserId, amount, 'ADMIN_ADJUST', { tx, memo })
          : await wallet.debit(targetUserId, amount, 'ADMIN_ADJUST', { tx, memo });
      await writeAudit(tx, {
        adminId,
        action: AUDIT_ACTIONS.ADJUST_BALANCE,
        targetUserId,
        before: { balance: (w.balance - deltaBig).toString() },
        after: { balance: w.balance.toString(), delta: deltaBig.toString(), reason },
        ip,
      });
      return w;
    });

    return { newBalance: result.balance.toString(), delta: deltaBig.toString() };
  }

  // ── Gift Code（高危） ──────────────────────────────────────────────────────────

  function generateGiftCode(): string {
    // CSPRNG token → 映射至 GIFT_CODE_CHARSET（避開易混淆字元），長度 ≥ 16
    const bytes = rngToken(GIFT_CODE_LENGTH); // base64url，長度足夠
    let out = '';
    for (let i = 0; i < GIFT_CODE_LENGTH; i += 1) {
      const ch = bytes.charCodeAt(i % bytes.length);
      out += GIFT_CODE_CHARSET[ch % GIFT_CODE_CHARSET.length];
    }
    return out;
  }

  async function createGiftCode(
    adminId: string,
    req: CreateGiftCodeReq,
    ip: string,
  ): Promise<GiftCodeItem> {
    const expiresAt = new Date(req.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('expiresAt 必須為未來時間');
    }

    // 極低機率撞碼時重試（code unique）
    let created: { id: string; code: string; amount: bigint; charmId: string | null; maxUses: number; usedCount: number; expiresAt: Date; createdAt: Date } | null =
      null;
    for (let attempt = 0; attempt < 3 && created === null; attempt += 1) {
      const code = generateGiftCode();
      try {
        created = await prisma.$transaction(async (tx) => {
          const row = await tx.giftCode.create({
            data: {
              code,
              amount: BigInt(req.amount),
              charmId: req.charmId ?? null,
              maxUses: req.maxUses,
              expiresAt,
              createdById: adminId,
            },
            select: {
              id: true,
              code: true,
              amount: true,
              charmId: true,
              maxUses: true,
              usedCount: true,
              expiresAt: true,
              createdAt: true,
            },
          });
          await writeAudit(tx, {
            adminId,
            action: AUDIT_ACTIONS.CREATE_GIFT_CODE,
            before: {},
            after: { giftCodeId: row.id, amount: req.amount, maxUses: req.maxUses },
            ip,
          });
          return row;
        });
      } catch (err) {
        // P2002 = code 撞碼，重試；其餘拋出
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code: string }).code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }
    if (created === null) throw new ConflictError('Gift Code 產生失敗，請重試');

    return {
      id: created.id,
      code: created.code, // 建立當下完整回傳一次
      amount: created.amount.toString(),
      charmId: created.charmId,
      maxUses: created.maxUses,
      usedCount: created.usedCount,
      expiresAt: created.expiresAt.toISOString(),
      createdAt: created.createdAt.toISOString(),
    };
  }

  async function listGiftCodes(query: GiftCodeListQuery): Promise<GiftCodeListRes> {
    const [rows, total] = await Promise.all([
      prisma.giftCode.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          amount: true,
          charmId: true,
          maxUses: true,
          usedCount: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
      prisma.giftCode.count(),
    ]);
    return {
      items: rows.map((g) => ({
        id: g.id,
        code: '****', // 列表遮蔽，明文僅建立時回傳一次
        amount: g.amount.toString(),
        charmId: g.charmId,
        maxUses: g.maxUses,
        usedCount: g.usedCount,
        expiresAt: g.expiresAt.toISOString(),
        createdAt: g.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  // ── 公告 ──────────────────────────────────────────────────────────────────────

  function toAnnouncementItem(a: {
    id: string;
    title: string;
    content: string;
    active: boolean;
    startsAt: Date;
    endsAt: Date | null;
    createdAt: Date;
  }): AnnouncementItem {
    return {
      id: a.id,
      title: a.title,
      content: a.content,
      active: a.active,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    };
  }

  async function listAnnouncements(): Promise<AnnouncementListRes> {
    const rows = await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' } });
    return { items: rows.map(toAnnouncementItem) };
  }

  /** 公開：目前有效公告（active 且在 startsAt..endsAt 窗口內） */
  async function getActiveAnnouncements(): Promise<AnnouncementListRes> {
    const now = new Date();
    const rows = await prisma.announcement.findMany({
      where: {
        active: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
      orderBy: { startsAt: 'desc' },
    });
    return { items: rows.map(toAnnouncementItem) };
  }

  async function createAnnouncement(
    adminId: string,
    req: AnnouncementCreateReq,
    ip: string,
  ): Promise<AnnouncementItem> {
    const startsAt = req.startsAt !== undefined ? new Date(req.startsAt) : new Date();
    const endsAt = req.endsAt !== undefined ? new Date(req.endsAt) : null;
    if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
      throw new ValidationError('endsAt 必須晚於 startsAt');
    }

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.announcement.create({
        data: {
          title: req.title,
          content: req.content,
          active: req.active ?? true,
          startsAt,
          endsAt,
        },
      });
      await writeAudit(tx, {
        adminId,
        action: AUDIT_ACTIONS.CREATE_ANNOUNCEMENT,
        before: {},
        after: { announcementId: created.id, title: created.title },
        ip,
      });
      return created;
    });

    // 立即生效的公告 → 全服廣播（system:announcement；前端 LobbyView 已訂閱）
    const item = toAnnouncementItem(row);
    if (item.active && row.startsAt.getTime() <= Date.now()) {
      try {
        deps.emitAnnouncement?.({ id: item.id, title: item.title, content: item.content });
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'admin: 公告廣播失敗');
      }
    }
    return item;
  }

  async function updateAnnouncement(
    adminId: string,
    id: string,
    req: AnnouncementUpdateReq,
    ip: string,
  ): Promise<AnnouncementItem> {
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (existing === null) throw new NotFoundError('公告不存在');

    const data: Prisma.AnnouncementUpdateInput = {};
    if (req.title !== undefined) data.title = req.title;
    if (req.content !== undefined) data.content = req.content;
    if (req.active !== undefined) data.active = req.active;
    if (req.startsAt !== undefined) data.startsAt = new Date(req.startsAt);
    if (req.endsAt !== undefined) data.endsAt = new Date(req.endsAt);

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.announcement.update({ where: { id }, data });
      await writeAudit(tx, {
        adminId,
        action: AUDIT_ACTIONS.UPDATE_ANNOUNCEMENT,
        before: { title: existing.title, active: existing.active },
        after: { title: updated.title, active: updated.active },
        ip,
      });
      return updated;
    });
    return toAnnouncementItem(row);
  }

  async function deleteAnnouncement(adminId: string, id: string, ip: string): Promise<void> {
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (existing === null) throw new NotFoundError('公告不存在');

    await prisma.$transaction(async (tx) => {
      await tx.announcement.delete({ where: { id } });
      await writeAudit(tx, {
        adminId,
        action: AUDIT_ACTIONS.DELETE_ANNOUNCEMENT,
        before: { title: existing.title },
        after: {},
        ip,
      });
    });
  }

  // ── 稽核日誌查詢 ────────────────────────────────────────────────────────────────

  async function listAuditLogs(query: AuditQuery): Promise<AuditListRes> {
    const where: Prisma.AdminAuditLogWhereInput = {};
    if (query.adminId !== undefined) where.adminId = query.adminId;
    if (query.action !== undefined) where.action = query.action;
    if (query.targetUserId !== undefined) where.targetUserId = query.targetUserId;
    if (query.from !== undefined || query.to !== undefined) {
      where.createdAt = {
        ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { lte: new Date(query.to) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.adminAuditLog.count({ where }),
    ]);

    // AdminAuditLog 無 FK 關聯，手動解析 admin / target 使用者名稱
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.adminId);
      if (r.targetUserId !== null) ids.add(r.targetUserId);
    }
    const users =
      ids.size > 0
        ? await prisma.user.findMany({
            where: { id: { in: [...ids] } },
            select: { id: true, username: true },
          })
        : [];
    const nameOf = new Map(users.map((u) => [u.id, u.username]));

    const items: AuditItem[] = rows.map((r) => ({
      id: r.id,
      adminId: r.adminId,
      adminUsername: nameOf.get(r.adminId) ?? null,
      action: r.action,
      targetUserId: r.targetUserId,
      targetUsername: r.targetUserId !== null ? nameOf.get(r.targetUserId) ?? null : null,
      before: r.before,
      after: r.after,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    }));

    return { items, total, page: query.page, limit: query.limit };
  }

  return {
    // 2FA
    setupTotp,
    confirmTotp,
    validate2fa,
    reverify,
    checkReverifyToken,
    getMe,
    // 玩家
    listPlayers,
    getPlayer,
    setBan,
    setMute,
    adjustBalance,
    // gift code
    createGiftCode,
    listGiftCodes,
    // 公告
    listAnnouncements,
    getActiveAnnouncements,
    createAnnouncement,
    updateAnnouncement,
    deleteAnnouncement,
    // 稽核
    listAuditLogs,
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
