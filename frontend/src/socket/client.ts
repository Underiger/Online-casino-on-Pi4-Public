/**
 * Socket.IO 客戶端單例（04_FOLDER_STRUCTURE §2 socket/client.ts）。
 *
 * - auth.token 從 auth store 讀取（每次重連時取最新 token）
 * - transports: ['websocket'] 優先（避免 polling + cluster 黏著問題；參見 M08 備註）
 * - 斷線重連：指數退避（delay 1s→2s→4s…，最大 20s，最多 10 次）
 * - server_full：握手被拒時觸發 connect_error，攔截後轉為 USER_FACING 提示
 */
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@casino/shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let _socket: AppSocket | null = null;

/**
 * 取得 Socket 單例。
 * 首次呼叫時建立連線；之後每次取得同一實例。
 * 重新登入後應先 disconnectSocket() 再呼叫 getSocket() 以使用新 token。
 */
export function getSocket(): AppSocket {
  if (_socket !== null) return _socket;

  _socket = io('/', {
    path: '/socket.io/',
    // websocket 優先；開發環境也可使用 polling fallback
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 20_000,
    randomizationFactor: 0.5,
    timeout: 10_000,

    // auth 為 getter function：每次重連時取最新 access token
    auth: (cb) => {
      import('../stores/auth').then(({ useAuthStore }) => {
        const auth = useAuthStore();
        cb({ token: auth.accessToken ?? '' });
      }).catch(() => cb({ token: '' }));
    },
  }) as AppSocket;

  _socket.on('connect', () => {
    console.info('[socket] connected:', _socket?.id);
  });

  _socket.on('disconnect', (reason) => {
    console.info('[socket] disconnected:', reason);
  });

  _socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
    const code = err.data?.code;
    if (code === 'SERVER_FULL') {
      console.warn('[socket] 伺服器連線已滿（SERVER_FULL），請稍後再試');
    } else if (code === 'UNAUTHORIZED') {
      console.warn('[socket] 握手授權失敗，請重新登入');
    } else {
      console.warn('[socket] 連線錯誤:', err.message);
    }
  });

  return _socket;
}

/** 主動斷線（登出時呼叫） */
export function disconnectSocket(): void {
  if (_socket !== null) {
    _socket.disconnect();
    _socket = null;
  }
}

/** 連線狀態 reactive wrapper（供元件用 watchEffect 監聽） */
export function isSocketConnected(): boolean {
  return _socket?.connected ?? false;
}
