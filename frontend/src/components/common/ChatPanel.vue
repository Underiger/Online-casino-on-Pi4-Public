<script setup lang="ts">
/**
 * ChatPanel（M17）：全域浮動聊天室面板。
 * - 右下角可折疊面板，訂閱 chat:message / chat:history
 * - 輸入框 + 發送，前端過濾空白 / 超長
 * - 系統訊息灰色斜體
 * - 連線狀態指示器（綠/紅點）
 */
import { ref, watch, nextTick, onMounted, onUnmounted, computed } from 'vue';
import { CHAT_MAX_LENGTH } from '@casino/shared';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';

const chatStore = useChatStore();
const auth = useAuthStore();

const isOpen = ref(false);
const inputText = ref('');
const messagesEl = ref<HTMLElement | null>(null);
const sending = ref(false);
const sendError = ref<string | null>(null);

// 未讀計數（面板收起時）
const unreadCount = ref(0);
const lastSeenCount = ref(0);

const unread = computed(() =>
  isOpen.value ? 0 : Math.max(0, chatStore.messages.length - lastSeenCount.value),
);

function togglePanel(): void {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    lastSeenCount.value = chatStore.messages.length;
    unreadCount.value = 0;
    void nextTick(scrollToBottom);
  }
}

function scrollToBottom(): void {
  if (messagesEl.value !== null) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  }
}

// 新訊息時自動捲到底（只在面板已開啟時）
watch(
  () => chatStore.messages.length,
  () => {
    if (isOpen.value) {
      void nextTick(scrollToBottom);
    }
  },
);

// 面板打開時也捲到底
watch(isOpen, (val) => {
  if (val) void nextTick(scrollToBottom);
});

async function handleSend(): Promise<void> {
  if (sending.value) return;
  const text = inputText.value.trim();
  if (text.length === 0) return;
  if (text.length > CHAT_MAX_LENGTH) {
    sendError.value = `訊息過長（上限 ${CHAT_MAX_LENGTH} 字）`;
    return;
  }

  sending.value = true;
  sendError.value = null;

  const err = await chatStore.sendMessage(text);
  if (err === null) {
    inputText.value = '';
  } else {
    sendError.value = friendlyError(err);
  }

  sending.value = false;
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void handleSend();
  }
}

