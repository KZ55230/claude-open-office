// layout.ts（16:9横長ビルの間取り・経路計算）の検証テスト。
// 実行: node --experimental-strip-types client/src/layout.test.ts
// カバレッジ:
//  - 上下段の交互割り当て（偶数=上段、奇数=下段）と増築時の段・x不変
//  - 部屋矩形の非重複、廊下への食い込みなし、建物外へのはみ出しなし
//  - ドアが廊下側の壁にあること（上段=下壁、下段=上壁）と西端列であること
//  - 全席・全机への fullPath / exitPath が直交セグメントのみで机を横切らないこと
// 部屋数1〜8 × 島数の組み合わせを走査して大量のケースを検証する。

import { strict as assert } from "node:assert";
import {
  computeBuildingLayout,
  roomRoute,
  fullPath,
  exitPath,
  segmentCrossesDesk,
  aisleRows,
  baseAisleRow,
  pathLength,
  roomHeight,
  orderDepartments,
  buildRoomSpecs,
  swappedOrder,
  ROOM_W,
  CORRIDOR_H,
  type RoomSpec,
  type PathPoint,
  type BuildingLayout,
  type RoomLayout,
} from "./layout.ts";

let assertions = 0;
function ok(cond: boolean, msg: string): void {
  assertions++;
  assert.ok(cond, msg);
}
function eq<T>(a: T, b: T, msg: string): void {
  assertions++;
  assert.deepEqual(a, b, msg);
}

/** 島数パターンを部屋数ぶん生成（全1島、全2島、交互、の3パターン） */
function islandPatterns(n: number): (1 | 2)[][] {
  const all1 = Array.from({ length: n }, () => 1 as const);
  const all2 = Array.from({ length: n }, () => 2 as const);
  const alt = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 2 : 1) as 1 | 2);
  return [all1, all2, alt];
}

function specsOf(islands: (1 | 2)[]): RoomSpec[] {
  return islands.map((n, i) => ({ id: `dept-${i}`, islands: n }));
}

/** 矩形の重なり判定 */
function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 経路の全セグメントが直交（水平または垂直）であることを確認 */
function assertOrthogonal(path: PathPoint[], label: string): void {
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    ok(p.x === q.x || p.y === q.y, `${label}: 区間${i} (${p.x},${p.y})→(${q.x},${q.y}) が直交移動`);
  }
}

/** 経路の部屋内部分が机を横切らないことを確認 */
function assertNoDeskCross(
  room: RoomLayout,
  path: PathPoint[],
  target: PathPoint,
  label: string
): void {
  for (let i = 1; i < path.length; i++) {
    ok(
      !segmentCrossesDesk(room, path[i - 1], path[i], target),
      `${label}: 区間${i} (${path[i - 1].x},${path[i - 1].y})→(${path[i].x},${path[i].y}) が他の机を横切らない`
    );
  }
}

/** 廊下の矩形 */
function corridorRect(b: BuildingLayout): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: b.corridorY, w: b.widthTiles, h: CORRIDOR_H };
}

// ================= 建物レイアウトの検証 =================

