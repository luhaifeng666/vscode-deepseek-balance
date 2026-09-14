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

/**
 * 用量数据的类型。
 *
 * 与余额刻意分成两套，不复用 BalanceError —— 理由有两条：
 *
 * 1. 会话过期是 **HTTP 200 信封里的错误码**（data.code / data.data.biz_code
 *    为 40002/40003），不是 HTTP 状态，现有的 classifyHttpStatus 表达不了。
 * 2. 更要紧的是：用量错误必须在**类型上**就与余额错误分开，这样「用量失败
 *    不影响余额」是结构上的保证，而不是靠调用方自觉。
 */

export type UsageRange = "today" | "week" | "month";

export interface UsageSnapshot {
  range: UsageRange;
  /**
   * 窗口起止（epoch 秒）。
   *
   * 展示出来是有用的：近 7 天与本月按 **UTC 日**切分（本地对齐的长窗口会被
   * 接口拒掉），把窗口摆出来才能让这个口径差别可见，而不是含糊地说「本月」。
   */
  start: number;
  end: number;
  currency: string;
  cost: number;
  /** 请求**次数**，不是 token 数——接口里叫 REQUEST，别跟 token 混在一起加。 */
  requests: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  fetchedAt: number;
  /** 生效的接口地址（只含 URL 与查询参数，token 在请求头里）。 */
  endpoint: string;
}

export type UsageErrorKind =
  | "no-token"
  | "expired"
  | "http"
  | "network"
  | "timeout"
  | "malformed";

export interface UsageError {
  kind: UsageErrorKind;
  /** 中文、面向用户，且保证不含任何凭据内容。 */
  message: string;
  httpStatus?: number;
}

export type UsageResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; error: UsageError };
