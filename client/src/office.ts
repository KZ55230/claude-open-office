// PixiJS v8 で「1つのオフィスビル」を描画・アニメーションするシーン。
// - 全部署が1つの建物に収まり、中央廊下・ドア・エントランスを持つ（layout.tsが間取りを計算）
// - 島は机を向かい合わせにくっつけた対面式（北側は顔が見え、南側は光るモニターが見える）
// - 明るいクリーム壁＋木目/カーペット床＋豊富な家具で可愛いドット絵オフィスにする
// - 入社／増築（引っ越し業者の搬入）／退場 の3演出は廊下・ドア経由の経路歩行で表現
//
// PixiJS v8 のAPI（Application.init() が async、Graphics のメソッドチェーン等）で書く。

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  TilingSprite,
  Rectangle,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Department, Employee, OfficeState } from "../../shared/types";
import { TweenManager, Easings, lerp } from "./tween";
import {
  charTexture,
  chairTexture,
  deskTexture,
  bookshelfTexture,
  sofaTexture,
  tableTexture,
  whiteboardTexture,
  vendingTexture,
  plantTexture,
  boardTexture,
  cartTexture,
  moverTexture,
  signTexture,
  floorTexture,
  type FloorKind,
} from "./sprites";
import { diffOfficeState } from "./diff";
import {
  computeBuildingLayout,
  buildRoomSpecs,
  fullPath,
  exitPath,
  pathLength,
  roomHeight,
  CORRIDOR_H,
  HEADER_H,
  type BuildingLayout,
  type RoomLayout,
  type RoomSpec,
  type PathPoint,
  type SeatSpot,
} from "./layout";

// ---- 描画定数 ----
const TILE = 16; // 1タイルの内部ピクセル
const SCALE = 3; // 表示スケール（ドット絵をくっきり）
const WALK_MS_PER_TILE = 80; // 入社・退場の歩行速度
const MOVER_MS_PER_TILE = 55; // 引っ越し業者の歩行速度（少し早足）

/**
 * PIXI.Text の内部解像度。最大ズーム（SCALE 3 × camScale 2.5 = 7.5倍）でも
 * 文字が滲まないよう8倍で描く（日本語含む）。
 */
const TEXT_RESOLUTION = 8;

/** 鮮明なテキストを生成するヘルパ。全てのPIXI.Textはここを通すこと */
function crispText(
  text: string,
  style: ConstructorParameters<typeof TextStyle>[0]
): Text {
  return new Text({
    text,
    style: new TextStyle(style),
    resolution: TEXT_RESOLUTION,
  });
}

// 建物の配色（明るいクリーム壁＋濃色トリム）
const WALL_FACE = 0xf2ead8;
const WALL_TRIM = 0x5a5064;
const WALL_SHADE = 0xd8cdb6;
const BG_COLOR = 0x39405c; // 建物の外の背景（建物が映える落ち着いた青紫）

// ステータス色
const STATUS_COLORS: Record<Employee["status"], number> = {
  working: 0x6fd08c,
  waiting: 0xf2b134,
  resting: 0xb8bece,
};

/** 席1つ分の描画状態 */
interface SeatView {
  employee: Employee;
  seatIdx: number;
  container: Container; // itemsLayer内
  charSprite: Sprite;
  badge: Graphics;
  zzz: Text;
  facing: "down" | "up";
  animPhase: number;
  homeX: number; // charSpriteのローカル基準位置
  homeY: number;
  /** 承認待ち・完了報告の吹き出し（表示中のみ非null） */
  speechBubble: Container | null;
}

/** 部屋1つ分の描画状態 */
interface RoomView {
  dept: Department;
  layout: RoomLayout;
  container: Container; // 部屋全体（rect位置に置き、移動はトゥイーン）
  bgLayer: Container; // 床・壁・掲示板・プレート（再描画対象）
  itemsLayer: Container; // 家具＋席（zIndex=タイル行でソート）
  furniture: Container[]; // 再描画時に破棄する家具リスト
  seats: Map<string, SeatView>;
  emptyMarkers: Container;
  hasIsland1Desks: boolean; // 2島目の机が設置済みか（搬入演出後にtrue）
}

export interface EmployeeClickInfo {
  department: Department;
  employee: Employee;
}
export interface EmptySeatClickInfo {
  department: Department;
}

/** オフィスシーン本体（公開APIは従来と同じ） */
export class OfficeScene {
  app!: Application;
  private world = new Container();
  private shellLayer = new Container(); // 建物の外壁・廊下（再生成時はクロスフェード）
  private roomLayer = new Container();
  private actorLayer = new Container(); // 歩行中のキャラ・業者（建物座標）
  private tweens = new TweenManager();
  private prevState: OfficeState | null = null;
  private layout: BuildingLayout | null = null;
  private rooms = new Map<string, RoomView>();
  private updateQueue: Promise<void> = Promise.resolve(); // 演出の直列化

  // カメラ
  private camX = 0;
  private camY = 0;
  private camScale = 1;
  private cameraLocked = false;

  // コールバック（main.tsから差し込む）
  onEmployeeClick?: (info: EmployeeClickInfo) => void;
  onEmptySeatClick?: (info: EmptySeatClickInfo) => void;
  onBoardHover?: (dept: Department, summary: string | null) => void;
  /** 部署名プレートのクリック（部署名の変更モーダルを開く） */
  onPlateClick?: (dept: Department) => void;
  /** 従業員ホバー（empがnullでホバー解除。リッチツールチップ用） */
  onEmployeeHover?: (dept: Department, emp: Employee | null) => void;
  /**
   * 模様替えモードで部屋を別の部屋にドロップしたとき。
   * 呼び出し側がroomOrderを更新して保存する（失敗をthrowすると部屋は元の位置へ戻る）
   */
  onRoomSwap?: (draggedId: string, targetId: string) => Promise<void>;

  // 模様替えモードの状態
  private rearrangeMode = false;
  private queueBusy = 0; // 演出シーケンス実行中はドラッグを受け付けない
  private drag: {
    room: RoomView;
    grabDX: number; // つかんだ位置と部屋原点のオフセット（ワールドpx）
    grabDY: number;
    origX: number; // ドラッグ開始時の部屋位置（戻し用）
    origY: number;
  } | null = null;
  private dropHighlight: Graphics | null = null;

