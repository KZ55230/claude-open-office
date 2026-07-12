// HTML/CSSオーバーレイUIの制御。ダークトーンのレトロゲーム風で統一、文言は日本語。
// ヘッダー・各種モーダル（新規プロジェクト／表示選択／OB名簿）・
// ターミナルパネルの開閉・接続エラー表示（リトライボタン）を扱う。

import type { OfficeState, Department, Employee, UsageInfo, DistillResult } from "../../shared/types";

/** 職能ロールの絵文字（スプライト・モーダル共通） */
const ROLE_EMOJI: Record<string, string> = {
  engineering:  "🔧",
  marketing:    "📣",
  finance:      "💹",
  product:      "🎯",
  legal:        "⚖️",
  data:         "📊",
  productivity: "📋",
  sales:        "🤝",
  research:     "🔍",
  ops:          "⚙️",
  general:      "👤",
};

/** 職能ロールの日本語ラベル */
const ROLE_LABEL_JA: Record<string, string> = {
  engineering:  "エンジニアリング",
  marketing:    "マーケティング",
  finance:      "ファイナンス",
  product:      "プロダクト",
  legal:        "リーガル",
  data:         "データ",
  productivity: "生産性",
  sales:        "営業",
  research:     "リサーチ",
  ops:          "運用",
  general:      "汎用",
};

/** DOM要素をIDで取得（存在前提のヘルパ） */
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素が見つかりません: #${id}`);
  return el as T;
}

/** UI全体を束ねるコントローラ。コールバックはmain.tsから差し込む */
export class UI {
  // コールバック
  onCreateProject?: (
    name: string,
    purpose: string,
    projectsRoot: string
  ) => Promise<void>;
  onSaveVisibility?: (visibleIds: string[]) => Promise<void>;
  onRecallAlumni?: (dept: Department, emp: Employee) => Promise<void>;
  onRetry?: () => void;
  /** 模様替えモードのトグル（ヘッダーのボタン） */
  onToggleRearrange?: () => void;
  /** 部署名エイリアスの保存（空文字で解除） */
  onSaveDeptAlias?: (departmentId: string, alias: string) => Promise<void>;
  /** 従業員カルテの保存（セッション名＋メモ） */
  onSaveKarte?: (info: {
    departmentId: string;
    sessionId: string;
    title: string;
    note: string;
    titleChanged: boolean;
  }) => Promise<void>;
  /** 従業員詳細モーダルからターミナルを開く */
  onOpenTerminal?: (dept: Department, emp: Employee) => void;
  /** 従業員詳細モーダルからSkill蒸留を実行する */
  onDistill?: (dept: Department, emp: Employee) => Promise<DistillResult>;

  private state: OfficeState | null = null;

  constructor() {
    this.wireHeaderButtons();
    this.wireModalClosers();
    this.wireProjectForm();
  }

  /** 最新のオフィス状態をUIへ反映（モーダルの中身の元データ） */
  setState(state: OfficeState): void {
    this.state = state;
  }

  // ---- ヘッダー ----

  private wireHeaderButtons(): void {
    byId("btn-new-project").addEventListener("click", () => this.openProjectModal());
    byId("btn-visibility").addEventListener("click", () => this.openVisibilityModal());
    byId("btn-alumni").addEventListener("click", () => this.openAlumniModal());
    byId("btn-rearrange").addEventListener("click", () => this.onToggleRearrange?.());
  }

  /** 模様替えモードの表示状態（ボタンのアクティブ表示＋ガイドの開閉） */
  setRearrangeActive(on: boolean): void {
    byId("btn-rearrange").classList.toggle("active", on);
    byId("rearrange-guide").classList.toggle("open", on);
  }

  // ---- 汎用モーダル制御 ----

