<script setup lang="ts">
/**
 * LoginView（04_FOLDER_STRUCTURE §2 views/LoginView.vue）：
 * 登入 / 註冊切換頁面。
 * - 登入成功後跳轉至 redirect query param 指定的路由或首頁（/）
 * - 表單驗證同步（Zod schema 在 @casino/shared），後端錯誤訊息透出
 */
import { ref, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import type { LoginReq, RegisterReq } from '@casino/shared';

type Mode = 'login' | 'register';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const mode = ref<Mode>('login');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const errorMsg = ref<string | null>(null);
const loading = ref(false);

const isRegister = computed(() => mode.value === 'register');
const submitLabel = computed(() => loading.value
  ? (isRegister.value ? '註冊中…' : '登入中…')
  : (isRegister.value ? '註冊' : '登入'),
);

function switchMode(m: Mode): void {
  mode.value = m;
  errorMsg.value = null;
  username.value = '';
  password.value = '';
  confirmPassword.value = '';
}

function validate(): string | null {
  if (username.value.length < 3 || username.value.length > 20) {
    return '使用者名稱須為 3–20 字元';
  }
  if (!/^[A-Za-z0-9_]+$/.test(username.value)) {
    return '使用者名稱只允許英數字與底線';
  }
  if (password.value.length < 8) {
    return '密碼至少 8 字元';
  }
  if (isRegister.value && password.value !== confirmPassword.value) {
    return '兩次密碼不一致';
  }
  return null;
}

async function onSubmit(): Promise<void> {
  errorMsg.value = null;
  const validErr = validate();
  if (validErr !== null) {
    errorMsg.value = validErr;
    return;
  }

  loading.value = true;
  try {
    if (isRegister.value) {
      const body: RegisterReq = { username: username.value, password: password.value };
      await auth.register(body);
    } else {
      const body: LoginReq = { username: username.value, password: password.value };
      await auth.login(body);
    }
    // 成功後跳轉
    const redirect = typeof route.query['redirect'] === 'string'
      ? route.query['redirect']
      : '/';
    await router.replace(redirect);
  } catch (e: unknown) {
    // axios 錯誤：嘗試解析後端 error.code/message
    if (
      e !== null &&
      typeof e === 'object' &&
      'response' in e &&
      e.response !== null &&
      typeof e.response === 'object' &&
      'data' in e.response
    ) {
      const data = e.response.data as { error?: { code?: string; message?: string } };
      const code = data.error?.code;
      const msg = data.error?.message;
      errorMsg.value = msg ?? code ?? '操作失敗，請稍後再試';
    } else {
      errorMsg.value = e instanceof Error ? e.message : '操作失敗，請稍後再試';
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="title">🎰 Virtual Casino</h1>

      <!-- 模式切換 -->
      <div class="tab-group" role="tablist">
        <button
          role="tab"
          :class="['tab', { active: mode === 'login' }]"
          :aria-selected="mode === 'login'"
          @click="switchMode('login')"
        >
          登入
        </button>
        <button
          role="tab"
          :class="['tab', { active: mode === 'register' }]"
          :aria-selected="mode === 'register'"
          @click="switchMode('register')"
        >
          註冊
        </button>
      </div>

      <!-- 表單 -->
      <form class="form" @submit.prevent="onSubmit">
        <div class="field">
          <label for="username">使用者名稱</label>
          <input
            id="username"
            v-model="username"
            type="text"
            autocomplete="username"
            placeholder="3–20 字元，英數底線"
            :disabled="loading"
            required
          />
        </div>

        <div class="field">
          <label for="password">密碼</label>
          <input
            id="password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="至少 8 字元"
            :disabled="loading"
            required
          />
        </div>

        <div v-if="isRegister" class="field">
          <label for="confirm-password">確認密碼</label>
          <input
            id="confirm-password"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            placeholder="再次輸入密碼"
            :disabled="loading"
            required
          />
        </div>

        <p v-if="errorMsg !== null" class="error" role="alert">{{ errorMsg }}</p>

        <button type="submit" class="submit-btn" :disabled="loading">
          {{ submitLabel }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  padding: 1rem;
}

.login-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  padding: 2rem 2.5rem;
  width: 100%;
  max-width: 400px;
  backdrop-filter: blur(8px);
}

.title {
  text-align: center;
  color: #ffd700;
  font-size: 1.8rem;
  margin-bottom: 1.5rem;
}

.tab-group {
  display: flex;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
  margin-bottom: 1.5rem;
}

.tab {
  flex: 1;
  padding: 0.6rem;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  font-size: 1rem;
  cursor: pointer;
  transition: color 0.2s;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.tab.active {
  color: #ffd700;
  border-bottom-color: #ffd700;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.field label {
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.875rem;
}

.field input {
  padding: 0.65rem 0.9rem;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.07);
  color: #fff;
  font-size: 1rem;
  outline: none;
  transition: border-color 0.2s;
}

.field input:focus {
  border-color: #ffd700;
}

.field input:disabled {
  opacity: 0.5;
}

.error {
  color: #ff6b6b;
  font-size: 0.875rem;
  text-align: center;
}

.submit-btn {
  margin-top: 0.5rem;
  padding: 0.75rem;
  border-radius: 8px;
  border: none;
  background: #ffd700;
  color: #1a1a2e;
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.1s;
}

.submit-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.submit-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
