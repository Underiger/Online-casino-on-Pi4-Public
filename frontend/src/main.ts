/**
 * 玩家端 Vue 3 SPA 入口（04_FOLDER_STRUCTURE §2 src/main.ts）。
 * 安裝 Pinia、Vue Router，掛載 App。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router/index';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
