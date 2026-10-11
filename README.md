# model-router

Claude Code の mod。プロンプトごとにタスクの重さを分類し、そのターンを最適なモデルと effort で実行します。

| ティア | 例 | 既定モデル | 既定 effort |
| --- | --- | --- | --- |
| simple | 質問・コード説明・タイポ修正・リネーム | `haiku` | `medium` |
| standard | 数ファイルの機能実装・テスト作成・通常のデバッグ | `sonnet` | `high` |
| complex | 設計・大規模リファクタ・難しいバグ・セキュリティ分析 | `opus` | `medium` |

あわせて、分類・採点・yes/no のような「決まった選択肢から選ぶ判断」を、System-1 決定モデルの [Jev](https://flaviocopes.com/jev/)（TypeSafe のホスト API）やローカルで動かす [Laya](https://github.com/NandhaKishorM/laya) に任せられます。Claude が `decide` ツールで判断を投げ、確率つきの答えを受け取って作業を続けます。この機能は既定では無効です。

## 導入

### 1. GitHub のリポジトリから入れる（他の人に配るとき）

このリポジトリを GitHub に push したあと、Claude Code のプロンプトで次を入力します。`<owner>/<repo>` は push 先に読み替えてください。

```
/plugin install model-router --marketplace <owner>/<repo>
```

マーケットプレイスの追加を聞かれたら `y`、続いてスコープ（個人で使うなら user）を選びます。完了すると `Installed model-router. Plugin is now active.` と出て、そのセッションからすぐ使えます。

### 2. ローカルのフォルダから入れる

このリポジトリを clone した状態で、フォルダを指定して起動します。そのセッションだけ有効になります。

```sh
git clone <このリポジトリの URL> model-router
claude --plugin-dir ./model-router
```

毎回フラグを付けたくない場合は、環境変数 `CLAUDE_CODE_PLUGIN_DIRS` にフォルダの絶対パスを入れておくと、同じように読み込まれます。

```sh
export CLAUDE_CODE_PLUGIN_DIRS=/path/to/model-router
```

### 動作の確認

起動後に `/router` を実行して、次のように現在の状態が出れば導入できています。

```
mode: auto
last route: -
models: simple=haiku, standard=sonnet, complex=opus
effort: simple=medium, standard=high, complex=medium
classifier: haiku
decide tool: off
```

## 使い方

何もしなくても、`auto` モードで自動的に振り分けます。プロンプトを送るたびに、ステータスラインへ現在のルートが出ます。

```
router: claude-sonnet-5-5 (standard, auto, effort high)
```

### コマンド

| コマンド | 動作 |
| --- | --- |
| `/router` | 現在のモード、直近のルート、モデルと effort の設定を表示 |
| `/router auto` | 自動で振り分ける（既定） |
| `/router off` | 振り分けをやめ、`/model` で選んだモデルをそのまま使う |
| `/router simple` | simple のモデルと effort に固定する |
| `/router standard` | standard のモデルと effort に固定する |
| `/router complex` | complex のモデルと effort に固定する |

モードは保存され、次のセッションにも引き継がれます。

### 使い分けの目安

- 普段使いは `auto` のままで構いません。
- 振り分けが合わないときや、モデルを自分で決めたいときは `/router off` にして、`/model` で選びます。
- 作業の間ずっと同じモデルで続けたいときは、`/router simple` などで固定します。固定モードは、依頼の重さに関係なく常にそのティアのモデルを使います。

## Jev / Laya に判断を任せる

Jev と Laya は文章を生成するモデルではなく、state（文章や JSON）と型付きの質問を受け取り、次の 3 種類の答えを確率つきで返す決定モデルです。両者は同じ `POST /v1/systemone` を話すので、この mod では送り先を切り替えるだけで使えます。

| 質問の型 | 答え |
| --- | --- |
| `choice` | 選択肢のどれか（`choice`）と各選択肢の確率、確信度 |
| `score` | 2〜10 段階の尺度での期待値（`score`）と各段階の確率、確信度 |
| `noul` | 命題が正しい確率（`noul`） |

### 有効にする

既定では `decide` ツールを出さず、分類も haiku で行います。使うときは `/config` で次のどちらか（または両方）を設定します。

- `decideBackend` を `laya` か `jev` にする: `decide` ツールが Claude に見えるようになります。
- `classifier` を `laya` か `jev` にする: ティア分類を決定モデルに任せます（後述）。

有効にすると mod が読み込み直され、すぐに使えない場合は transcript に案内が出ます。

- Jev を選んで `jevApiKey` が空のとき: TypeSafe の API キーの入力を促します。
- Laya を選んで `layaUrl` に接続できないとき: laya-serve の用意を促します。

### 任せるタスク

`decideBackend` を有効にすると、mod は `mcp__model-router__decide` ツールを登録します。Claude はツールの説明に従い、次のような判断を自分で考える代わりにこのツールへ回します。

- ログ行・issue・テストの失敗・レビューコメント・コミットメッセージの分類やトリアージ
- 感情・緊急度・言語・トピックの判定
- 多数のコード片が基準を満たすかどうかのチェック（`states` で最大 64 件をまとめて渡せます）

文章やコードの生成、手順を踏む推論、選択肢にない答えが要る判断には使いません。重要な答えや確信度の低い答えは Claude が自分で確かめます。送り先は `decideBackend` で選んだもの 1 つだけで、Claude がツール呼び出しで変えることはできません。

### Laya を使う

この mod は Laya を起動しません。Python 3.10 以上の環境で、別に laya-serve を動かしておきます。

```sh
pip install "laya[serve]"    # uv なら uv tool install "laya[serve]"
LAYA_HOST=127.0.0.1 laya-serve    # 既定で :8000 に立つ
```

初回はモデル（約 1GB）を Hugging Face からダウンロードします。別のポートや別のマシンで動かす場合は、`layaUrl` をその URL にしてください。

### Jev を使う

`decideBackend`（または `classifier`）を `jev` にし、TypeSafe の API キーを `jevApiKey` に入力します。Jev に送ると、state の内容は TypeSafe のサーバに送られます。コードや社外秘の文章を外に出したくない場合は Laya を使ってください。

### ティア分類にも使う

`classifier` を `laya` か `jev` にすると、プロンプトのティア分類（simple / standard / complex）を haiku ではなく決定モデルに任せます。ローカルの Laya なら 1 回数十ミリ秒で済み、分類のための API 呼び出しがなくなります。失敗したときは haiku で分類し直します。

## 設定

設定メニュー（`/config`）に、プラグインの項目として次が並びます。値を変えると mod が再読み込みされ、次のリクエストから反映されます。

| 項目 | 既定 | 内容 |
| --- | --- | --- |
| `simpleModel` | `haiku` | simple のモデル |
| `standardModel` | `sonnet` | standard のモデル |
| `complexModel` | `opus` | complex のモデル |
| `simpleEffort` | `medium` | simple の effort（Haiku 5.5 の推奨値） |
| `standardEffort` | `high` | standard の effort（Sonnet 5.5 の推奨値） |
| `complexEffort` | `medium` | complex の effort（Opus 5.5 の推奨値） |

| `classifier` | `haiku` | ティア分類に使うモデル（`haiku` / `laya` / `jev`） |
| `decideBackend` | `off` | `decide` ツールの送り先（`off` / `laya` / `jev`）。`off` ではツールを出さない |
| `layaUrl` | `http://localhost:8000` | laya-serve の URL |
| `layaApiKey` | なし | laya-serve を `LAYA_API_KEY` 付きで動かしているときのキー |
| `jevUrl` | `https://api.typesafe.ai` | Jev の API の URL |
| `jevModel` | `jev-latest` | Jev のモデル（`jev-preview` や `jev-1.13.0` など） |
| `jevApiKey` | なし | TypeSafe の API キー |

effort は `low` / `medium` / `high` / `xhigh` / `max` から選びます。`layaApiKey` と `jevApiKey` は機密の項目として、settings ファイルではなく安全な保存先に置かれます。

settings ファイルに書く場合は、`pluginConfigs` にプラグイン名で指定します。

```json
{
  "pluginConfigs": {
    "model-router": {
      "options": {
        "standardModel": "claude-sonnet-5-5",
        "complexEffort": "xhigh"
      }
    }
  }
}
```

モデルの指定には次のルールがあります。

- エイリアス（`haiku` / `sonnet` / `opus`）は、`claude-haiku-5-5` などのフル ID に変換して送ります。フル ID を直接書くこともできます。
- Bedrock などでモデル名に `us.anthropic.` のような接頭辞が付いている場合は、それを引き継ぎます。
- effort に対応しないモデル（Haiku 4.5 / Sonnet 4.5 以前）を指定した場合、effort は送りません。

## 仕組み

- `prompt.submit`: 自分で入力したプロンプトを `$.model.classify`（haiku）で 3 つのティアに分類します。短すぎるプロンプト（「続けて」など）は直前のルートを引き継ぎます。分類に失敗したときは standard として扱います。
- `turn.step`: メイン会話のリクエストだけ、モデルと effort を差し替えます。サブエージェントには触れません。
- `tool.call`（`mcp__model-router__decide`）: 質問を確かめてから Jev / Laya の `/v1/systemone` に送り、答えを JSON でモデルに返します。接続できないときやキーがないときは、理由をエラー結果として返します。
- `session.start`: Jev / Laya を有効にしていてすぐ使えないとき、キーの入力や laya-serve の用意を促す案内を出します。
- **モデルは粘ります。** 自動では、いま使っているモデルとの差が「簡単↔重い」の 2 段階以上になったときだけモデルを切り替えます。
- **effort は毎回ティアに合わせます。** 会話途中のモデル切り替えはプロンプトキャッシュを作り直しますが、effort だけの変更ではキャッシュは失われません。そのため、近いティアへの変化はモデルを変えず effort で調整します。
- 固定モード（`/router simple` など）は切り替えを待たず、そのモデルと effort をすぐ使います。

## 注意

- **分類の費用と待ち時間**：プロンプトごとに haiku を 1 回呼びます。そのぶん、毎回少し待ち時間と費用が増えます。
- **キャッシュ**：モデルを切り替えたターンは、会話全体のキャッシュを書き直します。切り替えが多いと、軽い依頼で節約できる分を上回ることがあります。
- **`/model` との関係**：`auto` と固定モードでは、`/model` や `--model` で選んだモデルをこの mod が上書きします。自分で選んだモデルを使いたいときは `/router off` にしてください。

## 開発

```sh
claude plugin validate .   # マニフェストとフックの検証
claude plugin test .       # tests/ のテストを実行
claude --plugin-dir .      # このフォルダを読み込んで起動
```

構成は次のとおりです。

| パス | 内容 |
| --- | --- |
| `.claude-plugin/plugin.json` | mod の定義と設定項目 |
| `.claude-plugin/marketplace.json` | `/plugin install` で入れるためのマーケットプレイス定義 |
| `hooks/hooks.json` | フックのモジュールの指定 |
| `hooks/router.ts` | 本体 |
| `hooks/systemone.ts` | Jev / Laya の質問と応答の型、入力の検証 |
| `types/index.d.ts` | mod が持つ状態の型 |
| `tests/router.test.ts` | ルーティングのテスト |
| `tests/decide.test.ts` | Jev / Laya 連携のテスト |
