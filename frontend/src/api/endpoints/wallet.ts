/**
 * 錢包模組 API 端點（docs/04_API_SPEC.md §3.5）。
 */
import http from '../http';
import type { BalanceRes, TxListQuery, TxListRes } from '@casino/shared';

export async function apiGetBalance(): Promise<BalanceRes> {
  const res = await http.get<BalanceRes>('/wallet/balance');
  return res.data;
}

export async function apiGetTransactions(query?: Partial<TxListQuery>): Promise<TxListRes> {
  const res = await http.get<TxListRes>('/wallet/transactions', { params: query });
  return res.data;
}
