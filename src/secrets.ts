import * as vscode from "vscode";

/**
 * API Key 只存在这里——SecretStorage（macOS 上即系统钥匙串）。
 * 不提供任何写进 settings.json 的路径，因此不会被 Settings Sync 同步出去。
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
