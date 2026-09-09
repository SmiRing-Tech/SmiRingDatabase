-- 「外部ミーティング」（DBアカウントを持たない完全外部ユーザーにも共有できる、
-- 失効日時つきの通話リンク）を固定ミーティングと同じ connect_rooms テーブルの
-- 上に表現するための拡張。
--
-- 背景: 固定ミーティング（meeting_type='fixed'）は「誰が見れるか」をロール・部署・
-- 個別選択で細かく制御する内部向けの常設ルームだった。外部ミーティング
-- （meeting_type='external'）はそれとは性質が異なり、
--   - 公開範囲は常に private（作成者 + 明示的に共有した内部メンバーのみ一覧に見える）
--   - 失効日時（expires_at）を必ず持ち、これを過ぎると新規入室ができなくなる
--     （実際の入室検証は完全外部ユーザー向けの合言葉URL機能とあわせて別途実装する）
--   - 開始/終了予定時刻（scheduled_start_at / scheduled_end_at）を任意で持てる
--     （将来のGoogleカレンダー同期を見据えたフィールド）
--   - ログイン不要のURL直リンクでPreJoinに入れるよう、推測不可能な招待トークンを持つ
-- という前提で作る。既存の閲覧・ピン留め・ホスト管理などのインフラを
-- そのまま使い回すため、新しいテーブルを増やすのではなく connect_rooms に
-- カラムを追加する形にしている。

ALTER TABLE public.connect_rooms
  ADD COLUMN meeting_type text NOT NULL DEFAULT 'fixed'
    CHECK (meeting_type IN ('fixed', 'external')),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN scheduled_start_at timestamptz,
  ADD COLUMN scheduled_end_at timestamptz,
  ADD COLUMN invite_token text;

COMMENT ON COLUMN public.connect_rooms.meeting_type IS
  'fixed=内部向けの常設ミーティング（従来通り）。external=完全外部ユーザーにも招待URLで共有できるミーティング。作成後の変更不可（作成時に確定）。';
COMMENT ON COLUMN public.connect_rooms.expires_at IS
  'external専用。この日時を過ぎるとinvite_tokenでの新規入室ができなくなる（fixedはNULLのまま）。';
COMMENT ON COLUMN public.connect_rooms.scheduled_start_at IS
  '任意の開催予定開始時刻（表示・将来のカレンダー連携用。入室可否には影響しない）。';
COMMENT ON COLUMN public.connect_rooms.scheduled_end_at IS
  '任意の開催予定終了時刻（表示・将来のカレンダー連携用。入室可否には影響しない）。';
COMMENT ON COLUMN public.connect_rooms.invite_token IS
  'external専用。ログイン不要のURL直リンク（/j/:invite_token 想定）に埋め込む推測不可能なトークン。host_codeと同様の「合言葉」的性質のため平文保存。';

CREATE UNIQUE INDEX connect_rooms_invite_token_key
  ON public.connect_rooms (invite_token)
  WHERE invite_token IS NOT NULL;
