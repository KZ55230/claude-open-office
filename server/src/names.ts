// sessionIdから決定的に従業員の名前とスプライトシードを生成するモジュール

/** 日本人の姓リスト（30個程度）。sessionIdハッシュから決定的に1つ選ぶ */
const SURNAMES = [
  "佐藤", "鈴木", "高橋", "田中", "伊藤",
  "渡辺", "山本", "中村", "小林", "加藤",
  "吉田", "山田", "佐々木", "山口", "松本",
  "井上", "木村", "林", "斎藤", "清水",
  "山崎", "森", "池田", "橋本", "阿部",
  "石川", "山下", "中島", "石井", "小川",
];

/**
 * 文字列を単純なハッシュ整数に変換する（文字コードの畳み込み）。
 * djb2に近い決定的ハッシュ。負値にならないよう符号なし32bitへ丸める。
 */
export function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + charCode
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // 符号なし32bit整数へ
  return hash >>> 0;
}

/** sessionIdから決定的に日本人の姓を選ぶ */
export function nameFromSessionId(sessionId: string): string {
  const h = hashString(sessionId);
  return SURNAMES[h % SURNAMES.length];
}

/** sessionIdから決定的にスプライト用シード整数を生成する */
export function spriteSeedFromSessionId(sessionId: string): number {
  // 名前選択とは別の攪拌をかけて、見た目のバリエーションを増やす
  return hashString(sessionId + "#sprite");
}