function friendlyError(code: string): string {
  const map: Record<string, string> = {
    EMPTY_MESSAGE: '訊息不可空白',
    MESSAGE_TOO_LONG: `訊息過長（上限 ${CHAT_MAX_LENGTH} 字）`,
    USER_BANNED: '帳號已封禁',
    USER_MUTED: '您已被禁言',
    RATE_LIMIT_BURST: '發送太快，請稍後',
    RATE_LIMIT_MINUTE: '每分鐘最多 10 則',
    INTERNAL_ERROR: '伺服器錯誤，請重試',
  };
  return map[code] ?? code;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

onMounted(() => {
  if (auth.user !== null) {
    chatStore.connectSocket();
  }
});

onUnmounted(() => {
  chatStore.disconnect();
});
</script>

<template>
  <!-- 浮動觸發按鈕（右下角） -->
  <div class="chat-fab-wrap">
    <button
      class="chat-fab"
      :class="{ open: isOpen }"
      :aria-label="isOpen ? '收起聊天室' : '開啟聊天室'"
      @click="togglePanel"
    >
      💬
      <span v-if="unread > 0 && !isOpen" class="unread-badge">{{ unread > 9 ? '9+' : unread }}</span>
    </button>

    <!-- 聊天面板 -->
    <Transition name="panel">
      <div
        v-if="isOpen"
        class="chat-panel"
        role="dialog"
        aria-label="聊天室"
        aria-modal="false"
      >
        <!-- 標題列 -->
        <div class="panel-header">
          <span class="header-title">聊天室</span>
          <span class="conn-dot" :class="{ connected: chatStore.isConnected }" :title="chatStore.isConnected ? '已連線' : '連線中斷'" />
          <button class="close-btn" aria-label="收起" @click="togglePanel">✕</button>
        </div>

        <!-- 訊息列表 -->
        <div ref="messagesEl" class="messages" aria-live="polite" aria-atomic="false">
          <div
            v-if="chatStore.messages.length === 0"
            class="empty-hint"
          >暫無訊息，快說第一句話！</div>

          <div
            v-for="msg in chatStore.messages"
            :key="msg.id"
            class="msg-row"
            :class="{ system: msg.system }"
          >
            <template v-if="msg.system">
              <span class="msg-system">🔔 {{ msg.content }}</span>
            </template>
            <template v-else>
              <span class="msg-meta">
                <span class="msg-username">{{ msg.username ?? '匿名' }}</span>
                <span class="msg-time">{{ formatTime(msg.createdAt) }}</span>
              </span>
              <span class="msg-content">{{ msg.content }}</span>
            </template>
          </div>
        </div>

        <!-- 傳送錯誤提示 -->
        <Transition name="fade">
          <div v-if="sendError !== null" class="send-error" role="alert">
            {{ sendError }}
          </div>
        </Transition>

        <!-- 輸入區 -->
        <div class="input-row">
          <textarea
            v-model="inputText"
            class="chat-input"
            :placeholder="chatStore.isConnected ? '說點什麼…' : '連線中…'"
            :disabled="!chatStore.isConnected || sending"
            :maxlength="CHAT_MAX_LENGTH"
            rows="1"
            aria-label="輸入訊息"
            @keydown="handleKeydown"
          />
          <button
            class="send-btn"
            :disabled="!chatStore.isConnected || sending || inputText.trim().length === 0"
            aria-label="發送"
            @click="handleSend"
          >
            <span v-if="sending">…</span>
            <span v-else>↑</span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ── FAB ── */
.chat-fab-wrap {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 400;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.chat-fab {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, #6a5acd, #8b5cf6);
  color: #fff;
  font-size: 1.35rem;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(106, 90, 205, 0.5);
  transition: transform 0.2s, box-shadow 0.2s;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-fab:hover { transform: scale(1.08); }
.chat-fab.open  { background: linear-gradient(135deg, #4f46e5, #6d28d9); }

.unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: #e74c3c;
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
  line-height: 1;
}

/* ── 面板 ── */
.chat-panel {
  position: absolute;
  bottom: 62px;
  right: 0;
  width: 320px;
  max-width: calc(100vw - 2rem);
  height: 420px;
  max-height: calc(100dvh - 120px);
  background: #1a1a2e;
  border: 1px solid rgba(106, 90, 205, 0.4);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

/* ── Header ── */
.panel-header {
  display: flex;
  align-items: center;
  padding: 0.65rem 0.9rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(106, 90, 205, 0.12);
  flex-shrink: 0;
}

.header-title {
  flex: 1;
  font-size: 0.88rem;
  font-weight: 600;
  color: #c4b5fd;
}

.conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e74c3c;
  margin-right: 0.65rem;
  flex-shrink: 0;
  transition: background 0.3s;
}

.conn-dot.connected { background: #2ecc71; }

.close-btn {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0 2px;
  transition: color 0.15s;
}
.close-btn:hover { color: #fff; }

/* ── 訊息列表 ── */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 0.6rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  scroll-behavior: smooth;
}

.empty-hint {
  color: rgba(255, 255, 255, 0.25);
  font-size: 0.78rem;
  text-align: center;
  margin-top: 2rem;
}

.msg-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.msg-row.system {
  align-items: center;
}

.msg-system {
  font-size: 0.73rem;
  color: rgba(255, 255, 255, 0.38);
  font-style: italic;
  text-align: center;
}

.msg-meta {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.msg-username {
  font-size: 0.75rem;
  font-weight: 600;
  color: #a78bfa;
}

.msg-time {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.28);
}

.msg-content {
  font-size: 0.83rem;
  color: rgba(255, 255, 255, 0.85);
  line-height: 1.4;
  word-break: break-word;
}

/* ── 錯誤提示 ── */
.send-error {
  padding: 0.3rem 0.75rem;
  font-size: 0.72rem;
  color: #f87171;
  background: rgba(239, 68, 68, 0.1);
  border-top: 1px solid rgba(239, 68, 68, 0.2);
  flex-shrink: 0;
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── 輸入區 ── */
.input-row {
  display: flex;
  align-items: flex-end;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #fff;
  font-size: 0.83rem;
  padding: 0.4rem 0.6rem;
  resize: none;
  line-height: 1.4;
  transition: border-color 0.2s;
  font-family: inherit;
}

.chat-input:focus {
  outline: none;
  border-color: rgba(139, 92, 246, 0.6);
}

.chat-input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.chat-input::placeholder { color: rgba(255, 255, 255, 0.28); }

.send-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: none;
  background: linear-gradient(135deg, #6a5acd, #8b5cf6);
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;
  line-height: 1;
}

.send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.send-btn:hover:not(:disabled) { opacity: 0.85; }

/* ── 面板進出動畫 ── */
.panel-enter-active { transition: opacity 0.18s, transform 0.18s; }
.panel-leave-active { transition: opacity 0.14s, transform 0.14s; }
.panel-enter-from,
.panel-leave-to { opacity: 0; transform: translateY(12px) scale(0.97); }

/* ── 捲軸 ── */
.messages::-webkit-scrollbar { width: 4px; }
.messages::-webkit-scrollbar-track { background: transparent; }
.messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
</style>
