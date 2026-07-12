// ピクセルアート生成モジュール。外部画像は一切使わない。
// - キャラクター等の小物：文字列の行配列（'H'=髪色 'S'=肌色 など）で定義
// - 大型家具（机・本棚・ソファ等）：Canvasへの手続き的ドット描画で精細に生成
// - 床：パターンテクスチャ（木目フローリング／カーペット／廊下タイル）
// すべて明るく彩度高めのパレットで「可愛いドット絵オフィス」の雰囲気に統一する。

import { Texture } from "pixi.js";

/** 文字→#RRGGBB のパレット */
export type Palette = Record<string, string>;

// 同一定義のテクスチャは使い回す
const textureCache = new Map<string, Texture>();

/** 決定的な擬似乱数（本棚の本の色などをseedから再現可能にする） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ドット描画用のCanvasヘルパ */
function makePixelCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return {
    canvas,
    /** 1ドット */
    px(x: number, y: number, color: string) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    },
    /** 矩形 */
    rect(x: number, y: number, rw: number, rh: number, color: string) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, rw, rh);
    },
  };
}

/** CanvasをPixiテクスチャ化（ニアレストでくっきり） */
function canvasToTexture(canvas: HTMLCanvasElement, cacheKey?: string): Texture {
  if (cacheKey && textureCache.has(cacheKey)) return textureCache.get(cacheKey)!;
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  if (cacheKey) textureCache.set(cacheKey, tex);
  return tex;
}

/**
 * ピクセル行配列＋パレットからテクスチャを生成する。
 * '.'（またはパレット未定義文字）は透明。行の長さが不揃いでも短い分は透明扱い。
 */
export function textureFromPixels(
  rows: string[],
  palette: Palette,
  scale = 1,
  cacheKey?: string
): Texture {
  if (cacheKey && textureCache.has(cacheKey)) return textureCache.get(cacheKey)!;
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const p = makePixelCanvas(w * scale, h * scale);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const color = palette[ch];
      if (!color || ch === "." || ch === " ") continue;
      p.rect(x * scale, y * scale, scale, scale, color);
    }
  }
  return canvasToTexture(p.canvas, cacheKey);
}

// =====================================================================
// キャラクター（丸っこい2.5頭身チビキャラ、16x18）
// H=髪 h=髪の影 S=肌 E=目 b=ほっぺ m=口 C=服 c=服の影 P=ズボン K=靴
// =====================================================================

const CHAR_FRONT = [
  "................",
  "....HHHHHHHH....",
  "...HHHHHHHHHH...",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HhSSSSSSSShH..",
  "..HSSSSSSSSSSH..",
  "..HSEESSSSEESH..",
  "..HSEESSSSEESH..",
  "..HSbSSmmSSbSH..",
  "...SSSSSSSSSS...",
  "....SSSSSSSS....",
  "...CCCCCCCCCC...",
  "..CCCCCCCCCCCC..",
  "..SCCCCccCCCCS..",
  "...CCCCCCCCCC...",
  "...PPP....PPP...",
  "..KKK......KKK..",
];

// タイピング中（両手を前に出す）
const CHAR_FRONT_TYPING = [
  "................",
  "....HHHHHHHH....",
  "...HHHHHHHHHH...",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HhSSSSSSSShH..",
  "..HSSSSSSSSSSH..",
  "..HSEESSSSEESH..",
  "..HSEESSSSEESH..",
  "..HSbSSmmSSbSH..",
  "...SSSSSSSSSS...",
  "....SSSSSSSS....",
  ".S.CCCCCCCCCC.S.",
  ".SCCCCCCCCCCCCS.",
  "..CCCCCccCCCC...",
  "...CCCCCCCCCC...",
  "...PPP....PPP...",
  "..KKK......KKK..",
];

