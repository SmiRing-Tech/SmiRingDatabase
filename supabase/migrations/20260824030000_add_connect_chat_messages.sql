-- SmiRing Connect のチャットメッセージを、ルーム単位の一時ストレージとして保存するテーブル。
-- 送信者identity・スレッドIDはクライアントを信用せず、常にbackend(service role)が確定させて書き込む。
-- ルームが再利用される際、backend側で「前セッションの残りメッセージ」をルーム開始時に削除するため、
-- 恒久保存は想定しない（詳細は backend/src/routes/connectRoutes.ts 参照）。

CREATE TABLE public.connect_chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id text NOT NULL,
    thread_id text NOT NULL,
    sender_identity text NOT NULL,
    sender_name text NOT NULL,
    sender_avatar_url text,
    recipient_identities text[] DEFAULT '{}'::text[] NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.connect_chat_messages
    ADD CONSTRAINT connect_chat_messages_pkey PRIMARY KEY (id);

CREATE INDEX connect_chat_messages_room_thread_idx
    ON public.connect_chat_messages (room_id, thread_id, created_at);

-- backendはservice role keyでアクセスするため、RLSは有効化のみ行いポリシーは追加しない
-- （connect_rooms と同じ方針）。
ALTER TABLE public.connect_chat_messages ENABLE ROW LEVEL SECURITY;
