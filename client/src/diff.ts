// オフィス状態の差分検出（純粋関数）
// 前回のOfficeStateと今回のOfficeStateを比較し、発火すべき演出イベントを算出する。
// 副作用を持たないため単体テストしやすい。演出（入社・退場・増築）の判定ロジックの中核。

import type { OfficeState, Department, Employee } from "../../shared/types";

/** 部署単位で検出した演出イベント */
export interface DepartmentDiff {
  departmentId: string;
  /** 新しく従業員枠に加わったセッション（入社演出の対象） */
  hired: Employee[];
  /** 従業員枠から外れたセッション（退場演出の対象） */
  departed: Employee[];
  /** 島が1→2に増えた（増築演出の対象）。1→1や2→2はfalse */
  expanded: boolean;
  /** ステータスだけが変化した従業員（アニメ切り替え用） */
  statusChanged: Employee[];
  /** 部署の表示名が変わった（エイリアス設定など。プレート再描画のみ・演出なし） */
  renamed: boolean;
}

/** OfficeState全体の差分結果 */
export interface OfficeDiff {
  /** 新規に出現した部署（初回描画や新規プロジェクト作成） */
  addedDepartments: Department[];
  /** 消滅した部署 */
  removedDepartments: Department[];
  /** 既存部署ごとの差分 */
  changed: DepartmentDiff[];
}

/** 部署IDでMap化するヘルパ */
function indexById(departments: Department[]): Map<string, Department> {
  const map = new Map<string, Department>();
  for (const d of departments) map.set(d.id, d);
  return map;
}

/** 従業員をsessionIdでMap化するヘルパ */
function employeesById(employees: Employee[]): Map<string, Employee> {
  const map = new Map<string, Employee>();
  for (const e of employees) map.set(e.sessionId, e);
  return map;
}

/**
 * 2つのOfficeStateを比較して演出イベントを算出する純粋関数。
 * @param prev 前回の状態（初回はnull）
 * @param next 今回の状態
 */
export function diffOfficeState(
  prev: OfficeState | null,
  next: OfficeState
): OfficeDiff {
  const result: OfficeDiff = {
    addedDepartments: [],
    removedDepartments: [],
    changed: [],
  };

  // 初回（prevなし）はすべて追加部署扱い（演出なしで即描画する側で扱う）
  if (!prev) {
    result.addedDepartments = [...next.departments];
    return result;
  }

  const prevDepts = indexById(prev.departments);
  const nextDepts = indexById(next.departments);

  // 追加された部署
  for (const dept of next.departments) {
    if (!prevDepts.has(dept.id)) {
      result.addedDepartments.push(dept);
    }
  }

  // 消滅した部署
  for (const dept of prev.departments) {
    if (!nextDepts.has(dept.id)) {
      result.removedDepartments.push(dept);
    }
  }

  // 既存部署ごとの従業員・島の差分
  for (const nextDept of next.departments) {
    const prevDept = prevDepts.get(nextDept.id);
    if (!prevDept) continue; // 新規部署はaddedで処理済み

    const prevEmps = employeesById(prevDept.employees);
    const nextEmps = employeesById(nextDept.employees);

    const hired: Employee[] = [];
    const departed: Employee[] = [];
    const statusChanged: Employee[] = [];

    // 入社（前回になかったsessionId）
    for (const emp of nextDept.employees) {
      const before = prevEmps.get(emp.sessionId);
      if (!before) {
        hired.push(emp);
      } else if (before.status !== emp.status) {
        statusChanged.push(emp);
      }
    }

    // 退場（今回消えたsessionId）
    for (const emp of prevDept.employees) {
      if (!nextEmps.has(emp.sessionId)) {
        departed.push(emp);
      }
    }

    // 増築：島が1→2に増えたときだけtrue（4席が埋まり5人目が入社したとき）
    const expanded = prevDept.islands === 1 && nextDept.islands === 2;

    // 表示名の変更（部署エイリアスの設定・解除）
    const renamed = prevDept.name !== nextDept.name;

    if (
      hired.length > 0 ||
      departed.length > 0 ||
      statusChanged.length > 0 ||
      expanded ||
      renamed
    ) {
      result.changed.push({
        departmentId: nextDept.id,
        hired,
        departed,
        expanded,
        statusChanged,
        renamed,
      });
    }
  }

  return result;
}

/**
 * 従業員数から島の数を導出する純粋関数（サーバーと同じルールの参照実装）。
 * 1〜4人=1島、5人以上=2島。0人でも1島扱い。
 */
export function islandsForCount(count: number): 1 | 2 {
  return count >= 5 ? 2 : 1;
}
