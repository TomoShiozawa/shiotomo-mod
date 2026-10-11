# model-router

Claude Code の mod。プロンプトごとにタスクの重さを分類し、そのターンを最適なモデルと effort で実行します。

| ティア | 例 | 既定モデル | 既定 effort |
| --- | --- | --- | --- |
| simple | 質問・コード説明・タイポ修正・リネーム | `haiku` | `low` |
| standard | 数ファイルの機能実装・テスト作成・通常のデバッグ | `sonnet` | `medium` |
| complex | 設計・大規模リファクタ・難しいバグ・セキュリティ分析 | `opus` | `high` |

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
effort: simple=low, standard=medium, complex=high
```

## 使い方

何もしなくても、`auto` モードで自動的に振り分けます。プロンプトを送るたびに、ステータスラインへ現在のルートが出ます。

```
router: claude-sonnet-5-5 (standard, auto, effort medium)
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

## 設定

設定メニュー（`/config`）に、プラグインの項目として次が並びます。値を変えると mod が再読み込みされ、次のリクエストから反映されます。

| 項目 | 既定 | 内容 |
| --- | --- | --- |
| `simpleModel` | `haiku` | simple のモデル |
| `standardModel` | `sonnet` | standard のモデル |
| `complexModel` | `opus` | complex のモデル |
| `simpleEffort` | `low` | simple の effort |
| `standardEffort` | `medium` | standard の effort |
| `complexEffort` | `high` | complex の effort |

effort は `low` / `medium` / `high` / `xhigh` / `max` から選びます。

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
| `types/index.d.ts` | mod が持つ状態の型 |
| `tests/router.test.ts` | テスト |
