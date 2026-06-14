import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessagePayload, ChatHistoryPayload } from '@casino/shared';
import { SOCKET_EVENTS, CHAT_MAX_LENGTH } from '@casino/shared';
import { getSocket } from '../socket/client';

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessagePayload[]>([]);
  const isConnected = ref(false);
  const error = ref<string | null>(null);
  /** 是否已安裝 Socket 監聽器（防重複安裝） */
  let socketInstalled = false;

  function addMessage(msg: ChatMessagePayload): void {
    messages.value.push(msg);
    // 本地保留最多 200 則，超出時移除最舊
    if (messages.value.length > 200) {
      messages.value.splice(0, messages.value.length - 200);
    }
  }

  function connectSocket(): void {
    if (socketInstalled) return;
    socketInstalled = true;

    const socket = getSocket();

    socket.on('connect', () => {
      isConnected.value = true;
      error.value = null;
    });

    socket.on('disconnect', () => {
      isConnected.value = false;
    });

    // 連線後伺服器推送歷史
    socket.on(SOCKET_EVENTS.CHAT_HISTORY, (payload: ChatHistoryPayload) => {
      messages.value = payload.messages;
    });

    // 即時新訊息（全服廣播）
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, (msg: ChatMessagePayload) => {
      addMessage(msg);
    });

    // 連線狀態初始化
    isConnected.value = socket.connected;
  }

  async function sendMessage(text: string): Promise<string | null> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return 'EMPTY_MESSAGE';
    if (trimmed.length > CHAT_MAX_LENGTH) return 'MESSAGE_TOO_LONG';

    error.value = null;

    return new Promise<string | null>((resolve) => {
      const socket = getSocket();
      socket.emit(
        SOCKET_EVENTS.CHAT_SEND,
        { content: trimmed },
        (err: string | null) => {
          if (err !== null) {
            error.value = err;
            resolve(err);
          } else {
            resolve(null);
          }
        },
      );
    });
  }

  function disconnect(): void {
    if (!socketInstalled) return;
    const socket = getSocket();
    socket.off(SOCKET_EVENTS.CHAT_HISTORY);
    socket.off(SOCKET_EVENTS.CHAT_MESSAGE);
    socket.off('connect');
    socket.off('disconnect');
    socketInstalled = false;
    isConnected.value = false;
  }

  return { messages, isConnected, error, connectSocket, sendMessage, disconnect };
});
