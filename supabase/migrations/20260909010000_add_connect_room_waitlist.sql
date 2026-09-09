-- 待機室（入室待ちリクエスト）。今回は「外部ミーティング（meeting_type='external'）の
-- 招待URL経由の参加は常に待機室ON」という決め打ちの範囲で実装する（固定ミーティング側の
-- ON/OFF切り替えUIはまだ作らない）。
--
-- PreJoinで名前・カメラ/マイクを設定して送信すると、いきなりLiveKitトークンを発行するの
-- ではなく、まずこのテーブルに pending 行を作る。ホストが承認する画面（参加許可の画面）は
-- 次のスコープで作るため、現状はこのテーブルにpending行が溜まるだけで、そこから admitted
-- に進める手段はまだ用意していない。
--
-- room_id は connect_rooms.id ではなく connect_chat_messages と同じ「LiveKitのルーム名
-- （テキスト）」。入室フロー・チャット同様、CallRoomPage が扱っているのはそのテキストの
-- room_id なので、その他の in-call 系テーブルと形式を揃えている。
CREATE TABLE public.connect_room_waitlist (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'admitted', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX connect_room_waitlist_room_id_status_idx
  ON public.connect_room_waitlist (room_id, status);

ALTER TABLE public.connect_room_waitlist ENABLE ROW LEVEL SECURITY;
-- backendはservice role keyでアクセスするためRLSは有効化のみでポリシーは追加しない（他のconnect_*テーブルと同じ方針）