  /** Pixiアプリを初期化してDOMへ追加する（v8のasync init） */
  async init(mount: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      resizeTo: mount,
      background: BG_COLOR,
      antialias: false,
      roundPixels: true,
      preference: "webgl",
    });
    mount.appendChild(this.app.canvas);

    this.world.scale.set(SCALE);
    this.world.addChild(this.shellLayer);
    this.world.addChild(this.roomLayer);
    this.world.addChild(this.actorLayer);
    this.app.stage.addChild(this.world);

    this.setupCameraControls();

    // ターミナルドックの開閉などで土台のサイズが変わったらキャンバスを追従させる
    // （PixiのresizeToはwindowのresizeイベントしか拾わないため明示的に呼ぶ）
    const ro = new ResizeObserver(() => this.app.resize());
    ro.observe(mount);

    this.app.ticker.add(() => {
      const dt = this.app.ticker.deltaMS;
      this.tweens.update(dt);
      this.updateEmployeeAnimations(dt);
    });

    // デバッグ用の参照（開発時にコンソールからシーン状態を確認できる）
    (globalThis as unknown as { __officeScene?: OfficeScene }).__officeScene = this;
  }

  /** デバッグ用：現在のシーン概況を返す */
  debugSummary(): Record<string, unknown> {
    return {
      layout: this.layout
        ? {
            w: this.layout.widthTiles,
            h: this.layout.heightTiles,
            rooms: this.layout.rooms.map((r) => ({
              id: r.id,
              row: r.row,
              rect: r.rect,
              islands: r.islands,
              seats: r.seats.length,
            })),
          }
        : null,
      roomViews: [...this.rooms.entries()].map(([id, r]) => ({
        id,
        seated: r.seats.size,
        furniture: r.furniture.length,
        emptyMarkers: r.emptyMarkers.children.length,
        pos: { x: r.container.x, y: r.container.y },
      })),
      shellChildren: this.shellLayer.children.length,
      actors: this.actorLayer.children.length,
    };
  }

  // ---- カメラ操作（ホイールズーム・ドラッグパン） ----

  private setupCameraControls(): void {
    const canvas = this.app.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener("wheel", (e) => {
      if (this.cameraLocked) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.camScale = Math.max(0.3, Math.min(2.5, this.camScale * factor));
      this.applyCamera();
    });
    canvas.addEventListener("pointerdown", (e) => {
      // 模様替えモード中はカメラのパンを無効化（部屋ドラッグを優先）
      if (this.cameraLocked || this.rearrangeMode) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.camX += e.clientX - lastX;
      this.camY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.applyCamera();
    });
    window.addEventListener("pointerup", () => {
      dragging = false;
    });
  }

  private applyCamera(): void {
    this.world.scale.set(SCALE * this.camScale);
    this.world.position.set(this.camX, this.camY);
  }

  // ---- 模様替えモード（部屋単位のドラッグ交換） ----

  /**
   * 模様替えモードのON/OFF。ON中はカメラパンと部屋内クリックを止め、
   * 全部屋をドラッグできるようにする。
   */
  setRearrangeMode(on: boolean): void {
    if (this.rearrangeMode === on) return;
    this.rearrangeMode = on;
    if (!on) this.cancelDrag();
    for (const room of this.rooms.values()) {
      this.applyRoomInteractivity(room);
    }
  }

  /** 模様替えモードに応じて部屋コンテナの当たり判定を切り替える */
  private applyRoomInteractivity(room: RoomView): void {
    const c = room.container;
    if (this.rearrangeMode) {
      // 部屋の中身（従業員・プレート等）のクリックを止め、部屋全体をつかめるようにする。
      // interactiveChildren=false にした素のContainerは自前のジオメトリを持たず
      // ヒットテストに掛からないため、部屋の矩形をhitAreaとして明示する
      c.interactiveChildren = false;
      c.hitArea = new Rectangle(
        0,
        0,
        room.layout.rect.w * TILE,
        room.layout.rect.h * TILE
      );
      c.eventMode = "static";
      c.cursor = "grab";
    } else {
      c.interactiveChildren = true;
      c.hitArea = null;
      c.eventMode = "passive";
      c.cursor = "default";
    }
  }

  /** ブラウザ座標→ワールド座標（タイル計算用） */
  private clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      x: (sx - this.world.x) / this.world.scale.x,
      y: (sy - this.world.y) / this.world.scale.y,
    };
  }

  /** ドラッグ開始（部屋コンテナのpointerdown） */
  private beginRoomDrag(room: RoomView, e: FederatedPointerEvent): void {
    if (!this.rearrangeMode || this.drag || this.queueBusy > 0) return;

    const wx = (e.global.x - this.world.x) / this.world.scale.x;
    const wy = (e.global.y - this.world.y) / this.world.scale.y;
    this.drag = {
      room,
      grabDX: wx - room.container.x,
      grabDY: wy - room.container.y,
      origX: room.container.x,
      origY: room.container.y,
    };
    // ゴースト表現：半透明にして最前面へ
    room.container.alpha = 0.7;
    room.container.cursor = "grabbing";
    this.roomLayer.addChild(room.container);

    const onMove = (ev: PointerEvent) => this.updateRoomDrag(ev);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      void this.endRoomDrag(ev);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** ドラッグ中：部屋をポインタに追従させ、ドロップ先候補をハイライト */
  private updateRoomDrag(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const w = this.clientToWorld(ev.clientX, ev.clientY);
    drag.room.container.position.set(w.x - drag.grabDX, w.y - drag.grabDY);

    const target = this.dropTargetAt(ev.clientX, ev.clientY, drag.room.dept.id);
    this.setDropHighlight(target);
  }

  /** ポインタ位置にあるドロップ先候補（自分自身は対象外） */
  private dropTargetAt(
    clientX: number,
    clientY: number,
    draggedId: string
  ): RoomView | null {
    if (!this.layout) return null;
    const w = this.clientToWorld(clientX, clientY);
    const tx = w.x / TILE;
    const ty = w.y / TILE;
    for (const rl of this.layout.rooms) {
      if (rl.id === draggedId) continue;
      const rv = this.rooms.get(rl.id);
      if (!rv) continue;
      if (
        tx >= rl.rect.x &&
        tx < rl.rect.x + rl.rect.w &&
        ty >= rl.rect.y &&
        ty < rl.rect.y + rl.rect.h
      ) {
        return rv;
      }
    }
    return null;
  }

  /** ドロップ先候補の枠ハイライトを更新する */
  private setDropHighlight(target: RoomView | null): void {
    if (this.dropHighlight) {
      this.dropHighlight.destroy();
      this.dropHighlight = null;
    }
    if (!target) return;
    const rl = target.layout;
    const g = new Graphics();
    g.roundRect(
      rl.rect.x * TILE - 2,
      rl.rect.y * TILE - 2,
      rl.rect.w * TILE + 4,
      rl.rect.h * TILE + 4,
      4
    ).stroke({ color: 0x6fd08c, width: 3, alpha: 0.95 });
    this.actorLayer.addChild(g);
    this.dropHighlight = g;
  }

  /** ドラッグ終了：有効な部屋なら交換を依頼、無効なら元の位置へ戻す */
  private async endRoomDrag(ev: PointerEvent): Promise<void> {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.setDropHighlight(null);
    drag.room.container.alpha = 1;
    drag.room.container.cursor = "grab";

    const target = this.dropTargetAt(ev.clientX, ev.clientY, drag.room.dept.id);
    if (target && this.onRoomSwap) {
      try {
        // 呼び出し側がroomOrderを保存→新しいstateが届き、relayoutのトゥイーンで交換が完了する
        await this.onRoomSwap(drag.room.dept.id, target.dept.id);
        return;
      } catch (e) {
        console.error("[office] 部屋の交換保存に失敗:", e);
        // 失敗時は下の「元へ戻す」へフォールスルー
      }
    }
    this.tweenRoomTo(drag.room, drag.origX, drag.origY);
  }

  /** 進行中のドラッグを中断し、部屋を元の位置へ戻す（モードOFF・state更新時の安全策） */
  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.setDropHighlight(null);
    drag.room.container.alpha = 1;
    drag.room.container.cursor = "grab";
    this.tweenRoomTo(drag.room, drag.origX, drag.origY);
  }

  /** 部屋コンテナを指定位置へトゥイーンで戻す */
  private tweenRoomTo(room: RoomView, x: number, y: number): void {
    const fx = room.container.x;
    const fy = room.container.y;
    void this.tweens.add({
      duration: 300,
      easing: Easings.easeOutCubic,
      onUpdate: (t) => {
        room.container.x = lerp(fx, x, t);
        room.container.y = lerp(fy, y, t);
      },
    });
  }

  // ---- 状態反映（diff→演出発火） ----

  applyState(state: OfficeState): void {
    // 表示対象の部署だけに絞る
    const visible = new Set(state.settings.visibleDepartments);
    const filtered: OfficeState = {
      ...state,
      departments: state.departments.filter(
        (d) => visible.size === 0 || visible.has(d.id)
      ),
    };

    const diff = diffOfficeState(this.prevState, filtered);
    const isFirst = !this.prevState;
    this.prevState = filtered;

    // 部屋の並び：roomOrder優先＋残りはID昇順
    const specs: RoomSpec[] = buildRoomSpecs(
      filtered.departments.map((d) => ({
        id: d.id,
        islands: d.islands,
      })),
      filtered.settings.roomOrder ?? []
    );
    const newLayout = computeBuildingLayout(specs);

    if (isFirst) {
      // 初回：全体を演出なしで即構築
      this.layout = newLayout;
      this.drawShell(newLayout, false);
      for (const dept of filtered.departments) {
        const rl = newLayout.rooms.find((r) => r.id === dept.id)!;
        this.createRoom(dept, rl);
      }
      this.centerCamera();
      return;
    }

    // ステータス変化は即時反映（演出不要）
    for (const dc of diff.changed) {
      const room = this.rooms.get(dc.departmentId);
      if (!room) continue;
      for (const emp of dc.statusChanged) {
        const seat = room.seats.get(emp.sessionId);
        if (seat) {
          seat.employee = emp;
          this.refreshSeatStatus(seat);
        }
      }
      // 部署名の変更（エイリアス）はプレートを含む内装の再描画のみ（演出なし）
      if (dc.renamed) {
        const nextDept = filtered.departments.find((d) => d.id === dc.departmentId);
        if (nextDept) {
          room.dept = nextDept;
          this.drawRoomInterior(room);
        }
      }
    }

    // 構造変化＋入退社演出は直列キューで順番に処理（state連打による混線を防ぐ）
    this.updateQueue = this.updateQueue.then(async () => {
      this.queueBusy++; // 実行中は模様替えドラッグを受け付けない
      try {
        await this.runUpdateSequence(filtered, diff, newLayout);
      } catch (e) {
        console.error("[office] 演出シーケンスでエラー:", e);
      } finally {
        this.queueBusy--;
      }
    });
  }

  /**
   * 1回のstate更新に対する演出シーケンス。
   * 順序：部屋の追加/削除 → （増築ならカメラパン＋看板）→ 建物再配置（トゥイーン）
   *      → 業者の机搬入 → 退場演出 → 入社演出
   */
  private async runUpdateSequence(
    state: OfficeState,
    diff: ReturnType<typeof diffOfficeState>,
    newLayout: BuildingLayout
  ): Promise<void> {
    // ドラッグ途中でstateが届いた場合は安全のためドラッグを中断して元へ戻す
    this.cancelDrag();

    // 部屋の追加・削除
    for (const dept of diff.addedDepartments) {
      const rl = newLayout.rooms.find((r) => r.id === dept.id);
      if (rl) this.createRoom(dept, rl);
    }
    for (const dept of diff.removedDepartments) {
      this.removeRoom(dept.id);
    }

    // dept参照を最新化
    for (const dept of state.departments) {
      const room = this.rooms.get(dept.id);
      if (room) room.dept = dept;
    }

    const expansions = diff.changed.filter((c) => c.expanded);

    // 増築：カメラを対象部屋へパンして「増築中」看板
    const signs: Sprite[] = [];
    if (expansions.length > 0) {
      this.cameraLocked = true;
      const firstRoom = newLayout.rooms.find(
        (r) => r.id === expansions[0].departmentId
      );
      if (firstRoom) await this.panCameraToRect(firstRoom.rect);
      for (const ex of expansions) {
        const room = this.rooms.get(ex.departmentId);
        if (!room) continue;
        const sign = new Sprite(signTexture());
        sign.width = TILE * 2.4;
        sign.height = TILE * 1.4;
        sign.x = TILE * 4.5;
        sign.y = TILE * 0.3;
        room.container.addChild(sign);
        signs.push(sign);
      }
      await this.tweens.wait(500);
    }

    // 部屋の位置がレイアウト上で変わったか（模様替えの交換・roomOrder変更の反映）
    const positionsChanged = [...this.rooms.values()].some((room) => {
      const rl = newLayout.rooms.find((r) => r.id === room.dept.id);
      return (
        !!rl &&
        (rl.rect.x !== room.layout.rect.x ||
          rl.rect.y !== room.layout.rect.y ||
          rl.rect.w !== room.layout.rect.w ||
          rl.rect.h !== room.layout.rect.h)
      );
    });

    // 建物再配置（壁の拡張・部屋の移動はすべてトゥイーン）
    const structureChanged =
      diff.addedDepartments.length > 0 ||
      diff.removedDepartments.length > 0 ||
      expansions.length > 0 ||
      positionsChanged;
    if (structureChanged) {
      await this.applyLayout(newLayout, true);
    } else {
      this.layout = newLayout;
    }

    // 増築：引っ越し業者が2島目の机を搬入
    for (const ex of expansions) {
      const room = this.rooms.get(ex.departmentId);
      if (room && !room.hasIsland1Desks) {
        await this.moveInDesks(room);
      }
    }
    for (const sign of signs) sign.destroy();

    // 退場演出（並行して歩かせる）
    const walks: Promise<void>[] = [];
    for (const dc of diff.changed) {
      const room = this.rooms.get(dc.departmentId);
      if (!room) continue;
      for (const emp of dc.departed) {
        walks.push(this.playDeparture(room, emp));
      }
    }

    // 入社演出（増築部屋の新入社員もここで歩いて入る）
    for (const dc of diff.changed) {
      const room = this.rooms.get(dc.departmentId);
      if (!room) continue;
      const dept = state.departments.find((d) => d.id === dc.departmentId);
      if (!dept) continue;
      for (const emp of dc.hired) {
        walks.push(this.playHire(room, dept, emp));
      }
      this.rebuildEmptyMarkers(room);
    }

    if (expansions.length > 0) {
      this.cameraLocked = false;
    }
    await Promise.all(walks);
  }

  /**
   * 新しい間取りを反映する。部屋の位置・大きさの変化はすべてトゥイーン。
   * 増築部屋は「壁が外側へ伸びる」ように、新しい内装を矩形マスクで徐々に開いて見せる。
   */
  private async applyLayout(newLayout: BuildingLayout, animate: boolean): Promise<void> {
    this.layout = newLayout;
    this.drawShell(newLayout, animate); // 外壁・廊下はクロスフェードで差し替え

    const jobs: Promise<void>[] = [];
    for (const room of this.rooms.values()) {
      const rl = newLayout.rooms.find((r) => r.id === room.dept.id);
      if (!rl) continue;
      const grew = rl.islands !== room.layout.islands;
      room.layout = rl;
      // 部屋サイズが変わってもドラッグ用hitAreaが古くならないよう反映し直す
      this.applyRoomInteractivity(room);

      // 位置の移動（トゥイーン。瞬間移動禁止）
      const tx = rl.rect.x * TILE;
      const ty = rl.rect.y * TILE;
      if (animate && (room.container.x !== tx || room.container.y !== ty)) {
        const fx = room.container.x;
        const fy = room.container.y;
        jobs.push(
          this.tweens.add({
            duration: 700,
            easing: Easings.easeInOutQuad,
            onUpdate: (t) => {
              room.container.x = lerp(fx, tx, t);
              room.container.y = lerp(fy, ty, t);
            },
          })
        );
      } else {
        room.container.position.set(tx, ty);
      }

      // 増築：内装を新サイズで再描画し、マスクを廊下と反対側へ開いて壁の拡張を見せる。
      // 下段の部屋は下方向（上端が廊下に固定）、上段の部屋は上方向（下端が廊下に固定）へ伸びる。
      if (grew) {
        const oldH = roomHeight(1) * TILE;
        const newH = rl.rect.h * TILE;
        this.drawRoomInterior(room);
        const maskRect = (h: number) =>
          rl.row === "top"
            ? { y: newH - h, h } // 上段：下端を基点に上へ開く
            : { y: 0, h }; // 下段：上端を基点に下へ開く
        const mask = new Graphics();
        const m0 = maskRect(oldH);
        mask.rect(0, m0.y, rl.rect.w * TILE, m0.h).fill(0xffffff);
        room.container.addChild(mask);
        room.container.mask = mask;
        jobs.push(
          this.tweens
            .add({
              duration: 900,
              easing: Easings.easeInOutQuad,
              onUpdate: (t) => {
                const m = maskRect(lerp(oldH, newH, t));
                mask.clear();
                mask.rect(0, m.y, rl.rect.w * TILE, m.h).fill(0xffffff);
              },
            })
            .then(() => {
              room.container.mask = null;
              mask.destroy();
            })
        );
      }
    }
    await Promise.all(jobs);
  }

  // ---- 建物の外殻（外壁・横廊下・西エントランス・廊下の飾り） ----

  private drawShell(layout: BuildingLayout, crossfade: boolean): void {
    const old = this.shellLayer.children.slice();
    const shell = new Container();

    const W = layout.widthTiles * TILE;
    const H = layout.heightTiles * TILE;

    const g = new Graphics();
    // 建物の外周トリム（縁取り）
    g.rect(-4, -4, W + 8, H + 8).fill(WALL_TRIM);
    // 全面を壁色で下塗り（部屋が無い領域＝プラザや外壁が見える）
    g.rect(0, 0, W, H).fill(WALL_FACE);
    // 上端の濃色トリム
    g.rect(0, 0, W, 6).fill(WALL_TRIM);
    shell.addChild(g);

    // 廊下の床（横に貫通。西端はエントランス開口として外壁ぶんまで敷く）
    const corridor = new TilingSprite({
      texture: floorTexture("corridor"),
      width: (layout.widthTiles - 1) * TILE,
      height: CORRIDOR_H * TILE,
    });
    corridor.tileScale.set(0.5); // 32pxパターンを16pxタイル相当に
    corridor.x = 0;
    corridor.y = layout.corridorY * TILE;
    shell.addChild(corridor);

    // 段の右端が揃わない部分はプラザ（多目的スペース）として床を敷く
    const topRooms = layout.rooms.filter((r) => r.row === "top");
    const botRooms = layout.rooms.filter((r) => r.row === "bottom");
    const topEnd = Math.max(1, ...topRooms.map((r) => r.rect.x + r.rect.w));
    const botEnd = Math.max(1, ...botRooms.map((r) => r.rect.x + r.rect.w));
    const rightWallX = layout.widthTiles - 1;
    const plazaAreas: { x: number; y: number; w: number; h: number }[] = [];
    if (topEnd < rightWallX) {
      // 上段のプラザは廊下の上に接する帯
      const py = Math.max(1, layout.corridorY - 5);
      plazaAreas.push({ x: topEnd, y: py, w: rightWallX - topEnd, h: layout.corridorY - py });
    }
    if (botEnd < rightWallX) {
      const py = layout.corridorY + CORRIDOR_H;
      const ph = Math.min(5, layout.heightTiles - 1 - py);
      plazaAreas.push({ x: botEnd, y: py, w: rightWallX - botEnd, h: ph });
    }
    for (const area of plazaAreas) {
      if (area.w <= 0 || area.h <= 0) continue;
      const plaza = new TilingSprite({
        texture: floorTexture("plaza"),
        width: area.w * TILE,
        height: area.h * TILE,
      });
      plaza.tileScale.set(0.5);
      plaza.x = area.x * TILE;
      plaza.y = area.y * TILE;
      shell.addChild(plaza);
      // プラザの飾り：大きめの観葉植物とソファ
      if (area.w >= 4 && area.h >= 3) {
        const pl = new Sprite(plantTexture(1));
        pl.width = TILE * 1.1;
        pl.height = TILE * 1.9;
        pl.x = (area.x + 0.5) * TILE;
        pl.y = (area.y + 0.4) * TILE;
        shell.addChild(pl);
        const sofa = new Sprite(sofaTexture());
        sofa.width = TILE * 2.4;
        sofa.height = TILE * 1.3;
        sofa.x = (area.x + 2) * TILE;
        sofa.y = (area.y + area.h - 1.6) * TILE;
        shell.addChild(sofa);
      }
    }

    // 西端のエントランス開口（左外壁の廊下部分をくり抜いた印象にする）
    const ent = new Graphics();
    ent
      .rect(0, layout.corridorY * TILE, 4, CORRIDOR_H * TILE)
      .fill(0xcfc8ba);
    shell.addChild(ent);

    // エントランスマット（縦長・青）
    const mat = new Graphics();
    mat
      .rect(3, layout.corridorY * TILE + 5, TILE * 1.2, CORRIDOR_H * TILE - 10)
      .fill(0x5aa9e6);
    mat
      .rect(3, layout.corridorY * TILE + 5, 3, CORRIDOR_H * TILE - 10)
      .fill(0x7fc4f2);
    shell.addChild(mat);
    const entText = crispText("ENTRANCE", {
      fontSize: 5,
      fill: 0x6a6074,
      fontFamily: "monospace",
      fontWeight: "bold",
    });
    entText.x = TILE * 1.6;
    entText.y = (layout.corridorY + CORRIDOR_H - 0.55) * TILE;
    shell.addChild(entText);

    // 廊下の飾り：ドアの列を避けて観葉植物を上下縁に交互に置く＋東端に自販機
    const doorCols = new Set<number>();
    for (const r of layout.rooms) {
      doorCols.add(r.door.x);
      doorCols.add(r.door.x + 1);
    }
    let side = 0;
    for (let x = 4; x < layout.widthTiles - 4; x += 6) {
      if (doorCols.has(x) || doorCols.has(x - 1) || doorCols.has(x + 1)) continue;
      const py = side % 2 === 0 ? layout.corridorY : layout.corridorY + CORRIDOR_H - 1;
      const plant = new Sprite(plantTexture(side % 2 === 0 ? 2 : 0));
      plant.width = TILE * 0.9;
      plant.height = TILE * (side % 2 === 0 ? 0.8 : 0.7);
      plant.x = (x + 0.05) * TILE;
      plant.y = (py + 0.2) * TILE;
      shell.addChild(plant);
      side++;
    }
    const vend = new Sprite(vendingTexture());
    vend.width = TILE * 1.0;
    vend.height = TILE * 1.8;
    vend.x = (rightWallX - 1.2) * TILE;
    vend.y = (layout.corridorY + 0.7) * TILE;
    shell.addChild(vend);

    // 差し替え（クロスフェード）
    this.shellLayer.addChild(shell);
    if (crossfade && old.length > 0) {
      shell.alpha = 0;
      this.tweens.add({
        duration: 500,
        easing: Easings.linear,
        onUpdate: (t) => {
          shell.alpha = t;
          for (const c of old) c.alpha = 1 - t;
        },
        onComplete: () => {
          for (const c of old) c.destroy({ children: true });
        },
      });
    } else {
      for (const c of old) c.destroy({ children: true });
    }
  }

  // ---- 部屋の生成・内装 ----

  private createRoom(dept: Department, rl: RoomLayout): void {
    const container = new Container();
    container.position.set(rl.rect.x * TILE, rl.rect.y * TILE);
    const bgLayer = new Container();
    const itemsLayer = new Container();
    itemsLayer.sortableChildren = true;
    const emptyMarkers = new Container();
    container.addChild(bgLayer);
    container.addChild(itemsLayer);
    container.addChild(emptyMarkers);

    const room: RoomView = {
      dept,
      layout: rl,
      container,
      bgLayer,
      itemsLayer,
      furniture: [],
      seats: new Map(),
      emptyMarkers,
      hasIsland1Desks: rl.islands === 2, // 初期から2島なら机は設置済み扱い
    };
    this.roomLayer.addChild(container);
    this.rooms.set(dept.id, room);

    // 模様替えモード用：部屋全体のドラッグ開始ハンドラ（モードOFF時はイベント無効）
    container.on("pointerdown", (e: FederatedPointerEvent) =>
      this.beginRoomDrag(room, e)
    );
    this.applyRoomInteractivity(room);

    this.drawRoomInterior(room);
    // 既存従業員を着席させる（演出なし）
    dept.employees.forEach((emp, idx) => {
      if (idx < rl.seats.length) {
        const seat = this.createSeat(room, emp, idx);
        room.seats.set(emp.sessionId, seat);
      }
    });
    this.rebuildEmptyMarkers(room);
  }

  /** 部屋の床・壁・ヘッダー（プレート/掲示板）・家具を（再）描画する */
  private drawRoomInterior(room: RoomView): void {
    const rl = room.layout;
    const wT = rl.rect.w * TILE;
    const hT = rl.rect.h * TILE;

    // 背景層と家具をリセット（席はitemsLayerに残す）
    for (const c of room.bgLayer.removeChildren()) c.destroy({ children: true });
    for (const f of room.furniture) f.destroy({ children: true });
    room.furniture = [];

    const g = new Graphics();
    // 壁の下地（全体）
    g.rect(0, 0, wT, hT).fill(WALL_FACE);
    // 上端の濃色トリム
    g.rect(0, 0, wT, 5).fill(WALL_TRIM);
    // ヘッダー帯の下端の影
    g.rect(0, 2 * TILE - 3, wT, 3).fill(WALL_SHADE);
    // 側壁の内側の影
    g.rect(0, 0, 3, hT).fill(WALL_SHADE);
    g.rect(wT - 3, 0, 3, hT).fill(WALL_SHADE);
    // 下壁
    g.rect(0, hT - TILE, wT, TILE).fill(WALL_FACE);
    g.rect(0, hT - 4, wT, 4).fill(WALL_TRIM);
    room.bgLayer.addChild(g);

    // 床（部署ごとに変える：木目/カーペット交互）
    const floorKind = this.floorKindFor(room.dept);
    const floor = new TilingSprite({
      texture: floorTexture(floorKind),
      width: rl.innerW * TILE,
      height: rl.innerH * TILE,
    });
    floor.tileScale.set(0.5);
    floor.x = (rl.innerX - rl.rect.x) * TILE;
    floor.y = (rl.innerY - rl.rect.y) * TILE;
    room.bgLayer.addChild(floor);

    // ドア開口（廊下側の壁・西端列の2タイル幅をくり抜き、廊下の床を見せる）
    // 上段の部屋＝下壁（1タイル厚）、下段の部屋＝ヘッダー帯（2タイル厚）に開口する
    const doorLocalX = (rl.door.x - rl.rect.x) * TILE;
    const doorG = new Graphics();
    if (rl.row === "top") {
      doorG.rect(doorLocalX, hT - TILE, TILE * 2, TILE).fill(0xded8cc);
      // 開口の左右の枠
      doorG.rect(doorLocalX - 3, hT - TILE, 3, TILE).fill(WALL_TRIM);
      doorG.rect(doorLocalX + TILE * 2, hT - TILE, 3, TILE).fill(WALL_TRIM);
    } else {
      doorG.rect(doorLocalX, 0, TILE * 2, TILE * HEADER_H).fill(0xded8cc);
      doorG.rect(doorLocalX - 3, 0, 3, TILE * HEADER_H).fill(WALL_TRIM);
      doorG.rect(doorLocalX + TILE * 2, 0, 3, TILE * HEADER_H).fill(WALL_TRIM);
    }
    room.bgLayer.addChild(doorG);

    // ---- ヘッダーの動的レイアウト（プレート→掲示板の順に配置し、重なりを避ける） ----
    // 下段の部屋はヘッダー帯の西端がドア開口なので、プレートはドアの右から始まる。
    // 部署名が長いと右側の掲示板・株価モニターと衝突するため、
    // 1) プレートはヘッダー幅の約55%で「…」省略  2) 掲示板はプレートの右端より右へ、
    // 3) 右側の限界（投資部屋=モニター左端−4px、通常=右壁−4px）に入り切らなければ非表示にする。

    // 部署名プレート（白地に木枠。クリックで部署名の変更モーダル）
    const plateX = rl.row === "bottom" ? doorLocalX + TILE * 2 + 8 : TILE * 0.6;
    const nameText = crispText(room.dept.name, {
      fontSize: 9,
      fill: 0x3a3244,
      fontFamily: "monospace",
      fontWeight: "bold",
    });
    // 表示名がヘッダー幅の約55%を超える場合は「…」で省略（フルネームは部署名変更モーダルで確認できる）
    const maxNameW = wT * 0.55;
    if (nameText.width > maxNameW) {
      let label = room.dept.name;
      while (label.length > 1 && nameText.width > maxNameW) {
        label = label.slice(0, -1);
        nameText.text = label + "…";
      }
    }
    nameText.x = plateX;
    nameText.y = 9;
    const plateBg = new Graphics();
    plateBg
      .roundRect(nameText.x - 4, nameText.y - 3, nameText.width + 8, nameText.height + 6, 2)
      .fill(0xffffff)
      .stroke({ color: 0x8c5a33, width: 1 });
    const plate = new Container();
    plate.addChild(plateBg);
    plate.addChild(nameText);
    plate.eventMode = "static";
    plate.cursor = "pointer";
    plate.on("pointertap", () => this.onPlateClick?.(room.dept));
    room.bgLayer.addChild(plate);
    const plateRight = nameText.x + nameText.width + 4; // 白枠の右端

    // 掲示板（ホバー/クリックでsummary表示）。プレートと重なる場合は右へ逃がし、
    // 限界を超えるなら非表示（summaryは従業員ホバーのツールチップでも見られる）
    const boardW = TILE * 2.6;
    const desiredBoardX = wT - TILE * 3.2;
    const boardX = Math.max(desiredBoardX, plateRight + 6);
    const boardLimitRight = wT - 4;
    if (boardX + boardW <= boardLimitRight) {
      const board = new Sprite(boardTexture());
      board.width = boardW;
      board.height = TILE * 1.2;
      board.x = boardX;
      board.y = 7;
      board.eventMode = "static";
      board.cursor = "pointer";
      board.on("pointerover", () =>
        this.onBoardHover?.(room.dept, this.roomSummary(room.dept))
      );
      board.on("pointerout", () => this.onBoardHover?.(room.dept, null));
      room.bgLayer.addChild(board);
    }

    // ---- 家具 ----
    const innerLX = (rl.innerX - rl.rect.x) * TILE; // 内装原点（ローカルpx）
    const innerLY = (rl.innerY - rl.rect.y) * TILE;

    // 机（島0は常設。島1は搬入済みの場合のみ）
    for (const desk of rl.desks) {
      if (desk.island === 1 && !room.hasIsland1Desks) continue;
      this.addDeskSprite(room, desk.x, desk.y, desk.view);
    }

    // 休憩コーナー（右側の空きスペース）：本棚・ソファ・ローテーブル・植物
    const fx = innerLX + 7 * TILE; // 内寸の7列目から
    this.addFurniture(room, new Sprite(bookshelfTexture(this.hashId(room.dept.id))), fx + TILE * 0.6, innerLY + TILE * 0.9, TILE * 1.8, TILE * 2.6, 3);
    this.addFurniture(room, new Sprite(plantTexture(1)), fx + TILE * 2.5, innerLY + TILE * 3.6, TILE * 0.9, TILE * 1.6, 5);
    this.addFurniture(room, new Sprite(sofaTexture()), fx + TILE * 0.3, innerLY + TILE * 5.2, TILE * 2.4, TILE * 1.3, 7);
    this.addFurniture(room, new Sprite(tableTexture()), fx + TILE * 0.7, innerLY + TILE * 6.6, TILE * 1.6, TILE * 0.8, 8);

    if (rl.islands === 2) {
      // 2島の部屋は下半分にも家具を足して賑やかに
      this.addFurniture(room, new Sprite(whiteboardTexture()), fx + TILE * 0.5, innerLY + TILE * 8.6, TILE * 1.9, TILE * 1.3, 10);
      this.addFurniture(room, new Sprite(vendingTexture()), fx + TILE * 2.4, innerLY + TILE * 10.6, TILE * 1.0, TILE * 1.8, 12);
      this.addFurniture(room, new Sprite(plantTexture(2)), fx + TILE * 0.6, innerLY + TILE * 13.2, TILE * 1.0, TILE * 0.9, 15);
    }
  }

  /** 家具スプライトを接地影付きでitemsLayerへ追加 */
  private addFurniture(
    room: RoomView,
    sprite: Sprite,
    x: number,
    y: number,
    w: number,
    h: number,
    zRow: number
  ): void {
    const c = new Container();
    const shadow = new Graphics();
    shadow.ellipse(w / 2, h - 1, w * 0.45, 2.5).fill({ color: 0x3a3244, alpha: 0.18 });
    c.addChild(shadow);
    sprite.width = w;
    sprite.height = h;
    c.addChild(sprite);
    c.position.set(x, y);
    c.zIndex = zRow;
    room.itemsLayer.addChild(c);
    room.furniture.push(c);
  }

  /** 机スプライト（3x2タイル）をitemsLayerへ追加 */
  private addDeskSprite(
    room: RoomView,
    tileX: number,
    tileY: number,
    view: "screen" | "back"
  ): Container {
    const rl = room.layout;
    const c = new Container();
    const shadow = new Graphics();
    shadow
      .ellipse(TILE * 1.5, TILE * 2 - 2, TILE * 1.3, 3)
      .fill({ color: 0x3a3244, alpha: 0.18 });
    c.addChild(shadow);
    const desk = new Sprite(deskTexture(view));
    desk.width = TILE * 3;
    desk.height = TILE * 2;
    c.addChild(desk);
    c.position.set((tileX - rl.rect.x) * TILE, (tileY - rl.rect.y) * TILE);
    c.zIndex = tileY - rl.rect.y + 1; // 机の下端行でソート
    room.itemsLayer.addChild(c);
    room.furniture.push(c);
    return c;
  }

  /** 部署→床の種類 */
  private floorKindFor(dept: Department): FloorKind {
    return this.hashId(dept.id) % 2 === 0 ? "wood" : "carpet-blue";
  }

  private hashId(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // ---- 席（椅子＋キャラ＋バッジ） ----

  private createSeat(room: RoomView, emp: Employee, seatIdx: number): SeatView {
    const rl = room.layout;
    const spot = rl.seats[seatIdx];
    const facing = spot.facing;
    const container = new Container();
    container.position.set((spot.x - rl.rect.x) * TILE, (spot.y - rl.rect.y) * TILE);
    container.zIndex = spot.y - rl.rect.y;

    // 椅子（キャラの足元）
    const chair = new Sprite(chairTexture());
    chair.width = TILE * 0.75;
    chair.height = TILE * 0.4;
    chair.x = TILE * 0.125;
    chair.y = TILE * 0.62;
    container.addChild(chair);

    // キャラ（向き付き：北席=正面が見える、南席=後ろ姿。resting時は目を閉じた見た目）
    const char = new Sprite(
      charTexture(
        emp.spriteSeed,
        facing === "down" ? "front" : "back",
        false,
        emp.status === "resting"
      )
    );
    char.width = TILE;
    char.height = TILE * 1.15;
    char.x = 0;
    char.y = -TILE * 0.15;
    container.addChild(char);

    // ステータスバッジ
    const badge = new Graphics();
    badge.circle(0, 0, 2.6).fill(STATUS_COLORS[emp.status]).stroke({ color: 0xffffff, width: 0.8 });
    badge.x = TILE / 2;
    badge.y = -TILE * 0.28;
    container.addChild(badge);

    // Zzz（resting時）
    const zzz = crispText("Zzz", {
      fontSize: 6,
      fill: 0xdfe4f0,
      fontFamily: "monospace",
    });
    zzz.x = TILE * 0.65;
    zzz.y = -TILE * 0.62;
    zzz.visible = emp.status === "resting";
    container.addChild(zzz);

    const seat: SeatView = {
      employee: emp,
      seatIdx,
      container,
      charSprite: char,
      badge,
      zzz,
      facing,
      animPhase: Math.random() * Math.PI * 2,
      homeX: 0,
      homeY: -TILE * 0.15,
      speechBubble: null,
    };

    // クリックでターミナルを開く／ホバーでリッチツールチップ
    char.eventMode = "static";
    char.cursor = "pointer";
    char.on("pointertap", () =>
      this.onEmployeeClick?.({ department: room.dept, employee: seat.employee })
    );
    char.on("pointerover", () =>
      this.onEmployeeHover?.(room.dept, seat.employee)
    );
    char.on("pointerout", () => this.onEmployeeHover?.(room.dept, null));

    room.itemsLayer.addChild(container);
    return seat;
  }

  /** 空席マーカー（椅子＋「＋」バッジ。クリックで雇用） */
  private rebuildEmptyMarkers(room: RoomView): void {
    for (const c of room.emptyMarkers.removeChildren()) c.destroy({ children: true });
    const rl = room.layout;
    // 2島目の机が未搬入なら島0の4席まで
    const capacity = room.hasIsland1Desks ? rl.seats.length : Math.min(4, rl.seats.length);
    const used = new Set([...room.seats.values()].map((s) => s.seatIdx));
    for (let idx = 0; idx < capacity; idx++) {
      if (used.has(idx)) continue;
      const spot = rl.seats[idx];
      const c = new Container();
      c.position.set((spot.x - rl.rect.x) * TILE, (spot.y - rl.rect.y) * TILE);
      const chair = new Sprite(chairTexture());
      chair.width = TILE * 0.75;
      chair.height = TILE * 0.4;
      chair.x = TILE * 0.125;
      chair.y = TILE * 0.62;
      chair.alpha = 0.9;
      c.addChild(chair);
      const bubble = new Graphics();
      bubble
        .circle(TILE / 2, TILE * 0.28, 5)
        .fill({ color: 0xffffff, alpha: 0.92 })
        .stroke({ color: 0x6fd08c, width: 1 });
      c.addChild(bubble);
      const plus = crispText("＋", {
        fontSize: 8,
        fill: 0x3aa55a,
        fontFamily: "monospace",
        fontWeight: "bold",
      });
      plus.x = TILE / 2 - 4.5;
      plus.y = TILE * 0.28 - 5;
      c.addChild(plus);
      c.eventMode = "static";
      c.cursor = "pointer";
      c.on("pointertap", () => this.onEmptySeatClick?.({ department: room.dept }));
      room.emptyMarkers.addChild(c);
    }
  }

  /** 席のステータス表示（バッジ色・Zzz）を更新 */
  private refreshSeatStatus(seat: SeatView): void {
    const st = seat.employee.status;
    seat.badge.clear();
    seat.badge.circle(0, 0, 2.6).fill(STATUS_COLORS[st]).stroke({ color: 0xffffff, width: 0.8 });
    seat.zzz.visible = st === "resting";
    if (st !== "working") {
      seat.charSprite.texture = charTexture(
        seat.employee.spriteSeed,
        seat.facing === "down" ? "front" : "back",
        false,
        st === "resting"
      );
    }
  }

  /** 承認待ち・完了報告の吹き出しを表示する（外部＝main.tsから呼ばれる） */
  showSpeechBubble(
    departmentId: string,
    sessionId: string,
    kind: "permission" | "done",
    text: string
  ): void {
    const room = this.rooms.get(departmentId);
    const seat = room?.seats.get(sessionId);
    if (room && seat) this.showSpeechBubbleOnSeat(room, seat, kind, text);
  }

  /**
   * 吹き出しの表示位置（ワールド座標）を計算する。
   * 部屋間をまたいで表示されるため座席コンテナ（部屋ローカル）ではなく
   * actorLayer（建物座標＝最前面）に置く必要があり、その位置決めに使う。
   */
  private speechBubblePosition(
    room: RoomView,
    seat: SeatView,
    bubbleWidth: number
  ): { x: number; y: number } {
    const worldX = room.container.x + seat.container.x + seat.charSprite.x;
    const worldY = room.container.y + seat.container.y + seat.charSprite.y;
    return {
      x: worldX + TILE / 2 - bubbleWidth / 2,
      y: worldY - TILE * 1.5,
    };
  }

  private showSpeechBubbleOnSeat(
    room: RoomView,
    seat: SeatView,
    kind: "permission" | "done",
    text: string
  ): void {
    if (seat.speechBubble) {
      seat.speechBubble.destroy({ children: true });
      seat.speechBubble = null;
    }
    const icon = kind === "permission" ? "🔧" : "✅";
    const label = crispText(`${icon} ${text}`, {
      fontSize: 6.5,
      fill: 0x2a2f3a,
      fontFamily: "monospace",
      wordWrap: true,
      wordWrapWidth: 90,
    });
    const pad = 4;
    const bg = new Graphics();
    bg.roundRect(-pad, -pad, label.width + pad * 2, label.height + pad * 2, 3)
      .fill({ color: kind === "permission" ? 0xfff2c4 : 0xd8f2df, alpha: 0.96 })
      .stroke({
        color: kind === "permission" ? 0xe8c020 : 0x6fd08c,
        width: 1,
      });
    const bubble = new Container();
    bubble.addChild(bg);
    bubble.addChild(label);
    // 他の部屋の家具・壁の下に隠れないよう、部屋のitemsLayerではなく
    // actorLayer（建物全体で最前面）にワールド座標で配置する。
    const pos = this.speechBubblePosition(room, seat, label.width);
    bubble.position.set(pos.x, pos.y);
    this.actorLayer.addChild(bubble);
    seat.speechBubble = bubble;

    const durationMs = kind === "permission" ? 20000 : 6000;
    void this.tweens.wait(durationMs).then(() => {
      if (seat.speechBubble !== bubble) return; // 既に新しい吹き出しに差し替わっていたら何もしない
      void this.tweens.add({
        duration: 400,
        easing: Easings.linear,
        onUpdate: (t) => {
          bubble.alpha = 1 - t;
        },
        onComplete: () => {
          bubble.destroy({ children: true });
          if (seat.speechBubble === bubble) seat.speechBubble = null;
        },
      });
    });
  }

  // ---- 毎フレームの従業員アニメーション ----

  private updateEmployeeAnimations(dt: number): void {
    for (const room of this.rooms.values()) {
      for (const seat of room.seats.values()) {
        seat.animPhase += dt * 0.005;
        const st = seat.employee.status;
        const face = seat.facing === "down" ? "front" : "back";
        if (st === "working") {
          // タイピング：2フレームでテクスチャを切り替え＋小さく揺れる
          const phase = Math.floor(seat.animPhase * 2) % 2;
          seat.charSprite.texture = charTexture(seat.employee.spriteSeed, face, phase === 0);
          seat.charSprite.y = seat.homeY + Math.sin(seat.animPhase * 4) * 0.5;
        } else if (st === "resting") {
          // 寝ている間は徘徊せず座席に固定する（Zzzの明滅のみ継続）
          seat.charSprite.x = seat.homeX;
          seat.charSprite.y = seat.homeY;
          seat.zzz.alpha = 0.5 + 0.5 * Math.sin(seat.animPhase * 1.5);
        } else {
          // waiting：ときどき見回す微小な横揺れ
          seat.charSprite.x = seat.homeX + Math.sin(seat.animPhase) * 0.4;
          seat.charSprite.y = seat.homeY;
        }

        // 吹き出し表示中は、部屋の移動・座席アニメーションに追従させる
        // （actorLayerのワールド座標に置いているため毎フレーム再計算が必要）
        if (seat.speechBubble) {
          const label = seat.speechBubble.children[1];
          const bubbleWidth = label instanceof Text ? label.width : 0;
          const pos = this.speechBubblePosition(room, seat, bubbleWidth);
          seat.speechBubble.position.set(pos.x, pos.y);
        }
      }
    }
  }

  // ---- 歩行アニメーション（経路のウェイポイントに沿って移動） ----

  /**
   * アクター（Container）を建物タイル経路に沿って等速で歩かせる。
   * onDir で移動方向を通知（キャラの向き・左右反転に使う）。
   */
  private async walkAlong(
    actor: Container,
    points: PathPoint[],
    msPerTile: number,
    onDir?: (dx: number, dy: number) => void
  ): Promise<void> {
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1];
      const to = points[i];
      const dist = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
      if (dist === 0) continue;
      onDir?.(Math.sign(to.x - from.x), Math.sign(to.y - from.y));
      const fx = (from.x + 0.5) * TILE;
      const fy = (from.y + 0.9) * TILE;
      const tx = (to.x + 0.5) * TILE;
      const ty = (to.y + 0.9) * TILE;
      await this.tweens.add({
        duration: dist * msPerTile,
        easing: Easings.linear,
        onUpdate: (t) => {
          actor.x = lerp(fx, tx, t);
          actor.y = lerp(fy, ty, t);
        },
      });
    }
  }

  /** 歩行キャラのアクターを作る（足元基準、ぴょこぴょこ跳ねる） */
  private makeWalkerActor(seed: number): {
    actor: Container;
    setDir: (dx: number, dy: number) => void;
    dispose: () => void;
  } {
    const actor = new Container();
    const char = new Sprite(charTexture(seed, "front"));
    char.width = TILE;
    char.height = TILE * 1.15;
    char.x = -TILE / 2;
    char.y = -TILE * 1.05;
    actor.addChild(char);
    this.actorLayer.addChild(actor);

    // 歩行中のぴょこぴょこ跳ね
    let bobPhase = 0;
    const bob = () => {
      bobPhase += this.app.ticker.deltaMS * 0.02;
      char.y = -TILE * 1.05 - Math.abs(Math.sin(bobPhase)) * 1.5;
    };
    this.app.ticker.add(bob);

    return {
      actor,
      setDir: (dx, dy) => {
        // 上向き移動は後ろ姿、それ以外は正面。左移動は反転
        char.texture = charTexture(seed, dy < 0 ? "back" : "front");
        char.scale.x = Math.abs(char.scale.x) * (dx < 0 ? -1 : 1);
        char.x = dx < 0 ? TILE / 2 : -TILE / 2;
      },
      dispose: () => {
        this.app.ticker.remove(bob);
        actor.destroy({ children: true });
      },
    };
  }

  // ---- 演出1：入社ウォークイン ----

  /**
   * 新入社員がエントランスから廊下を歩き、ドアをくぐって自席へ→着席→モニター点灯。
   * ターミナルは呼び出し側で即開くのでこの演出は待たなくてよい。
   */
  private async playHire(room: RoomView, dept: Department, emp: Employee): Promise<void> {
    if (!this.layout) return;
    const idx = dept.employees.findIndex((e) => e.sessionId === emp.sessionId);
    if (idx < 0 || idx >= room.layout.seats.length) return;
    if (room.seats.has(emp.sessionId)) return; // 二重演出防止
    const spot = room.layout.seats[idx];

    const path = fullPath(this.layout, room.layout, { x: spot.x, y: spot.y });
    // 経路が長くても2〜3秒に収まるよう速度を調整
    const ms = Math.min(WALK_MS_PER_TILE, 2600 / Math.max(1, pathLength(path)));
    const walker = this.makeWalkerActor(emp.spriteSeed);
    walker.actor.position.set((path[0].x + 0.5) * TILE, (path[0].y + 0.9) * TILE);

    await this.walkAlong(walker.actor, path, ms, walker.setDir);
    walker.dispose();

    // 着席（ぽんと座る）＋モニター点灯フラッシュ
    const seat = this.createSeat(room, emp, idx);
    room.seats.set(emp.sessionId, seat);
    seat.container.scale.set(0.2);
    await this.tweens.add({
      duration: 350,
      easing: Easings.easeOutBack,
      onUpdate: (t) => {
        seat.container.scale.set(lerp(0.2, 1, t));
      },
    });
    seat.container.scale.set(1);
    this.flashMonitor(room, spot);
    this.rebuildEmptyMarkers(room);
    this.refreshSeatStatus(seat);
  }

  /** 着席時にデスクのモニターが点灯する光のフラッシュ */
  private flashMonitor(room: RoomView, spot: SeatSpot): void {
    const rl = room.layout;
    // 席の向きの先にある机のモニターあたりを光らせる
    const dy = spot.facing === "down" ? 1.6 : -1.2;
    const glow = new Graphics();
    glow
      .circle((spot.x - rl.rect.x + 0.5) * TILE, (spot.y - rl.rect.y + dy) * TILE, TILE * 0.7)
      .fill({ color: 0xa8e4ff, alpha: 0.55 });
    glow.zIndex = 99;
    room.itemsLayer.addChild(glow);
    this.tweens.add({
      duration: 600,
      easing: Easings.easeOutCubic,
      onUpdate: (t) => {
        glow.alpha = 1 - t;
        glow.scale.set(1 + t * 0.4);
      },
      onComplete: () => glow.destroy(),
    });
  }

  // ---- 演出3：退場（ドア→廊下→エントランスから去る） ----

  private async playDeparture(room: RoomView, emp: Employee): Promise<void> {
    const seat = room.seats.get(emp.sessionId);
    if (!seat || !this.layout) return;
    room.seats.delete(emp.sessionId);
    const rl = room.layout;
    const spot = rl.seats[seat.seatIdx] ?? rl.seats[0];

    // 席のキャラを消して歩行アクターに差し替える
    seat.container.destroy({ children: true });
    const walker = this.makeWalkerActor(emp.spriteSeed);
    const path = exitPath(this.layout, rl, { x: spot.x, y: spot.y });
    walker.actor.position.set((path[0].x + 0.5) * TILE, (path[0].y + 0.9) * TILE);

    await this.walkAlong(walker.actor, path, WALK_MS_PER_TILE, walker.setDir);
    walker.dispose();
    this.rebuildEmptyMarkers(room);
  }

  // ---- 演出2：増築（引っ越し業者の机搬入） ----

  /**
   * 引っ越し業者が台車に机を載せてエントランスから搬入し、
   * 2島目の位置に設置（砂ぼこり）して退場する。4台を少しずつずらして並行搬入
   * （直列だと長すぎるため。全体で4〜5秒に収める）。
   */
  private async moveInDesks(room: RoomView): Promise<void> {
    if (!this.layout) return;
    const rl = room.layout;
    const targets = rl.desks.filter((d) => d.island === 1);

    const jobs = targets.map((desk, i) =>
      (async () => {
        await this.tweens.wait(1 + i * 450); // 業者を少しずつずらして出発

        // 業者＋台車＋机のアクター
        const crew = new Container();
        const cart = new Sprite(cartTexture());
        cart.width = TILE * 1.1;
        cart.height = TILE * 0.75;
        cart.x = -TILE * 0.1;
        cart.y = -TILE * 0.7;
        const miniDesk = new Sprite(deskTexture("back"));
        miniDesk.width = TILE * 1.0;
        miniDesk.height = TILE * 0.66;
        miniDesk.x = -TILE * 0.05;
        miniDesk.y = -TILE * 1.1;
        const mover = new Sprite(moverTexture());
        mover.width = TILE * 0.95;
        mover.height = TILE * 1.05;
        mover.x = -TILE * 0.95;
        mover.y = -TILE * 1.0;
        crew.addChild(cart);
        crew.addChild(miniDesk);
        crew.addChild(mover);
        this.actorLayer.addChild(crew);

        // 搬入経路（机の設置タイルへ）
        const path = fullPath(this.layout!, rl, { x: desk.x + 1, y: desk.y });
        crew.position.set((path[0].x + 0.5) * TILE, (path[0].y + 0.9) * TILE);
        await this.walkAlong(crew, path, MOVER_MS_PER_TILE);

        // 机を設置：本物の机スプライトをフェードイン＋砂ぼこり
        miniDesk.visible = false;
        const placed = this.addDeskSprite(room, desk.x, desk.y, desk.view);
        placed.alpha = 0;
        const dust = this.makeDust(
          (desk.x - rl.rect.x + 1.5) * TILE,
          (desk.y - rl.rect.y + 1.5) * TILE
        );
        room.itemsLayer.addChild(dust);
        await this.tweens.add({
          duration: 400,
          easing: Easings.easeOutCubic,
          onUpdate: (t) => {
            placed.alpha = t;
            dust.alpha = 1 - t;
            dust.scale.set(1 + t * 1.6);
          },
        });
        dust.destroy();

        // 業者は同じ経路を戻って退場
        const back = path.slice().reverse();
        await this.walkAlong(crew, back, MOVER_MS_PER_TILE);
        crew.destroy({ children: true });
      })()
    );

    await Promise.all(jobs);
    room.hasIsland1Desks = true;
    this.rebuildEmptyMarkers(room);
  }

  /** 砂ぼこりエフェクト */
  private makeDust(x: number, y: number): Container {
    const c = new Container();
    c.position.set(x, y);
    const g = new Graphics();
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      g.circle(Math.cos(ang) * 4, Math.sin(ang) * 3, 2).fill({ color: 0xe8dcc0, alpha: 0.8 });
    }
    c.zIndex = 99;
    c.addChild(g);
    return c;
  }

  // ---- カメラ ----

  /** 指定タイル矩形が画面中央に来るようにパンする */
  private panCameraToRect(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
    const cx = (rect.x + rect.w / 2) * TILE * SCALE * this.camScale;
    const cy = (rect.y + rect.h / 2) * TILE * SCALE * this.camScale;
    const targetX = this.app.screen.width / 2 - cx;
    const targetY = this.app.screen.height / 2 - cy;
    const fromX = this.camX;
    const fromY = this.camY;
    return this.tweens.add({
      duration: 800,
      easing: Easings.easeInOutQuad,
      onUpdate: (t) => {
        this.camX = lerp(fromX, targetX, t);
        this.camY = lerp(fromY, targetY, t);
        this.applyCamera();
      },
    });
  }

  /** 建物全体が画面に収まるようカメラを初期化 */
  private centerCamera(): void {
    if (!this.layout) return;
    const contentW = this.layout.widthTiles * TILE * SCALE;
    const contentH = this.layout.heightTiles * TILE * SCALE;
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    this.camScale = Math.min(1, Math.min(sw / (contentW + 80), sh / (contentH + 80)));
    this.camX = (sw - contentW * this.camScale) / 2;
    this.camY = (sh - contentH * this.camScale) / 2;
    this.applyCamera();
  }

  private removeRoom(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    this.tweens.add({
      duration: 400,
      easing: Easings.easeInCubic,
      onUpdate: (t) => {
        room.container.alpha = 1 - t;
      },
      onComplete: () => room.container.destroy({ children: true }),
    });
    this.rooms.delete(id);
  }

  /** 掲示板ツールチップ用のsummary（先頭従業員のもの） */
  private roomSummary(dept: Department): string | null {
    const emp = dept.employees[0];
    return emp?.summary ?? null;
  }
}
