// 自前のトゥイーン（補間アニメーション）エンジン。外部依存なし。
// 位置変化・カメラ移動・壁の拡張などすべての「なめらかな変化」に使う。
// requestAnimationFrame相当をPixiのtickerから駆動する。

/** イージング関数の型（0〜1を受け取り0〜1を返す） */
export type Easing = (t: number) => number;

/** よく使うイージング関数群 */
export const Easings = {
  // 線形（等速）
  linear: (t: number) => t,
  // 加減速あり（もっとも汎用的）
  easeInOutQuad: (t: number) =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  // 減速して止まる（着席やカメラ停止に自然）
  easeOutCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  // ゆっくり始まる
  easeInCubic: (t: number) => t * t * t,
  // 軽く弾む（着席の"ぽん"）
  easeOutBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

/** 1本のトゥイーン */
interface Tween {
  duration: number; // ミリ秒
  elapsed: number; // 経過ミリ秒
  delay: number; // 開始遅延ミリ秒
  easing: Easing;
  onUpdate: (t: number) => void; // イージング適用後の進捗0〜1を渡す
  onComplete?: () => void;
  done: boolean;
}

/**
 * トゥイーンを束ねて毎フレーム進めるマネージャ。
 * Pixiのapp.ticker.add(dt => manager.update(app.ticker.deltaMS)) で駆動する想定。
 */
export class TweenManager {
  private tweens: Tween[] = [];

  /**
   * 新しいトゥイーンを登録し、完了を待てるPromiseを返す。
   * @param opts.duration ミリ秒
   * @param opts.onUpdate 進捗コールバック（0→1、イージング適用済み）
   */
  add(opts: {
    duration: number;
    delay?: number;
    easing?: Easing;
    onUpdate: (t: number) => void;
    onComplete?: () => void;
  }): Promise<void> {
    return new Promise((resolve) => {
      this.tweens.push({
        duration: Math.max(1, opts.duration),
        elapsed: 0,
        delay: opts.delay ?? 0,
        easing: opts.easing ?? Easings.easeInOutQuad,
        onUpdate: opts.onUpdate,
        onComplete: () => {
          opts.onComplete?.();
          resolve();
        },
        done: false,
      });
    });
  }

  /** 一定時間待つだけのユーティリティ（演出の間合い用） */
  wait(ms: number): Promise<void> {
    return this.add({ duration: ms, easing: Easings.linear, onUpdate: () => {} });
  }

  /** 毎フレーム呼ぶ。deltaMSは前フレームからの経過ミリ秒 */
  update(deltaMS: number): void {
    for (const tw of this.tweens) {
      if (tw.done) continue;
      // 遅延消化
      if (tw.delay > 0) {
        tw.delay -= deltaMS;
        if (tw.delay > 0) continue;
        // 遅延を食いきった余剰分を経過時間へ
        tw.elapsed += -tw.delay;
        tw.delay = 0;
      } else {
        tw.elapsed += deltaMS;
      }
      const raw = Math.min(1, tw.elapsed / tw.duration);
      tw.onUpdate(tw.easing(raw));
      if (raw >= 1) {
        tw.done = true;
        tw.onComplete?.();
      }
    }
    // 完了済みを掃除
    if (this.tweens.some((t) => t.done)) {
      this.tweens = this.tweens.filter((t) => !t.done);
    }
  }
}

/** 数値の線形補間 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
