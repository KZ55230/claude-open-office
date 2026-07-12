// config/settings.json の読み書きを担当するモジュール
import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "./paths.js";
import type { OfficeSettings } from "../../shared/types.js";

/** 設定ファイルが無いときのデフォルト。表示部署は初回にscanner側で埋める */
function defaultSettings(): OfficeSettings {
  return {
    visibleDepartments: [],
    pinnedSessions: [],
    departmentAliases: {},
    employeeNotes: {},
    roomOrder: [],
  };
}

/** 値が「全要素がstringの配列」かを検証しつつ補完する型ガード */
export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string");
}

/** 値がRecord<string,string>であることを検証しつつ補完する型ガード */
function asStringRecord(v: unknown): Record<string, string> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

/**
 * settings.jsonを読み込む。存在しない・壊れている場合はデフォルトを返す。
 * 初回起動判定に使うため「ファイルが存在したかどうか」も返す。
 */
export function loadSettings(): { settings: OfficeSettings; existed: boolean } {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<OfficeSettings>;
    // 欠損フィールドはデフォルトで補完
    return {
      settings: {
        visibleDepartments: Array.isArray(parsed.visibleDepartments)
          ? parsed.visibleDepartments
          : [],
        pinnedSessions: Array.isArray(parsed.pinnedSessions)
          ? parsed.pinnedSessions
          : [],
        departmentAliases: asStringRecord(parsed.departmentAliases),
        employeeNotes: asStringRecord(parsed.employeeNotes),
        roomOrder: asStringArray(parsed.roomOrder),
      },
      existed: true,
    };
  } catch {
    // 未作成 or パース失敗
    return { settings: defaultSettings(), existed: false };
  }
}

/** settings.jsonへ書き込む。configディレクトリが無ければ作成する */
export function saveSettings(settings: OfficeSettings): void {
  const dir = path.dirname(SETTINGS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}
