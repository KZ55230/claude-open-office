// オフィスビル全体のレイアウト計算（純粋関数）。
// 16:9の画面に合う横長ビル：部屋を上下2段に並べ、中央に「横」廊下を通す。
// エントランスは廊下の西端（建物左外壁の開口）。各部屋のドアは廊下側の壁の西端列（innerX）に2タイル幅。
// 経路（エントランス→廊下→ドア→部屋内→席）もここで算出する。
// 副作用ゼロ・DOM/Pixi非依存なので node --experimental-strip-types で単体検証できる（layout.test.ts）。

// ---- タイル定数 ----
export const ROOM_W = 12; // 部屋の外寸幅（左右の壁1タイルずつ含む）
export const HEADER_H = 2; // 部屋上部の壁帯（部署名プレート・掲示板を置く）
export const INNER_W = 10; // 部屋の内寸幅
export const ISLAND_W = 6; // 島の幅（机3タイル×2列）
export const ISLAND_H = 6; // 島の高さ（北席1+北机2+南机2+南席1）
export const CORRIDOR_H = 3; // 廊下の高さ（横廊下なので「高さ」）
export const LOUNGE_X = 8; // 部屋内の休憩コーナー開始列（内寸座標）

/** 島数→部屋の内寸高さ。1島=上下通路1+島6+下通路1=8、2島=島の間に通路2を挟む=16 */
export function innerHeight(islands: 1 | 2): number {
  return islands === 1 ? 8 : 16;
}

/** 島数→部屋の外寸高さ（ヘッダー帯2+内寸+下壁1） */
export function roomHeight(islands: 1 | 2): number {
  return HEADER_H + innerHeight(islands) + 1;
}

/** 席の向き。down=南向き（顔が見える）、up=北向き（後ろ姿） */
export type Facing = "down" | "up";

/** 部屋がどちらの段にあるか。top=廊下の上（北）、bottom=廊下の下（南） */
export type RoomRow = "top" | "bottom";

export interface SeatSpot {
  x: number; // 建物タイル座標（キャラの立ち位置）
  y: number;
  facing: Facing;
}

export interface DeskSpot {
  x: number; // 机の左上タイル（3x2タイルを占有）
  y: number;
  island: 0 | 1;
  /** screen=画面がこちら向き（南机）、back=モニター背面が見える（北机） */
  view: "screen" | "back";
}

export interface RoomLayout {
  id: string;
  islands: 1 | 2;
  /** 上段（廊下の北）か下段（廊下の南）か */
  row: RoomRow;
  /** 部屋の外接矩形（壁・ヘッダー帯込み、建物タイル座標） */
  rect: { x: number; y: number; w: number; h: number };
  /** 内装の原点（壁の内側・ヘッダー帯の下） */
  innerX: number;
  innerY: number;
  innerW: number;
  innerH: number;
  /**
   * ドア（廊下側の壁の開口部）。x=開口の西端列（2タイル幅=x, x+1）、
   * wallY=壁の行（上段の部屋=下壁の行、下段の部屋=ヘッダー帯の上端行。下段は2行分の開口）
   */
  door: { x: number; wallY: number };
  /** 席（最大8席、島順） */
  seats: SeatSpot[];
  /** 机（島ごとに4台） */
  desks: DeskSpot[];
}

export interface BuildingLayout {
  widthTiles: number;
  heightTiles: number;
  /** 廊下の上端行（廊下はこの行から3行分） */
  corridorY: number;
  /** エントランス開口の中心レーン（歩行に使う行＝廊下の中央行） */
  entranceLaneY: number;
  rooms: RoomLayout[];
}

export interface RoomSpec {
  id: string;
  islands: 1 | 2;
}

/**
 * 部署一覧を表示順に並べる純粋関数。
 * roomOrder にあるIDをその順で先頭に、無いものはID昇順で後ろに続ける。
 */
export function orderDepartments<T extends { id: string }>(
  depts: T[],
  roomOrder: string[]
): T[] {
  const orderIndex = new Map(roomOrder.map((id, i) => [id, i]));
  return [...depts].sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id)! : Number.POSITIVE_INFINITY;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id)! : Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 部署一覧＋roomOrder から computeBuildingLayout 用の RoomSpec 列を作る純粋関数。
 * roomOrder（無いものはID昇順で末尾）の順で交互割り当ての対象になる。
 */
export function buildRoomSpecs(
  depts: { id: string; islands: 1 | 2 }[],
  roomOrder: string[]
): RoomSpec[] {
  return orderDepartments(depts, roomOrder).map((d) => ({
    id: d.id,
    islands: d.islands,
  }));
}

/**
 * 並び順のなかで2つのIDの位置を入れ替えた新しい配列を返す純粋関数。
 * どちらかが見つからない場合は元の配列のコピーをそのまま返す。
 */
