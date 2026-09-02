-- basic_profile_info に汎用のJSONBメタデータ列を追加する。
-- 当面はオンボーディング（初回プロフィール入力）の進捗（onboarding_completed / onboarding_step）を
-- ここに保存する。デフォルトが空オブジェクトなので、既存ユーザーもキー未設定＝未完了として
-- 自然に扱われる（バックフィル不要）。

ALTER TABLE public.basic_profile_info
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
