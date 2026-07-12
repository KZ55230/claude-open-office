// エントリポイント。オフィスシーン（Pixi）・UIオーバーレイ・ターミナルドック・通信層を配線する。
// 起動フロー：GET /api/office で初期描画 → /ws/office を購読して差分反映・演出発火。
// ステータスだけの軽量パッチ（type:"status"）は latestState を差し替えて同じ経路に流す。
// サーバー未起動時はエラーオーバーレイ（リトライ）を出す。

import { OfficeScene } from "./office";
import { UI } from "./ui";
import { TerminalDock } from "./terminal";
import {
  getOffice,
  putSettings,
  createProject,
  hire,
  openTerminal,
  putDepartmentAlias,
  putEmployeeNote,
  renameSession,
  OfficeSocket,
  type StatusUpdate,
} from "./api";
import { orderDepartments, swappedOrder } from "./layout";
import type {
  OfficeState,
  OfficeSettings,
  Department,
  Employee,
} from "../../shared/types";

/** アプリ全体の状態と配線を保持 */
class App {
  private scene = new OfficeScene();
  private ui = new UI();
  private dock!: TerminalDock;
  private officeSocket: OfficeSocket | null = null;
  private latestState: OfficeState | null = null;

  async start(): Promise<void> {
    // Pixiシーンの初期化
    await this.scene.init(document.getElementById("office-mount")!);

    // ターミナルドック初期化（0〜2面の可変表示）
    this.dock = new TerminalDock(document.getElementById("terminal-dock")!);
    this.dock.onSessionBound = (sessionId) => {
      // hire直後に新sessionIdが確定：以後のoffice stateで入社演出が自然に発火する
      console.debug("[office] sessionBound:", sessionId);
    };
    this.dock.onKarteClick = (sessionId) => {
      if (!sessionId) {
        alert("セッションの確定前です。少し待ってからもう一度お試しください。");
        return;
      }
      this.openKarteBySession(sessionId);
    };

    // 各種コールバックを配線
    this.wireScene();
    this.wireUI();

    // 初期ロード
    await this.loadInitial();
  }

  /** 初回オフィス状態の取得と描画。失敗時はエラー表示 */
  private async loadInitial(): Promise<void> {
    try {
      // 開発時はサーバーの起動が画面より一瞬遅れることがあるため、少し待って再試行する
      const state = await this.getOfficeWithRetry(8, 500);
      this.applyStateFromRest(state);
      this.ui.hideError();
      this.connectOfficeSocket();
    } catch (e) {
      this.ui.showError(
        (e instanceof Error ? e.message : "初期化に失敗しました。") +
          "\nサーバー（ポート3777）が起動しているか確認してください。"
      );
    }
  }

