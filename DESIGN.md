# Claude Office 設計書

Claude Codeのプロジェクト／セッションを「仮想オフィス」として可視化するローカルWebアプリ。
従業員＝セッション。従業員をクリックするとターミナルが開き、そのセッションに直接指示できる。

## 全体構成

- ブラウザ（PixiJSオフィス描画 + xterm.jsターミナル + HTML UI）
- Node.jsサーバー（Express + ws + @lydell/node-pty + chokidar）ポート **3777**
- 開発時はVite（5173）が `/api` と `/ws` を3777へプロキシする（vite.config.ts設定済み）
- 起動: `npm run dev`
- 共有型: `shared/types.ts` が唯一の契約。REST/WSの仕様コメントもここにある。**変更する場合は両担当合意の上で**

## ディレクトリ構成と担当分担

```
claude-office/
  DESIGN.md            ← 本書（メイン担当）
  package.json 等      ← 雛形（メイン担当。依存追加が必要ならメインに報告）
  shared/types.ts      ← 共有契約（メイン担当）
  server/src/          ← 担当A（サーバー）。client/ には触れない
  client/              ← 担当B（クライアント）。server/ には触れない
  config/settings.json ← サーバーが実行時に生成・更新（gitignore済み）
```

## データソース（重要）

### Claude Codeのセッション履歴

`~/.claude/projects/<エンコード済みcwd>/<sessionId>.jsonl`

- ディレクトリ名はcwdの `/` を `-` に置換したもの（例: `-home-shoai090925-claude-projects-KIZUNA`）。ハイフンを含むパスと区別できないため、**cwdはJSONL内の `cwd` フィールドから取得する**（各行のJSONに `cwd`, `sessionId`, `timestamp`(ISO), `type`("user"/"assistant"/"summary"), `message` などが含まれる）
- ファイル名（拡張子除く）＝sessionId
- `lastActiveAt` はファイルのmtimeを使う
- `summary`（掲示板用）: ファイル末尾から遡って `type:"summary"` 行の `summary` フィールド、なければ最後のuser/assistantメッセージのテキストを120文字で切る。JSONLは行単位で壊れている可能性があるので1行ずつtry-parseすること
- 対象プロジェクト: `~/.claude/projects/` 配下すべて。ただしcwdが存在しないフォルダを指す場合も部署として表示してよい（休眠部署）

### 部署の種別

- `project`: 通常のプロジェクト（現状はこの1種類のみ）

## ドメインルール

- **従業員（表示枠）**: 部署ごとに直近活動順で最大8人。`pinnedSessions` にあるものは優先的に枠入り。枠外は `alumni`（OB名簿）
- **島**: 1島=4席。従業員1〜4人=1島、5人以上（〜8人）=2島。**4席が埋まり5人目が入社するときに増築**
- **ステータス判定**（サーバー側）:
  - pty未稼働 → `resting`
  - pty稼働中・直近5秒以内に出力あり → `working`
  - pty稼働中・5秒以上出力なし → `waiting`
  - 状態変化時に /ws/office へ配信（1秒デバウンス）
- **従業員名**: sessionIdの単純ハッシュ（例: 文字コード和）から日本人の姓リスト（30個程度）を決定的に選ぶ。`spriteSeed` も同ハッシュ由来
- **表示部署の初期値**: settings.json が無い初回起動時は、直近活動順の上位6部署を表示ON

## サーバー仕様（担当A）

REST/WSの契約は `shared/types.ts` のコメント参照。実装モジュール分割の目安:

- `index.ts`: Express起動、静的配信（production時 `dist/`）、ルーティング、WSアップグレード
- `scanner.ts`: `~/.claude/projects` の走査 → OfficeState構築。chokidarで `*.jsonl` を監視して差分更新
- `terminal.ts`: pty管理。`claude --resume <sessionId>` をその部署のcwdで起動（env: TERM=xterm-256color）。terminalId(UUID)→ptyのMap。**出力リングバッファ（最大200KB）**を保持し、WS再接続時に再生。WSが切れてもptyは生かす（従業員は裏で働き続ける）。DELETE時のみkill
- **hire（新規雇用）**: `claude`（引数なし）をcwdで起動。chokidarがそのプロジェクトdirに新しい.jsonlを検知したら、terminalIdとsessionIdを紐づけ、WSへ `sessionBound` を送る
- `projects.ts`: 新規プロジェクト作成。name検証（`[a-zA-Z0-9_-]{1,40}`、既存フォルダ拒否）。`settings.projectsRoot`（ユーザー設定の絶対パス。未設定なら作成不可としてエラーを返す）の配下に`<name>/CLAUDE.md` を生成。テンプレート:

