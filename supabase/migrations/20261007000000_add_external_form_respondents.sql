-- フォームをログインなしの外部ユーザーにも回答可能にするための拡張。
--
-- 背景: フォームはこれまで内部メンバー（Supabaseアカウント保持者）専用で、
-- 回答は必ず user_id を持っていた。既存の allow_anonymous は「user_id は記録するが
-- 閲覧者に名前を見せない」表示上の匿名であり、ログインなし回答とは別概念として残す。
--   - forms.access_mode: 誰が回答してよいか（フォーム単位のルール）
--   - form_response_mappings.guest_key / guest_info: 実際に誰が答えたか（回答単位の事実）。
--     user_id が NULL ならゲスト回答。guest_key は下書き再開・重複チェック・
--     未回答者計算・入退室ログとの突き合わせに使う識別子なのでカラムで持ち、
--     表示用の情報（現状は名前のみ）は guest_info にまとめる。

ALTER TABLE public.forms
  ADD COLUMN access_mode text NOT NULL DEFAULT 'members'
    CHECK (access_mode IN ('members', 'public'));

COMMENT ON COLUMN public.forms.access_mode IS
  'members=ログイン必須（従来通り）。public=ログインせずにも回答可能（回答時にログインするかゲストで答えるかを選ぶ）。';

ALTER TABLE public.form_response_mappings
  ADD COLUMN guest_key text,
  ADD COLUMN guest_info jsonb;

-- 既存データに user_id が NULL の行が残っていても適用できるよう NOT VALID（新規・更新行のみ検証）
ALTER TABLE public.form_response_mappings
  ADD CONSTRAINT form_response_mappings_respondent_check
    CHECK ((user_id IS NOT NULL) <> (guest_key IS NOT NULL)) NOT VALID;

COMMENT ON COLUMN public.form_response_mappings.guest_key IS
  'ログインなし回答者の識別キー（ブラウザに保存され、再入室・再訪問をまたいで同一人物として扱うためのもの）。user_id とどちらか一方のみが入る。';
COMMENT ON COLUMN public.form_response_mappings.guest_info IS
  'ログインなし回答者の表示用情報。形式: { "name": string }';

CREATE INDEX form_response_mappings_form_guest_key_idx
  ON public.form_response_mappings (form_id, guest_key)
  WHERE guest_key IS NOT NULL;
