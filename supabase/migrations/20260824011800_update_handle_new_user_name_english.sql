-- handle_new_user トリガー関数を更新して、サインアップ時に入力された name_english / display_name を
-- public.basic_profile_info の name_english カラムに初期設定する

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_name_english text;
BEGIN
  v_name_english := COALESCE(
    new.raw_user_meta_data->>'name_english',
    new.raw_user_meta_data->>'display_name',
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name'
  );

  INSERT INTO public.basic_profile_info (id, name_english, updated_at)
  VALUES (new.id, v_name_english, now())
  ON CONFLICT (id) DO UPDATE
    SET name_english = COALESCE(public.basic_profile_info.name_english, EXCLUDED.name_english),
        updated_at = now();

  RETURN new;
END;
$$;
