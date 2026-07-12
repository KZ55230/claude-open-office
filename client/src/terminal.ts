// 右側ターミナルドック（0〜2面の可変表示）の制御。
// - 接続中の面が0のときはドック自体が非表示（オフィスが横幅100%）
// - 1面のときはコンソール1面が高さ100%、2面のときは上下50%ずつ
// - 面を閉じてもWSを切るだけでptyは生存する（従業員は裏で働き続ける）
// - 描画は @xterm/addon-webgl を優先し、コンテキストロス時はCanvasへ自動フォールバック
// - @xterm/addon-fit でサイズ追従し、リサイズをWSでサーバーへ通知する

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { TerminalSocket } from "./api";

/** 面ヘッダーに表示するタイトル（従業員名＋セッション名） */
export interface PaneTitle {
  empName: string;
  sessionTitle: string;
}

/** ターミナル1面分の状態 */
class Pane {
  readonly index: number;
  readonly root: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly sessionEl: HTMLElement;
  readonly body: HTMLElement;
  readonly term: Terminal;
  readonly fit: FitAddon;
  private webgl: WebglAddon | null = null;
  socket: TerminalSocket | null = null;
  terminalId: string | null = null;
  sessionId: string | null = null;
  attachedAt = 0;

  constructor(index: number, root: HTMLElement) {
    this.index = index;
    this.root = root;
    this.nameEl = root.querySelector(".pane-name")!;
    this.sessionEl = root.querySelector(".pane-session")!;
    this.body = root.querySelector(".pane-body")!;

    // ダークトーンの端末テーマ（オーバーレイUIと統一）
    this.term = new Terminal({
      fontFamily: '"DejaVu Sans Mono", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#12121a",
        foreground: "#d0d0e0",
        cursor: "#7fe0a0",
        black: "#12121a",
        green: "#7fe0a0",
        yellow: "#e8c020",
        blue: "#5a9ad0",
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.body);
    this.tryEnableWebgl();

    // 打鍵をサーバーへ送る
    this.term.onData((data) => {
      this.socket?.sendInput(data);
    });

    // 面サイズの変化に追従（ドックの開閉・2面化のCSSトランジション後も発火する）
    const ro = new ResizeObserver(() => this.refit());
    ro.observe(this.body);
  }

  /** WebGLレンダラを試す。失敗・コンテキストロス時はCanvas描画に戻す */
  private tryEnableWebgl(): void {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // GPUコンテキストが失われたら破棄してCanvasへフォールバック
        addon.dispose();
        this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      // WebGL非対応環境はCanvasのまま
      this.webgl = null;
    }
  }

  /** 面にフィットさせ、寸法をサーバーへ通知する */
  refit(): void {
    if (this.body.offsetWidth === 0 || this.body.offsetHeight === 0) return;
    try {
      this.fit.fit();
      this.socket?.sendResize(this.term.cols, this.term.rows);
    } catch {
      // レイアウト未確定時などは無視
    }
  }

  setTitle(title: PaneTitle): void {
    this.nameEl.textContent = title.empName;
    this.sessionEl.textContent = title.sessionTitle || "（セッション名未設定）";
  }

  /** WSを閉じて面を空にする（ptyは生存） */
  detach(): void {
    this.socket?.close();
    this.socket = null;
    this.terminalId = null;
    this.sessionId = null;
    this.term.reset();
  }
}

/**
 * ターミナルドック本体。最大2面を管理する。
 * 接続先の選択規則：同一セッションの面があれば再利用 → 空き面 → 最古の面（attachedAt）。
 */
export class TerminalDock {
  /** hire後に新sessionIdが確定したら通知（入社演出はstate差分で発火するため情報用） */
  onSessionBound?: (sessionId: string) => void;
  /** 面ヘッダーの✎（従業員カルテ）クリック */
  onKarteClick?: (sessionId: string | null) => void;
  /** ドックの表示状態が変わった（オフィス側のリサイズ通知などに使える） */
  onLayoutChange?: () => void;

  private readonly dockEl: HTMLElement;
  private readonly panes: Pane[];

