// Claude Code CLIの対話内蔵スラッシュコマンド `/usage` を裏で定期実行し、
// セッション（5時間ウィンドウ）・週次の使用率(%)を取得するモジュール。
//
// TerminalManagerとは完全に独立しており、sessionsマップへの登録を一切行わない。
// そのため従業員一覧・scanner.tsのファイルスキャンには構造的に現れない
// （/usageはローカル完結のUIコマンドで、~/.claude/projects/**/*.jsonlへの
// 新規セッション作成も一切発生しないことを実機検証済み）。
import * as pty from "@lydell/node-pty";
import { buildChildEnv } from "./childEnv.js";
import { USAGE_PROBE_CWD } from "./paths.js";
import type { UsageInfo } from "../../shared/types.js";

const POLL_INTERVAL_MS = 90_000; // /usageを送る間隔
const STARTUP_DELAY_MS = 8_000; // claude CLI起動直後の初期化待ち
const OUTPUT_WAIT_MS = 4_000; // /usage送信後、出力が安定するまでの待ち
const CLOSE_WAIT_MS = 300; // Esc送信後の反映待ち
const RESTART_BACKOFF_MS = 30_000; // pty異常終了・起動失敗時の再起動間隔

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ANSIエスケープシーケンスを除去する（CSI・OSC・その他の制御シーケンス） */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // CSIシーケンス（色・カーソル移動等）
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "") // OSCシーケンス
    .replace(/\x1b[()][A-Za-z0-9]/g, "") // 文字セット指定
    .replace(/\r/g, "");
}

/** ANSI除去済みテキストから「Current session」「Current week (all models)」の%usedを抽出する */
export function parseUsageOutput(text: string): {
  sessionPercent: number | null;
  weekPercent: number | null;
} {
  const sessionMatch = /Current session[\s\S]*?(\d+)\s*%\s*used/i.exec(text);
  const weekMatch = /Current week \(all models\)[\s\S]*?(\d+)\s*%\s*used/i.exec(
    text
  );
  return {
    sessionPercent: sessionMatch ? Number(sessionMatch[1]) : null,
    weekPercent: weekMatch ? Number(weekMatch[1]) : null,
  };
}

export type UsageUpdateHandler = (usage: UsageInfo) => void;

/**
 * 使用量チェック専用の内部pty。TerminalManagerとは完全に独立しており、
 * Office従業員一覧・scanner.tsのスキャンには決して現れない。
 */
export class UsageMonitor {
  private proc: pty.IPty | null = null;
  private buffer = "";
  private info: UsageInfo = {
    sessionPercent: null,
    weekPercent: null,
    updatedAt: "",
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private onUpdate: UsageUpdateHandler | null = null;

  setUpdateHandler(handler: UsageUpdateHandler): void {
    this.onUpdate = handler;
  }

  getUsage(): UsageInfo {
    return this.info;
  }

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    try {
      this.proc?.kill();
    } catch {
      // 既に死んでいる場合は無視
    }
  }

  private spawn(): void {
    try {
      this.proc = pty.spawn("claude", [], {
        name: "xterm-256color",
        cols: 100,
        rows: 40,
        cwd: USAGE_PROBE_CWD,
        env: buildChildEnv(),
      });
    } catch (e) {
      console.error("[usage-monitor] ptyの起動に失敗:", e);
      this.scheduleRestart();
      return;
    }
    this.buffer = "";
    this.proc.onData((d) => {
      this.buffer += d;
    });
    this.proc.onExit(({ exitCode }) => {
      console.warn(`[usage-monitor] ptyが終了しました(code=${exitCode})。再起動します`);
      if (!this.stopped) this.scheduleRestart();
    });
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollLoop(), STARTUP_DELAY_MS);
  }

  private scheduleRestart(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    setTimeout(() => {
      if (!this.stopped) this.spawn();
    }, RESTART_BACKOFF_MS);
  }

  private async pollLoop(): Promise<void> {
    if (this.stopped || !this.proc) return;
    try {
      await this.checkOnce();
    } catch (e) {
      console.error("[usage-monitor] チェックに失敗:", e);
    }
    if (!this.stopped) {
      this.pollTimer = setTimeout(() => void this.pollLoop(), POLL_INTERVAL_MS);
    }
  }

  private async checkOnce(): Promise<void> {
    if (!this.proc) return;
    this.buffer = "";
    this.proc.write("/usage\r");
    await sleep(OUTPUT_WAIT_MS);
    const parsed = parseUsageOutput(stripAnsi(this.buffer));
    // "Scanning local sessions…"のプレースホルダー等で両方nullの場合は前回値を維持する
    if (parsed.sessionPercent !== null || parsed.weekPercent !== null) {
      this.info = { ...parsed, updatedAt: new Date().toISOString() };
      this.onUpdate?.(this.info);
    }
    // モーダルを閉じて通常プロンプトへ戻す
    this.proc.write("\x1b");
    await sleep(CLOSE_WAIT_MS);
  }
}