// 寝ている（resting）。目のブロック上段(7行目相当)を肌色に潰し、下段だけを
// 残すことで「閉じたまぶたの線」に見せる。パレット追加は不要（既存のEを流用）。
const CHAR_FRONT_SLEEP = [
  "................",
  "....HHHHHHHH....",
  "...HHHHHHHHHH...",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HhSSSSSSSShH..",
  "..HSSSSSSSSSSH..",
  "..HSSSSSSSSSSH..",
  "..HSEESSSSEESH..",
  "..HSbSSmmSSbSH..",
  "...SSSSSSSSSS...",
  "....SSSSSSSS....",
  "...CCCCCCCCCC...",
  "..CCCCCCCCCCCC..",
  "..SCCCCccCCCCS..",
  "...CCCCCCCCCC...",
  "...PPP....PPP...",
  "..KKK......KKK..",
];

// 後ろ姿（髪だけの丸い頭＋背中）
const CHAR_BACK = [
  "................",
  "....HHHHHHHH....",
  "...HHHHHHHHHH...",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HHhHHHHHHhHH..",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HHhHHHHHHhHH..",
  "...HHHHHHHHHH...",
  "....SSSSSSSS....",
  "...CCCCCCCCCC...",
  "..CCCCCCCCCCCC..",
  "..CCCCCccCCCCC..",
  "...CCCCCCCCCC...",
  "...PPP....PPP...",
  "..KKK......KKK..",
];

const CHAR_BACK_TYPING = [
  "................",
  "....HHHHHHHH....",
  "...HHHHHHHHHH...",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HHhHHHHHHhHH..",
  "..HHHHHHHHHHHH..",
  "..HHHHHHHHHHHH..",
  "..HHhHHHHHHhHH..",
  "...HHHHHHHHHH...",
  "....SSSSSSSS....",
  ".S.CCCCCCCCCC.S.",
  ".SCCCCCCCCCCCCS.",
  "..CCCCCccCCCCC..",
  "...CCCCCCCCCC...",
  "...PPP....PPP...",
  "..KKK......KKK..",
];

// 明るく彩度高めの色候補（seedで決定的に選ぶ）
const HAIR_COLORS = ["#4a3226", "#7a4a2a", "#b07840", "#e0a860", "#4a4e69", "#8a4a3a", "#3a5a4a", "#6a4a7a"];
const HAIR_SHADES = ["#3a2620", "#5e3820", "#8e5e30", "#c08a48", "#3a3e56", "#703a2e", "#2e483c", "#563a62"];
const CLOTH_COLORS = ["#5aa9e6", "#ef767a", "#6fd08c", "#f2b134", "#9d8cff", "#4ecdc4", "#f78fb3", "#ffa552"];
const CLOTH_SHADES = ["#4a8dc2", "#cc5e62", "#58ae72", "#cc9328", "#8172d8", "#3daaa4", "#d57394", "#d98a40"];
const SKIN_COLORS = ["#ffe0bd", "#ffd1a3", "#f0c090", "#ffe8cc"];

/** spriteSeedから決定的にキャラのパレットを組む（髪・服の色替えを維持） */
export function paletteForSeed(seed: number): Palette {
  const s = Math.abs(Math.floor(seed));
  const hi = s % HAIR_COLORS.length;
  const ci = Math.floor(s / 7) % CLOTH_COLORS.length;
  const si = Math.floor(s / 13) % SKIN_COLORS.length;
  return {
    H: HAIR_COLORS[hi],
    h: HAIR_SHADES[hi],
    S: SKIN_COLORS[si],
    E: "#3a3038",
    b: "#f7b2a5",
    m: "#c1665a",
    C: CLOTH_COLORS[ci],
    c: CLOTH_SHADES[ci],
    P: "#4a5568",
    K: "#3a3244",
  };
}

