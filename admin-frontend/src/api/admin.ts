import http from './http';

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface LoginRes {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  hmacKey: string;
  user: { id: string; username: string; role: string; balance: string; avatarId: number };
}

export async function apiLogin(username: string, password: string): Promise<LoginRes> {
  const res = await http.post<LoginRes>('/auth/login', { username, password });
  return res.data;
}

export async function apiLogout(refreshToken: string): Promise<void> {
  await http.post('/auth/logout', { refreshToken });
}

// ─── Admin Me ─────────────────────────────────────────────────────────────────

export interface AdminMeRes {
  userId: string;
  username: string;
  role: string;
  totpEnabled: boolean;
}

export async function apiAdminMe(): Promise<AdminMeRes> {
  const res = await http.get<AdminMeRes>('/admin/me');
  return res.data;
}

// ─── TOTP / 2FA ───────────────────────────────────────────────────────────────

export interface ValidateRes {
  reverifyToken: string;
  expiresIn: number;
}

export interface ReverifyRes {
  reverifyToken: string;
  expiresIn: number;
}

export async function apiTotpValidate(code: string): Promise<ValidateRes> {
  const res = await http.post<ValidateRes>('/admin/totp/validate', { code });
  return res.data;
}

export async function apiTotpReverify(totpCode: string): Promise<ReverifyRes> {
  const res = await http.post<ReverifyRes>('/admin/totp/reverify', { totpCode });
  return res.data;
}

// ─── Players ──────────────────────────────────────────────────────────────────

export interface AdminPlayerItem {
  id: string;
  username: string;
  role: string;
  balance: string;
  avatarId: number;
  banned: boolean;
  muted: boolean;
  flagged: boolean;
  jackpotPoints: number;
  loginStreak: number;
  createdAt: string;
}

export interface AdminPlayerListRes {
  items: AdminPlayerItem[];
  total: number;
  page: number;
  limit: number;
}

export async function apiListPlayers(params: {
  q?: string;
  banned?: boolean;
  page?: number;
  limit?: number;
}): Promise<AdminPlayerListRes> {
  const res = await http.get<AdminPlayerListRes>('/admin/users', { params });
  return res.data;
}

export interface AdjustBalanceRes {
  newBalance: string;
  delta: string;
}

export async function apiBanUser(
  userId: string,
  reverifyToken: string,
  reason?: string,
): Promise<{ userId: string; banned: boolean }> {
  const res = await http.post<{ userId: string; banned: boolean }>(
    `/admin/users/${userId}/ban`,
    { reason },
    { headers: { 'x-reverify-token': reverifyToken } },
  );
  return res.data;
}

export async function apiUnbanUser(
  userId: string,
  reverifyToken: string,
  reason?: string,
): Promise<{ userId: string; banned: boolean }> {
  const res = await http.post<{ userId: string; banned: boolean }>(
    `/admin/users/${userId}/unban`,
    { reason },
    { headers: { 'x-reverify-token': reverifyToken } },
  );
  return res.data;
}

export async function apiAdjustBalance(
  userId: string,
  delta: number,
  reason: string,
  reverifyToken: string,
): Promise<AdjustBalanceRes> {
  const res = await http.post<AdjustBalanceRes>(
    `/admin/users/${userId}/adjust-balance`,
    { delta, reason },
    { headers: { 'x-reverify-token': reverifyToken } },
  );
  return res.data;
}

// ─── Gift Codes ───────────────────────────────────────────────────────────────

export interface GiftCodeItem {
  id: string;
  code: string;
  amount: string;
  charmId: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
}

export interface GiftCodeListRes {
  items: GiftCodeItem[];
  total: number;
  page: number;
  limit: number;
}

export async function apiCreateGiftCode(
  payload: {
    amount: number;
    charmId?: string;
    maxUses: number;
    expiresAt: string;
  },
  reverifyToken: string,
): Promise<GiftCodeItem> {
  const res = await http.post<GiftCodeItem>('/admin/gift-codes', payload, {
    headers: { 'x-reverify-token': reverifyToken },
  });
  return res.data;
}

