/**
 * 余额的纯展示逻辑：选币种、格式化、低余额判断。
 *
 * 本模块不 import vscode，也不发任何请求，因此可以直接单测。
 * 语义移植自 dsh-balance/index.js:26-36（同一作者的上一个插件），
 * 包括 ?? "0" / ?? [] 这些宽松回退与中文文案。
 */

import type { BalanceInfo } from "./types";

export type CurrencyPref = "AUTO" | "CNY" | "USD";

/**
 * 选出状态栏要显示的那一条余额。
 * AUTO 优先人民币，没有 CNY 就退回接口返回的第一条。
 */
export function selectInfo(
  infos: BalanceInfo[],
  pref: CurrencyPref,
): BalanceInfo | undefined {
  if (infos.length === 0) return undefined;
  const wanted = pref === "AUTO" ? "CNY" : pref;
  return infos.find((info) => info.currency === wanted) ?? infos[0];
}

/** 状态栏用的紧凑形式，例如 "CNY 34.53"。 */
export function formatAmount(info: BalanceInfo): string {
  return `${info.currency} ${info.total_balance}`;
}

/** 详情用的完整形式，例如 "CNY 34.53（赠送 0.00 / 充值 34.53）"。 */
export function formatDetailed(info: BalanceInfo): string {
  const granted = info.granted_balance ?? "0";
  const topped = info.topped_up_balance ?? "0";
  return `${info.currency} ${info.total_balance}（赠送 ${granted} / 充值 ${topped}）`;
}

/** 单行罗列全部币种；无数据时回退到与 dsh-balance 相同的中文文案。 */
export function formatAllDetailed(infos: BalanceInfo[]): string {
  if (infos.length === 0) return "（无余额信息）";
  return infos.map(formatDetailed).join("  ·  ");
}

/**
 * 是否低于告警阈值。
 * 阈值 <= 0 视为关闭提醒；金额解析不出来时不告警（不拿脏数据报警）。
 * 比较是严格小于——所以阈值 0 天然不会误报。
 */
export function isLow(info: BalanceInfo | undefined, threshold: number): boolean {
  if (info === undefined || !(threshold > 0)) return false;
  const total = Number.parseFloat(info.total_balance);
  if (!Number.isFinite(total)) return false;
  return total < threshold;
}