/** キャラのテクスチャ（向き・タイピング/睡眠フレーム別、seedごとにキャッシュ） */
export function charTexture(
  seed: number,
  facing: "front" | "back",
  typing = false,
  sleeping = false
): Texture {
  const rows =
    facing === "front"
      ? sleeping
        ? CHAR_FRONT_SLEEP
        : typing
          ? CHAR_FRONT_TYPING
          : CHAR_FRONT
      : typing
        ? CHAR_BACK_TYPING
        : CHAR_BACK; // 後ろ姿は目が描かれていないためsleeping分岐は不要
  const key = `chr-${seed}-${facing}-${typing ? 1 : 0}-${sleeping ? 1 : 0}`;
  return textureFromPixels(rows, paletteForSeed(seed), 4, key);
}

// =====================================================================
// 引っ越し業者（ヘルメット＋オレンジの反射ベスト）
// =====================================================================

const MOVER_PIXELS = [
  "................",
  "....YYYYYYYY....",
  "...YYYYYYYYYY...",
  "..YYYYYYYYYYYY..",
  "..yyyyyyyyyyyy..",
  "..SSSSSSSSSSSS..",
  "..SSEESSSSEESS..",
  "..SSEESSSSEESS..",
  "..SSSSSmmSSSSS..",
  "...SSSSSSSSSS...",
  "....SSSSSSSS....",
  "...VVVVVVVVVV...",
  "..VVLLVVVVLLVV..",
  "..SVVVVVVVVVVS..",
  "...VVVVVVVVVV...",
  "...PPP....PPP...",
  "..KKK......KKK..",
];
const MOVER_PALETTE: Palette = {
  Y: "#ffc93c", // ヘルメット
  y: "#e0a820", // ヘルメットのつば
  S: "#ffd1a3",
  E: "#3a3038",
  m: "#c1665a",
  V: "#ff8a3d", // 作業ベスト
  L: "#fff2a8", // 反射帯
  P: "#4a5568",
  K: "#3a3244",
};

export function moverTexture(): Texture {
  return textureFromPixels(MOVER_PIXELS, MOVER_PALETTE, 4, "mover");
}

// =====================================================================
// 椅子（キャラの足元に敷く）
// =====================================================================

const CHAIR_PIXELS = [
  "..RRRRRRRR..",
  ".RRrrrrrrRR.",
  ".RRrrrrrrRR.",
  ".RRRRRRRRRR.",
  "....R..R....",
  "...RR..RR...",
];
const CHAIR_PALETTE: Palette = {
  R: "#4a5568",
  r: "#5d6b80",
};

export function chairTexture(): Texture {
  return textureFromPixels(CHAIR_PIXELS, CHAIR_PALETTE, 4, "chair");
}

// =====================================================================
// 机（3タイル×2タイル＝48x32px、手続き描画で精細に）
// view="screen"：光る青いモニターの画面が見える（南机）
// view="back" ：モニターの背面が見える（北机）
// =====================================================================

const WOOD_TOP = "#d9a066";
const WOOD_TOP_HI = "#e8b478";
const WOOD_EDGE = "#b97f45";
const WOOD_LEG = "#8c5a33";

