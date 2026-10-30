# shiotomo-mod

Claude Code の mod。プロンプトごとにタスクの重さを分類し、そのターンを最適なモデルで実行します。effort は各モデルの既定に任せ、明らかに合わないときだけ変えます。


| ティア      | 例                          | 既定モデル    |
| -------- | -------------------------- | -------- |
| simple   | 質問・コード説明・タイポ修正・リネーム        | `haiku`  |
| standard | 数ファイルの機能実装・テスト作成・通常のデバッグ   | `sonnet` |
| complex  | 設計・大規模リファクタ・難しいバグ・セキュリティ分析 | `opus`   |


## 導入

### 1. GitHub のリポジトリから入れる

```sh
/plugin install shiotomo-mod --marketplace TomoShiozawa/shiotomo-mod
```

### 2. ローカルのフォルダから入れる

このリポジトリを clone した状態で、フォルダを指定して起動します。そのセッションだけ有効になります。

```sh
claude --plugin-dir ./shiotomo-mod
```

### 動作の確認

起動後に `/router` を実行して、次のように現在の状態が出れば導入できています。

```
mode: auto
models: simple=haiku, standard=sonnet, complex=opus
Enable model switching: on
Enable decision making (Jev / Laya): on
classifier: haiku
decide tool: off
animation: off
```

## 使い方

何もしなくても、`auto` モードで自動的に振り分けます。プロンプトを送るたびに、ステータスラインへ現在のルートが出ます。

```
router: claude-sonnet-5-5 (standard, auto)
```

### コマンド