for (let n = 1; n <= 8; n++) {
  for (const pattern of islandPatterns(n)) {
    const specs = specsOf(pattern);
    const b = computeBuildingLayout(specs);
    const label = `部屋${n}(${pattern.join("")})`;

    eq(b.rooms.length, n, `${label}: 部屋数`);
    eq(b.entranceLaneY, b.corridorY + 1, `${label}: エントランスレーンは廊下中央行`);

    const corridor = corridorRect(b);

    b.rooms.forEach((room, i) => {
      // 段の交互割り当て
      eq(room.row, i % 2 === 0 ? "top" : "bottom", `${label}: 部屋${i}の段`);

      // 上段は下端が廊下上端に接し、下段は上端が廊下下端に接する
      if (room.row === "top") {
        eq(room.rect.y + room.rect.h, b.corridorY, `${label}: 部屋${i}(上段)の下端=廊下上端`);
      } else {
        eq(room.rect.y, b.corridorY + CORRIDOR_H, `${label}: 部屋${i}(下段)の上端=廊下下端`);
      }

      // 建物内に収まる（外壁1タイルの余白）
      ok(room.rect.x >= 1 && room.rect.x + room.rect.w <= b.widthTiles - 1, `${label}: 部屋${i}が横方向に収まる`);
      ok(room.rect.y >= 1 && room.rect.y + room.rect.h <= b.heightTiles - 1, `${label}: 部屋${i}が縦方向に収まる`);

      // 廊下への食い込みなし
      ok(!rectsOverlap(room.rect, corridor), `${label}: 部屋${i}が廊下に食い込まない`);

      // ドア：西端列（innerX）かつ廊下側の壁
      eq(room.door.x, room.innerX, `${label}: 部屋${i}のドアは西端列`);
      if (room.row === "top") {
        eq(room.door.wallY, room.rect.y + room.rect.h - 1, `${label}: 部屋${i}(上段)のドアは下壁`);
        ok(room.door.wallY === b.corridorY - 1, `${label}: 部屋${i}(上段)のドアは廊下に面する`);
      } else {
        eq(room.door.wallY, room.rect.y, `${label}: 部屋${i}(下段)のドアは上壁`);
        ok(room.door.wallY === b.corridorY + CORRIDOR_H, `${label}: 部屋${i}(下段)のドアは廊下に面する`);
      }
      // ドア開口（2タイル幅）が部屋の幅に収まる
      ok(room.door.x + 2 <= room.rect.x + room.rect.w - 1, `${label}: 部屋${i}のドア開口が壁内に収まる`);

      // 席と机が内寸に収まる
      for (const s of room.seats) {
        ok(
          s.x >= room.innerX && s.x < room.innerX + room.innerW &&
            s.y >= room.innerY && s.y < room.innerY + room.innerH,
          `${label}: 部屋${i}の席(${s.x},${s.y})が内寸内`
        );
      }
      for (const d of room.desks) {
        ok(
          d.x >= room.innerX && d.x + 3 <= room.innerX + room.innerW &&
            d.y >= room.innerY && d.y + 2 <= room.innerY + room.innerH,
          `${label}: 部屋${i}の机(${d.x},${d.y})が内寸内`
        );
      }

      // 対面式：北机(back)の直下に南机(screen)が接する
      const backs = room.desks.filter((d) => d.view === "back");
      for (const bd of backs) {
        ok(
          room.desks.some((sd) => sd.view === "screen" && sd.x === bd.x && sd.y === bd.y + 2),
          `${label}: 部屋${i}の北机(${bd.x},${bd.y})に南机が向かい合う`
        );
      }
      // 席の向き：島内の並びは down, down, up, up
      room.seats.forEach((s, si) => {
        eq(s.facing, si % 4 < 2 ? "down" : "up", `${label}: 部屋${i}の席${si}の向き`);
      });

      // 通路行の本数
      eq(aisleRows(room).length, room.islands === 1 ? 2 : 4, `${label}: 部屋${i}の通路行数`);
    });

    // 部屋矩形の非重複（全ペア）
    for (let i = 0; i < b.rooms.length; i++) {
      for (let j = i + 1; j < b.rooms.length; j++) {
        ok(
          !rectsOverlap(b.rooms[i].rect, b.rooms[j].rect),
          `${label}: 部屋${i}と部屋${j}が重ならない`
        );
      }
    }

    // ================= 経路の検証 =================
    for (const room of b.rooms) {
      const targets: { p: PathPoint; kind: string }[] = [
        ...room.seats.map((s, si) => ({ p: { x: s.x, y: s.y }, kind: `席${si}` })),
        ...room.desks.map((d, di) => ({ p: { x: d.x + 1, y: d.y }, kind: `机${di}` })),
      ];
      for (const { p: target, kind } of targets) {
        const tLabel = `${label}: ${room.id} ${kind}`;

        // 部屋内経路
        const inner = roomRoute(room, target);
        const last = inner[inner.length - 1];
        eq({ x: last.x, y: last.y }, { x: target.x, y: target.y }, `${tLabel}: roomRouteの終点`);
        eq(inner[0], { x: room.innerX, y: baseAisleRow(room) }, `${tLabel}: roomRouteの起点はドア内側`);
        assertOrthogonal(inner, tLabel);
        assertNoDeskCross(room, inner, target, tLabel);

        // 完全経路（エントランスから）
        const path = fullPath(b, room, target);
        ok(path[0].x === -2 && path[0].y === b.entranceLaneY, `${tLabel}: スポーンは建物の西外`);
        const pl = path[path.length - 1];
        eq({ x: pl.x, y: pl.y }, { x: target.x, y: target.y }, `${tLabel}: fullPathの終点`);
        assertOrthogonal(path, tLabel + "(full)");
        assertNoDeskCross(room, path, target, tLabel + "(full)");
        ok(pathLength(path) > 0, `${tLabel}: 経路長が正`);
        // 廊下レーン→ドア列→部屋、の順にドアをくぐる（ドア列を通る点がある）
        ok(
          path.some((pt) => pt.x === room.door.x && pt.y === b.entranceLaneY),
          `${tLabel}: 廊下のドア前を通過`
        );

        // 退場経路は逆順で建物外に出る
        const ep = exitPath(b, room, target);
        eq({ x: ep[0].x, y: ep[0].y }, { x: target.x, y: target.y }, `${tLabel}: 退場の起点は席`);
        ok(ep[ep.length - 1].x === -2, `${tLabel}: 退場の終点は建物外`);
      }
    }
  }
}