export function swappedOrder(currentIds: string[], a: string, b: string): string[] {
  const ia = currentIds.indexOf(a);
  const ib = currentIds.indexOf(b);
  const out = currentIds.slice();
  if (ia < 0 || ib < 0) return out;
  out[ia] = b;
  out[ib] = a;
  return out;
}

/** 島内の席の相対位置（島原点=島の左上タイル） */
function islandSeats(ix: number, iy: number): SeatSpot[] {
  return [
    { x: ix + 1, y: iy + 0, facing: "down" }, // 北西席（南向き＝顔が見える）
    { x: ix + 4, y: iy + 0, facing: "down" }, // 北東席
    { x: ix + 1, y: iy + 5, facing: "up" }, // 南西席（北向き＝後ろ姿）
    { x: ix + 4, y: iy + 5, facing: "up" }, // 南東席
  ];
}

/** 島内の机の相対位置。北机はモニター背面、南机は光る画面が見える */
function islandDesks(ix: number, iy: number, island: 0 | 1): DeskSpot[] {
  return [
    { x: ix + 0, y: iy + 1, island, view: "back" },
    { x: ix + 3, y: iy + 1, island, view: "back" },
    { x: ix + 0, y: iy + 3, island, view: "screen" },
    { x: ix + 3, y: iy + 3, island, view: "screen" },
  ];
}

/**
 * 部署一覧から建物全体のレイアウトを計算する純粋関数。
 * 部屋は上下段に交互に割り当てて横に並べる（specsの中でのインデックス偶数=上段、奇数=下段）。
 * 割り当てを決定的にすることで、増築時に部屋が段をまたいで飛び移らないようにする。
 * 上段の部屋は下端を廊下に、下段の部屋は上端を廊下に揃える（増築しても x は変わらない）。
 */
export function computeBuildingLayout(specs: RoomSpec[]): BuildingLayout {
  const seq: { spec: RoomSpec; row: RoomRow }[] = specs.map((spec, i) => ({
    spec,
    row: i % 2 === 0 ? "top" : "bottom",
  }));

  // 各段の最大高さを先に求め、廊下の位置を決める
  let maxTopH = 0;
  let maxBotH = 0;
  for (const { spec, row } of seq) {
    const h = roomHeight(spec.islands);
    if (row === "top") maxTopH = Math.max(maxTopH, h);
    else maxBotH = Math.max(maxBotH, h);
  }

  const corridorY = 1 + maxTopH; // 上端に外壁1タイル分の余白
  const bottomRoomY = corridorY + CORRIDOR_H;

  const rooms: RoomLayout[] = [];
  let topX = 1; // 左端に外壁1タイル分の余白
  let botX = 1;

  seq.forEach(({ spec, row }) => {
    const h = roomHeight(spec.islands);
    const x = row === "top" ? topX : botX;
    // 上段は下端を廊下に揃える（増築すると上方向へ伸びる）
    const y = row === "top" ? corridorY - h : bottomRoomY;
    if (row === "top") topX += ROOM_W;
    else botX += ROOM_W;

    const innerX = x + 1;
    const innerY = y + HEADER_H;
    const innerH = innerHeight(spec.islands);

    // 席と机（島0は内寸(1,1)、島1は内寸(1,9)＝島の間に2タイル通路）
    const seats: SeatSpot[] = [...islandSeats(innerX + 1, innerY + 1)];
    const desks: DeskSpot[] = [...islandDesks(innerX + 1, innerY + 1, 0)];
    if (spec.islands === 2) {
      seats.push(...islandSeats(innerX + 1, innerY + 9));
      desks.push(...islandDesks(innerX + 1, innerY + 9, 1));
    }

    rooms.push({
      id: spec.id,
      islands: spec.islands,
      row,
      rect: { x, y, w: ROOM_W, h },
      innerX,
      innerY,
      innerW: INNER_W,
      innerH,
      door: {
        x: innerX, // 廊下側の壁の西端列（開口はこの列と次の列の2タイル幅）
        wallY: row === "top" ? y + h - 1 : y,
      },
      seats,
      desks,
    });
  });

  // 建物の幅＝長い方の段＋右外壁1タイル（最低限の幅も確保）
  const widthTiles = Math.max(topX, botX, ROOM_W + 2) + 1;
  const heightTiles = bottomRoomY + maxBotH + 1;

  return {
    widthTiles,
    heightTiles,
    corridorY,
    entranceLaneY: corridorY + 1, // 廊下3行の中央レーン
    rooms,
  };
}

// ---- 経路計算 ----

export interface PathPoint {
  x: number;
  y: number;
}

/**
 * 部屋の中の通路行（島の上下の空き行）を列挙する。
 * 1島: [inner+0, inner+7] / 2島: [inner+0, inner+7, inner+8, inner+15]
 */