export function deskTexture(view: "screen" | "back" = "screen"): Texture {
  const key = `desk-${view}`;
  if (textureCache.has(key)) return textureCache.get(key)!;
  const W = 48;
  const H = 32;
  const p = makePixelCanvas(W, H);

  // ---- 天板（木目、下半分） ----
  p.rect(1, 14, W - 2, 12, WOOD_TOP);
  p.rect(1, 14, W - 2, 2, WOOD_TOP_HI); // 上端ハイライト
  p.rect(1, 25, W - 2, 1, WOOD_EDGE); // 縁
  // 木目の筋
  for (let i = 0; i < 5; i++) {
    p.rect(4 + i * 9, 17 + (i % 3) * 2, 6, 1, WOOD_EDGE);
  }
  // 脚と幕板
  p.rect(3, 26, 3, 6, WOOD_LEG);
  p.rect(W - 6, 26, 3, 6, WOOD_LEG);
  p.rect(3, 26, W - 6, 1, WOOD_LEG);

  if (view === "screen") {
    // ---- モニター正面（青く発光する画面＋グラフ表示） ----
    p.rect(14, 1, 20, 14, "#2a2f3a"); // ベゼル
    p.rect(16, 3, 16, 10, "#7fd4ff"); // 画面
    p.rect(16, 3, 16, 2, "#a8e4ff"); // 上部の光
    // 画面内の折れ線グラフ
    const line = [9, 8, 9, 7, 6, 7, 5, 4];
    for (let i = 0; i < line.length; i++) {
      p.px(17 + i * 2, 3 + line[i], "#1d5a8a");
      p.px(18 + i * 2, 3 + line[i], "#1d5a8a");
    }
    // 文字のダッシュ表現
    p.rect(17, 11, 6, 1, "#3a86c8");
    p.rect(25, 11, 4, 1, "#3a86c8");
    // スタンド
    p.rect(22, 15, 4, 2, "#2a2f3a");
    // キーボード＆マウス
    p.rect(17, 19, 12, 4, "#3d4454");
    p.rect(18, 20, 10, 1, "#5d6b80");
    p.rect(33, 20, 3, 3, "#3d4454");
    // マグカップ
    p.rect(8, 18, 4, 5, "#ef767a");
    p.px(12, 19, "#ef767a");
    p.px(12, 21, "#ef767a");
  } else {
    // ---- モニター背面 ----
    p.rect(14, 1, 20, 14, "#3d4454");
    p.rect(15, 2, 18, 12, "#4a5568");
    // 通気スリット
    for (let i = 0; i < 4; i++) {
      p.rect(18, 4 + i * 2, 12, 1, "#3d4454");
    }
    // スタンドとケーブル
    p.rect(22, 15, 4, 2, "#3d4454");
    p.px(24, 17, "#2a2f3a");
    p.px(25, 18, "#2a2f3a");
    // 書類とペン
    p.rect(7, 19, 8, 5, "#f4efe4");
    p.rect(8, 20, 6, 1, "#b8b2a4");
    p.rect(8, 22, 5, 1, "#b8b2a4");
    p.rect(36, 20, 5, 2, "#5aa9e6");
  }

  return canvasToTexture(p.canvas, key);
}

// =====================================================================
// 本棚（2タイル×3タイル＝32x48px、色とりどりの本がぎっしり）
// =====================================================================

export function bookshelfTexture(seed = 1): Texture {
  const key = `shelf-${seed}`;
  if (textureCache.has(key)) return textureCache.get(key)!;
  const W = 32;
  const H = 48;
  const p = makePixelCanvas(W, H);
  const rand = mulberry32(seed * 7919 + 17);
  const bookColors = ["#ef767a", "#5aa9e6", "#6fd08c", "#f2b134", "#9d8cff", "#4ecdc4", "#f78fb3", "#d96a4a"];

  // 外枠
  p.rect(0, 0, W, H, "#8c5a33");
  p.rect(1, 1, W - 2, H - 2, "#a06a3a");
  p.rect(2, 0, W - 4, 2, "#b07840"); // 天板ハイライト

  // 3段の棚に本をぎっしり
  for (let shelf = 0; shelf < 3; shelf++) {
    const sy = 4 + shelf * 14;
    p.rect(2, sy, W - 4, 12, "#5e3820"); // 棚の奥
    p.rect(2, sy + 12, W - 4, 2, "#b07840"); // 棚板
    let bx = 3;
    while (bx < W - 5) {
      const bw = rand() < 0.5 ? 2 : 3;
      const bh = 8 + Math.floor(rand() * 4);
      const color = bookColors[Math.floor(rand() * bookColors.length)];
      p.rect(bx, sy + 12 - bh, bw, bh, color);
      bx += bw + (rand() < 0.15 ? 2 : 0); // たまに隙間
    }
  }
  return canvasToTexture(p.canvas, key);
}

