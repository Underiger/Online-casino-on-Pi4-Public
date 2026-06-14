/**
 * 認證模組 API 端點（docs/04_API_SPEC.md §3.1）。
 *
 * 注意：register / login 不經 http 攔截器（尚無 access token），
 * 直接用 axios instance 即可；refresh / logout 同樣不需 HMAC。
 */
import http from '../http';
import type { LoginReq, RegisterReq, RefreshReq, LogoutReq, LoginRes, RegisterRes, RefreshRes } from '@casino/shared';

export async function apiRegister(body: RegisterReq): Promise<RegisterRes> {
  const res = await http.post<RegisterRes>('/auth/register', body);
  return res.data;
}

export async function apiLogin(body: LoginReq): Promise<LoginRes> {
  const res = await http.post<LoginRes>('/auth/login', body);
  return res.data;
}

export async function apiRefresh(body: RefreshReq): Promise<RefreshRes> {
  const res = await http.post<RefreshRes>('/auth/refresh', body);
  return res.data;
}

export async function apiLogout(body: LogoutReq): Promise<void> {
  await http.post('/auth/logout', body);
}