  private openModal(id: string): void {
    byId(id).classList.add("open");
    byId("modal-backdrop").classList.add("open");
  }
  private closeModal(id: string): void {
    byId(id).classList.remove("open");
    // ほかに開いているモーダルがなければbackdropも閉じる
    const anyOpen = document.querySelectorAll(".modal.open").length > 0;
    if (!anyOpen) byId("modal-backdrop").classList.remove("open");
  }
  private wireModalClosers(): void {
    document.querySelectorAll<HTMLElement>("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-close")!;
        this.closeModal(target);
      });
    });
    byId("modal-backdrop").addEventListener("click", () => {
      document.querySelectorAll<HTMLElement>(".modal.open").forEach((m) =>
        m.classList.remove("open")
      );
      byId("modal-backdrop").classList.remove("open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // エラーオーバーレイが開いていれば閉じる
      const overlay = byId("error-overlay");
      if (overlay.classList.contains("open")) {
        this.hideError();
        return;
      }
      // 通常モーダルを閉じる
      document.querySelectorAll<HTMLElement>(".modal.open").forEach((m) =>
        m.classList.remove("open")
      );
      byId("modal-backdrop").classList.remove("open");
    });
  }

  // ---- 新規プロジェクト立案モーダル ----

  private openProjectModal(): void {
    // 保存先フォルダは前回設定した値を自動で入れておく（未設定なら空欄）
    byId<HTMLInputElement>("proj-root").value = this.state?.settings.projectsRoot ?? "";
    byId<HTMLInputElement>("proj-name").value = "";
    byId<HTMLTextAreaElement>("proj-purpose").value = "";
    byId("proj-error").textContent = "";
    this.openModal("modal-project");
  }

  private wireProjectForm(): void {
    byId("proj-submit").addEventListener("click", async () => {
      const projectsRoot = byId<HTMLInputElement>("proj-root").value.trim();
      const name = byId<HTMLInputElement>("proj-name").value.trim();
      const purpose = byId<HTMLTextAreaElement>("proj-purpose").value.trim();
      const errEl = byId("proj-error");
      // 絶対パスかどうかの厳密な判定はサーバー側で行う（Windows等のパス形式にも対応するため）
      if (!projectsRoot) {
        errEl.textContent = "保存先フォルダを指定してください（例: /home/you/projects）。";
        return;
      }
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) {
        errEl.textContent = "プロジェクト名は英数字・ハイフン・アンダースコア（1〜40文字）で入力してください。";
        return;
      }
      if (!purpose) {
        errEl.textContent = "プロジェクトの目的を入力してください。";
        return;
      }
      errEl.textContent = "作成中…";
      try {
        await this.onCreateProject?.(name, purpose, projectsRoot);
        this.closeModal("modal-project");
      } catch (e) {
        errEl.textContent = e instanceof Error ? e.message : "作成に失敗しました。";
      }
    });
  }

  // ---- 表示プロジェクト選択モーダル ----

  private openVisibilityModal(): void {
    if (!this.state) return;
    const listEl = byId("visibility-list");
    listEl.innerHTML = "";
    const visible = new Set(this.state.settings.visibleDepartments);
    for (const dept of this.state.departments) {
      const label = document.createElement("label");
      label.className = "check-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = dept.id;
      cb.checked = visible.size === 0 || visible.has(dept.id);
      const span = document.createElement("span");
      span.textContent = `${dept.name}（${this.deptTypeLabel(dept.type)}・${dept.employees.length}名）`;
      label.appendChild(cb);
      label.appendChild(span);
      listEl.appendChild(label);
    }
    this.openModal("modal-visibility");
  }

  // 表示選択の保存ボタンは1回だけ配線する
  private visibilityWired = false;
  wireVisibilitySave(): void {
    if (this.visibilityWired) return;
    this.visibilityWired = true;
    byId("visibility-save").addEventListener("click", async () => {
      const checks = byId("visibility-list").querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]'
      );
      const ids: string[] = [];
      checks.forEach((c) => {
        if (c.checked) ids.push(c.value);
      });
      const errEl = byId("visibility-error");
      errEl.textContent = "保存中…";
      try {
        await this.onSaveVisibility?.(ids);
        this.closeModal("modal-visibility");
        errEl.textContent = "";
      } catch (e) {
        errEl.textContent = e instanceof Error ? e.message : "保存に失敗しました。";
      }
    });
  }

  // ---- OB名簿モーダル ----

  private openAlumniModal(): void {
    if (!this.state) return;
    const listEl = byId("alumni-list");
    listEl.innerHTML = "";
    let any = false;
    for (const dept of this.state.departments) {
      for (const emp of dept.alumni) {
        any = true;
        const row = document.createElement("div");
        row.className = "alumni-row";
        const info = document.createElement("div");
        info.className = "alumni-info";
        info.innerHTML =
          `<strong>${this.escape(emp.name)}</strong>` +
          `<span class="alumni-dept">${this.escape(dept.name)}</span>` +
          `<span class="alumni-sum">${this.escape(emp.summary || "（作業内容なし）")}</span>`;
        const btn = document.createElement("button");
        btn.className = "btn-small";
        btn.textContent = "呼び戻す";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "呼び戻し中…";
          try {
            await this.onRecallAlumni?.(dept, emp);
            row.remove();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = "呼び戻す";
            alert(e instanceof Error ? e.message : "呼び戻しに失敗しました。");
          }
        });
        row.appendChild(info);
        row.appendChild(btn);
        listEl.appendChild(row);
      }
    }
    if (!any) {
      listEl.innerHTML = '<p class="empty-note">OB名簿は空です。</p>';
    }
    this.openModal("modal-alumni");
  }

  // ---- ツールチップ（掲示板ホバー＝テキスト、従業員ホバー＝リッチ表示） ----

  showTooltip(text: string, x: number, y: number): void {
    const tip = byId("tooltip");
    tip.textContent = text;
    this.placeTooltip(tip, x, y);
  }

  /**
   * 従業員ホバー用のリッチツールチップ。
   * 従業員名（姓）／業務内容(title・summary)／進捗(直近のassistant発言・自動)／
   * メモ（カルテの手動入力、あれば追加表示）を整形表示する。
   */
  showEmployeeTooltip(
    info: { dept: Department; emp: Employee; note: string },
    x: number,
    y: number
  ): void {
    const { dept, emp, note } = info;
    const tip = byId("tooltip");
    // title/summaryが同一文字列にフォールバックすることがあるため、
    // 「業務内容」1本にまとめて重複表示を防ぐ（titleを優先、無ければsummary）。
    const taskContent =
      emp.title || emp.summary || "（作業内容はまだ記録されていません）";
    const parts = [
      `<div class="tip-name">${this.escape(emp.name)} <span style="opacity:.7">（${this.escape(dept.name)}）</span></div>`,
      `<div class="tip-label">業務内容</div>`,
      `<div class="tip-body">${this.escape(taskContent)}</div>`,
    ];
    if (emp.progress) {
      parts.push(`<div class="tip-label">進捗</div>`);
      parts.push(`<div class="tip-body">${this.escape(emp.progress)}</div>`);
    }
    if (note) {
      parts.push(`<div class="tip-label">メモ</div>`);
      parts.push(`<div class="tip-body">${this.escape(note)}</div>`);
    }
    tip.innerHTML = parts.join("");
    this.placeTooltip(tip, x, y);
  }

  private placeTooltip(tip: HTMLElement, x: number, y: number): void {
    tip.style.left = `${Math.min(x + 12, window.innerWidth - 300)}px`;
    tip.style.top = `${Math.min(y + 12, window.innerHeight - 140)}px`;
    tip.classList.add("open");
  }

  hideTooltip(): void {
    byId("tooltip").classList.remove("open");
  }

  // ---- 部署名の変更モーダル（プレートクリック） ----

  private aliasTarget: Department | null = null;
  private aliasWired = false;

  openDeptAliasModal(dept: Department): void {
    this.aliasTarget = dept;
    byId("alias-current").textContent = `現在の表示名：${dept.name}（フォルダ: ${dept.id}）`;
    byId<HTMLInputElement>("alias-input").value = dept.name;
    byId("alias-error").textContent = "";
    this.openModal("modal-dept-alias");
    this.wireAliasSave();
  }

  private wireAliasSave(): void {
    if (this.aliasWired) return;
    this.aliasWired = true;
    byId("alias-save").addEventListener("click", async () => {
      if (!this.aliasTarget) return;
      const alias = byId<HTMLInputElement>("alias-input").value.trim();
      const errEl = byId("alias-error");
      errEl.textContent = "保存中…";
      try {
        await this.onSaveDeptAlias?.(this.aliasTarget.id, alias);
        errEl.textContent = "";
        this.closeModal("modal-dept-alias");
      } catch (e) {
        errEl.textContent = e instanceof Error ? e.message : "保存に失敗しました。";
      }
    });
  }

  // ---- 従業員カルテモーダル（セッション名変更＋メモ） ----

  private karteTarget: { dept: Department; emp: Employee } | null = null;
  private karteWired = false;

  openKarteModal(dept: Department, emp: Employee, note: string): void {
    this.karteTarget = { dept, emp };
    byId("karte-who").textContent = `${emp.name}（${dept.name}）`;
    byId<HTMLInputElement>("karte-title").value = emp.title;
    byId<HTMLTextAreaElement>("karte-note").value = note;
    byId("karte-error").textContent = "";
    this.openModal("modal-karte");
    this.wireKarteSave();
  }

  private wireKarteSave(): void {
    if (this.karteWired) return;
    this.karteWired = true;
    byId("karte-save").addEventListener("click", async () => {
      if (!this.karteTarget) return;
      const { dept, emp } = this.karteTarget;
      const title = byId<HTMLInputElement>("karte-title").value.trim();
      const note = byId<HTMLTextAreaElement>("karte-note").value.trim();
      const errEl = byId("karte-error");
      errEl.textContent = "保存中…";
      try {
        await this.onSaveKarte?.({
          departmentId: dept.id,
          sessionId: emp.sessionId,
          title,
          note,
          titleChanged: title !== emp.title,
        });
        errEl.textContent = "";
        this.closeModal("modal-karte");
      } catch (e) {
        errEl.textContent = e instanceof Error ? e.message : "保存に失敗しました。";
      }
    });
  }

  // ---- 従業員詳細モーダル ----

  private empTarget: { dept: Department; emp: Employee; note: string } | null = null;
  private empModalWired = false;

  openEmployeeModal(dept: Department, emp: Employee, note: string): void {
    this.empTarget = { dept, emp, note };

    byId("emp-modal-title").textContent = `${emp.name}（${dept.name}）`;
    byId("emp-name").textContent = emp.name;

    const statusMap: Record<string, string> = {
      working: "🟢 作業中",
      waiting: "🟡 返事待ち",
      resting: "⚪ 休憩中",
    };
    byId("emp-status").textContent = statusMap[emp.status] ?? emp.status;

    // 職能ロールバッジ（安全なDOM操作で生成）
    const roleEl = byId("emp-role");
    roleEl.textContent = "";
    const badge = document.createElement("span");
    badge.className = `role-badge ${emp.role ?? "general"}`;
    badge.textContent = `${ROLE_EMOJI[emp.role ?? "general"]} ${ROLE_LABEL_JA[emp.role ?? "general"]}`;
    roleEl.appendChild(badge);

    byId("emp-task").textContent = emp.title || "（未設定）";
    byId("emp-branch").textContent = emp.gitBranch || "（不明）";
    byId("emp-dept").textContent = dept.name;
    byId("emp-progress").textContent = emp.progress || "（なし）";
    byId("emp-summary").textContent = emp.summary || "（なし）";

    this.openModal("modal-employee");
    this.wireEmployeeModalButtons();
  }

  private wireEmployeeModalButtons(): void {
    if (this.empModalWired) return;
    this.empModalWired = true;

    byId("emp-open-terminal").addEventListener("click", () => {
      if (!this.empTarget) return;
      this.closeModal("modal-employee");
      this.onOpenTerminal?.(this.empTarget.dept, this.empTarget.emp);
    });

    byId("emp-open-karte").addEventListener("click", () => {
      if (!this.empTarget) return;
      this.closeModal("modal-employee");
      this.openKarteModal(this.empTarget.dept, this.empTarget.emp, this.empTarget.note);
    });

    byId("emp-distill-btn").addEventListener("click", async () => {
      if (!this.empTarget) return;
      this.closeModal("modal-employee");
      this.openDistillModal();
      try {
        const result = await this.onDistill?.(this.empTarget.dept, this.empTarget.emp);
        if (result) this.showDistillResult(result);
      } catch (e) {
        const errEl = byId("distill-error");
        errEl.textContent = e instanceof Error ? e.message : "蒸留に失敗しました。";
        errEl.style.display = "block";
        byId("distill-loading").style.display = "none";
      }
    });

    byId("distill-copy-btn").addEventListener("click", () => {
      const tmpl = byId("distill-template").textContent ?? "";
      navigator.clipboard.writeText(tmpl).then(() => {
        const btn = byId("distill-copy-btn");
        const orig = btn.textContent;
        btn.textContent = "✅ コピー完了";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
    });
  }

  private openDistillModal(): void {
    byId("distill-loading").style.display = "block";
    byId("distill-content").style.display = "none";
    byId("distill-error").style.display = "none";
    byId("distill-error").textContent = "";
    this.openModal("modal-distill");
  }

  showDistillResult(result: DistillResult): void {
    byId("distill-loading").style.display = "none";
    byId("distill-content").style.display = "block";

    // ツール一覧タグ（DOM操作でXSSを回避）
    const toolsEl = byId("distill-tools");
    toolsEl.textContent = "";
    if (result.toolsUsed.length > 0) {
      for (const t of result.toolsUsed) {
        const tag = document.createElement("span");
        tag.className = "distill-tag";
        tag.textContent = t;
        toolsEl.appendChild(tag);
      }
    } else {
      const none = document.createElement("span");
      none.style.color = "var(--muted)";
      none.textContent = "（なし）";
      toolsEl.appendChild(none);
    }

    // 参照ファイル（DOM操作）
    const filesEl = byId("distill-files");
    filesEl.textContent = "";
    if (result.filesReferenced.length > 0) {
      for (const f of result.filesReferenced) {
        const code = document.createElement("code");
        code.textContent = f;
        filesEl.appendChild(code);
        filesEl.appendChild(document.createElement("br"));
      }
    } else {
      filesEl.textContent = "（なし）";
    }

    // 主要決断（DOM操作）
    const decisionsEl = byId("distill-decisions");
    decisionsEl.textContent = "";
    if (result.keyDecisions.length > 0) {
      for (const d of result.keyDecisions) {
        const li = document.createElement("li");
        li.textContent = d;
        decisionsEl.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.style.color = "var(--muted)";
      li.textContent = "（なし）";
      decisionsEl.appendChild(li);
    }

    // Skillテンプレート
    byId("distill-template").textContent = result.skillTemplate;
  }

  // ---- 接続エラー表示（リトライ） ----

  showError(message: string): void {
    byId("error-message").textContent = message;
    byId("error-overlay").classList.add("open");
  }
  hideError(): void {
    byId("error-overlay").classList.remove("open");
  }
  wireRetry(): void {
    byId("error-retry").addEventListener("click", () => {
      this.hideError();
      this.onRetry?.();
    });
    byId("error-close").addEventListener("click", () => {
      this.hideError();
    });
  }

  /** 接続状態インジケータ（ヘッダー右のドット） */
  setConnected(connected: boolean): void {
    const dot = byId("conn-dot");
    dot.classList.toggle("connected", connected);
    dot.classList.toggle("disconnected", !connected);
    dot.title = connected ? "サーバー接続中" : "サーバー未接続";
  }

  /** ヘッダーの使用量表示を更新する（未取得の値は"--"表示） */
  setUsageInfo(usage: UsageInfo): void {
    const el = byId("usage-info");
    const s = usage.sessionPercent !== null ? `${usage.sessionPercent}%` : "--";
    const w = usage.weekPercent !== null ? `${usage.weekPercent}%` : "--";
    el.textContent = `使用量: 5h ${s} ／ 週 ${w}`;
    el.title = usage.updatedAt
      ? `最終更新: ${new Date(usage.updatedAt).toLocaleTimeString("ja-JP")}`
      : "まだ取得できていません";
  }

  // ---- ヘルパ ----

  private deptTypeLabel(_type: Department["type"]): string {
    return "プロジェクト部";
  }

  private escape(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
}
