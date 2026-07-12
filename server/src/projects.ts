// 新規プロジェクト作成モジュール。<projectsRoot>/<name>/CLAUDE.md を生成する。
// projectsRootはユーザーが設定画面で指定する絶対パス（settings.projectsRoot）。
import fs from "node:fs";
import path from "node:path";
import { resolveInsideProjectsRoot } from "./paths.js";

// プロジェクト名の許可パターン（英数字・アンダースコア・ハイフン、1〜40文字）
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

/** 作成成功時は作成したフォルダの絶対パス、失敗時はエラーメッセージを返す */
export type CreateProjectResult =
  | { ok: true; cwd: string }
  | { ok: false; error: string };

/** CLAUDE.mdテンプレートを生成する（DESIGN.md記載の雛形） */
function claudeMdTemplate(name: string, purpose: string): string {
  return `# ${name}

## プロジェクトの目的
${purpose}

## 基本方針
- 会話は日本語で行う
- 作業前に計画を説明し、承認を得てから実行する
`;
}

/**
 * 新規プロジェクトを作成する。
 *  - projectsRoot未設定は拒否（設定画面での指定を促す）
 *  - name検証（パターン一致）
 *  - パスが projectsRoot 配下に収まるか検証
 *  - 既存フォルダは拒否
 *  - フォルダ作成 + CLAUDE.md 生成
 */
export function createProject(
  name: unknown,
  purpose: unknown,
  projectsRoot: string | null
): CreateProjectResult {
  if (!projectsRoot) {
    return {
      ok: false,
      error:
        "プロジェクトの保存先フォルダが未設定です。このフォームでフォルダを指定してから作成してください。",
    };
  }
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error:
        "プロジェクト名は英数字・ハイフン・アンダースコアの1〜40文字で指定してください",
    };
  }
  const purposeText = typeof purpose === "string" ? purpose : "";

  // <projectsRoot>/<name> を組み立て、配下に収まるか検証
  const target = path.join(projectsRoot, name);
  const safe = resolveInsideProjectsRoot(target, projectsRoot);
  if (!safe) {
    return { ok: false, error: "不正なプロジェクトパスです" };
  }

  // 既存フォルダは拒否
  if (fs.existsSync(safe)) {
    return { ok: false, error: "同名のプロジェクトが既に存在します" };
  }

  try {
    fs.mkdirSync(safe, { recursive: false });
    fs.writeFileSync(
      path.join(safe, "CLAUDE.md"),
      claudeMdTemplate(name, purposeText),
      "utf8"
    );
  } catch (e) {
    return {
      ok: false,
      error: `プロジェクト作成に失敗しました: ${(e as Error).message}`,
    };
  }

  return { ok: true, cwd: safe };
}
