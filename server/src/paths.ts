// パス関連のユーティリティとセキュリティ検証をまとめたモジュール
import os from "node:os";
import path from "node:path";

/** ホームディレクトリの絶対パス（例: /home/shoai090925） */
export const HOME = os.homedir();

/** Claude Codeのセッション履歴が置かれるディレクトリ（~/.claude/projects） */
export const CLAUDE_PROJECTS_DIR = path.join(HOME, ".claude", "projects");

/**
 * 使用量チェック専用ptyのcwd。新規ディレクトリを使うと新しい部署が
 * 作られてしまうため、既存の部署cwd（このアプリ自身のリポジトリ＝サーバーの
 * 実行ディレクトリ）を使う。クローン先のフォルダ名に依存しないよう、
 * 固定のフォルダ名ではなく実際にサーバーが起動されたディレクトリを使う。
 */
export const USAGE_PROBE_CWD = process.cwd();

/** サーバーが設定を保存するファイル（config/settings.json） */
export const SETTINGS_FILE = path.join(
  process.cwd(),
  "config",
  "settings.json"
);

/**
 * 与えられたパスが projectsRoot 配下に収まっているかを検証する。
 * パストラバーサル（../ など）による外部アクセスを防ぐためのセキュリティ関門。
 * projectsRoot はユーザーが設定画面で指定する絶対パス（settings.projectsRoot）。
 * @returns 収まっていれば正規化した絶対パス、そうでなければ null
 */
export function resolveInsideProjectsRoot(
  target: string,
  projectsRoot: string
): string | null {
  // 絶対パスへ正規化（. や .. を解決）
  const resolved = path.resolve(target);
  const root = path.resolve(projectsRoot);
  // ルート自身、またはルート + セパレータで始まる場合のみ許可
  if (resolved === root || resolved.startsWith(root + path.sep)) {
    return resolved;
  }
  return null;
}

/**
 * projectsRoot として妥当な絶対パスかを検証する。
 * 不正な形式（相対パス・空文字）ならnullを返す。
 * @returns 正規化した絶対パス、または不正ならnull
 */
export function normalizeProjectsRoot(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}