// =====================================================================
// ソファ＋ローテーブル（休憩コーナー用）
// =====================================================================

export function sofaTexture(): Texture {
  const key = "sofa";
  if (textureCache.has(key)) return textureCache.get(key)!;
  const W = 40;
  const H = 22;
  const p = makePixelCanvas(W, H);
  const body = "#4ecdc4";
  const shade = "#3daaa4";
  const hi = "#7fe0d8";
  // 背もたれ
  p.rect(2, 0, W - 4, 8, body);
  p.rect(2, 0, W - 4, 2, hi);
  // 座面（クッション2つ）
  p.rect(0, 8, W, 10, body);
  p.rect(2, 9, 17, 7, hi);
  p.rect(21, 9, 17, 7, hi);
  p.rect(2, 15, W - 4, 2, shade);
  // 肘掛け
  p.rect(0, 4, 3, 14, shade);
  p.rect(W - 3, 4, 3, 14, shade);
  // 脚
  p.rect(3, 18, 3, 3, "#8c5a33");
  p.rect(W - 6, 18, 3, 3, "#8c5a33");
  return canvasToTexture(p.canvas, key);
}

export function tableTexture(): Texture {
  const key = "lowtable";
  if (textureCache.has(key)) return textureCache.get(key)!;
  const W = 26;
  const H = 14;
  const p = makePixelCanvas(W, H);
  p.rect(0, 2, W, 8, WOOD_TOP);
  p.rect(0, 2, W, 2, WOOD_TOP_HI);
  p.rect(0, 9, W, 1, WOOD_EDGE);
  p.rect(2, 10, 3, 4, WOOD_LEG);
  p.rect(W - 5, 10, 3, 4, WOOD_LEG);
  // マグと本
  p.rect(5, 4, 4, 4, "#f2b134");
  p.rect(14, 4, 7, 4, "#5aa9e6");
  p.rect(15, 5, 5, 1, "#a8d4f2");
  return canvasToTexture(p.canvas, key);
}

// =====================================================================
// ホワイトボード
// =====================================================================

export function whiteboardTexture(): Texture {
  const key = "whiteboard";
  if (textureCache.has(key)) return textureCache.get(key)!;
  const W = 32;
  const H = 22;
  const p = makePixelCanvas(W, H);
  p.rect(0, 0, W, 18, "#9aa2b0"); // フレーム
  p.rect(2, 2, W - 4, 14, "#f8f8f4"); // ボード面
  // 落書き（フロー図と印）
  p.rect(5, 5, 6, 4, "#5aa9e6");
  p.rect(11, 7, 4, 1, "#5aa9e6");
  p.rect(15, 5, 6, 4, "#5aa9e6");
  p.rect(21, 7, 3, 1, "#ef767a");
  p.rect(24, 4, 4, 5, "#ef767a");
  p.rect(6, 12, 16, 1, "#6fd08c");
  // ペントレイと脚
  p.rect(4, 18, W - 8, 2, "#7a8494");
  p.rect(6, 20, 2, 2, "#5d6b80");
  p.rect(W - 8, 20, 2, 2, "#5d6b80");
  return canvasToTexture(p.canvas, key);
}

// =====================================================================
// 自販機（赤いボディ＋光る商品窓）
// =====================================================================

