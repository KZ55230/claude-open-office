// サーバーとの通信層。shared/types.ts の契約どおりにREST/WSを実装する。
// サーバーは並行開発中でまだ存在しない可能性があるため、失敗は呼び出し側にthrow/コールバックで通知し、
// 画面側でエラー表示＋リトライを出せるようにする。

import type {
  OfficeState,
  OfficeSettings,
  OfficeWsMessage,
  TermServerMessage,
  TermClientMessage,
  EmployeeStatus,
  UsageInfo,
} from "../../shared/types";

/** WSのstatusパッチ1件分（契約のOfficeWsMessage type:"status" のupdates要素） */
export interface StatusUpdate {
  sessionId: string;
  status: EmployeeStatus;
  hasLiveTerminal: boolean;
}

// devではViteが/apiと/wsを3777へプロキシするので、相対パスで叩けばよい
const API_BASE = "";

/** WSのURLを現在のロケーションから組み立てる（https→wss対応） */
function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

/** 共通のJSON取得。失敗時は分かりやすい日本語エラーをthrowする */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (e) {
    // ネットワーク到達不能（サーバー未起動など）
    throw new Error(`サーバーに接続できません（${path}）`);
  }
  if (!res.ok) {
    // サーバーが返す具体的な理由（{ error: "..." }）があればそれをそのまま表示する
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error.trim()) {
        detail = body.error.trim();
      }
    } catch {
      // JSONでないボディは無視して汎用メッセージへフォールバック
    }
    throw new Error(detail || `サーバーエラー ${res.status}（${path}）`);
  }
  return (await res.json()) as T;
}

// ---- REST ----

/** GET /api/office → 初期オフィス状態 */
export function getOffice(): Promise<OfficeState> {
  return fetchJson<OfficeState>("/api/office");
}

/** PUT /api/settings → 表示設定を更新し最新状態を得る */
export function putSettings(settings: OfficeSettings): Promise<OfficeState> {
  return fetchJson<OfficeState>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** POST /api/projects → 新規プロジェクト（部署）を作成 */
export function createProject(name: string, purpose: string): Promise<OfficeState> {
  return fetchJson<OfficeState>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, purpose }),
  });
}

/** GET /api/usage → 使用量チェック専用ptyの直近取得結果 */
export function getUsage(): Promise<UsageInfo> {
  return fetchJson<UsageInfo>("/api/usage");
}

/** POST /api/hire → 新規雇用。空席クリック時。terminalIdを返す */
export function hire(departmentId: string): Promise<{ terminalId: string }> {
  return fetchJson<{ terminalId: string }>("/api/hire", {
    method: "POST",
    body: JSON.stringify({ departmentId }),
  });
}

/** POST /api/terminal → 既存セッションにresume接続。terminalIdを返す */
export function openTerminal(
  departmentId: string,
  sessionId: string
): Promise<{ terminalId: string }> {
  return fetchJson<{ terminalId: string }>("/api/terminal", {
    method: "POST",
    body: JSON.stringify({ departmentId, sessionId }),
  });
}

/** DELETE /api/terminal/:id → ptyを終了（退勤） */
export function closeTerminal(terminalId: string): Promise<void> {
  return fetchJson<void>(`/api/terminal/${encodeURIComponent(terminalId)}`, {
    method: "DELETE",
  }).catch(() => {
    // 退勤はベストエフォート。失敗しても致命ではない
  });
}

/** PUT /api/departments/:id/alias → 部署の表示名エイリアスを設定（空文字で解除） */
export function putDepartmentAlias(
  departmentId: string,
  alias: string
): Promise<OfficeState> {
  return fetchJson<OfficeState>(
    `/api/departments/${encodeURIComponent(departmentId)}/alias`,
    {
      method: "PUT",
      body: JSON.stringify({ alias }),
    }
  );
}

/** PUT /api/employees/:sessionId/note → 手動の進捗メモを設定（空文字で解除） */
export function putEmployeeNote(
  sessionId: string,
  note: string
): Promise<OfficeState> {
  return fetchJson<OfficeState>(
    `/api/employees/${encodeURIComponent(sessionId)}/note`,
    {
      method: "PUT",
      body: JSON.stringify({ note }),
    }
  );
}

/**
 * POST /api/sessions/:sessionId/title → セッション名の変更。
 * サーバーが .jsonl へ custom-title 行を追記する（append専用）。
 * 反映されたtitleは次回のstate配信で届く。
 */
export function renameSession(
  sessionId: string,
  departmentId: string,
  title: string
): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/title`,
    {
      method: "POST",
      body: JSON.stringify({ departmentId, title }),
    }
  );
}

// ---- WebSocket: /ws/office ----

/** OfficeSocketのイベントハンドラ一覧 */
export interface OfficeSocketHandlers {
  onState: (state: OfficeState) => void;
  onStatusChange?: (connected: boolean) => void;
  onStatusPatch?: (updates: StatusUpdate[]) => void;
  onUsage?: (usage: UsageInfo) => void;
  onSpeech?: (
    sessionId: string,
    kind: "permission" | "done",
    text: string
  ) => void;
}

/**
 * /ws/office に接続し、stateメッセージを購読する。
 * 切断時は自動で指数バックオフ再接続する（オフィスの状態配信は継続性が重要）。
 */
export class OfficeSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retryDelay = 1000;
  private readonly handlers: OfficeSocketHandlers;

  constructor(handlers: OfficeSocketHandlers) {
    this.handlers = handlers;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl("/ws/office"));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryDelay = 1000; // 再接続成功でバックオフをリセット
      this.handlers.onStatusChange?.(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as OfficeWsMessage;
        if (msg.type === "state") this.handlers.onState(msg.state);
        else if (msg.type === "status")
          this.handlers.onStatusPatch?.(msg.updates);
        else if (msg.type === "usage") this.handlers.onUsage?.(msg.usage);
        else if (msg.type === "speech")
          this.handlers.onSpeech?.(msg.sessionId, msg.kind, msg.text);
      } catch {
        // 壊れたメッセージは無視
      }
    };
    ws.onclose = () => {
      this.handlers.onStatusChange?.(false);
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // oncloseが続くので特別扱いしない
    };
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (!this.closedByUser) this.open();
    }, this.retryDelay);
    // 最大30秒までバックオフ
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }
}

// ---- WebSocket: /ws/term/:terminalId ----

/** ターミナルWSのラッパ。双方向入出力＋sessionBound通知を扱う */
export class TerminalSocket {
  private ws: WebSocket;
  constructor(
    terminalId: string,
    handlers: {
      onOutput: (data: string) => void;
      onExit?: (code: number) => void;
      onSessionBound?: (sessionId: string) => void;
      onOpen?: () => void;
      onClose?: () => void;
    }
  ) {
    this.ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(terminalId)}`));
    this.ws.onopen = () => handlers.onOpen?.();
    this.ws.onclose = () => handlers.onClose?.();
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as TermServerMessage;
        if (msg.type === "output") handlers.onOutput(msg.data);
        else if (msg.type === "exit") handlers.onExit?.(msg.code);
        else if (msg.type === "sessionBound") handlers.onSessionBound?.(msg.sessionId);
      } catch {
        // 無視
      }
    };
  }

  /** 端末への入力を送る */
  sendInput(data: string): void {
    this.send({ type: "input", data });
  }

  /** リサイズ通知を送る */
  sendResize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  private send(msg: TermClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.ws.close();
  }
}
