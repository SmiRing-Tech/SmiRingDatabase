-- 待機室にいる訪問者がタブを閉じる／ネットワーク切断などで消えたことを検知するための
-- ハートビート列。待機画面が5秒おきにハートビートを送り、20秒（GET .../waitlist 側の判定）
-- 更新が無ければ 'left' に遷移させる。バックエンドの実装は connectRoutes.ts を参照。
ALTER TABLE public.connect_room_waitlist
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.connect_room_waitlist
  DROP CONSTRAINT connect_room_waitlist_status_check;

ALTER TABLE public.connect_room_waitlist
  ADD CONSTRAINT connect_room_waitlist_status_check
  CHECK (status IN ('pending', 'admitted', 'denied', 'left'));
