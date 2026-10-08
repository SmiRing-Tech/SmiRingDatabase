-- SmiRing Connect の通話中アンケート。ホストが通話中に既存のフォームを選んで「開始」すると
-- 1行作られ、参加者の画面にそのフォームが表示される。ルームへの事前の紐づけは持たない。
-- room_id は LiveKit 上のメインルーム名（connect_chat_messages.room_id と同じ考え方）なので、
-- 登録済みの固定/外部ミーティングでも、その場で作ったミーティングでも同じように使える。
-- ended_at が NULL の行が「実施中」。1ルームで同時に実施できるのは1件まで。
-- 回答そのものは form_response_mappings にあり、進捗は backend がLiveKitの参加者と突き合わせて計算する。

CREATE TABLE public.connect_room_surveys (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    room_id text NOT NULL,
    form_id uuid NOT NULL REFERENCES public.forms(id) ON DELETE CASCADE,
    started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);

CREATE UNIQUE INDEX connect_room_surveys_one_active_idx
    ON public.connect_room_surveys (room_id)
    WHERE ended_at IS NULL;

CREATE INDEX connect_room_surveys_room_started_idx
    ON public.connect_room_surveys (room_id, started_at DESC);

-- backendはservice role keyでアクセスするため、RLSは有効化のみ行いポリシーは追加しない
-- （connect_miniroom_rooms と同じ方針）。
ALTER TABLE public.connect_room_surveys ENABLE ROW LEVEL SECURITY;
