import * as vscode from "vscode";

import type { AppConfig } from "./config";
import { fetchBalance } from "./deepseek/client";
import type { BalanceError, BalanceSnapshot } from "./deepseek/types";
import { COMMAND_SET_API_KEY, type StatusState } from "./render";

export type RefreshTrigger =
  | "startup"
  | "timer"
  | "manual"
  | "config"
  | "key-change"
  | "focus";

export interface RefreshControllerDeps {
  getApiKey: () => Promise<string | undefined>;
  getConfig: () => AppConfig;
  onState: (state: StatusState) => void;
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * 负责「什么时候去查余额」以及并发的正确性。
 *
 * 三条关键设计：
 * - 自重排的 setTimeout 而非 setInterval，慢请求不会堆积；
 * - inFlight 合流，在途时再次触发不会重复发请求；
 * - generation 代际计数，密钥/端点变更后落地的旧结果一律丢弃。
 */
export class RefreshController implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private snapshot: BalanceSnapshot | undefined;
  private state: StatusState = { kind: "no-key" };
  private lastNotifiedKind: string | undefined;

  constructor(private readonly deps: RefreshControllerDeps) {}

  getState(): StatusState {
    return this.state;
  }

  start(): void {
    void this.refresh("startup");
  }

  refresh(trigger: RefreshTrigger): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight !== undefined) return this.inFlight;

    const promise = this.run(trigger).finally(() => {
      // 只有仍是最新那次请求时才收尾，避免被后来的请求顶掉后重复排期。
      if (this.inFlight === promise) {
        this.inFlight = undefined;
        this.reschedule();
      }
    });
    this.inFlight = promise;
    return promise;
  }

  /** 密钥被设置、清除或由其它窗口改动时调用。 */
  onKeyChanged(): void {
    if (this.disposed) return;
    this.invalidate();
    this.snapshot = undefined;
    this.lastNotifiedKind = undefined;
    void this.refresh("key-change");
  }

  onConfigChanged(previous: AppConfig, next: AppConfig): void {
    if (this.disposed) return;

    if (previous.refreshInterval !== next.refreshInterval) {
      this.reschedule();
    }

    if (previous.baseUrl !== next.baseUrl) {
      // 旧数据来自另一个端点，必须重新拉。
      this.invalidate();
      this.snapshot = undefined;
      void this.refresh("config");
      return;
    }

    // 币种、阈值、对齐方式只影响渲染，重放当前状态即可。
    this.emit(this.state);
  }

  /** 窗口重新获得焦点时，若数据已超过一个刷新周期就补一次。 */
  onFocus(): void {
    if (this.disposed) return;
    const config = this.deps.getConfig();
    if (config.refreshInterval <= 0) return;

    const snapshot = this.snapshot;
    if (snapshot === undefined) return;
    if (Date.now() - snapshot.fetchedAt < config.refreshInterval * 60_000) return;

    void this.refresh("focus");
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.abort?.abort();
    this.abort = undefined;
  }

  private async run(trigger: RefreshTrigger): Promise<void> {
    const config = this.deps.getConfig();
    const generation = this.generation;

    const apiKey = await this.deps.getApiKey();
    if (this.isOutdated(generation)) return;

    if (apiKey === undefined) {
      this.snapshot = undefined;
      this.emit({ kind: "no-key" });
      return;
    }

    // 后台轮询不显示转圈——每 5 分钟闪一下很烦；其余触发方式给出明确反馈。
    if (trigger !== "timer") {
      this.emit(
        this.snapshot === undefined
          ? { kind: "loading" }
          : { kind: "loading", previous: this.snapshot },
      );
    }

    const requestAbort = new AbortController();
    this.abort = requestAbort;

    const result = await fetchBalance({
      apiKey,
      baseUrl: config.baseUrl,
      signal: requestAbort.signal,
    });

    if (this.abort === requestAbort) this.abort = undefined;
    if (this.isOutdated(generation)) return;

    if (!result.ok) {
      this.handleError(result.error, trigger);
      return;
    }

    this.snapshot = result.snapshot;
    this.lastNotifiedKind = undefined;
    this.deps.debug(
      `余额刷新成功：${result.snapshot.infos.length} 个币种，端点 ${result.snapshot.endpoint}。`,
    );
    this.emit({
      kind: "ok",
      snapshot: result.snapshot,
      stale: this.isStale(result.snapshot, config),
    });
  }

  private handleError(error: BalanceError, trigger: RefreshTrigger): void {
    const suffix =
      error.httpStatus === undefined ? "" : ` HTTP ${error.httpStatus}`;
    const line = `余额刷新失败：${error.kind}${suffix} —— ${error.message}`;

    // 瞬时网络问题不算异常，记 debug 即可；其余记 warn。
    if (error.kind === "network" || error.kind === "timeout") {
      this.deps.debug(line);
    } else {
      this.deps.warn(line);
    }

    this.notify(error, trigger);

    const previous = this.snapshot;
    this.emit(
      previous === undefined
        ? { kind: "error", error, stale: false }
        : { kind: "error", error, previous, stale: true },
    );

    if (error.kind === "unauthorized" || error.kind === "forbidden") {
      // 旧值已不可信，下次展示时不再拿它当「上次已知良好值」。
      this.snapshot = undefined;
    }
  }

  private notify(error: BalanceError, trigger: RefreshTrigger): void {
    const isAuth = error.kind === "unauthorized" || error.kind === "forbidden";

    // 后台轮询从不弹窗；手动刷新之外的瞬时错误也不打扰。
    if (!isAuth && trigger !== "manual") return;
    // 同一种鉴权错误连续发生只提示一次，成功后重置。
    if (isAuth && this.lastNotifiedKind === error.kind) return;
    this.lastNotifiedKind = error.kind;

    if (isAuth) {
      void vscode.window
        .showWarningMessage(`DeepSeek：${error.message}`, "重新设置 API Key")
        .then((picked) => {
          if (picked !== undefined) {
            void vscode.commands.executeCommand(COMMAND_SET_API_KEY);
          }
        });
      return;
    }

    void vscode.window.showWarningMessage(`DeepSeek 余额刷新失败：${error.message}`);
  }

  private isOutdated(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private isStale(snapshot: BalanceSnapshot, config: AppConfig): boolean {
    // 关掉自动刷新即视为用户接受手动控制，不再按时长判过期。
    // （错误导致的过期仍由 error 态单独表达。）
    if (config.refreshInterval <= 0) return false;
    const limit = Math.max(2 * config.refreshInterval, 5) * 60_000;
    return Date.now() - snapshot.fetchedAt > limit;
  }

  private invalidate(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    this.inFlight = undefined;
  }

  private reschedule(): void {
    this.clearTimer();
    if (this.disposed) return;

    const config = this.deps.getConfig();
    if (config.refreshInterval <= 0) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh("timer");
    }, config.refreshInterval * 60_000);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private emit(state: StatusState): void {
    if (this.disposed) return;
    this.state = state;
    this.deps.onState(state);
  }
}
