// セッションの実名リネームモジュール。
// ~/.claude/projects/<departmentId>/<sessionId>.jsonl へ custom-title 行を「追記のみ」で書き込む。
// これはClaude Code自身がセッション名変更に使う正式形式（実データで確認済み）。
// 既存行は絶対に書き換えない。
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS_DIR } from "./paths.js";

// sessionIdはUUID形式のみ許可（パス操作の入口なので厳格に検証する）
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// titleの最大文字数
const TITLE_MAX = 100;

/** 追記の成否 */
export type RenameResult = { ok: true } | { ok: false; error: string };

/**
 * セッションのJSONLファイル末尾へ custom-title 行を追記する。
 *  - sessionId: UUID形式を検証
 *  - departmentId: パス区切り文字・「..」を拒否し、正規化後も
 *    CLAUDE_PROJECTS_DIR 配下に収まることを確認（パストラバーサル防止）
 *  - title: 1〜100文字・改行禁止
 *  - ファイル末尾が改行で終わっていなければ "\n" を前置してから追記する
 *    （既存の最終行を壊さないため）
 */
export function appendCustomTitle(
  departmentId: unknown,
  sessionId: unknown,
  title: unknown
): RenameResult {
  // --- sessionId検証 ---
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    return { ok: false, error: "sessionIdの形式が不正です" };
  }

  // --- departmentId検証（ディレクトリ名として安全なことを確認） ---
  if (
    typeof departmentId !== "string" ||
    departmentId.length === 0 ||
    departmentId.includes("/") ||
    departmentId.includes("\\") ||
    departmentId.includes("..")
  ) {
    return { ok: false, error: "departmentIdが不正です" };
  }

  // --- title検証（1〜100文字・改行禁止） ---
  if (
    typeof title !== "string" ||
    title.length < 1 ||
    title.length > TITLE_MAX ||
    /[\r\n]/.test(title)
  ) {
    return {
      ok: false,
      error: `titleは改行を含まない1〜${TITLE_MAX}文字で指定してください`,
    };
  }

  // --- 対象パスの正規化と配下検証 ---
  const target = path.resolve(
    CLAUDE_PROJECTS_DIR,
    departmentId,
    `${sessionId}.jsonl`
  );
  const root = path.resolve(CLAUDE_PROJECTS_DIR);
  if (!target.startsWith(root + path.sep)) {
    return { ok: false, error: "対象パスが不正です" };
  }

  // --- 対象ファイルの存在確認 ---
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, error: "対象のセッションファイルが見つかりません" };
  }
  if (!stat.isFile()) {
    return { ok: false, error: "対象がファイルではありません" };
  }

  // --- 末尾改行チェック（最終バイトだけ読む。巨大ファイルでも軽量） ---
  let needsLeadingNewline = false;
  if (stat.size > 0) {
    try {
      const fd = fs.openSync(target, "r");
      try {
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, stat.size - 1);
        needsLeadingNewline = buf[0] !== 0x0a; // "\n"
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { ok: false, error: "ファイル末尾の確認に失敗しました" };
    }
  }

  // --- custom-title行の組み立てと追記（既存行は絶対に書き換えない） ---
  const line =
    JSON.stringify({
      type: "custom-title",
      customTitle: title,
      sessionId,
    }) + "\n";
  try {
    fs.appendFileSync(target, (needsLeadingNewline ? "\n" : "") + line, "utf8");
  } catch (e) {
    return {
      ok: false,
      error: `追記に失敗しました: ${(e as Error).message}`,
    };
  }

  return { ok: true };
}
