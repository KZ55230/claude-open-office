// pty（疑似端末）管理モジュール。claude CLIをその部署のcwdで起動し、
// 出力のバッチング配信・リングバッファ保持・WS再接続時の再生・ステータス判定を担う。
import { randomUUID } from "node:crypto";
import * as pty from "@lydell/node-pty";
import type { WebSocket } from "ws";
import type {
  EmployeeStatus,
  TermServerMessage,
} from "../../shared/types.js";
import { buildChildEnv } from "./childEnv.js";
import { resolveCaudeBin } from "./paths.js";

// 出力リングバッファの最大サイズ（64KB。再接続時の再生用）
const RING_BUFFER_MAX = 64 * 1024;
// この秒数以内に出力があれば working、超えたら waiting（DESIGN.md: 5秒）
const WORKING_WINDOW_MS = 5000;
// pty出力のバッチング間隔（この間隔でまとめて1つのoutputメッセージにする）
const BATCH_INTERVAL_MS = 16;
// バッチ蓄積がこのサイズを超えたらタイマーを待たず即時flushする
const BATCH_FLUSH_SIZE = 32 * 1024;
// 再接続時の再生を分割送信するチャンクサイズ
const REPLAY_CHUNK_SIZE = 16 * 1024;
// claude CLI の実行パス（Windows では .exe/.cmd を解決する）
const CLAUDE_BIN = resolveCaudeBin();
// /clear等で同一ptyのsessionIdが変わった際、直近この時間内に出力があった
// bind済み端末を「セッション遷移した本人」とみなして再割り当てする猶予時間
const REBIND_WINDOW_MS = 10000;

/** 1つのpty（＝1人の従業員の稼働端末）を表す */
interface TerminalSession {
  terminalId: string;
  proc: pty.IPty;
  /** その端末が属する部署のcwd */
  cwd: string;
  /** 紐づくsessionId。hireの場合は確定まで null */
  sessionId: string | null;
  /**
   * 出力のリングバッファ（WS再接続時に再生する）。
   * string連結だと出力のたびに全体コピーが走るため、チャンク配列＋合計長で管理し、
   * 上限超過時は先頭チャンクをshiftして捨てる。
   */
  bufferChunks: string[];
  /** bufferChunksの合計文字数 */
  bufferLen: number;
  /** バッチング用の未送信出力（flushでまとめて1メッセージにする） */
  pending: string;
  /** バッチングflushの予約タイマー */
  flushTimer: NodeJS.Timeout | null;
  /** 最後に出力があった時刻（ms） */
  lastOutputAt: number;
  /** 現在この端末を購読しているWS（切断されても pty は生かす） */
  clients: Set<WebSocket>;
  /** プロセスが終了済みか */
  exited: boolean;
}

/** hireで新規sessionIdが確定したときに呼ばれるコールバック */
export type SessionBoundHandler = (
  terminalId: string,
  sessionId: string
) => void;

/** statusSnapshot() が返す1セッション分の稼働状況 */
export interface SessionStatus {
  status: EmployeeStatus;
  hasLiveTerminal: boolean;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private onSessionBound: SessionBoundHandler | null = null;

  /** sessionBound（新規雇用でsessionId確定）時の通知先を登録 */
  setSessionBoundHandler(handler: SessionBoundHandler): void {
    this.onSessionBound = handler;
  }

  /**
   * バッチ蓄積分をリングバッファへ反映し、1つのoutputメッセージとして配信する。
   * onExit時にも呼ばれるため、exitメッセージより先に必ず出力が届く（順序保証）。
   */
  private flushPending(session: TerminalSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pending.length === 0) return;
    const data = session.pending;
    session.pending = "";

    // リングバッファへ蓄積（チャンク配列。上限超過は先頭から捨てる）
    session.bufferChunks.push(data);
    session.bufferLen += data.length;
    while (
      session.bufferLen > RING_BUFFER_MAX &&
      session.bufferChunks.length > 0
    ) {
      const removed = session.bufferChunks.shift()!;
      session.bufferLen -= removed.length;
    }

