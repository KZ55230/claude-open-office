// ~/.claude/projects を走査してOfficeStateを構築し、chokidarで差分更新するモジュール
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { CLAUDE_PROJECTS_DIR } from "./paths.js";
import { nameFromSessionId, spriteSeedFromSessionId } from "./names.js";
import { loadSettings, saveSettings } from "./settings.js";
import type {
  Department,
  DepartmentType,
  Employee,
  EmployeeStatus,
  OfficeSettings,
  OfficeState,
} from "../../shared/types.js";

// 部署ごとの表示枠の上限人数（DESIGN.md: 最大8人）
const MAX_EMPLOYEES = 8;
// 初回起動時に自動で表示ONにする通常プロジェクト数（DESIGN.md: 上位6部署）
const DEFAULT_VISIBLE_PROJECT_COUNT = 6;
// summaryの最大文字数
const SUMMARY_MAX = 120;
// 吹き出しに表示するテキストの最大文字数
const SPEECH_TEXT_MAX = 60;

/** 直近の構造的シグナル（承認待ち／完了報告）の検知結果 */
export interface SpeechDetectionResult {
  kind: "permission" | "done";
  text: string;
  /** 重複排除キー（同じassistantターンに対して2回配信しないための識別子） */
  signature: string;
}

/** JSONLから抽出したセッションの生情報（部署構築前の中間表現） */
interface RawSession {
  sessionId: string;
  cwd: string | null; // JSONL内のcwd（無い場合あり）
  lastActiveAt: number; // mtime(ms)
  lastActiveIso: string; // mtimeのISO文字列
  summary: string;
  /** セッション名（custom-title > ai-title 優先。無ければ空文字） */
  title: string;
  /** 直近のassistant発言から自動抽出した進捗（現在何をしている/したか）。無ければ空文字 */
  progress: string;
  /** 承認待ち／完了報告の検知結果。どちらでもなければnull */
  speech: SpeechDetectionResult | null;
}

/**
 * ファイル単位の解析キャッシュ。
 * mtime+sizeが一致する限りread/parseをスキップして解析結果を再利用する。
 * 毎回の全スキャンでのファイルI/Oを激減させる性能改善の柱。
 */
const sessionCache = new Map<
  string,
  { mtimeMs: number; size: number; raw: RawSession }
>();

/**
 * ライブ状態プロバイダ。terminal.ts側が保持するpty状態を注入するための関数群。
 * scannerは自分でptyを持たないので、状態判定をコールバックで受け取る。
 */
export interface LiveStatusProvider {
  /** そのsessionIdにひもづくptyが稼働しているか */
  hasLiveTerminal(sessionId: string): boolean;
  /** ライブptyのステータス（working/waiting）。未稼働ならnull */
  liveStatus(sessionId: string): EmployeeStatus | null;
}

/**
 * JSONLファイルを1行ずつtry-parseして、そのファイル（=1セッション）の
 * cwdとsummaryを抽出する。行単位で壊れていても他行から復旧する。
 */
