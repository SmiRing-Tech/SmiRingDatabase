-- SmiRing Connect チャットメッセージの返信・編集情報カラムを追加
-- reply_to: { id: string, senderName: string, text: string } を保持する JSONB
-- is_edited: 編集済みフラグ

ALTER TABLE public.connect_chat_messages
  ADD COLUMN IF NOT EXISTS reply_to jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_edited boolean DEFAULT false;
