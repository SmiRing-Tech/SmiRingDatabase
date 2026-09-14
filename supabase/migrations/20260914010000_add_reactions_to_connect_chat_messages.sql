-- SmiRing Connect チャットメッセージの絵文字リアクションカラムを追加
-- reactions: { [emoji: string]: string[] } (絵文字文字をキー、リアクションしたユーザーID配列を値とする JSONB)

ALTER TABLE public.connect_chat_messages
  ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '{}'::jsonb;
