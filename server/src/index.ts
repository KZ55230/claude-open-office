// Claude Office サーバーのエントリポイント。
// Express（REST + 静的配信）と ws（/ws/office, /ws/term/:id）を1つのHTTPサーバーで扱う。
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

import {
  buildOfficeState,
  watchProjects,
  detectSpeechSignal,
  type LiveStatusProvider,
} from "./scanner.js";
import { TerminalManager, type SessionStatus } from "./terminal.js";
import { createProject } from "./projects.js";
import { loadSettings, saveSettings } from "./settings.js";
import { appendCustomTitle } from "./rename.js";
import { UsageMonitor } from "./usageMonitor.js";
import type {
  OfficeSettings,
  OfficeState,
  OfficeWsMessage,
  TermClientMessage,
  UsageInfo,
} from "../../shared/types.js";

// バインド先（DESIGN.md: 127.0.0.1のみ）
const HOST = "127.0.0.1";
const PORT = 3777;
// office WS配信のデバウンス（DESIGN.md: 1秒）
const OFFICE_DEBOUNCE_MS = 1000;
// ステータス差分パッチ配信の間隔（メモリ上のスナップショット比較のみ。ファイルI/Oゼロ）
const STATUS_POLL_MS = 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- pty管理 & ライブ状態プロバイダ ----
const terminals = new TerminalManager();
const liveProvider: LiveStatusProvider = {
  hasLiveTerminal: (sid) => terminals.hasLiveTerminal(sid),
  liveStatus: (sid) => terminals.liveStatus(sid),
};

// ---- 使用量チェック専用ptyの管理（TerminalManagerとは完全に独立） ----
const usageMonitor = new UsageMonitor();

/** 現在のOfficeStateを構築する（scanner + ライブpty状態） */
function currentState(): OfficeState {
  return buildOfficeState(liveProvider);
}

// ---- Express（REST）----
const app = express();
app.use(express.json());

// GET /api/office → OfficeState
app.get("/api/office", (_req, res) => {
  res.json(currentState());
});

// PUT /api/settings → OfficeSettingsを保存し、更新後のOfficeStateを返す。
// 既存設定とマージして保存する（クライアントが知らない新フィールドの消失を防ぐ）。
app.put("/api/settings", (req, res) => {
  const body = req.body as Partial<OfficeSettings>;
  const { settings: existing } = loadSettings();
  const settings: OfficeSettings = {
    visibleDepartments: Array.isArray(body.visibleDepartments)
      ? body.visibleDepartments
      : existing.visibleDepartments,
    pinnedSessions: Array.isArray(body.pinnedSessions)
      ? body.pinnedSessions
      : existing.pinnedSessions,
    departmentAliases: isStringRecord(body.departmentAliases)
      ? body.departmentAliases
      : existing.departmentAliases,
    employeeNotes: isStringRecord(body.employeeNotes)
      ? body.employeeNotes
      : existing.employeeNotes,
    roomOrder: isStringArray(body.roomOrder)
      ? body.roomOrder
      : existing.roomOrder,
  };
  saveSettings(settings);
  const state = currentState();
  res.json(state);
  // 表示設定変更は他クライアントにも反映
  broadcastOffice();
});

// POST /api/projects → 新規プロジェクト作成、更新後のOfficeStateを返す
app.post("/api/projects", (req, res) => {
  const { name, purpose } = req.body ?? {};
  const result = createProject(name, purpose);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  // 新規部署を表示ONにする（settings.jsonのvisibleに追加）
  try {
    const { settings } = loadSettings();
    const deptId = result.cwd.replace(/\//g, "-");
    if (!settings.visibleDepartments.includes(deptId)) {
      settings.visibleDepartments.push(deptId);
      saveSettings(settings);
    }
  } catch {
    // 設定更新失敗は致命的ではない
  }
  res.json(currentState());
  broadcastOffice();
});

// GET /api/usage → UsageInfo（使用量チェック専用ptyの直近取得結果）
app.get("/api/usage", (_req, res) => {
  res.json(usageMonitor.getUsage());
});

// POST /api/hire → body:{departmentId} 新規雇用、terminalIdを返す
app.post("/api/hire", (req, res) => {
  const { departmentId } = req.body ?? {};
  const cwd = departmentCwd(departmentId);
  if (!cwd) {
    res.status(400).json({ error: "部署が見つかりません" });
    return;
  }
  const terminalId = terminals.hire(cwd);
  res.json({ terminalId });
});

// POST /api/terminal → body:{departmentId, sessionId} resume接続、terminalIdを返す
app.post("/api/terminal", (req, res) => {
  const { departmentId, sessionId } = req.body ?? {};
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    res.status(400).json({ error: "sessionIdが必要です" });
    return;
  }
  const cwd = departmentCwd(departmentId);
  if (!cwd) {
    res.status(400).json({ error: "部署が見つかりません" });
    return;
  }
  const terminalId = terminals.resume(cwd, sessionId);
  res.json({ terminalId });
});

