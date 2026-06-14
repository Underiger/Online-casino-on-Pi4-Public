<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">系統監控</h2>
      <div class="refresh-info">
        <span v-if="stats" class="last-updated">上次更新：{{ lastUpdated }}</span>
        <span class="auto-refresh">每 10 秒自動刷新</span>
        <button class="refresh-btn" :disabled="loading" @click="() => void fetchStats()">
          {{ loading ? '刷新中…' : '立即刷新' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error-banner">
      ⚠ 無法取得監控資料，請檢查後端服務是否正常運作
    </div>

    <template v-if="stats">
      <!-- 即時資訊 -->
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">線上人數</div>
          <div class="stat-value stat-value--blue">{{ stats.onlineUsers }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">活躍房間數</div>
          <div class="stat-value stat-value--green">{{ stats.activeRooms }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">系統運行時間</div>
          <div class="stat-value stat-value--gray">{{ fmtUptime(stats.uptime) }}</div>
        </div>
      </div>

      <!-- CPU -->
      <div class="card" style="margin-bottom: 16px">
        <h3 class="section-title">CPU</h3>
        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">型號</span>
            <span>{{ stats.cpu.brand }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">實體核心</span>
            <span>{{ stats.cpu.physicalCores }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">負載</span>
            <div class="progress-wrap">
              <div class="progress">
                <div
                  class="progress-bar"
                  :class="loadClass(stats.cpu.currentLoad)"
                  :style="{ width: stats.cpu.currentLoad + '%' }"
                />
              </div>
              <span>{{ stats.cpu.currentLoad.toFixed(1) }}%</span>
            </div>
          </div>
          <div class="info-item">
            <span class="info-label">溫度</span>
            <span :class="tempClass(stats.cpu.temperature)">
              {{ stats.cpu.temperature !== null ? stats.cpu.temperature + ' °C' : 'N/A' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 記憶體 -->
      <div class="card" style="margin-bottom: 16px">
        <h3 class="section-title">記憶體</h3>
        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">總容量</span>
            <span>{{ fmtBytes(stats.memory.total) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">已用</span>
            <span>{{ fmtBytes(stats.memory.used) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">可用</span>
            <span>{{ fmtBytes(stats.memory.free) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">使用率</span>
            <div class="progress-wrap">
              <div class="progress">
                <div
                  class="progress-bar"
                  :class="loadClass(stats.memory.usedPercent)"
                  :style="{ width: stats.memory.usedPercent + '%' }"
                />
              </div>
              <span>{{ stats.memory.usedPercent.toFixed(1) }}%</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 磁碟 -->
      <div class="card">
        <h3 class="section-title">磁碟</h3>
        <table>
          <thead>
            <tr>
              <th>掛載點</th>
              <th>總容量</th>
              <th>已用</th>
              <th>使用率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in stats.disk" :key="d.fs">
              <td style="font-family: monospace">{{ d.fs }}</td>
              <td>{{ fmtBytes(d.size) }}</td>
              <td>{{ fmtBytes(d.used) }}</td>
              <td>
                <div class="progress-wrap">
                  <div class="progress">
                    <div
                      class="progress-bar"
                      :class="loadClass(d.use)"
                      :style="{ width: d.use + '%' }"
                    />
                  </div>
                  <span>{{ d.use.toFixed(1) }}%</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div v-else-if="!error" class="loading-text">載入中…</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { apiGetMonitorStats, type SystemStatsRes } from '../api/admin';

const stats = ref<SystemStatsRes | null>(null);
const error = ref(false);
const loading = ref(false);
const lastUpdated = ref('');

async function fetchStats(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    stats.value = await apiGetMonitorStats();
    error.value = false;
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
    lastUpdated.value = new Date().toLocaleTimeString('zh-TW');
  }
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function loadClass(pct: number): string {
  if (pct >= 85) return 'progress-bar--red';
  if (pct >= 60) return 'progress-bar--yellow';
  return 'progress-bar--green';
}

function tempClass(temp: number | null): string {
  if (temp === null) return '';
  if (temp >= 75) return 'temp-hot';
  if (temp >= 60) return 'temp-warm';
  return 'temp-ok';
}

let intervalId: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void fetchStats();
  intervalId = setInterval(() => void fetchStats(), 10_000);
});

onUnmounted(() => {
  if (intervalId !== null) clearInterval(intervalId);
});
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 20px;
}
.page-title {
  font-size: 20px;
  font-weight: 700;
  color: #1e293b;
}
.refresh-info {
  display: flex;
  gap: 12px;
  font-size: 12px;
}
.last-updated { color: #64748b; }
.auto-refresh { color: #94a3b8; }
.refresh-btn {
  padding: 4px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #475569;
  font-size: 12px;
  cursor: pointer;
}
.refresh-btn:hover:not(:disabled) { background: #f1f5f9; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.error-banner {
  background: #fef9c3;
  border: 1px solid #fde047;
  border-radius: 8px;
  padding: 10px 14px;
  color: #854d0e;
  font-size: 13px;
  margin-bottom: 16px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.stat-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  text-align: center;
}
.stat-label {
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 8px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.stat-value {
  font-size: 32px;
  font-weight: 700;
}
.stat-value--blue { color: #2563eb; }
.stat-value--green { color: #16a34a; }
.stat-value--gray { color: #475569; font-size: 22px; }
.section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
  color: #374151;
}
.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.info-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.progress-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #475569;
}
.progress {
  flex: 1;
  max-width: 120px;
  height: 8px;
  background: #e2e8f0;
  border-radius: 9999px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  border-radius: 9999px;
  transition: width 0.5s ease;
}
.progress-bar--green { background: #16a34a; }
.progress-bar--yellow { background: #d97706; }
.progress-bar--red { background: #dc2626; }
.temp-ok { color: #16a34a; font-weight: 600; }
.temp-warm { color: #d97706; font-weight: 600; }
.temp-hot { color: #dc2626; font-weight: 600; }
.loading-text {
  text-align: center;
  padding: 60px;
  color: #94a3b8;
}
</style>
