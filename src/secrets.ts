import * as vscode from "vscode";

/**
 * 凭据门面。两条凭据都只存在这里——SecretStorage（macOS 上即系统钥匙串）。
 * 不提供任何写进 settings.json 的路径，因此不会被 Settings Sync 同步出去。
 *
 * 两者用途与风险不同（API Key 打公开接口、用量 Token 打未公开的控制台接口且会
 * 过期），所以分开存取、分开清理，绝不合并成一个键。
 */
export const API_KEY_SECRET = "deepseekBalance.apiKey";

/** 宽松的格式提示，只用于输入时提醒，不做硬性拦截（可能存在代理改写的 key）。 */
const KEY_HINT = /^sk-[A-Za-z0-9_-]{16,}$/;

/**
 * 读取已保存的密钥。SecretStorage 在个别 Linux 环境下可能不可用，
 * 这里吞掉异常并当作「未配置」，而不是让激活流程崩掉。
 */
export async function getApiKey(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  try {
    const value = await context.secrets.get(API_KEY_SECRET);
    const trimmed = value?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function storeApiKey(
  context: vscode.ExtensionContext,
  raw: string,
): Promise<void> {
  // 粘贴时带上的空白/换行是 401 的头号原因，先 trim。
  await context.secrets.store(API_KEY_SECRET, raw.trim());
}

export async function clearApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  await context.secrets.delete(API_KEY_SECRET);
}

/** 弹出密码输入框并在确认后落盘；用户取消时返回 undefined。 */
export async function promptForApiKey(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "DeepSeek API Key",
    prompt:
      "粘贴你的 DeepSeek API Key。它只保存在系统钥匙串中，不会写入设置，也不会被 Settings Sync 同步。",
    placeHolder: "sk-…",
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => {
      const trimmed = input.trim();
      if (trimmed.length === 0) return "API Key 不能为空";
      if (!KEY_HINT.test(trimmed)) return "格式看起来不太对（通常以 sk- 开头）";
      return undefined;
    },
  });

  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  await storeApiKey(context, trimmed);
  return trimmed;
}

/**
 * 用量 Token——DeepSeek **控制台**（platform.deepseek.com）的会话凭据。
 *
 * 与 API Key 是两回事，别混：
 *
 * - API Key 打 api.deepseek.com（公开接口，返回余额），长期有效、权限窄。
 * - 用量 Token 打 platform.deepseek.com 的控制台接口（未公开、随时可能改），
 *   **从浏览器登录态里取、会过期**，而且权限比 API Key 宽（它等价于你的控制台
 *   会话）。
 *
 * 同样只进 SecretStorage，不落 settings.json、不被 Settings Sync 同步。
 */
export const USAGE_TOKEN_SECRET = "deepseekBalance.usageToken";

export async function getUsageToken(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  try {
    const value = await context.secrets.get(USAGE_TOKEN_SECRET);
    const trimmed = value?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function storeUsageToken(
  context: vscode.ExtensionContext,
  raw: string,
): Promise<void> {
  await context.secrets.store(USAGE_TOKEN_SECRET, raw.trim());
}

export async function clearUsageToken(
  context: vscode.ExtensionContext,
): Promise<void> {
  await context.secrets.delete(USAGE_TOKEN_SECRET);
}

/**
 * 弹出输入框收集用量 Token；用户取消时返回 undefined。
 *
 * 这里**不做格式校验**（与 API Key 的 KEY_HINT 不同）：控制台 token 的形状是
 * 未公开实现的一部分，现在看着像什么都是猜的。照形状拦人只会拦掉将来变了形状的
 * 正确 token，那种失败用户还查不出来。真正的校验交给接口——它返回 40002/40003
 * 时会明确提示「已过期」。
 */
export async function promptForUsageToken(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "DeepSeek 用量 Token",
    prompt:
      "从 platform.deepseek.com 的登录态里取的会话凭据（F12 → Console → " +
      "copy(JSON.parse(localStorage.getItem('userToken')).value)）。" +
      "它会过期，需要定期重新获取。只保存在系统钥匙串中，只发给 platform.deepseek.com。",
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) =>
      input.trim().length === 0 ? "用量 Token 不能为空" : undefined,
  });

  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  await storeUsageToken(context, trimmed);
  return trimmed;
}
