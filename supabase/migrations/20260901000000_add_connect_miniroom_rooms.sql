-- SmiRing Connect のミニルーム（ブレイクアウトルーム）を、メイン通話単位の一時ストレージとして保存するテーブル。
-- id は LiveKit 上のルーム名そのもの（backend が生成、connect_chat_messages.room_id と同じ考え方）。
-- name は参加者に見せる表示名（ホストの自由入力）。
-- allow_self_assign はセッション（同一 main_room_id の有効行群）単位の値として全行に同じ値を書き込む。
-- 「誰がどのルームにいるか」はLiveKit自体を正とし、backendがその都度問い合わせるためこのテーブルには持たない。
-- メインルームが空になった際、backend側で残存ミニルームの行 + LiveKit上のルームを削除する
-- （詳細は backend/src/routes/connectRoutes.ts の cleanupStaleRoomData を参照）。

CREATE TABLE public.connect_miniroom_rooms (
    id text NOT NULL,
    main_room_id text NOT NULL,
    name text NOT NULL,
    allow_self_assign boolean DEFAULT false NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.connect_miniroom_rooms
    ADD CONSTRAINT connect_miniroom_rooms_pkey PRIMARY KEY (id);

CREATE INDEX connect_miniroom_rooms_main_room_idx
    ON public.connect_miniroom_rooms (main_room_id, created_at);

-- backendはservice role keyでアクセスするため、RLSは有効化のみ行いポリシーは追加しない
-- （connect_chat_messages と同じ方針）。
ALTER TABLE public.connect_miniroom_rooms ENABLE ROW LEVEL SECURITY;