export function vendingTexture(): Texture {
  const key = "vending";
  if (textureCache.has(key)) return textureCache.get(key)!;
  const W = 18;
  const H = 32;
  const p = makePixelCanvas(W, H);
  p.rect(0, 0, W, H, "#d94a4a"); // ボディ
  p.rect(0, 0, W, 2, "#e86a6a"); // 上面ハイライト
  p.rect(0, H - 2, W, 2, "#a83a3a");
  // 光る商品窓
  p.rect(2, 3, 10, 16, "#fff4d8");
  // カラフルな缶
  const cans = ["#5aa9e6", "#6fd08c", "#f2b134", "#9d8cff", "#ef767a", "#4ecdc4"];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      p.rect(3 + c * 3, 5 + r * 5, 2, 3, cans[(r * 3 + c) % cans.length]);
    }
  }
  // 取り出し口・コイン投入
  p.rect(2, 21, 10, 4, "#7a2a2a");
  p.rect(14, 4, 2, 6, "#f8f8f4");
  p.px(14, 12, "#3a3038");
  return canvasToTexture(p.canvas, key);
}

// =====================================================================
// 観葉植物（3種類：小鉢／背の高いフィカス／モンステラ風）
// =====================================================================

const PLANT_SMALL = [
  "....gGg....",
  "..gGGGGGg..",
  ".gGGgGGgGg.",
  "..gGGGGGg..",
  "....ggg....",
  "...TTTTT...",
  "...TttTT...",
  "....TTT....",
];
const PLANT_TALL = [
  "....gGGg....",
  "..gGGGGGGg..",
  ".gGGgGGGgGg.",
  ".GGGGGGGGGG.",
  ".gGGGGgGGGg.",
  "..gGGGGGGg..",
  "..GGgGGgGG..",
  "...gGGGGg...",
  "....gGg.....",
  "....BBB.....",
  "....BBB.....",
  "...TTTTT....",
  "...TttTT....",
  "...TTTTT....",
];
const PLANT_MONSTERA = [
  "..GG....GG..",
  ".GGGG..GGGG.",
  ".GgGGGGGGgG.",
  "..GGGGGGGG..",
  ".GGgGGGGgGG.",
  "..GGGGGGGG..",
  "...gGGGGg...",
  "....TTTT....",
  "...TTttTT...",
  "...TTTTTT...",
];
const PLANT_PALETTE: Palette = {
  g: "#4a9a4a",
  G: "#6fc06f",
  B: "#8c5a33",
  T: "#e8946a", // テラコッタ鉢
  t: "#d97e50",
};

export function plantTexture(kind: 0 | 1 | 2 = 0): Texture {
  const rows = kind === 0 ? PLANT_SMALL : kind === 1 ? PLANT_TALL : PLANT_MONSTERA;
  return textureFromPixels(rows, PLANT_PALETTE, 4, `plant-${kind}`);
}

// =====================================================================
// 掲示板（コルクにカラフルな貼り紙）
// =====================================================================

const BOARD_PIXELS = [
  "FFFFFFFFFFFFFFFFFFFFFF",
  "FbbbbbbbbbbbbbbbbbbbbF",
  "FbYYYbbbBBBBbbbPPPbbbF",
  "FbYYYbbbBBBBbbbPPPbbbF",
  "FbYYYbbbbbbbbbbPPPbbbF",
  "FbbbbbbGGGGbbbbbbbbbbF",
  "FbWWWWbGGGGbbbYYYYbbbF",
  "FbWWWWbbbbbbbbYYYYbbbF",
  "FbbbbbbbbbbbbbbbbbbbbF",
  "FFFFFFFFFFFFFFFFFFFFFF",
];
const BOARD_PALETTE: Palette = {
  F: "#8c5a33",
  b: "#e0c9a0",
  Y: "#f9e07f",
  B: "#9ad0f2",
  P: "#f7b2d9",
  G: "#a8e6a8",
  W: "#ffffff",
};

export function boardTexture(): Texture {
  return textureFromPixels(BOARD_PIXELS, BOARD_PALETTE, 4, "board");
}

// =====================================================================
// 「増築中」看板・台車（引っ越し演出用）
// =====================================================================

