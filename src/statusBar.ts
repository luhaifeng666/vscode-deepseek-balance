import * as vscode from "vscode";

import {
  ALERT_BACKGROUNDS,
  ALL_COMMANDS,
  type StatusViewModel,
} from "./render";

/**
 * 把纯函数 render() 产出的视图模型落到真正的 StatusBarItem 上。
 * 这里是 render.ts 之外唯一接触 vscode 状态栏 API 的地方。
 */
export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem | undefined;
  private alignment: "left" | "right" | undefined;
  private disposed = false;

  update(view: StatusViewModel, alignment: "left" | "right"): void {
    if (this.disposed) return;

    const item = this.ensureItem(alignment);
    item.text = view.text;
    item.command = view.command;
    item.accessibilityInformation = {
      label: view.accessibleLabel,
      role: "button",
    };
    item.color =
      view.colorId === undefined ? undefined : new vscode.ThemeColor(view.colorId);

    // 背景色只有 warning/error 两个 id 在多数主题下真正生效，其余一律不设。
    const backgroundId = view.backgroundColorId;
    item.backgroundColor =
      backgroundId !== undefined && ALERT_BACKGROUNDS.includes(backgroundId)
        ? new vscode.ThemeColor(backgroundId)
        : undefined;

    const tooltip = new vscode.MarkdownString(view.tooltip);
    tooltip.supportThemeIcons = true;
    // 命令白名单，绝不是 isTrusted: true——那会放行 tooltip 里任意命令 URI。
    tooltip.isTrusted = { enabledCommands: [...ALL_COMMANDS] };
    item.tooltip = tooltip;

    item.show();
  }

  private ensureItem(alignment: "left" | "right"): vscode.StatusBarItem {
    if (this.item !== undefined && this.alignment === alignment) return this.item;

    // 改变对齐方式只能重建，没有就地切换的 API。
    this.item?.dispose();
    this.item = vscode.window.createStatusBarItem(
      alignment === "left"
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = "DeepSeek 余额";
    this.alignment = alignment;
    return this.item;
  }

  dispose(): void {
    this.disposed = true;
    this.item?.dispose();
    this.item = undefined;
  }
}