| コマンド               | 動作                                                         |
| ------------------ | ---------------------------------------------------------- |
| `/router`          | 現在のモード、直近のルート、モデルの設定を表示                           |
| `/router auto`     | 自動で振り分ける（既定）                                               |
| `/router off`      | 振り分けをやめ、`/model` で選んだモデルをそのまま使う                            |
| `/router simple`   | simple のモデルに固定する                                  |
| `/router standard` | standard のモデルに固定する                                |
| `/router complex`  | complex のモデルに固定する                                 |
| `/decide ...`      | Jev / Laya に判断を直接任せる（[`/decide` で自分で任せる](#decide-で自分で任せる)） |


モードは保存され、次のセッションにも引き継がれます。

### 補足

- 振り分けが合わないときや、モデルを自分で決めたいときは `/router off` にして、`/model` で選びます。
- 作業の間ずっと同じモデルで続けたいときは、`/router simple` などで固定します。固定モードは、依頼の重さに関係なく常にそのティアのモデルを使います。

## decideツール

Jev/Layaを利用した `/decide` コマンドも利用できます。
デフォルトでは無効になっています。

| 質問の型     | 答え                                  |
| -------- | ----------------------------------- |
| `choice` | 選択肢のどれか（`choice`）と各選択肢の確率、確信度       |
| `score`  | 2〜10 段階の尺度での期待値（`score`）と各段階の確率、確信度 |
| `noul`   | 命題が正しい確率（`noul`）                    |


### 有効にする

既定では `decide` ツールを出さず、分類も haiku で行います。使うときは `/config` で次のどちらか（または両方）を設定します。

- `decideBackend` を `laya` か `jev` にする: `decide` ツールが Claude 利用できるようになります
  - `decideBackend` を有効にすると、mod は `mcp__shiotomo-mod__decide` ツールを登録します。
- `classifier` を `laya` か `jev` にする: ティア分類を決定モデルに任せます（後述）。

- Jev を選んで `jevApiKey` が空のとき: TypeSafe の API キーの入力を促します。キーは機密項目なので `/config` には出ず、`/plugin configure shiotomo-mod` で入力します。


### `/decide` コマンド

| 書き方                                          | 内容                                      |
| -------------------------------------------- | --------------------------------------- |
| `/decide yesno <命題> :: <テキスト>`               | 命題が正しい確率を返す                             |
| `/decide choice <a,b,c> <質問> :: <テキスト>`      | 選択肢のどれかと各確率を返す                          |
| `/decide score <2〜10> <質問> :: <テキスト>`        | 段階数ぶんの尺度での期待値を返す                        |
| `/decide {"state": ..., "questions": {...}}` | `decide` ツールの入力をそのまま渡す（`states` で複数件も可） |


```
/decide choice bug,flaky,other 失敗の種類は？ :: test timed out once, passed on retry
```

`choice` の選択肢は名前がそのまま説明になります。説明を付けたい質問や複数の質問は JSON で渡してください。

### Laya を使う

この mod は Laya を起動しません。Python 3.10 以上の環境で、別に laya-serve を動かしておきます。

```sh
pip install "laya[serve]"    # uv なら uv tool install "laya[serve]"
LAYA_HOST=127.0.0.1 laya-serve    # 既定で :8000 に立つ
```

初回はモデル（約 1GB）を Hugging Face からダウンロードします。別のポートや別のマシンで動かす場合は、`layaUrl` をその URL にしてください。

### Jev を使う

`decideBackend`（または `classifier`）を `jev` にし、TypeSafe の API キーを `jevApiKey` に入力します。キーは `/config` ではなく、`/plugin configure shiotomo-mod` で入力します。Jev に送ると、state の内容は TypeSafe のサーバに送られます。コードや社外秘の文章を外に出したくない場合は Laya を使ってください。

### ティア分類にも使う

`classifier` を `laya` か `jev` にすると、プロンプトのティア分類（simple / standard / complex）を haiku ではなく決定モデルに任せます。ローカルの Laya なら 1 回数十ミリ秒で済み、分類のための API 呼び出しがなくなります。失敗したときは haiku で分類し直します。モデルを切り替えるターンの effort の判定にも、同じ分類器を使います。

## スピナーのアニメーション

ジョーク機能です。Claude が動いている間の行に、動くアスキーアートを出します。既定ではオフです。元のスピナーの語（`Sauteing` など）の前に付きます。

```
|   =^.^=      | Sauteing… (12s, 300 tokens)
```

## 設定

設定メニュー（`/config`）に、プラグインの項目として次が並びます（機密項目の `layaApiKey` と `jevApiKey` を除く）。値を変えると mod が再読み込みされ、次のリクエストから反映されます。


| 項目                | 既定                        | 内容                                                                                           |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `simpleModel`     | `haiku`                   | simple のモデル                                                                                  |
| `standardModel`   | `sonnet`                  | standard のモデル                                                                                |
| `complexModel`    | `opus`                    | complex のモデル                                                                                 |
| `routingEnabled`  | `true`                    | モデルの切り替えを有効にする。`false` ではモデルも effort も変えない（Jev / Laya には影響しない）                               |
| `decisionEnabled` | `true`                    | Jev / Laya の利用（ティア分類と `decide` ツール）を有効にする。`false` では分類は haiku、`decide` は出さない（モデル切り替えには影響しない） |
| `classifier`      | `haiku`                   | ティア分類に使うモデル（`haiku` / `laya` / `jev`）                                                        |
| `decideBackend`   | `off`                     | `decide` ツールの送り先（`off` / `laya` / `jev`）。`off` ではツールを出さない                                    |
| `animationStyle`  | `off`                     | スピナー行のアニメーション（`off` / `random` / `cat` / `rocket` / `shades` / `loading` / `think` / `sleep` / `wave` / `pacman`）                                        |
| `layaUrl`         | `http://localhost:8000`   | laya-serve の URL                                                                             |
| `layaApiKey`      | なし                        | laya-serve を `LAYA_API_KEY` 付きで動かしているときのキー                                                   |
| `jevUrl`          | `https://api.typesafe.ai` | Jev の API の URL                                                                              |
| `jevModel`        | `jev-latest`              | Jev のモデル（`jev-preview` や `jev-1.13.0` など）                                                    |
| `jevApiKey`       | なし                        | TypeSafe の API キー                                                                            |


`layaApiKey` と `jevApiKey` は機密の項目として、settings ファイルではなく安全な保存先に置かれます。機密項目は `/config` の行には出ないので、`/plugin configure shiotomo-mod`（ターミナルからは `claude plugin configure shiotomo-mod@shiotomo-mod --values-stdin`）で入力します。

settings ファイルに書く場合は、`pluginConfigs` にプラグイン名で指定します。

```json
{
  "pluginConfigs": {
    "shiotomo-mod": {
      "options": {
        "standardModel": "claude-sonnet-5-5"
      }
    }
  }
}
```

モデルの指定には次のルールがあります。

- エイリアス（`haiku` / `sonnet` / `opus`）は、`claude-haiku-5-5` などのフル ID に変換して送ります。フル ID を直接書くこともできます。
- Bedrock などでモデル名に `us.anthropic.` のような接頭辞が付いている場合は、それを引き継ぎます。
- effort は各モデルの既定に任せ、変えるのは次の 2 つのときだけです。固定モード（`/router simple` など）では触れません。
  - モデルを切り替えるターンで、既定のままでは明らかに合わないと判定されたとき、既定から 1 段階下げるか上げます。
  - 下げを見送って重いモデルに留まるとき、ティアに合わせて既定より下がる場合だけ下げます（simple は `low`、standard は `medium`）。
- effort を変えたターンは、ステータスに `effort low` のように出ます。effort に対応しないモデル（Haiku 4.5 / Sonnet 4.5 以前）には送りません。

## 注意

- **分類の費用と待ち時間**：プロンプトごとに `classifier` で選んだ分類器を 1 回呼びます（既定は haiku）。haiku ではそのぶん毎回少し待ち時間と費用が増えます。モデルを切り替えるターンは、effort の判定のためにもう 1 回呼びます。
- **キャッシュ**：モデルを切り替えたターンは、会話全体のキャッシュを書き直します。長い会話で軽い方へ下げると節約額より書き直しの費用が大きくなるため、下げは大きく離れたときか小さい会話のときだけにしています。
- **`/model` との関係**：`auto` と固定モードでは、`/model` や `--model` で選んだモデルをこの mod が上書きします。自分で選んだモデルを使いたいときは `/router off` にしてください。

## 開発

```sh
claude plugin validate .   # マニフェストとフックの検証
claude plugin test .       # tests/ のテストを実行
claude --plugin-dir .      # このフォルダを読み込んで起動
```

構成は次のとおりです。


| パス                                | 内容                                   |
| --------------------------------- | ------------------------------------ |
| `.claude-plugin/plugin.json`      | mod の定義と設定項目                         |
| `.claude-plugin/marketplace.json` | `/plugin install` で入れるためのマーケットプレイス定義 |
| `hooks/hooks.json`                | フックのモジュールの指定                         |
| `hooks/main.ts`                   | 本体（ルーティング・decide・アニメーションのフック）                                  |
| `hooks/systemone.ts`              | Jev / Laya の質問と応答の型、入力の検証            |
| `hooks/animation.ts`              | スピナーのアニメーションのコマ（フックは `main.ts`） |
| `scripts/preview-animation.ts`    | アニメーションをコンソールで確かめるスクリプト           |
| `types/index.d.ts`                | mod が持つ状態の型                          |
| `tests/router.test.ts`            | ルーティングのテスト                           |
| `tests/decide.test.ts`            | Jev / Laya 連携のテスト                    |
| `tests/animation.test.ts`         | アニメーションのテスト                          |


