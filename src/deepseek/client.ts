/**
 * DeepSeek 余额接口客户端。
 *
 * 不 import vscode：调用方注入 baseUrl / signal，测试里注入假 fetch。
 * 使用扩展宿主自带的全局 fetch（Node 18+），因此没有任何运行时依赖。
 */

import type { BalanceError, BalanceInfo, BalanceResult } from "./types";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";

const DEFAULT_TIMEOUT_MS = 15_000;

/** 兜底脱敏：任何要离开进程的文本都过一遍，防止将来有人不小心把密钥拼进消息。 */
const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "sk-***");
}

export function classifyHttpStatus(
  status: number,
): "unauthorized" | "forbidden" | "http" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return "http";
}

export function buildBalanceUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/user/balance`;
}

function isBalanceInfo(value: unknown): value is BalanceInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.currency === "string" && typeof info.total_balance === "string"
  );
}

function malformed(message: string): BalanceResult {
  return { ok: false, error: { kind: "malformed", message } };
}

function describeThrown(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}

export interface FetchBalanceOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  /** 调用方的取消信号（例如密钥变更时中止在途请求）。 */
  signal?: AbortSignal;
}

/**
 * 查询余额。任何失败都归一化成 { ok: false, error }，绝不向调用方抛裸异常，
 * 且 error.message 只由状态码与固定中文串拼成——密钥不会出现在里面。
 */
export async function fetchBalance(
  options: FetchBalanceOptions,
): Promise<BalanceResult> {
  const { apiKey, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  const url = buildBalanceUrl(baseUrl);
  try {
    new URL(url);
  } catch {
    return malformed(`接口地址无效：${baseUrl}`);
  }

  // 超时与调用方取消合成一个信号。两者要能分辨：超时要报错，取消是静默的。
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined =
    signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: combined,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `请求超时（${Math.round(timeoutMs / 1000)} 秒）。`,
        },
      };
    }
    if (signal?.aborted === true) {
      return { ok: false, error: { kind: "network", message: "请求已取消。" } };
    }
    return {
      ok: false,
      error: {
        kind: "network",
        message: `网络请求失败：${describeThrown(error)}`,
      },
    };
  }

  if (!response.ok) {
    const kind = classifyHttpStatus(response.status);
    const error: BalanceError = {
      kind,
      httpStatus: response.status,
      message:
        kind === "unauthorized"
          ? "API Key 无效或已失效，请重新设置。"
          : kind === "forbidden"
            ? "该 API Key 没有访问余额接口的权限。"
            : `余额接口返回异常（HTTP ${response.status}）。`,
    };
    return { ok: false, error };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return malformed(
      "接口返回的内容不是合法 JSON（可能是代理返回了错误页）。",
    );
  }

  if (typeof payload !== "object" || payload === null) {
    return malformed("接口返回的数据结构不符合预期。");
  }

  const body = payload as Record<string, unknown>;
  if (typeof body.is_available !== "boolean") {
    return malformed("接口返回的数据结构不符合预期（is_available 缺失或类型错误）。");
  }

  // 与 dsh-balance/index.js:27 一致：字段缺失按空数组处理。
  const rawInfos = body.balance_infos ?? [];
  if (!Array.isArray(rawInfos) || !rawInfos.every(isBalanceInfo)) {
    return malformed("接口返回的数据结构不符合预期（balance_infos 格式错误）。");
  }

  // is_available 为 false 不算错误：余额仍然存在、值得展示，只是不能用于 API 调用。
  return {
    ok: true,
    snapshot: {
      infos: rawInfos,
      isAvailable: body.is_available,
      fetchedAt: Date.now(),
      endpoint: url,
    },
  };
}