export async function apiListGiftCodes(params: {
  page?: number;
  limit?: number;
}): Promise<GiftCodeListRes> {
  const res = await http.get<GiftCodeListRes>('/admin/gift-codes', { params });
  return res.data;
}

// ─── Records ──────────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
}

export interface LoginLogItem {
  id: string;
  userId: string | null;
  username: string;
  ip: string;
  userAgent: string;
  result: string;
  createdAt: string;
}

export interface BetRecordItem {
  id: string;
  userId: string;
  gameType: string;
  amount: string;
  payout: string;
  detail: unknown;
  roundId: string | null;
  createdAt: string;
}

export interface TxRecordItem {
  id: string;
  userId: string;
  type: string;
  delta: string;
  balanceBefore: string;
  balanceAfter: string;
  refId: string | null;
  memo: string | null;
  createdAt: string;
}

export async function apiListLoginRecords(params: {
  userId?: string;
  result?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResult<LoginLogItem>> {
  const res = await http.get<PaginatedResult<LoginLogItem>>('/admin/records/login', { params });
  return res.data;
}

export async function apiListBetRecords(params: {
  userId?: string;
  gameType?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResult<BetRecordItem>> {
  const res = await http.get<PaginatedResult<BetRecordItem>>('/admin/records/bets', { params });
  return res.data;
}

export async function apiListTxRecords(params: {
  userId?: string;
  type?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResult<TxRecordItem>> {
  const res = await http.get<PaginatedResult<TxRecordItem>>('/admin/records/transactions', {
    params,
  });
  return res.data;
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

export interface SystemStatsRes {
  cpu: { manufacturer: string; brand: string; physicalCores: number; currentLoad: number; temperature: number | null };
  memory: { total: number; used: number; free: number; usedPercent: number };
  disk: { fs: string; size: number; used: number; use: number }[];
  onlineUsers: number;
  activeRooms: number;
  uptime: number;
  sampledAt: string;
}

export async function apiGetMonitorStats(): Promise<SystemStatsRes> {
  const res = await http.get<SystemStatsRes>('/admin/monitor');
  return res.data;
}

// ─── Announcements ────────────────────────────────────────────────────────────

export interface AnnouncementItem {
  id: string;
  title: string;
  content: string;
  active: boolean;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
}

export interface AnnouncementListRes {
  items: AnnouncementItem[];
}

export async function apiListAnnouncements(): Promise<AnnouncementListRes> {
  const res = await http.get<AnnouncementListRes>('/admin/announcements');
  return res.data;
}

export async function apiCreateAnnouncement(payload: {
  title: string;
  content: string;
  active?: boolean;
  startsAt?: string;
  endsAt?: string;
}): Promise<AnnouncementItem> {
  const res = await http.post<AnnouncementItem>('/admin/announcements', payload);
  return res.data;
}

export async function apiUpdateAnnouncement(
  id: string,
  payload: {
    title?: string;
    content?: string;
    active?: boolean;
    startsAt?: string;
    endsAt?: string;
  },
): Promise<AnnouncementItem> {
  const res = await http.put<AnnouncementItem>(`/admin/announcements/${id}`, payload);
  return res.data;
}

export async function apiDeleteAnnouncement(id: string): Promise<void> {
  await http.delete(`/admin/announcements/${id}`);
}

// ─── Error helpers ────────────────────────────────────────────────────────────

export function extractErrorMessage(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'response' in err &&
    err.response !== null &&
    typeof err.response === 'object' &&
    'data' in err.response &&
    err.response.data !== null &&
    typeof err.response.data === 'object' &&
    'message' in err.response.data &&
    typeof err.response.data.message === 'string'
  ) {
    return err.response.data.message;
  }
  if (err instanceof Error) return err.message;
  return '未知錯誤';
}