```markdown
# <name>

## プロジェクトの目的
<purpose>

## 基本方針
- 会話は日本語で行う
- 作業前に計画を説明し、承認を得てから実行する
```

- `settings.ts`: `config/settings.json` の読み書き（無ければデフォルト生成）
- セキュリティ: 127.0.0.1のみバインド。パス操作は必ず正規化して `settings.projectsRoot` 配下かを検証（`resolveInsideProjectsRoot`）。`projectsRoot`自体は`normalizeProjectsRoot`で絶対パスであることを検証し、保存時にフォルダを自動作成する

## クライアント仕様（担当B）

### 画面構成

- 全面: PixiJSキャンバス（オフィスマップ）。ホイールでズーム、ドラッグでパン
- 上部ヘッダー（HTML）: タイトル／「新規プロジェクト立案」／「表示プロジェクト選択」
- 右側スライドインパネル（HTML）: xterm.jsターミナル（@xterm/addon-fitでリサイズ追従、WSへresize送信）
- モーダル: 新規プロジェクト入力（名前・目的）、表示選択（チェックボックス、PUT /api/settings）、OB名簿（呼び戻すボタン→POST /api/terminal＋pinnedSessions更新）

### オフィス描画

- タイルベース（1タイル=16px、表示スケール3倍、`roundPixels`でドット絵をくっきり）
- スプライトは外部画像を使わず、**16x16程度のピクセル配列をコードで定義**してテクスチャ生成。パレットを `spriteSeed` で差し替えて従業員の見た目を変える（髪・服の色）
- 部屋（部署）: フローリング＋壁＋部署名プレート＋掲示板（ホバー/クリックでsummary表示）。島=机4席のかたまり
- 部屋はマップ上に自動配置（行単位のフローレイアウト）。**配置変更は必ずトゥイーンで移動**（瞬間移動禁止）
- 従業員: デスクに着席。ステータスバッジを頭上に表示（🟢/🟡/⚪相当の色ドット＋restingはZzz）。workingはタイピングアニメ、restingはたまに部屋内をうろうろ歩く
- クリック: 従業員→ターミナルパネル（resting なら POST /api/terminal でresume）。空席→「雇う」確認→POST /api/hire

### 演出（重要要件）

1. **入社**: 新セッション検知時（`sessionBound` またはoffice stateに新規sessionId出現時）、キャラがマップ端の入り口ドアから登場→通路を歩いて自席へ（グリッド上のシンプルな経路探索）→着席→PC点灯→ステータス表示。2〜3秒。**ターミナルは演出を待たずに即座に開く**
2. **増築（5人目入社時）**: カメラを対象の部屋へパン → 「増築中」看板 → 壁がトゥイーンで外側へ拡張・周囲の部屋も滑らかに再配置 → **引っ越し業者キャラが台車で机を1台ずつ搬入**（ドアから入り、設置位置まで押していき、設置時に砂ぼこりエフェクト、業者は退場）→ 新入社員が入社演出で着席。全体4〜5秒
3. **退勤/OB化**: 表示枠から外れた従業員はドアから歩いて退場
4. 島の縮小はリアルタイムでは行わない（次回起動時に整理された状態で開始）

### 通信

- 起動時 GET /api/office → 描画。以後 /ws/office の `state` メッセージで差分反映（前回stateと比較して入社/退場/増築を検出して演出を発火）
- ターミナル: POST /api/hire または /api/terminal → terminalId → WS `/ws/term/<terminalId>` 接続

## 品質基準

- `npm run typecheck` が通ること
- サーバーは実データ（~/.claude/projects）で起動確認すること
- クライアントは `vite build` が通ること