  constructor(dockEl: HTMLElement) {
    this.dockEl = dockEl;
    this.panes = [0, 1].map((i) => {
      const root = dockEl.querySelector<HTMLElement>(`#term-pane-${i}`);
      if (!root) throw new Error(`ターミナル面が見つかりません: #term-pane-${i}`);
      const pane = new Pane(i, root);
      // 閉じるボタン：WSのみ切断（ptyは生存）
      root.querySelector<HTMLElement>(".pane-close")!.addEventListener("click", () => {
        pane.detach();
        this.updateVisibility();
      });
      // カルテ✎ボタン
      root.querySelector<HTMLElement>(".pane-karte")!.addEventListener("click", () => {
        this.onKarteClick?.(pane.sessionId);
      });
      return pane;
    });
    this.updateVisibility();
  }

  /** 接続中の面の数（0〜2） */
  get activeCount(): number {
    return this.panes.filter((p) => p.terminalId !== null).length;
  }

  /**
   * ターミナルを開く。同一セッションの面があれば再利用し、
   * なければ空き面→最古の面の順に割り当てる。
   * @param sessionId hire直後は未確定なのでnull（sessionBoundで確定する）
   */
  open(terminalId: string, sessionId: string | null, title: PaneTitle): void {
    // 1) 同一セッション or 同一ターミナルの面を再利用
    let pane =
      (sessionId
        ? this.panes.find((p) => p.sessionId !== null && p.sessionId === sessionId)
        : undefined) ?? this.panes.find((p) => p.terminalId === terminalId);

    if (pane) {
      pane.setTitle(title);
      if (pane.terminalId !== terminalId) {
        // 同一セッションだがptyが作り直された場合は接続し直す
        this.attach(pane, terminalId, sessionId ?? pane.sessionId, title);
      } else {
        pane.attachedAt = Date.now();
        this.updateVisibility();
        pane.refit();
        pane.term.focus();
      }
      return;
    }

    // 2) 空き面 → 3) 最古の面
    pane =
      this.panes.find((p) => p.terminalId === null) ??
      this.panes.reduce((a, b) => (a.attachedAt <= b.attachedAt ? a : b));

    this.attach(pane, terminalId, sessionId, title);
  }

  /** 指定セッションの面があればフォーカスして true（REST呼び出し前の再利用判定に使う） */
  focusSession(sessionId: string): boolean {
    const pane = this.panes.find((p) => p.sessionId === sessionId);
    if (!pane) return false;
    pane.attachedAt = Date.now();
    this.updateVisibility();
    pane.refit();
    pane.term.focus();
    return true;
  }

  /** セッション名の表示だけ更新する（リネーム直後の楽観反映） */
  setSessionTitle(sessionId: string, sessionTitle: string): void {
    for (const pane of this.panes) {
      if (pane.sessionId === sessionId) {
        pane.sessionEl.textContent = sessionTitle || "（セッション名未設定）";
      }
    }
  }

  /** 面へWS接続する */
  private attach(
    pane: Pane,
    terminalId: string,
    sessionId: string | null,
    title: PaneTitle
  ): void {
    pane.socket?.close();
    pane.term.reset();
    pane.terminalId = terminalId;
    pane.sessionId = sessionId;
    pane.attachedAt = Date.now();
    pane.setTitle(title);

    pane.socket = new TerminalSocket(terminalId, {
      onOutput: (data) => pane.term.write(data),
      onExit: (code) => {
        pane.term.write(
          `\r\n\x1b[33m[セッションが終了しました（コード ${code}）]\x1b[0m\r\n`
        );
      },
      onSessionBound: (sid) => {
        pane.sessionId = sid; // hire直後の面にsessionIdを紐づける
        this.onSessionBound?.(sid);
      },
      onOpen: () => {
        pane.refit();
        pane.term.focus();
      },
      onClose: () => {
        pane.term.write("\r\n\x1b[90m[接続が切れました]\x1b[0m\r\n");
      },
    });

    this.updateVisibility();
    // ドックの開閉トランジション後に再フィット（ResizeObserverの取りこぼし保険）
    setTimeout(() => pane.refit(), 300);
  }

  /**
   * ドックと各面の表示状態をCSSクラスで反映する。
   * panes-0=ドック非表示 / panes-1=1面が高さ100% / panes-2=上下50%ずつ
   */
  private updateVisibility(): void {
    const active = this.panes.filter((p) => p.terminalId !== null);
    this.dockEl.classList.remove("panes-0", "panes-1", "panes-2");
    this.dockEl.classList.add(`panes-${active.length}`);
    for (const pane of this.panes) {
      pane.root.classList.toggle("hidden", pane.terminalId === null);
    }
    this.onLayoutChange?.();
    // トランジション完了後に全面を再フィット
    setTimeout(() => {
      for (const pane of active) pane.refit();
    }, 300);
  }
}
