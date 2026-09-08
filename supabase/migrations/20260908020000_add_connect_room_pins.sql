-- 固定ミーティングのピン留めは完全に個人設定（他の人の一覧順には影響しない）
CREATE TABLE public.connect_room_pins (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.connect_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id)
);
CREATE INDEX connect_room_pins_user_id_idx ON public.connect_room_pins (user_id);
ALTER TABLE public.connect_room_pins ENABLE ROW LEVEL SECURITY;
-- backendはservice role keyでアクセスするためポリシーは追加しない（他のconnect_*テーブルと同じ方針）