function extractSession(filePath: string): RawSession | null {
  const sessionId = path.basename(filePath, ".jsonl");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // ファイル消滅時はキャッシュも掃除する
    sessionCache.delete(filePath);
    return null;
  }

  // キャッシュヒット判定: mtime+sizeが一致すればread/parseをスキップ
  const cached = sessionCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.raw;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    sessionCache.delete(filePath);
    return null;
  }

  const lines = content.split("\n");
  let cwd: string | null = null;

  // summary候補（優先度順）:
  //  1) 末尾から遡って type:"summary" 行の summary フィールド
  //  2) type:"ai-title" 行の aiTitle（このJSONL形式の要約に相当）
  //  3) 最後のuser/assistantメッセージのテキスト
  let summaryFromSummaryLine: string | null = null;
  let aiTitle: string | null = null;
  let lastMessageText: string | null = null;
  // セッション名（ユーザーが付けた実名）: custom-title行。ファイル内で最後の行が勝ち
  let customTitle: string | null = null;

  // 承認待ち／完了報告の検知用（直近のassistant APIターンの状態を追跡する）。
  // 1回のAPIターンはthinking/text/tool_useが複数行に分かれて記録されるため、
  // 同一message.idの間は状態を積み上げ、新しいmessage.idが来たらリセットする。
  let lastAssistantMessageId: string | null = null;
  let lastAssistantStopReason: string | null = null;
  let lastAssistantTexts: string[] = [];
  const pendingToolUses = new Map<string, { name: string; input: unknown }>();
  // 進捗欄の自動生成用：ターンのリセットに関わらず「最後に見つかったassistantのテキスト」を保持する
  let lastAssistantOnlyText: string | null = null;

  // 末尾から遡ると効率的だが、cwdは前方の行にしか無いこともあるため
  // 全行を1回走査して各候補を集める。summary/ai-title/custom-titleは「最も後ろ」を採用。
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // 壊れた行はスキップ
      continue;
    }

    if (!cwd && typeof obj.cwd === "string" && obj.cwd.length > 0) {
      cwd = obj.cwd;
    }

    if (obj.type === "summary" && typeof obj.summary === "string") {
      summaryFromSummaryLine = obj.summary;
    } else if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
      aiTitle = obj.aiTitle;
    } else if (
      obj.type === "custom-title" &&
      typeof obj.customTitle === "string"
    ) {
      customTitle = obj.customTitle;
    } else if (obj.type === "assistant") {
      const msg = obj.message;
      const mid = typeof msg?.id === "string" ? msg.id : null;
      if (mid && mid !== lastAssistantMessageId) {
        // 新しいAPIターンの開始：前ターンの追跡状態をリセット
        lastAssistantMessageId = mid;
        lastAssistantStopReason = null;
        lastAssistantTexts = [];
        pendingToolUses.clear();
      }
      if (typeof msg?.stop_reason === "string") {
        lastAssistantStopReason = msg.stop_reason;
      }
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && typeof b.text === "string") {
            lastAssistantTexts.push(b.text);
            lastAssistantOnlyText = b.text;
          } else if (b.type === "tool_use" && typeof b.id === "string") {
            pendingToolUses.set(b.id, { name: b.name, input: b.input });
          }
        }
      }
      const text = extractMessageText(msg);
      if (text) lastMessageText = text;
    } else if (obj.type === "user") {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "tool_result" && typeof b.tool_use_id === "string") {
            pendingToolUses.delete(b.tool_use_id);
          }
        }
      }
      const text = extractMessageText(obj.message);
      if (text) lastMessageText = text;
    }
  }

  const summaryRaw =
    summaryFromSummaryLine ?? aiTitle ?? lastMessageText ?? "";
  const summary = truncate(summaryRaw.replace(/\s+/g, " ").trim(), SUMMARY_MAX);

  // 進捗：直近のassistant発言（「今何をしたか」）を自動抽出する
  const progress = lastAssistantOnlyText
    ? truncate(lastAssistantOnlyText.replace(/\s+/g, " ").trim(), SUMMARY_MAX)
    : "";

  // 直近assistantターンの状態からspeech（承認待ち／完了報告）を判定する
  let speech: SpeechDetectionResult | null = null;
  if (lastAssistantMessageId) {
    if (lastAssistantStopReason === "tool_use" && pendingToolUses.size > 0) {
      speech = {
        kind: "permission",
        text: describeToolWait(pendingToolUses),
        signature: `${lastAssistantMessageId}:permission`,
      };
    } else if (
      lastAssistantStopReason === "end_turn" &&
      lastAssistantTexts.length > 0
    ) {
      const text = truncate(
        lastAssistantTexts.join(" ").replace(/\s+/g, " ").trim(),
        SPEECH_TEXT_MAX
      );
      if (text) {
        speech = { kind: "done", text, signature: `${lastAssistantMessageId}:done` };
      }
    }
  }

  const raw: RawSession = {
    sessionId,
    cwd,
    lastActiveAt: stat.mtimeMs,
    lastActiveIso: stat.mtime.toISOString(),
    summary,
    // セッション名: custom-title（実名）優先、無ければai-title、どちらも無ければ空
    title: customTitle ?? aiTitle ?? "",
    progress,
    speech,
  };

  // 解析結果をキャッシュへ保存（次回スキャンで再利用）
  sessionCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    raw,
  });

  return raw;
}

/** message.content（string または ブロック配列）からテキストを取り出す */
function extractMessageText(message: any): string | null {
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    // text ブロックを優先して連結
    const texts = content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
    if (texts.length > 0) return texts.join(" ");
    // tool_result の文字列コンテンツをフォールバック
    for (const b of content) {
      if (b && b.type === "tool_result" && typeof b.content === "string") {
        return b.content;
      }
    }
  }
  return null;
}

/** 文字列を最大長で切る（超過時は末尾に … を付ける） */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** ツール実行待ちの説明文を作る。inputのdescription（人間向け説明）があれば優先する */
function describeToolWait(
  pending: Map<string, { name: string; input: unknown }>
): string {
  if (pending.size === 1) {
    const [{ name, input }] = [...pending.values()];
    const desc =
      input &&
      typeof (input as Record<string, unknown>).description === "string" &&
      ((input as Record<string, unknown>).description as string).trim()
        ? ((input as Record<string, unknown>).description as string).trim()
        : null;
    return desc ? truncate(desc, SPEECH_TEXT_MAX) : `${name} の実行の承認待ち`;
  }
  return `${pending.size}件のツール実行の承認待ち`;
}