const SIGN_PIXELS = [
  "YYYYYYYYYYYYYYYY",
  "YBBBBBBBBBBBBBBY",
  "YB.B.BB.B.BB.BBY",
  "YB.B.B.BB.B.B.BY",
  "YBBBBBBBBBBBBBBY",
  "YYYYYYYYYYYYYYYY",
  ".....M..M.......",
  ".....M..M.......",
  "....MMMMMM......",
];
const SIGN_PALETTE: Palette = {
  Y: "#ffc93c",
  B: "#3a3038",
  M: "#8c5a33",
};

export function signTexture(): Texture {
  return textureFromPixels(SIGN_PIXELS, SIGN_PALETTE, 4, "sign");
}

const CART_PIXELS = [
  "............",
  "...HHHHHH...",
  "..H......H..",
  "..H......H..",
  "..HHHHHHHH..",
  "..PPPPPPPP..",
  "..P......P..",
  "..oo....oo..",
];
const CART_PALETTE: Palette = {
  H: "#c8ccd4",
  P: "#5d6b80",
  o: "#3a3244",
};

export function cartTexture(): Texture {
  return textureFromPixels(CART_PIXELS, CART_PALETTE, 4, "cart");
}

// =====================================================================
// 床パターン（32x32を敷き詰める。TilingSpriteで使用）
// =====================================================================

export type FloorKind = "wood" | "carpet-blue" | "carpet-green" | "corridor" | "plaza";

export function floorTexture(kind: FloorKind): Texture {
  const key = `floor-${kind}`;
  if (textureCache.has(key)) return textureCache.get(key)!;
  const S = 32;
  const p = makePixelCanvas(S, S);

  if (kind === "wood") {
    // 温かみのある木目フローリング（横板、互い違いの継ぎ目）
    const tones = ["#dcaa72", "#d4a069", "#e2b27c", "#d8a56e"];
    for (let row = 0; row < 4; row++) {
      p.rect(0, row * 8, S, 8, tones[row % tones.length]);
      p.rect(0, row * 8 + 7, S, 1, "#bd8a52"); // 板の継ぎ目
      const cut = (row % 2 === 0 ? 10 : 24) % S;
      p.rect(cut, row * 8, 1, 7, "#bd8a52"); // 板の切れ目（互い違い）
      p.px((cut + 8) % S, row * 8 + 3, "#c89058"); // 木目の点
    }
  } else if (kind === "carpet-blue") {
    // ブルーグレーのカーペット（ディザの市松で質感）
    p.rect(0, 0, S, S, "#96aabf");
    for (let y = 0; y < S; y += 2) {
      for (let x = 0; x < S; x += 2) {
        if ((x + y) % 4 === 0) p.px(x, y, "#8a9eb3");
      }
    }
    p.rect(0, 0, S, 1, "#a2b6ca");
  } else if (kind === "carpet-green") {
    // 落ち着いたグリーンのカーペット
    p.rect(0, 0, S, S, "#9dbfa4");
    for (let y = 0; y < S; y += 2) {
      for (let x = 0; x < S; x += 2) {
        if ((x + y) % 4 === 0) p.px(x, y, "#90b297");
      }
    }
  } else if (kind === "corridor") {
    // 明るいタイル床（16pxグリッド）
    p.rect(0, 0, S, S, "#ded8cc");
    p.rect(0, 15, S, 1, "#ccc5b6");
    p.rect(15, 0, 1, S, "#ccc5b6");
    p.rect(0, 31, S, 1, "#ccc5b6");
    p.rect(31, 0, 1, S, "#ccc5b6");
    p.px(4, 4, "#d2ccbf");
    p.px(22, 24, "#d2ccbf");
  } else {
    // plaza：エントランス周りの少し濃いタイル
    p.rect(0, 0, S, S, "#cfc8ba");
    p.rect(0, 15, S, 1, "#bdb5a5");
    p.rect(15, 0, 1, S, "#bdb5a5");
    p.rect(0, 31, S, 1, "#bdb5a5");
    p.rect(31, 0, 1, S, "#bdb5a5");
  }
  return canvasToTexture(p.canvas, key);
}