// DELETE /api/terminal/:terminalId → ptyを終了（退勤）
app.delete("/api/terminal/:terminalId", (req, res) => {
  const ok = terminals.kill(req.params.terminalId);
  if (!ok) {
    res.status(404).json({ error: "ターミナルが見つかりません" });
    return;
  }
  res.json({ ok: true });
});

/** 値がRecord<string,string>かの簡易判定（PUT系のbody検証用） */
function isStringRecord(v: unknown): v is Record<string, string> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (val) => typeof val === "string"
  );
}

/** 値が「全要素がstringの配列」かの簡易判定（PUT系のbody検証用） */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

// PUT /api/departments/:departmentId/alias → 部署の表示名エイリアス設定（空文字で解除）
app.put("/api/departments/:departmentId/alias", (req, res) => {
  const departmentId = req.params.departmentId;
  const alias = (req.body ?? {}).alias;
  if (typeof alias !== "string") {
    res.status(400).json({ error: "aliasは文字列で指定してください" });
    return;
  }
  const { settings } = loadSettings();
  if (alias.length === 0) {
    // 空文字は解除（元のフォルダ名表示に戻す）
    delete settings.departmentAliases[departmentId];
  } else {
    settings.departmentAliases[departmentId] = alias;
  }
  saveSettings(settings);
  res.json(currentState());
  broadcastOffice();
});

// PUT /api/employees/:sessionId/note → 従業員の進捗メモ設定（空文字で解除）
app.put("/api/employees/:sessionId/note", (req, res) => {
  const sessionId = req.params.sessionId;
  const note = (req.body ?? {}).note;
  if (typeof note !== "string") {
    res.status(400).json({ error: "noteは文字列で指定してください" });
    return;
  }
  const { settings } = loadSettings();
  if (note.length === 0) {
    // 空文字は解除
    delete settings.employeeNotes[sessionId];
  } else {
    settings.employeeNotes[sessionId] = note;
  }
  saveSettings(settings);
  res.json(currentState());
  broadcastOffice();
});

// POST /api/sessions/:sessionId/title → セッションの実名リネーム
// （JSONLへcustom-title行をappend専用で追記。既存行は書き換えない）
app.post("/api/sessions/:sessionId/title", (req, res) => {
  const sessionId = req.params.sessionId;
  const { departmentId, title } = req.body ?? {};
  const result = appendCustomTitle(departmentId, sessionId, title);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
  // mtime変化でchokidarも発火するが、確実に反映するため明示的にも配信する
  broadcastOffice();
});

// production時は dist/（viteビルド成果物）を静的配信する
if (process.env.NODE_ENV === "production") {
  const distDir = path.resolve(__dirname, "..", "..", "dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPAフォールバック（API/WS以外はindex.htmlへ）
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }
}

/**
 * departmentIdから起動用cwdを求める。
 * 現在のOfficeStateに存在する部署のcwdを引く。
 * cwdが空（履歴からcwd不明）な部署はhire/resumeできない。
 */
function departmentCwd(departmentId: unknown): string | null {
  if (typeof departmentId !== "string") return null;
  const state = currentState();
  const dept = state.departments.find((d) => d.id === departmentId);
  if (!dept || !dept.cwd) return null;
  return dept.cwd;
}

// ---- HTTPサーバー + WebSocket ----
const server = http.createServer(app);

// WSは手動アップグレードで /ws/office と /ws/term/:id を振り分ける
const officeWss = new WebSocketServer({ noServer: true });
const termWss = new WebSocketServer({ noServer: true });

// office WSの購読クライアント集合
const officeClients = new Set<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  if (url === "/ws/office") {
    officeWss.handleUpgrade(req, socket, head, (ws) => {
      officeWss.emit("connection", ws, req);
    });
  } else if (url.startsWith("/ws/term/")) {
    termWss.handleUpgrade(req, socket, head, (ws) => {
      // URLからterminalIdを取り出して渡す
      const terminalId = decodeURIComponent(url.slice("/ws/term/".length));
      (ws as any)._terminalId = terminalId;
      termWss.emit("connection", ws, req);
    });
  } else {
    // 未知のWSパスは破棄
    socket.destroy();
  }
});