/** ディレクトリ内の *.jsonl からRawSession配列を作る */
function scanProjectDir(dirPath: string): RawSession[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return [];
  }
  const sessions: RawSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const s = extractSession(path.join(dirPath, entry));
    if (s) sessions.push(s);
  }
  return sessions;
}

/** cwdからDepartmentType を判定する（現状は常に"project"）。 */
function departmentType(_cwd: string | null): DepartmentType {
  return "project";
}

/** cwdから表示名（フォルダ名）を得る。取れなければディレクトリID末尾から推測 */
function departmentName(cwd: string | null, dirId: string): string {
  if (cwd) return path.basename(cwd);
  // ディレクトリID（-区切りエンコード）から末尾セグメントを表示名に使う
  const seg = dirId.split("-").filter(Boolean).pop();
  return seg ?? dirId;
}

/** RawSessionをEmployee（表示用）へ変換する */
function toEmployee(
  raw: RawSession,
  live: LiveStatusProvider
): Employee {
  const hasLive = live.hasLiveTerminal(raw.sessionId);
  // ステータス判定: ライブptyがあればworking/waiting、無ければresting
  const liveStatus = hasLive ? live.liveStatus(raw.sessionId) : null;
  const status: EmployeeStatus = liveStatus ?? "resting";
  return {
    sessionId: raw.sessionId,
    name: nameFromSessionId(raw.sessionId),
    spriteSeed: spriteSeedFromSessionId(raw.sessionId),
    status,
    lastActiveAt: raw.lastActiveIso,
    summary: raw.summary,
    hasLiveTerminal: hasLive,
    title: raw.title,
    progress: raw.progress,
  };
}

/**
 * 1部署分のDepartmentを構築する。
 * 直近活動順に並べ、pinnedを優先しつつ最大8人を表示枠(employees)へ、
 * 残りをalumniへ振り分ける。島数は表示人数から算出。
 */
function buildDepartment(
  dirId: string,
  cwd: string | null,
  type: DepartmentType,
  rawSessions: RawSession[],
  pinned: Set<string>,
  live: LiveStatusProvider,
  aliases: Record<string, string>
): Department {
  // 直近活動（mtime）降順にソート
  const sorted = [...rawSessions].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt
  );

  // pinnedを先頭へ寄せる（pinned同士も活動順を維持）
  const pinnedSessions = sorted.filter((s) => pinned.has(s.sessionId));
  const others = sorted.filter((s) => !pinned.has(s.sessionId));
  const ordered = [...pinnedSessions, ...others];

  const shown = ordered.slice(0, MAX_EMPLOYEES);
  const rest = ordered.slice(MAX_EMPLOYEES);

  const employees = shown.map((r) => toEmployee(r, live));
  const alumni = rest.map((r) => toEmployee(r, live));

  // 島数: 1〜4人=1島、5人以上=2島
  const islands: 1 | 2 = employees.length >= 5 ? 2 : 1;

  // 部署名: ユーザー設定のエイリアスがあれば優先（実フォルダ名は変更しない）
  const alias = aliases[dirId];
  return {
    id: dirId,
    name: alias && alias.length > 0 ? alias : departmentName(cwd, dirId),
    cwd: cwd ?? "",
    type,
    employees,
    alumni,
    islands,
  };
}

/**
 * OfficeState全体を構築する。
 * @param live pty状態プロバイダ
 */
