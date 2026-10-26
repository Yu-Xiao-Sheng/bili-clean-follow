// 片内数字的类型入口（FOR-70 取数纪律）。实现与契约在 numbersCore.mjs，
// 那份同时被 promo/tools/fill_numbers.mjs 和 tests/promo/ 复用。
import { NUMBERS } from "./numbers.generated";
import { NOT_FILLED, categoryName, fmtWith, placeholdersIn, resolveValues } from "./numbersCore.mjs";

export type FilmCategory = { id: string; n: number; pct: number };
export type FilmValues = {
  followTotal: number;
  pages: number;
  pageSize: number;
  diffN: number;
  unfollowDone: number;
  partialFetched: number;
  batchTotal: number;
  batchCurrent: number;
  categories: FilmCategory[];
};

export { NOT_FILLED, categoryName, placeholdersIn };

let cached: FilmValues | null = null;

export function values(): FilmValues {
  if (!cached) cached = resolveValues(NUMBERS as unknown as { filled: boolean; values: FilmValues });
  return cached;
}

// 文案里写 {{follow_total}}，渲染时替换；未注入或占位符不认识都会抛，渲染中断。
export const fmt = (text: string): string => fmtWith(text, values());