// office WS: 接続時に現在stateを1回送信し、以後は差分配信を受け取る
officeWss.on("connection", (ws: WebSocket) => {
  officeClients.add(ws);
  sendOfficeState(ws, currentState());
  sendUsage(ws, usageMonitor.getUsage());
  ws.on("close", () => officeClients.delete(ws));
  ws.on("error", () => officeClients.delete(ws));
});

// term WS: 指定terminalIdのptyへ接続。入出力を仲介する
termWss.on("connection", (ws: WebSocket) => {
  const terminalId: string = (ws as any)._terminalId;
  const attached = terminals.attachClient(terminalId, ws);
  if (!attached) {
    // 端末が存在しない → exitを送って閉じる
    ws.send(JSON.stringify({ type: "exit", code: -1 }));
    ws.close();
    return;
  }

  ws.on("message", (raw) => {
    let msg: TermClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input") {
      terminals.write(terminalId, msg.data);
    } else if (msg.type === "resize") {
      terminals.resize(terminalId, msg.cols, msg.rows);
    }
  });

  ws.on("close", () => terminals.detachClient(terminalId, ws));
  ws.on("error", () => terminals.detachClient(terminalId, ws));
});

/** 1つのoffice WSへstateメッセージを送る */
function sendOfficeState(ws: WebSocket, state: OfficeState): void {
  if (ws.readyState !== 1) return;
  const msg: OfficeWsMessage = { type: "state", state };
  ws.send(JSON.stringify(msg));
}

/** 1つのoffice WSへusageメッセージを送る */
function sendUsage(ws: WebSocket, usage: UsageInfo): void {
  if (ws.readyState !== 1) return;
  const msg: OfficeWsMessage = { type: "usage", usage };
  ws.send(JSON.stringify(msg));
}