  /** /api/office をリトライ付きで取得（起動直後のレース対策） */
  private async getOfficeWithRetry(
    attempts: number,
    delayMs: number
  ): Promise<OfficeState> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await getOffice();
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  }

  /** /ws/office を購読して差分反映（state全体＋statusパッチ＋使用量＋吹き出し） */
  private connectOfficeSocket(): void {
    this.officeSocket?.close();
    this.officeSocket = new OfficeSocket({
      onState: (state) => this.applyStateFromRest(state), // 内部で前回stateと比較して演出発火
      onStatusChange: (connected) => this.ui.setConnected(connected),
      onStatusPatch: (updates) => this.applyStatusPatch(updates),
      onUsage: (usage) => this.ui.setUsageInfo(usage),
      onSpeech: (sessionId, kind, text) =>
        this.handleSpeech(sessionId, kind, text),
    });
    this.officeSocket.connect();
  }

  /**
   * ステータスだけの軽量パッチを反映する。
   * latestState の該当従業員を差し替えた新しいstateを作り、
   * 既存の applyState（statusChanged検出）経路にそのまま流す。
   */
  private applyStatusPatch(updates: StatusUpdate[]): void {
    if (!this.latestState || updates.length === 0) return;
    const byId = new Map(updates.map((u) => [u.sessionId, u]));
    const next: OfficeState = {
      ...this.latestState,
      departments: this.latestState.departments.map((dept) => {
        if (!dept.employees.some((e) => byId.has(e.sessionId))) return dept;
        return {
          ...dept,
          employees: dept.employees.map((e) => {
            const u = byId.get(e.sessionId);
            return u
              ? { ...e, status: u.status, hasLiveTerminal: u.hasLiveTerminal }
              : e;
          }),
        };
      }),
    };
    this.applyStateFromRest(next);
  }

  /** 現在の設定に部分変更を重ねたOfficeSettingsを作る（契約の全フィールドを維持） */
  private mergedSettings(partial: Partial<OfficeSettings>): OfficeSettings {
    const cur = this.latestState?.settings;
    return {
      visibleDepartments: cur?.visibleDepartments ?? [],
      pinnedSessions: cur?.pinnedSessions ?? [],
      departmentAliases: cur?.departmentAliases ?? {},
      employeeNotes: cur?.employeeNotes ?? {},
      roomOrder: cur?.roomOrder ?? [],
      ...partial,
    };
  }

  /**
   * 現在の表示順（roomOrder優先＋残りID昇順）での部屋のID一覧。
   * 非表示の部署は含まない。模様替えの交換時はこのリストを入れ替えて保存する。
   */
  private currentNormalOrder(): string[] {
    const state = this.latestState;
    if (!state) return [];
    const visible = new Set(state.settings.visibleDepartments);
    const normals = state.departments.filter(
      (d) => visible.size === 0 || visible.has(d.id)
    );
    return orderDepartments(normals, state.settings.roomOrder ?? []).map((d) => d.id);
  }

  /** sessionIdから部署と従業員を探す */
  private findEmployee(
    sessionId: string
  ): { dept: Department; emp: Employee } | null {
    for (const dept of this.latestState?.departments ?? []) {
      const emp =
        dept.employees.find((e) => e.sessionId === sessionId) ??
        dept.alumni.find((e) => e.sessionId === sessionId);
      if (emp) return { dept, emp };
    }
    return null;
  }

  /** 承認待ち・完了報告の吹き出しを該当従業員の座席に表示する */
  private handleSpeech(
    sessionId: string,
    kind: "permission" | "done",
    text: string
  ): void {
    const found = this.findEmployee(sessionId);
    if (!found) return; // 非表示部署・OB名簿落ち等は単に無視
    this.scene.showSpeechBubble(found.dept.id, sessionId, kind, text);
  }

  /** カルテモーダルを開く（面ヘッダの✎から） */
  private openKarteBySession(sessionId: string): void {
    const found = this.findEmployee(sessionId);
    if (!found) {
      alert("この従業員の情報が見つかりませんでした。");
      return;
    }
    const note = this.latestState?.settings.employeeNotes[sessionId] ?? "";
    this.ui.openKarteModal(found.dept, found.emp, note);
  }

  // ---- シーン（Pixi）→アプリのコールバック ----

  private wireScene(): void {
    // 従業員クリック：ターミナルドックの面へ接続（同一セッションの面があれば再利用）
    this.scene.onEmployeeClick = async (info) => {
      const title = {
        empName: `${info.employee.name}（${info.department.name}）`,
        sessionTitle: info.employee.title,
      };
      // 既に面が開いていればフォーカスだけ（REST不要）
      if (this.dock.focusSession(info.employee.sessionId)) return;
      try {
        const { terminalId } = await openTerminal(
          info.department.id,
          info.employee.sessionId
        );
        this.dock.open(terminalId, info.employee.sessionId, title);
      } catch (e) {
        this.ui.showError(
          e instanceof Error ? e.message : "ターミナルの接続に失敗しました。"
        );
      }
    };

    // 空席クリック：雇用確認→hire（ターミナルは演出を待たず即座に開く）
    this.scene.onEmptySeatClick = async (info) => {
      const ok = confirm(
        `${info.department.name} に新しく従業員を雇いますか？\n（新しいClaudeセッションを起動します）`
      );
      if (!ok) return;
      try {
        const { terminalId } = await hire(info.department.id);
        this.dock.open(terminalId, null, {
          empName: `新入社員（${info.department.name}）`,
          sessionTitle: "",
        });
      } catch (e) {
        this.ui.showError(e instanceof Error ? e.message : "雇用に失敗しました。");
      }
    };

    // 掲示板ホバー：summaryをテキストツールチップ表示
    this.scene.onBoardHover = (_dept, summary) => {
      if (summary) {
        this.ui.showTooltip(summary, this.lastMouseX, this.lastMouseY);
      } else {
        this.ui.hideTooltip();
      }
    };

    // 従業員ホバー：リッチツールチップ（名前／セッション名／業務概要／進捗メモ）
    this.scene.onEmployeeHover = (dept, emp) => {
      if (emp) {
        const note = this.latestState?.settings.employeeNotes[emp.sessionId] ?? "";
        this.ui.showEmployeeTooltip(
          { dept, emp, note },
          this.lastMouseX,
          this.lastMouseY
        );
      } else {
        this.ui.hideTooltip();
      }
    };

    // 部署名プレートクリック：部署名の変更モーダル
    this.scene.onPlateClick = (dept) => {
      this.ui.openDeptAliasModal(dept);
    };

    // 模様替え：部屋のドロップ交換 → roomOrderを更新して保存
    // （失敗をthrowするとシーン側が部屋を元の位置へ戻す）
    this.scene.onRoomSwap = async (draggedId, targetId) => {
      const order = swappedOrder(this.currentNormalOrder(), draggedId, targetId);
      const state = await putSettings(this.mergedSettings({ roomOrder: order }));
      this.applyStateFromRest(state);
    };

    // ツールチップ追従用にマウス座標を記録
    window.addEventListener("mousemove", (e) => {
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });
  }

  private lastMouseX = 0;
  private lastMouseY = 0;

  // ---- UI→アプリのコールバック ----

  private rearrangeOn = false;

  private wireUI(): void {
    this.ui.wireVisibilitySave();
    this.ui.wireRetry();

    // 模様替えモードのトグル（ON中はカメラパン無効・部屋ドラッグ有効）
    this.ui.onToggleRearrange = () => {
      this.rearrangeOn = !this.rearrangeOn;
      this.scene.setRearrangeMode(this.rearrangeOn);
      this.ui.setRearrangeActive(this.rearrangeOn);
    };

    // 新規プロジェクト作成
    this.ui.onCreateProject = async (name, purpose) => {
      const state = await createProject(name, purpose);
      this.applyStateFromRest(state);
    };

    // 表示プロジェクト選択の保存
    this.ui.onSaveVisibility = async (visibleIds) => {
      const state = await putSettings(
        this.mergedSettings({ visibleDepartments: visibleIds })
      );
      this.applyStateFromRest(state);
    };

    // OB名簿から呼び戻し：pinnedSessionsに追加＋terminal接続
    this.ui.onRecallAlumni = async (dept: Department, emp: Employee) => {
      // 1) resume接続を開く（ドックの面に割り当て）
      const { terminalId } = await openTerminal(dept.id, emp.sessionId);
      this.dock.open(terminalId, emp.sessionId, {
        empName: `${emp.name}（${dept.name}）`,
        sessionTitle: emp.title,
      });
      // 2) pinnedSessionsに追加して表示枠に固定
      const pinned = new Set(this.latestState?.settings.pinnedSessions ?? []);
      pinned.add(emp.sessionId);
      const state = await putSettings(
        this.mergedSettings({ pinnedSessions: [...pinned] })
      );
      this.applyStateFromRest(state);
    };

    // 部署名エイリアスの保存（空文字で解除）
    this.ui.onSaveDeptAlias = async (departmentId, alias) => {
      const state = await putDepartmentAlias(departmentId, alias);
      this.applyStateFromRest(state);
    };

    // 従業員カルテの保存：セッション名の変更＋進捗メモ
    this.ui.onSaveKarte = async ({ departmentId, sessionId, title, note, titleChanged }) => {
      if (titleChanged) {
        // .jsonlへのcustom-title追記。反映は次回のstate配信で届くため、面の表示は楽観更新する
        await renameSession(sessionId, departmentId, title);
        this.dock.setSessionTitle(sessionId, title);
      }
      const currentNote = this.latestState?.settings.employeeNotes[sessionId] ?? "";
      if (note !== currentNote) {
        const state = await putEmployeeNote(sessionId, note);
        this.applyStateFromRest(state);
      }
    };

    // リトライ：初期ロードからやり直す
    this.ui.onRetry = () => {
      void this.loadInitial();
    };
  }

  /** REST/WSで得たstateをシーン・UIへ反映する共通経路 */
  private applyStateFromRest(state: OfficeState): void {
    this.latestState = state;
    this.ui.setState(state);
    this.scene.applyState(state);
  }
}

// 起動
const app = new App();
void app.start();

// デバッグ用の参照（開発時にコンソールから配線状態を確認できる）
(globalThis as unknown as { __officeApp?: App }).__officeApp = app;