export function buildOfficeState(live: LiveStatusProvider): OfficeState {
  const { settings, existed } = loadSettings();
  const pinned = new Set(settings.pinnedSessions);

  // ~/.claude/projects 配下の各ディレクトリを1部署として構築
  let dirIds: string[] = [];
  try {
    dirIds = fs
      .readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    dirIds = [];
  }

  const departments: Department[] = [];

  for (const dirId of dirIds) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirId);
    const rawSessions = scanProjectDir(dirPath);
    // cwdはセッション行から取得（DESIGN.md: ディレクトリ名からは復元しない）
    const cwd = rawSessions.find((s) => s.cwd)?.cwd ?? null;
    const type = departmentType(cwd);
    departments.push(
      buildDepartment(
        dirId,
        cwd,
        type,
        rawSessions,
        pinned,
        live,
        settings.departmentAliases
      )
    );
  }

  // 各部署の「最新活動時刻」を算出（従業員が居ない部署は0）
  const deptLastActive = new Map<string, number>();
  for (const dept of departments) {
    const all = [...dept.employees, ...dept.alumni];
    const latest = all.reduce(
      (max, e) => Math.max(max, Date.parse(e.lastActiveAt) || 0),
      0
    );
    deptLastActive.set(dept.id, latest);
  }

  // セッション履歴がまだ無い実プロジェクトフォルダも空部署として追加する
  // （POST /api/projects 直後のフォルダ等。settings.projectsRoot 直下1階層のみ走査。
  //   未設定の間はこの機能自体をスキップする）
  const knownCwds = new Set(
    departments.map((d) => d.cwd).filter((c) => c.length > 0)
  );
  try {
    if (!settings.projectsRoot) throw new Error("projectsRoot未設定");
    const rootEntries = fs.readdirSync(settings.projectsRoot, {
      withFileTypes: true,
    });
    for (const entry of rootEntries) {
      // 隠しフォルダ（.始まり）とディレクトリ以外はスキップ
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const cwd = path.join(settings.projectsRoot, entry.name);
      if (knownCwds.has(cwd)) continue;
      departments.push(
        buildDepartment(
          virtualDeptId(cwd),
          cwd,
          departmentType(cwd),
          [],
          pinned,
          live,
          settings.departmentAliases
        )
      );
    }
  } catch {
    // projectsRoot未設定・読めない、のいずれでも致命的ではない（単にスキップ）
  }

  // 部署の並び順をID（名前）で固定する。
  // readdirの順序は環境依存で、順序が揺れるとクライアント側で部屋の配置が
  // 大きく引っ越してしまうため、常に決定的な順序で返す。
  departments.sort((a, b) => a.id.localeCompare(b.id, "en"));

  // 初回起動（settings.json無し）なら表示部署の初期値を決める:
  //   直近活動順の上位6プロジェクト
  let effectiveSettings: OfficeSettings = settings;
  if (!existed) {
    const projectDepts = departments
      .filter((d) => d.type === "project")
      .sort(
        (a, b) =>
          (deptLastActive.get(b.id) ?? 0) - (deptLastActive.get(a.id) ?? 0)
      )
      .slice(0, DEFAULT_VISIBLE_PROJECT_COUNT)
      .map((d) => d.id);
    effectiveSettings = {
      visibleDepartments: projectDepts,
      pinnedSessions: [],
      departmentAliases: {},
      employeeNotes: {},
      roomOrder: [],
      projectsRoot: null,
    };
    // 初期設定を永続化しておく（次回以降はexisted=trueになる）
    saveSettings(effectiveSettings);
  }

  return {
    departments,
    settings: effectiveSettings,
  };
}

/**
 * 1ファイル分の直近の構造的シグナル（承認待ち／完了報告）を返す。
 * extractSession()のmtime+sizeキャッシュを再利用するため、直前にbuildOfficeState()が
 * 同一ファイルを処理済みであれば追加のファイルI/Oは発生しない。
 */
export function detectSpeechSignal(filePath: string): SpeechDetectionResult | null {
  const raw = extractSession(filePath);
  return raw?.speech ?? null;
}

/** 実フォルダパスから仮想部署IDを作る（エンコード済みディレクトリ名に合わせる） */
function virtualDeptId(cwd: string): string {
  // ~/.claude/projects のエンコード規則（/ を - に置換）に合わせたID
  return cwd.replace(/\//g, "-");
}

/** chokidarのイベント種別 */
export type ProjectsWatchEvent = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

/**
 * chokidarで ~/.claude/projects 配下の *.jsonl を監視し、
 * 変化があれば onChange を呼ぶ（呼び出し側でデバウンス配信する）。
 * イベント種別とファイルパスを渡すため、呼び出し側は個別ファイルの
 * 差分検知（吹き出しシグナルの再解析など）にそのまま使える。
 * @returns watcherインスタンス（closeで停止）
 */
export function watchProjects(
  onChange: (event: ProjectsWatchEvent, filePath: string) => void
): FSWatcher {
  const watcher = chokidar.watch(CLAUDE_PROJECTS_DIR, {
    // *.jsonl 以外は無視。深さ2まで（<dir>/<session>.jsonl）
    ignored: (targetPath: string, stats?: fs.Stats) => {
      if (stats && stats.isFile()) {
        return !targetPath.endsWith(".jsonl");
      }
      return false;
    },
    ignoreInitial: true, // 起動時の既存ファイル列挙イベントは無視
    depth: 2,
    awaitWriteFinish: {
      // 書き込み中の中間状態を避ける
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on("add", (p) => onChange("add", p));
  watcher.on("change", (p) => onChange("change", p));
  watcher.on("unlink", (p) => onChange("unlink", p));
  watcher.on("addDir", (p) => onChange("addDir", p));
  watcher.on("unlinkDir", (p) => onChange("unlinkDir", p));

  return watcher;
}
