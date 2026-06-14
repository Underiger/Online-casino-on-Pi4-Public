/**
 * zod 請求驗證工具：解析失敗統一轉為 ValidationError（400 VALIDATION_ERROR），
 * 由 app.ts 全域錯誤處理器組裝回應。
 */
import type { ZodType, ZodTypeDef } from 'zod';
import { ValidationError } from './errors.js';

// Input 與 Output 分離：支援帶 .default() / .coerce 的 schema（如分頁 query），
// 回傳值為「套用預設值後」的 Output 型別
export function parse<Output, Input = Output>(
  schema: ZodType<Output, ZodTypeDef, Input>,
  data: unknown,
): Output {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('；');
    throw new ValidationError(detail);
  }
  return result.data;
}
