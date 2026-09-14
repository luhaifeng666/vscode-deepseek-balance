/**
 * DeepSeek 余额接口的数据类型。
 *
 * 金额一律保持接口返回的字符串原样——绝不用 toFixed 之类重排，
 * 否则会把非两位小数的币种悄悄改坏。
 */

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export type BalanceErrorKind =
  | "unauthorized"
  | "forbidden"
  | "http"
  | "network"
  | "timeout"
  | "malformed";

export interface BalanceError {
  kind: BalanceErrorKind;
  /** 中文、面向用户，且保证不含任何密钥内容。 */
  message: string;
  httpStatus?: number;
}

/**
 * 一次成功查询的结果。
 *
 * 注意这里没有 apiKey 字段——tooltip 与日志只接触 BalanceSnapshot，
 * 因此密钥不可能经由它们泄漏，这是结构上的保证而非靠自觉。
 */
export interface BalanceSnapshot {
  infos: BalanceInfo[];
  /** 对应接口的 is_available。为 false 表示资金仍在但不可用于 API 调用。 */
  isAvailable: boolean;
  fetchedAt: number;
  /** 生效的接口地址，展示在 tooltip 里，便于排查代理配错。 */
  endpoint: string;
}

export type BalanceResult =
  | { ok: true; snapshot: BalanceSnapshot }
  | { ok: false; error: BalanceError };