export function aisleRows(room: RoomLayout): number[] {
  const rows = [room.innerY + 0, room.innerY + 7];
  if (room.islands === 2) {
    rows.push(room.innerY + 8, room.innerY + 15);
  }
  return rows;
}

/** 部屋の基準通路行＝ドアの内側すぐの通路行（上段=最下段の通路行、下段=最上段の通路行） */
export function baseAisleRow(room: RoomLayout): number {
  return room.row === "top" ? room.innerY + room.innerH - 1 : room.innerY;
}

/**
 * 部屋内の経路：ドア内側の入口→目標タイルへのウェイポイント列（入口点含む）。
 * 上下段で対称なアルゴリズム：
 *  1. 入口は西端列（innerX）×基準通路行。ドアが西端にあるため必ずここから始まる
 *  2. 目標に最も近い通路行を選ぶ
 *  3. その行が基準行でなければ、西端の空き列（innerX。島は innerX+1 から始まる）を縦移動
 *  4. 通路行を横移動 → 縦に1〜3歩で目標へ
 *  島の机(3x2)を横切らないことは layout.test.ts で担保する
 */
export function roomRoute(room: RoomLayout, target: PathPoint): PathPoint[] {
  const westX = room.innerX;
  const base = baseAisleRow(room);
  const points: PathPoint[] = [{ x: westX, y: base }];

  // 目標に最も近い通路行
  const rows = aisleRows(room);
  let best = base;
  let bestDist = Math.abs(base - target.y);
  for (const r of rows) {
    const d = Math.abs(r - target.y);
    if (d < bestDist) {
      best = r;
      bestDist = d;
    }
  }

  if (best !== base) {
    points.push({ x: westX, y: best }); // 西端列を縦移動
  }
  points.push({ x: target.x, y: best }); // 通路行を横移動
  if (best !== target.y) {
    points.push({ x: target.x, y: target.y }); // 縦に数歩で目標へ
  }
  return dedupe(points);
}

/**
 * エントランス（建物の西端・廊下の左）→廊下→ドア→部屋内の目標タイル、の完全経路。
 * 戻り値の先頭は建物外（西側の外）で、そこからスポーンして歩き始める。
 */
export function fullPath(
  layout: BuildingLayout,
  room: RoomLayout,
  target: PathPoint
): PathPoint[] {
  const lane = layout.entranceLaneY;
  const doorX = room.door.x; // ドア開口の西端列＝部屋の西端通路列と同じ
  const base = baseAisleRow(room);
  const points: PathPoint[] = [
    { x: -2, y: lane }, // 建物の外（スポーン位置）
    { x: 1, y: lane }, // エントランス開口をくぐる
    { x: doorX, y: lane }, // 廊下を東へ進みドアの列へ
    { x: doorX, y: base }, // ドアの開口を縦にくぐって部屋の基準通路行へ
  ];
  // 部屋内経路（入口点が重複するのでそのまま連結してよい）
  points.push(...roomRoute(room, target));
  return dedupe(points);
}

/** 退場経路＝入場経路の逆順 */
export function exitPath(
  layout: BuildingLayout,
  room: RoomLayout,
  from: PathPoint
): PathPoint[] {
  return fullPath(layout, room, from).slice().reverse();
}

/** 連続する同一点を除去 */
function dedupe(points: PathPoint[]): PathPoint[] {
  const out: PathPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out;
}

/** 経路の総距離（タイル単位）。歩行時間の算出に使う */
export function pathLength(points: PathPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  }
  return len;
}

/**
 * 検証用：点pから点qへの直線移動（水平または垂直）がいずれかの机(3x2)の内部を横切るかを判定する。
 * ignoreTarget を含む机（＝目標の机そのもの。搬入時は机の足元まで入り込むため）は判定から除外する。
 */
export function segmentCrossesDesk(
  room: RoomLayout,
  p: PathPoint,
  q: PathPoint,
  ignoreTarget?: PathPoint
): boolean {
  // 通過タイルを列挙（水平か垂直のみを想定）
  const tiles: PathPoint[] = [];
  if (p.x === q.x) {
    const [a, b] = p.y < q.y ? [p.y, q.y] : [q.y, p.y];
    for (let y = a; y <= b; y++) tiles.push({ x: p.x, y });
  } else if (p.y === q.y) {
    const [a, b] = p.x < q.x ? [p.x, q.x] : [q.x, p.x];
    for (let x = a; x <= b; x++) tiles.push({ x, y: p.y });
  }
  const inDesk = (d: DeskSpot, t: PathPoint) =>
    t.x >= d.x && t.x < d.x + 3 && t.y >= d.y && t.y < d.y + 2;
  for (const d of room.desks) {
    // 目標を含む机は「自分の机」なので除外
    if (ignoreTarget && inDesk(d, ignoreTarget)) continue;
    for (const t of tiles) {
      if (inDesk(d, t)) return true;
    }
  }
  return false;
}
