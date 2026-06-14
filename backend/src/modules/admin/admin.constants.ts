/**
 * Admin 模組常數（M21）。
 */

/** Gift Code 長度（≥ shared GIFT_CODE_MIN_LENGTH=16） */
export const GIFT_CODE_LENGTH = 16;

/**
 * Gift Code 字元集：去除易混淆字元（0/O、1/I/L），降低人工輸入錯誤。
 * 31 個字元，配合 CSPRNG 取樣。
 */
export const GIFT_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