    const msg: TermServerMessage = { type: "output", data };
    this.broadcast(session, msg);
  }

  /** 共通のpty生成処理。args と cwd を指定して端末を作る */
  private createTerminal(
    cwd: string,
    args: string[],
    sessionId: string | null
  ): TerminalSession {
    const proc = pty.spawn(CLAUDE_BIN, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: buildChildEnv(),
    });

    const session: TerminalSession = {
      terminalId: randomUUID(),
      proc,
      cwd,
      sessionId,
      bufferChunks: [],
      bufferLen: 0,
      pending: "",
      flushTimer: null,
      lastOutputAt: Date.now(),
      clients: new Set(),
      exited: false,
    };

    // pty出力: pendingへ蓄積し、16msタイマーでまとめて配信（1チャンク毎の送信を避ける）
    proc.onData((data) => {
      session.lastOutputAt = Date.now();
      session.pending += data;
      if (session.pending.length >= BATCH_FLUSH_SIZE) {
        // 蓄積が大きくなったら即時flush（メモリ膨張と遅延を防ぐ）
        this.flushPending(session);
      } else if (!session.flushTimer) {
        session.flushTimer = setTimeout(
          () => this.flushPending(session),
          BATCH_INTERVAL_MS
        );
      }
    });

    // pty終了: 残りの出力を必ずflushしてからexitを通知し、Mapから除去
    proc.onExit(({ exitCode }) => {
      session.exited = true;
      this.flushPending(session);
      const msg: TermServerMessage = { type: "exit", code: exitCode };
      this.broadcast(session, msg);
      this.sessions.delete(session.terminalId);
    });

    this.sessions.set(session.terminalId, session);
    return session;
  }

  /**
   * 新規雇用（hire）: claude を引数なしでcwd起動する。
   * sessionIdはまだ確定していないので、scanner側が新しい.jsonlを検知したら
   * bindSession() を呼んで紐づける。
   */
  hire(cwd: string): string {
    const session = this.createTerminal(cwd, [], null);
    return session.terminalId;
  }

  /**
   * 既存セッションのresume接続: claude --resume <sessionId> をcwd起動する。
   */
  resume(cwd: string, sessionId: string): string {
    const session = this.createTerminal(
      cwd,
      ["--resume", sessionId],
      sessionId
    );
    return session.terminalId;
  }

  /**
   * hire後に新規sessionIdを紐づける。sessionBoundをWSへ通知する。
   * すでにsessionIdが確定済み、または端末が無い場合は何もしない。
   */
  bindSession(terminalId: string, sessionId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session || session.sessionId) return;
    session.sessionId = sessionId;
    const msg: TermServerMessage = { type: "sessionBound", sessionId };
    this.broadcast(session, msg);
    this.onSessionBound?.(terminalId, sessionId);
  }

  /**
   * まだsessionId未確定（hire直後）の端末一覧を返す。
   * scanner側が新規.jsonl検知時に、どのhire端末へ紐づけるか判断するのに使う。
   */
  getUnboundTerminals(): { terminalId: string; cwd: string }[] {
    const result: { terminalId: string; cwd: string }[] = [];
    for (const s of this.sessions.values()) {
      if (!s.sessionId && !s.exited) {
        result.push({ terminalId: s.terminalId, cwd: s.cwd });
      }
    }
    return result;
  }

  /**
   * 同じcwdで既にsessionIdが確定済みの端末のうち、直近REBIND_WINDOW_MS以内に
   * 出力があったものを探す（/clear等で同一ptyのsessionIdが変わったケースの
   * 再割り当て候補探索に使う）。excludeSessionIdは新しく出現したsessionId自身。
   * 候補が複数あれば最も出力が新しいものを選ぶ。
   */
  findRecentBoundTerminal(
    cwd: string,
    excludeSessionId: string
  ): { terminalId: string } | null {
    const now = Date.now();
    let best: TerminalSession | null = null;
    for (const s of this.sessions.values()) {
      if (s.exited || !s.sessionId || s.cwd !== cwd) continue;
      if (s.sessionId === excludeSessionId) continue;
      if (now - s.lastOutputAt > REBIND_WINDOW_MS) continue;
      if (!best || s.lastOutputAt > best.lastOutputAt) best = s;
    }
    return best ? { terminalId: best.terminalId } : null;
  }

  /**
   * 既にsessionId確定済みの端末を、別のsessionIdへ付け替える。
   * /clear等で同一ptyの中で会話（＝.jsonl）が切り替わったとみなされたときに使う。
   * 古いsessionIdは以後このptyのhasLiveTerminal判定から外れ、resting表示になる。
   */
  rebindSession(terminalId: string, sessionId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.sessionId = sessionId;
    const msg: TermServerMessage = { type: "sessionBound", sessionId };
    this.broadcast(session, msg);
    this.onSessionBound?.(terminalId, sessionId);
  }

  /**
   * WS接続をこの端末に購読させ、リングバッファを再生する。
   * 再生は16KBずつ複数のoutputメッセージに分割して送る
   * （巨大な1メッセージでクライアント側の描画が固まるのを防ぐ）。
   */
  attachClient(terminalId: string, ws: WebSocket): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    session.clients.add(ws);
    if (session.bufferLen > 0) {
      const full = session.bufferChunks.join("");
      for (let i = 0; i < full.length; i += REPLAY_CHUNK_SIZE) {
        this.send(ws, {
          type: "output",
          data: full.slice(i, i + REPLAY_CHUNK_SIZE),
        });
      }
    }
    return true;
  }

  /** WS切断時: 購読解除するがptyは生かす（従業員は裏で働き続ける） */
  detachClient(terminalId: string, ws: WebSocket): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.clients.delete(ws);
  }

  /** クライアントからの入力をptyへ書き込む */
  write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId);
    if (session && !session.exited) session.proc.write(data);
  }

  /** ターミナルサイズ変更をptyへ反映する */
  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId);
    if (session && !session.exited) {
      try {
        session.proc.resize(cols, rows);
      } catch {
        // 無効なサイズ等は無視
      }
    }
  }

  /** ptyを終了する（DELETE時のみ＝退勤） */
  kill(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    try {
      session.proc.kill();
    } catch {
      // すでに死んでいる場合は無視
    }
    return true;
  }

  /** 指定sessionIdにひもづく稼働中ptyがあるか */
  hasLiveTerminal(sessionId: string): boolean {
    for (const s of this.sessions.values()) {
      if (!s.exited && s.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * 指定sessionIdのライブptyのステータスを返す。
   *  直近WORKING_WINDOW_MS以内に出力あり → working
   *  それ以上出力なし → waiting
   *  稼働中ptyが無ければ null
   */
  liveStatus(sessionId: string): EmployeeStatus | null {
    for (const s of this.sessions.values()) {
      if (s.exited || s.sessionId !== sessionId) continue;
      const idle = Date.now() - s.lastOutputAt;
      return idle <= WORKING_WINDOW_MS ? "working" : "waiting";
    }
    return null;
  }

  /**
   * メモリ上のpty状態だけからスナップショットを作る（ファイルI/Oゼロ）。
   * sessionId確定済み・未exitのptyのみが対象。
   * index.ts側が毎秒これを前回分と比較し、変化分だけWSへ差分配信する。
   */
  statusSnapshot(): Map<string, SessionStatus> {
    const snap = new Map<string, SessionStatus>();
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.exited || !s.sessionId) continue;
      const idle = now - s.lastOutputAt;
      snap.set(s.sessionId, {
        status: idle <= WORKING_WINDOW_MS ? "working" : "waiting",
        hasLiveTerminal: true,
      });
    }
    return snap;
  }

  /** メッセージを1つのWSへ送る（JSON文字列化） */
  private send(ws: WebSocket, msg: TermServerMessage): void {
    // OPEN(=1)のときのみ送信
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** 購読中の全WSへメッセージを配信 */
  private broadcast(session: TerminalSession, msg: TermServerMessage): void {
    for (const ws of session.clients) {
      this.send(ws, msg);
    }
  }
}
