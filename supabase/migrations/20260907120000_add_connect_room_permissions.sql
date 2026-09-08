-- 固定ミーティング（connect_rooms）に「誰が一覧で見られるか」「誰が初期ホスト権を持つか」を
-- 設定できるようにするための拡張。
--
-- 背景: これまで固定ミーティングはログインさえしていれば誰でも作成・閲覧・削除できていた。
-- 「誰が見れるか」はUI上は人単位のマルチセレクト（basic_profile_infoの全員が未選択の状態から
-- スタートし、検索して選ぶ・「全員」ボタンで一括選択してから一部を外す、といった操作ができる）
-- として作成するため、DB上は「このルームを見られる人」を列挙する1テーブルだけで表現する
-- （除外リストと許可リストを分ける必要はなく、選択結果＝閲覧できる人のスナップショット）。
-- あわせて、そのミーティングの録画開始・ミニルーム作成・強制退出などの操作を行える「ホスト」を
-- 作成時に複数人指定できるようにする（ホストコードを知っていれば権限を持たない人でもホストに
-- なれる、という運用も想定）。

ALTER TABLE public.connect_rooms
  ADD COLUMN visibility text NOT NULL DEFAULT 'custom'
    CHECK (visibility IN ('all', 'internal', 'custom')),
  ADD COLUMN host_code text,
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.connect_rooms.visibility IS
  '一覧バッジ表示用のラベルで、作成時点の閲覧者選択がどのショートカットと一致していたかのスナップショット。all=全メンバーを選択していた、internal=内部メンバー全員を選択していた、custom=それ以外の個別選択。実際のアクセス制御はconnect_room_viewersの中身で行う（このカラムはフィルタ条件には使わない）';
COMMENT ON COLUMN public.connect_rooms.host_code IS
  'このコードを知っていれば、権限を付与されていない人でも通話内でホストになれる合言葉（平文保存。ログイン資格情報ではなくZoomのパスコードに近いもの）';

-- このルームを一覧で見られる人（作成時に選択された人のスナップショット）。
-- 作成者・ホストは別途 created_by / connect_room_hosts で常に閲覧可能なので、ここには含めなくてよい。
CREATE TABLE public.connect_room_viewers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.connect_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id)
);
CREATE INDEX connect_room_viewers_room_id_idx ON public.connect_room_viewers (room_id);
ALTER TABLE public.connect_room_viewers ENABLE ROW LEVEL SECURITY;
-- backendはservice role keyでアクセスするためRLSは有効化のみでポリシーは追加しない（他のconnect_*テーブルと同じ方針）

-- 固定ミーティングの初期ホスト権を持つユーザー（作成者は常に含まれる）
CREATE TABLE public.connect_room_hosts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.connect_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id)
);
CREATE INDEX connect_room_hosts_room_id_idx ON public.connect_room_hosts (room_id);
ALTER TABLE public.connect_room_hosts ENABLE ROW LEVEL SECURITY;