/** 使用量の更新を購読中の全office WSへ配信する */
function broadcastUsage(usage: UsageInfo): void {
  if (officeClients.size === 0) return;
  const msg: OfficeWsMessage = { type: "usage", usage };
  const payload = JSON.stringify(msg);
  for (const ws of officeClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ---- 承認待ち・完了報告の吹き出し ----
// sessionId → 直前に配信済みのsignature（同一APIターンへの重複配信を防ぐ。
// サーバー再起動でリセットされるが、chokidarはignoreInitial:trueのため
// 起動直後の既存ファイルでは発火せず、再起動直後にフラッド配信される心配はない）
const lastSpeechSignature = new Map<string, string>();

function checkAndBroadcastSpeech(filePath: string): void {
  const sessionId = path.basename(filePath, ".jsonl");
  const signal = detectSpeechSignal(filePath);
  if (!signal) return;
  if (lastSpeechSignature.get(sessionId) === signal.signature) return;
  lastSpeechSignature.set(sessionId, signal.signature);
  broadcastSpeech(sessionId, signal.kind, signal.text);
}

function broadcastSpeech(
  sessionId: string,
  kind: "permission" | "done",
  text: string
): void {
  if (officeClients.size === 0) return;
  const msg: OfficeWsMessage = { type: "speech", sessionId, kind, text };
  const payload = JSON.stringify(msg);
  for (const ws of officeClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ---- office state配信（デバウンス） ----
let debounceTimer: NodeJS.Timeout | null = null;

/** office stateを購読クライアント全員へ配信する（デバウンス付き） */
function broadcastOffice(): void {
  if (debounceTimer) return; // すでに配信予約済み
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (officeClients.size === 0) return;
    const state = currentState();
    for (const ws of officeClients) {
      sendOfficeState(ws, state);
    }
  }, OFFICE_DEBOUNCE_MS);
}

// ---- hire → sessionBound の紐づけ ----
// 直前スキャンで見えていたsessionIdの集合。新規.jsonl検知に使う。
let knownSessionIds = new Set<string>();

/** 現在のstateから全sessionId集合を作る */
function collectSessionIds(state: OfficeState): Set<string> {
  const ids = new Set<string>();
  for (const dept of state.departments) {
    for (const e of dept.employees) ids.add(e.sessionId);
    for (const e of dept.alumni) ids.add(e.sessionId);
  }
  return ids;
}

/**
 * scanの度に呼ぶ。新規に出現したsessionIdがあれば、
 * まず未確定(hire中)の端末のうち同じcwdのものへ紐づける。
 * 未確定端末が無ければ、/clear等で同一ptyのセッションが切り替わった
 * ケースとみなし、直近出力があった同cwdのbind済み端末を付け替える。
 */
function reconcileHires(state: OfficeState): void {
  const nowIds = collectSessionIds(state);
  const unbound = terminals.getUnboundTerminals();
  // 新規sessionIdを探す
  for (const dept of state.departments) {
    for (const e of dept.employees) {
      if (knownSessionIds.has(e.sessionId)) continue;

      // 1. hire直後の未確定端末があれば従来通り紐づける
      const match = unbound.find((u) => u.cwd === dept.cwd);
      if (match) {
        terminals.bindSession(match.terminalId, e.sessionId);
        const idx = unbound.indexOf(match);
        if (idx >= 0) unbound.splice(idx, 1);
        continue;
      }

      // 2. 未確定端末が無い場合、/clear等によるセッション切り替えとみなし、
      //    同じcwdで直近出力のあった既存端末を新sessionIdへ付け替える
      const rebindTarget = terminals.findRecentBoundTerminal(
        dept.cwd,
        e.sessionId
      );
      if (rebindTarget) {
        terminals.rebindSession(rebindTarget.terminalId, e.sessionId);
      }
    }
  }
  knownSessionIds = nowIds;
}

// ---- 起動処理 ----
function start(): void {
  // hireで新規sessionId確定時はoffice stateを再配信
  terminals.setSessionBoundHandler(() => broadcastOffice());

  // 使用量チェック専用ptyを起動（値が更新される度にWSへ配信）
  usageMonitor.setUpdateHandler((usage) => broadcastUsage(usage));
  usageMonitor.start();

  // 初期スキャンでknownSessionIdsを埋める
  const initial = currentState();
  knownSessionIds = collectSessionIds(initial);

  // chokidarで *.jsonl を監視 → 変化時に hire紐づけ + 配信 + 吹き出しシグナル検知
  watchProjects((event, filePath) => {
    const state = currentState();
    reconcileHires(state);
    broadcastOffice();
    if ((event === "add" || event === "change") && filePath.endsWith(".jsonl")) {
      checkAndBroadcastSpeech(filePath);
    }
  });

  // ステータス変化（working→waiting等）の検知は、メモリ上のptyスナップショット
  // 同士の比較だけで行う（ファイルI/Oゼロ。毎秒の全JSONLスキャンは廃止）。
  // 変化分だけを軽量な status 差分パッチとして /ws/office へ配信する。
  let lastSnapshot: Map<string, SessionStatus> = terminals.statusSnapshot();
  setInterval(() => {
    const snapshot = terminals.statusSnapshot();
    const updates: {
      sessionId: string;
      status: SessionStatus["status"];
      hasLiveTerminal: boolean;
    }[] = [];

    // 追加・変化したセッション
    for (const [sessionId, cur] of snapshot) {
      const prev = lastSnapshot.get(sessionId);
      if (
        !prev ||
        prev.status !== cur.status ||
        prev.hasLiveTerminal !== cur.hasLiveTerminal
      ) {
        updates.push({
          sessionId,
          status: cur.status,
          hasLiveTerminal: cur.hasLiveTerminal,
        });
      }
    }
    // 消滅したセッション（pty終了）はrestingとして通知
    for (const sessionId of lastSnapshot.keys()) {
      if (!snapshot.has(sessionId)) {
        updates.push({
          sessionId,
          status: "resting",
          hasLiveTerminal: false,
        });
      }
    }

    lastSnapshot = snapshot;
    if (updates.length > 0) {
      broadcastStatusPatch(updates);
    }
  }, STATUS_POLL_MS);

  server.listen(PORT, HOST, () => {
    console.log(`[claude-office] server listening on http://${HOST}:${PORT}`);
  });
}

/** ステータス差分パッチを購読中の全office WSへ即時配信する（デバウンス不要の軽量メッセージ） */
function broadcastStatusPatch(
  updates: Extract<OfficeWsMessage, { type: "status" }>["updates"]
): void {
  if (officeClients.size === 0) return;
  const msg: OfficeWsMessage = { type: "status", updates };
  const payload = JSON.stringify(msg);
  for (const ws of officeClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

start();
