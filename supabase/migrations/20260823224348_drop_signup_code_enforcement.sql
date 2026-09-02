-- 招待コード制を廃止（オープン登録＋オンボーディングでの自己申告に移行）したため、
-- サインアップ時にコードを強制するDBトリガー・関数・テーブルを撤去する。

DROP TRIGGER IF EXISTS check_signup_code_before_insert ON auth.users;
DROP FUNCTION IF EXISTS public.validate_signup_code();
DROP FUNCTION IF EXISTS public.check_signup_code(text);
DROP TABLE IF EXISTS public.signup_codes;
