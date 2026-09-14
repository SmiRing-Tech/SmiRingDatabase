# recording-compositor

SmiRing Connect の録画を1本の動画に合成する Cloud Run Job。

通話中は Hetzner 上の LiveKit Egress が参加者ごとのトラックを個別ファイルとして R2 に保存し、
通話終了時に backend がこの Job を起動する。Job は個別ファイルを集めて ffmpeg で合成し、
完成した動画を R2 に保存して `connect_recordings` 行を `completed` に更新し、一時ファイルを削除する。

合成が Hetzner ではなくここで動くのは、あの箱(CX33 / 4 vCPU)がライブ通話の SFU を
動かしているため。録画(コーデックコピーのみ)は軽いが、合成は重い。

「なぜ今の実装がこうなっているか」の経緯(踏んだバグ・実測・検証の過程)は
[`docs/DEVELOPMENT_LOG.md`](docs/DEVELOPMENT_LOG.md) を参照。

## レイアウト

- 画面共有あり: 共有画面を左に大きく + 右の列に顔を最大10人
- 画面共有なし: 顔を最大20人のグリッド
- **録画されるカメラは同時最大20本まで**(backend の `MAX_RECORDED_CAMERAS`、既定20)。
  1トラック = 1 egress ジョブ = Hetzner上の1プロセス + SFUへの1接続で、実測で映像1本あたり
  約0.06〜0.11コア。このコストはビットレートではなく**本数**に比例する(Track Egress は
  コーデックコピーのみで再エンコードしないため、6Mbpsの画面共有と720pのカメラがほぼ同コスト)
  ので、人数に比例して効く対策は本数の上限だけ。20という数字はこのファイルの
  `MAX_FACES_IN_GRID` とフロントの `MAX_LIVE_TILES` に合わせてあり、**合成が描けたはずの顔を
  録り逃すことは起きない**。溢れた人は在室情報から本人のアバタータイルとして描かれる
  (カメラOFFの人と同じ経路)。**マイクと画面共有は上限の対象外**
- 枠は**カメラOFF・退室で解放され、空いたら溢れていた人が埋める**。退室時は
  `participant_left` webhook が (1) その人の開いているトラック行を閉じて枠を返し
  (`closeParticipantTracks`)、(2) その場で `syncCameraRecordings` を回して空いた枠を埋める。
  これが無いと、最初の20人が全員抜けた後も枠が埋まったままになり、残った人が最後まで
  アイコンのままになる
- 画面共有の開始・終了だけでなく、**カメラの参加・退出(録画開始後に誰かが参加/カメラON/OFF
  した瞬間)でもタイムラインを区切り**、区間ごとに描画してから連結する(そうしないと、後から
  参加した人がいる区間全体が「最終的な人数」に合わせたグリッドサイズになってしまい、その人が
  実際にいなかった時間帯まで小さいグリッドのままになる)
- 音声は区間に関係なく全マイクをミックスする(画面に映っていない人の声も残る)
- **カメラのOFFは egress を止め、ONで新しい egress を張り直す**(1トラックが録画中に複数ファイルを
  持ち、R2キーとDBの `segment_index` で区別される)。これは LiveKit がカメラOFFを unpublish では
  なく mute で扱うため — publication が生き続けるので
    * ミュート中のトラックに egress を張ると、実際に映像が届くまでの空白がファイル内部の時刻に
      残らず、後から来た映像が録画開始時刻に配置されてズレる
    * 一度でもONにした後のOFF/ONは webhook が一切飛ばない
      (`track_published` が飛ぶのは「そのセッションで初めてpublishした瞬間」だけ。
      `track_muted`/`track_unmuted` というwebhookイベントはLiveKitに存在しない)
  という2点があり、クライアントが `POST /api/connect/rooms/:roomId/recording/sync` を叩いて
  backendに「LiveKitの状態を読み直せ」と促す方式にしている。**リクエストの中身は一切信用せず**、
  状態は `listParticipants()` から、時刻はサーバー自身の時計から取る
- 各トラックが「録画のどの時点から始まったか」は `connect_recording_tracks` テーブル
  (backend が egress 開始と同時に書き込む)から取得する。以前は LiveKit の `listEgress` API
  から事後に復元しようとしていたが、録画開始後に追加されたトラック(画面共有ON・後から参加
  した人)について開始時刻が取得できないことがあり、原因が特定できなかったため、egress を
  開始したその瞬間に自分たちのDBへ書く方式に変更した(`backend/src/lib/recording.ts`の
  `startTrackRecording`)。この Job は LiveKit の API を一切呼ばない。
- 顔の選定は「その区間でカメラがONだった時間が長い順」。カメラOFFでも**その時点でルームにいれば**
  本人のプロフィールアバター画像を1タイルとして表示する
  (`basic_profile_info.avatar_id` → `gallery` から取得、`recording-compositor/src/avatars.ts`)。
  **アバター未設定の人・画像が読めなかった人には汎用の人型シルエット**を出す(フォントを必要と
  しないよう`geq`で描画。コンテナは`node:22-slim`+ffmpegのみでフォントが入っていないため)。
  サムネイル(webp)が読めない環境に備えて原本(jpg)へ自動フォールバックする。
  カメラON勢が定員(10 / 20)を優先的に埋め、余った枠だけアイコン勢に回る
