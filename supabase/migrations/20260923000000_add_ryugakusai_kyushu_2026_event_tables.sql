-- 留学祭九州2026用のイベント固有テーブル11個。
-- ryugakusai2026_*（留学祭2026）のスキーマを ryugakusai_kyushu_2026_* として複製したもの。
-- テーブル間のFKは新プレフィックス側へ張り替え、basic_profile_info等の横断共有テーブルへのFKはそのまま。
-- backendはservice role keyでアクセスするためRLSポリシーは原則追加しない。
-- 例外はcheckin_eventsで、apps/appがanon keyのRealtimeで購読するためSELECTポリシーが要る。

-- 1. 1on1メンター
CREATE TABLE public.ryugakusai_kyushu_2026_1on1_mentors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  mentor_id         uuid REFERENCES public.basic_profile_info(id) ON DELETE CASCADE,
  metadata          jsonb,
  display_order     smallint,
  participance_day  text,
  study_abroad_area text[],
  ba_or_bs          text
);
ALTER TABLE public.ryugakusai_kyushu_2026_1on1_mentors ENABLE ROW LEVEL SECURITY;

-- 2. チェックインイベント（QRチェックインの演出トリガー）
CREATE TABLE public.ryugakusai_kyushu_2026_checkin_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  type       text NOT NULL,
  message    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ryugakusai_kyushu_2026_checkin_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read checkin events"
  ON public.ryugakusai_kyushu_2026_checkin_events FOR SELECT USING (true);

-- 3. イベントコンテンツ
CREATE TABLE public.ryugakusai_kyushu_2026_event_contents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  title          text,
  speaker        text,
  description    text,
  photo_path     text,
  event_category text,
  date           text,
  start_time     text,
  end_time       text,
  metadata       jsonb
);
ALTER TABLE public.ryugakusai_kyushu_2026_event_contents ENABLE ROW LEVEL SECURITY;

-- 4. 応援メッセージ
CREATE TABLE public.ryugakusai_kyushu_2026_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sender     text,
  card_type  text,
  message    text,
  metadata   jsonb
);
ALTER TABLE public.ryugakusai_kyushu_2026_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable insert for all user"
  ON public.ryugakusai_kyushu_2026_messages FOR INSERT WITH CHECK (true);

-- 5. お知らせ
CREATE TABLE public.ryugakusai_kyushu_2026_news (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  title        text,
  photo_path   text,
  content      text,
  email_status text,
  email_sent   timestamptz,
  metadata     jsonb,
  category     text,
  date         date
);
ALTER TABLE public.ryugakusai_kyushu_2026_news ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all users"
  ON public.ryugakusai_kyushu_2026_news FOR SELECT USING (true);

-- 6. 参加者（basic_profile_infoとの1対1、イベント参加レコード）
CREATE TABLE public.ryugakusai_kyushu_2026_participants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  user_id               uuid UNIQUE REFERENCES public.basic_profile_info(id) ON DELETE CASCADE,
  attendance_days       text,
  metadata              jsonb,
  attendance_time_day1  timestamptz,
  attendance_time_day2  timestamptz,
  attendance_time_test  timestamptz
);
ALTER TABLE public.ryugakusai_kyushu_2026_participants ENABLE ROW LEVEL SECURITY;

-- 7. 1on1予約・お気に入りマッピング
CREATE TABLE public.ryugakusai_kyushu_2026_participant_1on1_mappings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  participant_id uuid REFERENCES public.ryugakusai_kyushu_2026_participants(id) ON DELETE CASCADE,
  mentor_id      uuid REFERENCES public.ryugakusai_kyushu_2026_1on1_mentors(id) ON DELETE CASCADE,
  register_type  text,
  start_time     time without time zone,
  done_at        timestamptz,
  day            text,
  metadata       jsonb,
  -- 東京版の同名制約(participant_1on1_mappings_unique_slot)がスキーマ全体で名前を専有しているため、
  -- 制約名にもイベントのプレフィックスを付ける。制約名＝インデックス名はテーブル単位ではなくスキーマ単位で一意。
  CONSTRAINT ryugakusai_kyushu_2026_1on1_mappings_unique_slot
    UNIQUE (participant_id, mentor_id, register_type, day, start_time)
);
CREATE UNIQUE INDEX ryugakusai_kyushu_2026_1on1_mappings_favorite_unique
  ON public.ryugakusai_kyushu_2026_participant_1on1_mappings (participant_id, mentor_id)
  WHERE (register_type = 'favorite'::text);
CREATE UNIQUE INDEX ryugakusai_kyushu_2026_1on1_mappings_register_unique
  ON public.ryugakusai_kyushu_2026_participant_1on1_mappings (participant_id, mentor_id, start_time)
  WHERE (register_type = 'register'::text);
ALTER TABLE public.ryugakusai_kyushu_2026_participant_1on1_mappings ENABLE ROW LEVEL SECURITY;

-- 8. コンテンツ参加マッピング（user_idはbasic_profile_infoを参照。participant_idではない）
CREATE TABLE public.ryugakusai_kyushu_2026_participant_content_mappings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id    uuid REFERENCES public.basic_profile_info(id) ON DELETE CASCADE,
  content_id uuid REFERENCES public.ryugakusai_kyushu_2026_event_contents(id) ON DELETE CASCADE,
  type       text,
  UNIQUE (user_id, content_id, type)
);
ALTER TABLE public.ryugakusai_kyushu_2026_participant_content_mappings ENABLE ROW LEVEL SECURITY;

-- 9. シフトタスク
CREATE TABLE public.ryugakusai_kyushu_2026_shift_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  category    text,
  title       text,
  content_id  uuid REFERENCES public.ryugakusai_kyushu_2026_event_contents(id) ON DELETE CASCADE,
  description text,
  metadata    jsonb
);
ALTER TABLE public.ryugakusai_kyushu_2026_shift_tasks ENABLE ROW LEVEL SECURITY;

-- 10. シフト割り当て（reservation_idという名前だがparticipantsを参照する）
CREATE TABLE public.ryugakusai_kyushu_2026_shift_mapping (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  task_id        uuid REFERENCES public.ryugakusai_kyushu_2026_shift_tasks(id) ON DELETE CASCADE,
  staff_id       uuid REFERENCES public.basic_profile_info(id),
  day            text,
  start_time     time without time zone,
  end_time       time without time zone,
  reservation_id uuid REFERENCES public.ryugakusai_kyushu_2026_participants(id) ON DELETE CASCADE,
  metadata       jsonb
);
ALTER TABLE public.ryugakusai_kyushu_2026_shift_mapping ENABLE ROW LEVEL SECURITY;

-- 11. 協賛
CREATE TABLE public.ryugakusai_kyushu_2026_sponsors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  sponsor_name text,
  logo_path    text,
  metadata     jsonb,
  company_url  text
);
ALTER TABLE public.ryugakusai_kyushu_2026_sponsors ENABLE ROW LEVEL SECURITY;
CREATE POLICY sponsors_public_read
  ON public.ryugakusai_kyushu_2026_sponsors FOR SELECT TO authenticated, anon USING (true);

-- checkin_eventsをRealtimeのpublicationに追加する（apps/appのQRConnectが購読するため）。
-- 既に入っている場合はスキップ。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'ryugakusai_kyushu_2026_checkin_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.ryugakusai_kyushu_2026_checkin_events;
  END IF;
END
$$;
