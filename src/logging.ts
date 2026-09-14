import * as vscode from "vscode";

/**
 * 日志通道。
 *
 * 注意本模块没有、也不应有任何能携带 API Key 的参数——
 * 密钥不进日志这件事靠这个签名保证，而不是靠调用处的自觉。
 */
export function initLogger(): vscode.LogOutputChannel {
  return vscode.window.createOutputChannel("DeepSeek 余额", { log: true });
}
