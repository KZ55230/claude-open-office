// サーバー・クライアント間で共有する型定義（この契約を変更する場合はDESIGN.mdも更新すること）

/** 従業員（＝Claude Codeのセッション）のステータス */
export type EmployeeStatus = "working" | "waiting" | "resting";
// working: ターミナル稼働中でClaudeが出力中（🟢 作業中）
// waiting: ターミナル稼働中だが5秒以上出力がない＝指示待ち（🟡 返事待ち）
// resting: ターミナル未接続（⚪ 休憩中）

export interface Employee {
  sessionId: string;
  /** sessionIdのハッシュから決定的に生成する日本人の姓（例：佐藤） */
  name: string;
  /** 見た目のバリエーション用シード（sessionIdハッシュ由来の整数） */
  spriteSeed: number;
  status: EmployeeStatus;
  /** 最終活動日時（ISO 8601） */
  lastActiveAt: string;
  /** 掲示板・ツールチップ用の直近の作業内容（transcriptのsummary行または最後のメッセージ抜粋、最大120文字） */
  summary: string;
  /** ptyが稼働中かどうか（ターミナル未表示でも裏で働いている場合true） */
  hasLiveTerminal: boolean;
  /** セッション名（custom-title > ai-title の優先で取得。無ければ空文字） */
  title: string;
  /** 直近のassistant発言から自動抽出した進捗（現在何をしている/したか）。無ければ空文字 */
  progress: string;
  /** セッションが動作しているgitブランチ。取得できなければ空文字 */
  gitBranch: string;
}

// ---- セッション蒸留（Skill改善候補の自動抽出） ----

export interface DistillResult {
  sessionId: string;
  title: string;
  gitBranch: string;
  summary: string;
  /** 使用されたツール名の一覧（重複除去・使用頻度の高い順） */
  toolsUsed: string[];
  /** Read/Edit/Write等で参照されたファイルパス（重複除去） */
  filesReferenced: string[];
  /** 注目すべきassistant発言の抜粋（最大3件） */
  keyDecisions: string[];
  /** .claude/skills/ に追記できるMarkdownテンプレート */
  skillTemplate: string;
}

export type DepartmentType = "project";

export interface Department {
  /** ~/.claude/projects配下のディレクトリ名をIDとして使う */
  id: string;
  /** 表示名（プロジェクトフォルダ名。例：KIZUNA、slide-md） */
  name: string;
  /** プロジェクトの実フォルダの絶対パス（cwd） */
  cwd: string;
  type: DepartmentType;
  /** 表示対象の従業員（直近活動順、最大8人） */
  employees: Employee[];
  /** OB名簿（表示枠から外れた古いセッション） */
  alumni: Employee[];
  /** 島の数：従業員1〜4人=1島、5人以上=2島 */
  islands: 1 | 2;
}

export interface OfficeSettings {
  /** 表示する部署のID一覧 */
  visibleDepartments: string[];
  /** OB名簿から呼び戻して表示枠に固定したセッションID */
  pinnedSessions: string[];
  /** 部署ID → 表示名エイリアス（実フォルダ名は変更しない） */
  departmentAliases: Record<string, string>;
  /** sessionId → ユーザー手動の進捗メモ */
  employeeNotes: Record<string, string>;
  /**
   * 部屋の並び順（部署IDの配列）。模様替えモードのドラッグ交換で更新される。
   * リストに無い部署は末尾（ID昇順）に続く。
   */
  roomOrder: string[];
  /**
   * 新規プロジェクトの作成先・空フォルダ自動検出の対象フォルダ（絶対パス）。
   * Claude Code自体には「プロジェクトフォルダの既定値」という概念が無いため、
   * 未設定（null）が初期値。未設定の間は「新規プロジェクト立案」機能は使えない。
   */
  projectsRoot: string | null;
}

export interface OfficeState {
  departments: Department[];
  settings: OfficeSettings;
}

// ---- 使用量（/usage コマンドの内部監視結果） ----

export interface UsageInfo {
  /** 直近セッション（5時間ウィンドウ、Claude CLIの"Current session"）の使用率(0-100)。未取得ならnull */
  sessionPercent: number | null;
  /** 週次（全モデル、"Current week (all models)"）の使用率(0-100)。未取得ならnull */
  weekPercent: number | null;
  /** 最終更新時刻（ISO 8601）。一度も取得できていなければ空文字 */
  updatedAt: string;
}

// ---- REST API ----
// GET  /api/office                  → OfficeState
// PUT  /api/settings                → body: OfficeSettings、戻り: OfficeState（サーバー側で既存設定とマージ）
// POST /api/projects                → body: { name: string, purpose: string }、戻り: OfficeState（新部署追加済み）
//   settings.projectsRoot が未設定（null）の場合は400エラー
//   （「まずプロジェクトの保存先フォルダを設定してください」という趣旨のエラーメッセージを返す）
// GET  /api/usage                   → UsageInfo（使用量チェック専用ptyの直近取得結果）
// POST /api/hire                    → body: { departmentId: string }、戻り: { terminalId: string }
// POST /api/terminal                → body: { departmentId: string, sessionId: string }、戻り: { terminalId: string }（resume接続）
// DELETE /api/terminal/:terminalId  → ptyを終了（退勤）
// PUT  /api/departments/:departmentId/alias → body: { alias: string }（空文字で解除）、戻り: OfficeState
// PUT  /api/employees/:sessionId/note       → body: { note: string }（空文字で解除）、戻り: OfficeState
// POST /api/sessions/:sessionId/title       → body: { departmentId: string, title: string }、戻り: { ok: true }
//   （~/.claude/projects/<departmentId>/<sessionId>.jsonl へ custom-title 行を追記する。append専用）
// GET  /api/sessions/:sessionId/distill?departmentId=... → DistillResult（Skill改善候補の抽出）

// ---- WebSocket ----
// /ws/office : サーバー→クライアントへOfficeStateの更新を配信
export type OfficeWsMessage =
  | { type: "state"; state: OfficeState }
  /** ターミナル稼働状況だけの軽量な差分パッチ（全体stateの再構築なしで毎秒配信可能） */
  | {
      type: "status";
      updates: {
        sessionId: string;
        status: EmployeeStatus;
        hasLiveTerminal: boolean;
      }[];
    }
  /** 使用量チェック専用ptyが/usageを解析した結果（値が更新される度に配信） */
  | { type: "usage"; usage: UsageInfo }
  /** 承認待ち・完了報告の吹き出し表示（同一APIターンにつき1回だけ配信） */
  | { type: "speech"; sessionId: string; kind: "permission" | "done"; text: string };

// /ws/term/:terminalId : ターミナル入出力（双方向）
export type TermClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };
export type TermServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number }
  /** hire直後、新しいsessionIdが確定したときに通知（入社演出のトリガー） */
  | { type: "sessionBound"; sessionId: string };
