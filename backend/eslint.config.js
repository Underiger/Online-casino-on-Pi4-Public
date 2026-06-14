/**
 * Backend ESLint 9 flat config（04_FOLDER_STRUCTURE §1）
 *
 * 兩條專案鐵律由此強制：
 *  1. 嚴禁 Math.random — 全專案唯一亂數出口為 src/security/csprng.ts（CSPRNG）。
 *  2. 嚴禁繞過 wallet 模組直接以 prisma.user.update / updateMany / upsert 修改餘額。
 */
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // 全域忽略（等同舊 ignorePatterns）
  {
    ignores: ['dist/**', 'node_modules/**', '*.cjs'],
  },

  // 基礎 + TypeScript 推薦規則
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // Prettier：關閉所有與格式相關的 ESLint 規則（避免與 Prettier 衝突）
  prettierConfig,

  // 專案通用規則
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // ★ 鐵律 1：禁止 Math.random（含任何位置的 Math.random 屬性存取）
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            '嚴禁使用 Math.random。請改用 src/security/csprng.ts（crypto.randomInt / randomBytes）— 全專案唯一亂數出口。',
        },
      ],

      // ★ 鐵律 2：禁止直接透過 prisma.user.* 寫入（餘額必須走 wallet 模組的 debit()/credit()）
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.object.name='prisma'][callee.object.property.name='user'][callee.property.name=/^(update|updateMany|upsert)$/]",
          message:
            '禁止直接以 prisma.user.update/updateMany/upsert 修改使用者資料（餘額）。請改走 modules/wallet 的 debit()/credit()。',
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },

  // wallet 模組覆蓋：放行 prisma.user 條件更新（唯一合法出口）
  {
    files: ['src/modules/wallet/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // admin 模組覆蓋（M21）：放行 prisma.user.update 以管理非餘額欄位
  // （banned / muted / totpEnabled / totpSecretEnc / recoveryCodes）。
  // ★ 餘額鐵律不破例：admin 調幣一律經 wallet.credit/debit（type=ADMIN_ADJUST），
  //   本模組永不直接寫 balance——由 code review 把關。
  {
    files: ['src/modules/admin/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