- 在室は `connect_recording_participants`(`participant_joined` / `participant_left` webhookで
  backendが記録)から取る。トラックから推測しないのは、**マイクもカメラも切って入室した人は
  publishされたトラックが1つも無い**ため — それだと録画上まったく存在しないことになってしまう
- 区間の区切りは、画面共有・カメラの開始/終了に加えて**入室・退室**でも行う

## ストレージ

一時トラックファイル・完成動画とも、既存のメインバケット(`R2_BUCKET_NAME`)にそのまま入る。
既存の `connect/backgrounds/` と同じ `connect/` 配下の規約に合わせて、
`connect/recordings-tmp/` と `connect/recordings/` の prefix で分けている。egress もこの
Job も同じ R2認証情報を使うため、バケットを分けても隔離効果がなく、新規バケットは作らない。

一時ファイルは合成成功時にこの Job が明示的に削除するが、Job が落ちた場合の保険として、
`backend/src/routes/maintenanceRoutes.ts`(Cloud Scheduler から10分おきに叩かれる既存の
メンテナンスAPI)の `runHourlyTasks` から `cleanupStaleTempRecordings`
(`backend/src/lib/recording.ts`)を呼び、24時間を超えた `connect/recordings-tmp/` 配下の
ファイルを削除している。R2側のライフサイクルルールは使わない。

## セットアップ

### 1. Cloud Run Job をデプロイする

```sh
cd recording-compositor
gcloud run jobs deploy recording-compositor \
  --source . \
  --region <GCP_REGION> \
  --task-timeout 3600 \
  --memory 8Gi \
  --cpu 4 \
  --max-retries 1 \
  --set-env-vars R2_ENDPOINT=...,R2_ACCESS_KEY_ID=...,R2_SECRET_ACCESS_KEY=...,\
R2_BUCKET_NAME=...,SUPABASE_URL=...,SUPABASE_SECRET_KEY=...
```

値はすべて既存の backend Cloud Run サービスに設定済みのものと同じでよい(`R2_BUCKET_NAME`は
既存のメインバケット)。新しく用意する必要があるものはない。

`--memory` に余裕を持たせているのは、トラックファイルを `/tmp`(Cloud Run ではメモリ上)に
ダウンロードするため。20人 × 長時間の通話ではここが最初に詰まるので、長い会議を録るなら
メモリを増やすか、Cloud Storage ボリュームのマウントに切り替える。

`ROOM_NAME` と `RECORDING_ID` は backend が実行ごとに上書きで渡すので、ここでは設定しない。

### 2. backend に権限と環境変数を設定する

Cloud Run のバックエンドのサービスアカウントに、この Job を起動する権限を付与する:

```sh
gcloud run jobs add-iam-policy-binding recording-compositor \
  --region <GCP_REGION> \
  --member serviceAccount:<バックエンドのサービスアカウント> \
  --role roles/run.developer
```

Cloud Run Admin API (`run.googleapis.com`) も有効にしておく。

backend 側に必須の環境変数は `COMPOSITOR_JOB_NAME`(Job 名、上の例では
`recording-compositor`)の1つだけ。プロジェクト・リージョンは backend が Vertex AI 用に
既に持っている `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` をそのまま再利用する
(`backend/src/lib/compositorTrigger.ts`)。

任意で `MAX_RECORDED_CAMERAS`(同時に録画するカメラの上限、未設定なら20)も設定できる。
Hetzner の箱が大人数の通話で詰まるようなら下げる。上限の意味は上の「レイアウト」を参照。

### 3. 権限レコードを追加する

`CLAUDE.md` の規約通り、マイグレーションではなく直接 SQL を実行する:

```sql
INSERT INTO permissions (name, resource, action, description) VALUES
  ('録画の閲覧', 'connect_recording', 'read', 'SmiRing Connectの録画を閲覧・ダウンロードできる'),
  ('録画の開始・保存・破棄', 'connect_recording', 'write', 'SmiRing Connectの通話で録画を開始でき、停止後の保存確定・破棄ができる');
-- 録画の「停止」はこの権限を問わない。ホストなら誰でも進行中の録画を止められる
-- （止めた人にしか見えない保存/破棄の確認画面が出るだけで、保存確定にはこのwrite権限が要る）。

-- smiring_member ロールに write を付与(write は read を包含する)
INSERT INTO permission_mappings (grantee_type, grantee_id, permission_id)
SELECT 'role', (SELECT id FROM user_roles WHERE role_name = 'smiring_member'), id
FROM permissions WHERE resource = 'connect_recording' AND action = 'write';
```

### 4. Hetzner 側に Egress を追加する

`hetzner-livekit/` で `./render-config.sh` を実行してから `docker compose up -d`。
`egress` サービスが追加されているので、`docker compose logs egress` で
LiveKit(Redis経由)に接続できているか確認する。

R2 の認証情報は egress 側には設定しない(backend がリクエストごとに渡す)。

## ローカル実行

```sh
npm install
ROOM_NAME=<ルーム名> RECORDING_ID=<connect_recordings.id> npm run dev
```

ffmpeg と ffprobe が PATH に必要。`.env` があれば自動で読み込む。
