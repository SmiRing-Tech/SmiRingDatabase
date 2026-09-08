-- インスタントミーティング（固定ミーティングとして登録されていないルーム）のホストを記録する
-- テーブル。固定ミーティングは connect_rooms.created_by / connect_room_hosts で判定できるが、
-- インスタントルームは connect_rooms に一切レコードが無いため、代わりにこちらで持つ。
-- connect_room_hosts と全く同じ「1ルームに複数ホスト」の形にしてあるのは、将来ホストを
-- あとから手動アサインできるようにする際にテーブル構造を変えずに済むようにするため
-- （今回は自動登録のみで、手動アサインのUI/APIはまだ作らない）。
-- ルームの全参加者がいなくなったタイミング（cleanupStaleRoomData）で行ごと削除され、
-- 同じルームIDが再利用されたときは次に来た人が新しくホストになる。
CREATE TABLE public.connect_instant_hosts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id)
);
CREATE INDEX connect_instant_hosts_room_id_idx ON public.connect_instant_hosts (room_id);
ALTER TABLE public.connect_instant_hosts ENABLE ROW LEVEL SECURITY;
-- backendはservice role keyでアクセスするためポリシーは追加しない（他のconnect_*テーブルと同じ方針）