// ================= 増築の安定性（x・段の不変） =================

for (let n = 2; n <= 8; n++) {
  // 各部屋を順に1島→2島へ増築して、他の部屋のx・段が変わらないことを確認
  for (let grow = 0; grow < n; grow++) {
    const before = computeBuildingLayout(
      specsOf(Array.from({ length: n }, () => 1 as const))
    );
    const afterIslands = Array.from({ length: n }, (_, i) => (i === grow ? 2 : 1) as 1 | 2);
    const after = computeBuildingLayout(specsOf(afterIslands));
    const label = `増築 n=${n} 部屋${grow}`;

    for (let i = 0; i < n; i++) {
      eq(after.rooms[i].rect.x, before.rooms[i].rect.x, `${label}: 部屋${i}のx不変`);
      eq(after.rooms[i].row, before.rooms[i].row, `${label}: 部屋${i}の段不変`);
    }
    // 増築した部屋だけ高くなる
    eq(
      after.rooms[grow].rect.h,
      roomHeight(2),
      `${label}: 増築部屋の高さ`
    );
    eq(after.rooms[grow].seats.length, 8, `${label}: 増築後は8席`);
    eq(after.rooms[grow].desks.length, 8, `${label}: 増築後は8机`);

    // 上段の増築は上方向へ伸びる（下端＝廊下位置に対する相対関係を維持）
    const room = after.rooms[grow];
    if (room.row === "top") {
      eq(room.rect.y + room.rect.h, after.corridorY, `${label}: 上段増築後も下端=廊下上端`);
    } else {
      eq(room.rect.y, after.corridorY + CORRIDOR_H, `${label}: 下段増築後も上端=廊下下端`);
    }

    // 2つ目の島は島0と通路を挟んで配置される
    const island0South = Math.max(...room.desks.filter((d) => d.island === 0).map((d) => d.y + 2));
    const island1North = Math.min(...room.seats.slice(4).map((s) => s.y));
    ok(island1North - island0South >= 1, `${label}: 島の間に通路がある`);
  }
}

// ================= 建物寸法の妥当性（16:9向けの横長） =================

{
  // 8部屋（上下4部屋ずつ）で幅が高さを上回る＝横長になっている
  const b = computeBuildingLayout(specsOf(Array.from({ length: 8 }, () => 1 as const)));
  ok(b.widthTiles > b.heightTiles, "8部屋の全1島ビルは横長");
  eq(b.widthTiles, 1 + ROOM_W * 4 + 1, "8部屋の建物幅=外壁+部屋4つ分+外壁");
}

// ================= 並び順（orderDepartments / swappedOrder） =================

