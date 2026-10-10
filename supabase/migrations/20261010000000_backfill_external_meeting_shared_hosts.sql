-- 外部ミーティングは「共有するメンバー」（connect_room_viewers）全員にホスト権を渡す仕様に変更した。
-- 新規作成・編集時は backend が connect_room_hosts にも書き込むが、変更前に作られた既存の外部ミーティングの
-- 共有メンバーはまだホストになっていないので、ここで一度だけ補完する。
INSERT INTO public.connect_room_hosts (room_id, user_id)
SELECT v.room_id, v.user_id
FROM public.connect_room_viewers v
JOIN public.connect_rooms r ON r.id = v.room_id
WHERE r.meeting_type = 'external'
ON CONFLICT (room_id, user_id) DO NOTHING;