{
  const depts = ["zeta", "alpha", "mike", "kilo"].map((id) => ({ id }));
  // roomOrderにあるものが先頭にその順で、無いものはID昇順で後ろ
  const ordered = orderDepartments(depts, ["mike", "zeta"]).map((d) => d.id);
  eq(ordered, ["mike", "zeta", "alpha", "kilo"], "roomOrder優先＋残りはID昇順");
  // roomOrderが空なら全てID昇順
  eq(
    orderDepartments(depts, []).map((d) => d.id),
    ["alpha", "kilo", "mike", "zeta"],
    "roomOrder空はID昇順"
  );
  // 元配列は破壊しない
  eq(depts.map((d) => d.id), ["zeta", "alpha", "mike", "kilo"], "orderDepartmentsは非破壊");

  // swappedOrder
  eq(swappedOrder(["a", "b", "c"], "a", "c"), ["c", "b", "a"], "swappedOrderで位置交換");
  eq(swappedOrder(["a", "b", "c"], "a", "x"), ["a", "b", "c"], "見つからないIDはno-op");
}

// ================= roomOrderによる交換のシミュレーション =================

/** n部屋分のspec列を作る（buildRoomSpecs経由） */
function specsOfN(n: number, roomOrder: string[] = []): RoomSpec[] {
  const depts = Array.from({ length: n }, (_, i) => ({
    id: `dept-${i}`,
    islands: 1 as const,
  }));
  return buildRoomSpecs(depts, roomOrder);
}

{
  // buildRoomSpecs：roomOrderの反映確認
  const specs = specsOfN(3, ["dept-2"]);
  eq(
    specs.map((s) => s.id),
    ["dept-2", "dept-0", "dept-1"],
    "buildRoomSpecs：roomOrder優先＋残りはID昇順"
  );
}

{
  // 4部屋。dept-0とdept-3を交換する
  const before = computeBuildingLayout(specsOfN(4, []));
  const orderBefore = ["dept-0", "dept-1", "dept-2", "dept-3"]; // ID昇順=初期表示順
  const orderAfter = swappedOrder(orderBefore, "dept-0", "dept-3");
  eq(orderAfter, ["dept-3", "dept-1", "dept-2", "dept-0"], "交換後のroomOrder");

  const after = computeBuildingLayout(specsOfN(4, orderAfter));
  const label = "交換シミュレーション";

  // 交換した2部屋は互いの位置（rect・段）を引き継ぐ
  const b0 = before.rooms.find((r) => r.id === "dept-0")!;
  const b3 = before.rooms.find((r) => r.id === "dept-3")!;
  const a0 = after.rooms.find((r) => r.id === "dept-0")!;
  const a3 = after.rooms.find((r) => r.id === "dept-3")!;
  eq({ x: a0.rect.x, row: a0.row }, { x: b3.rect.x, row: b3.row }, `${label}: dept-0が旧dept-3の位置へ`);
  eq({ x: a3.rect.x, row: a3.row }, { x: b0.rect.x, row: b0.row }, `${label}: dept-3が旧dept-0の位置へ`);

  // 交換していない部屋は不変
  for (const id of ["dept-1", "dept-2"]) {
    const rb = before.rooms.find((r) => r.id === id)!;
    const ra = after.rooms.find((r) => r.id === id)!;
    eq({ x: ra.rect.x, row: ra.row }, { x: rb.rect.x, row: rb.row }, `${label}: ${id}は不変`);
  }

  // 交換後も矩形非重複・経路の机横断ゼロ
  for (let i = 0; i < after.rooms.length; i++) {
    for (let j = i + 1; j < after.rooms.length; j++) {
      ok(!rectsOverlap(after.rooms[i].rect, after.rooms[j].rect), `${label}: 部屋${i}/${j}非重複`);
    }
  }
  for (const room of after.rooms) {
    for (const s of room.seats) {
      const path = fullPath(after, room, { x: s.x, y: s.y });
      assertOrthogonal(path, `${label}: ${room.id}`);
      assertNoDeskCross(room, path, { x: s.x, y: s.y }, `${label}: ${room.id}`);
    }
  }
}

console.log(`layout.test.ts: 全 ${assertions} 件のアサーションに合格しました`);
