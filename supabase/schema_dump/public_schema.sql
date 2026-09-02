--
-- PostgreSQL database dump
--

\restrict O9g34kSoFzKlvKG6bAgQ1lf9LDbHaeV1kD9pi2tuJTVIAYyZCaomzv2mEPvRrRc

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: check_signup_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_signup_code(code_to_check text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
  -- 存在して、かつ有効(is_active)なら true を返す
  return exists (
    select 1 
    from public.signup_codes 
    where code = code_to_check 
    and is_active = true
  );
end;
$$;


--
-- Name: get_user_permissions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_permissions(p_user_id uuid) RETURNS TABLE(permission_id uuid, resource text, action text, name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  -- ① 直接付与
  SELECT p.id, p.resource, p.action, p.name
  FROM permission_mappings pm
  JOIN permissions p ON p.id = pm.permission_id
  WHERE pm.grantee_type = 'user'
    AND pm.grantee_id = p_user_id

  UNION

  -- ② ロール経由
  SELECT p.id, p.resource, p.action, p.name
  FROM permission_mappings pm
  JOIN permissions p ON p.id = pm.permission_id
  WHERE pm.grantee_type = 'role'
    AND pm.grantee_id IN (
      SELECT user_role FROM user_role_mappings WHERE user_id = p_user_id
    )

  UNION

  -- ③ 部署経由
  SELECT p.id, p.resource, p.action, p.name
  FROM permission_mappings pm
  JOIN permissions p ON p.id = pm.permission_id
  WHERE pm.grantee_type = 'department'
    AND pm.grantee_id IN (
      SELECT department_id FROM member_department_mappings WHERE user_id = p_user_id
    )

  UNION

  -- ④ 汎用グループ経由
  SELECT p.id, p.resource, p.action, p.name
  FROM permission_mappings pm
  JOIN permissions p ON p.id = pm.permission_id
  WHERE pm.grantee_type = 'group'
    AND pm.grantee_id IN (
      SELECT ugm.group_id
      FROM user_group_mappings ugm
      JOIN groups g ON g.id = ugm.group_id
      WHERE ugm.user_id = p_user_id
        AND g.deleted_at IS NULL
    )
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
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


--
-- Name: handle_user_sign_in(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_user_sign_in() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.basic_profile_info
  SET last_sign_in_at = new.last_sign_in_at
  WHERE id = new.id;
  RETURN new;
END;
$$;


--
-- Name: search_gemini_vectors(public.vector, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_gemini_vectors(query_embedding public.vector, match_threshold double precision, match_count integer) RETURNS TABLE(id uuid, source_id uuid, source_type text, content text, metadata jsonb, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    unified_search_index.id,
    unified_search_index.source_id,
    unified_search_index.source_type,
    unified_search_index.content,
    unified_search_index.metadata,
    1 - (unified_search_index.embedding_gemini <=> query_embedding) AS similarity
  FROM unified_search_index
  WHERE 1 - (unified_search_index.embedding_gemini <=> query_embedding) > match_threshold
  ORDER BY unified_search_index.embedding_gemini <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: search_local_vectors(public.vector, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_local_vectors(query_embedding public.vector, match_threshold double precision, match_count integer) RETURNS TABLE(id uuid, source_type text, content text, metadata jsonb, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    unified_search_index.id,
    unified_search_index.source_type,
    unified_search_index.content,
    unified_search_index.metadata,
    -- 1 - コサイン距離 = 類似度 (1に近いほど似ている)
    1 - (unified_search_index.embedding_local <=> query_embedding) AS similarity
  FROM unified_search_index
  -- 類似度がしきい値以上のものだけを絞り込み
  WHERE 1 - (unified_search_index.embedding_local <=> query_embedding) > match_threshold
  -- 似ている順（距離が近い順）に並び替え
  ORDER BY unified_search_index.embedding_local <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: update_modified_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_modified_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: validate_signup_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_signup_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  submitted_code text;
  source_app text;
  provider_name text;
BEGIN
  -- Google等のOAuthログインはメタデータにsourceやsignup_codeを乗せられないため対象外とする
  provider_name := new.raw_app_meta_data->>'provider';
  IF provider_name IS DISTINCT FROM 'email' THEN
    RETURN new;
  END IF;

  source_app := new.raw_user_meta_data->>'source';

  -- 留学祭2026からの登録はサインアップコード不要
  IF source_app = 'ryugakusai2026' THEN
    RETURN new;
  END IF;

  submitted_code := new.raw_user_meta_data->>'signup_code';

  IF EXISTS (SELECT 1 FROM public.signup_codes WHERE code = submitted_code AND is_active = true) THEN
    RETURN new;
  ELSE
    RAISE EXCEPTION '無効なサインアップコードです。正しいコードを入力してください。';
  END IF;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: answers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.answers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    form_id uuid,
    question_id uuid,
    answer_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: basic_profile_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.basic_profile_info (
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    avatar_id uuid,
    name_english text,
    name_kanji text,
    birthday date,
    hometown text,
    grade_level text,
    personality text[],
    important_values text[],
    future_image text[],
    smiring_department text[],
    smiring_join_date date,
    timezone text,
    last_sign_in_at timestamp with time zone,
    short_message text
);


--
-- Name: connect_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connect_rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    room_id text,
    room_title text,
    metadata text
);


--
-- Name: current_study_abroad_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.current_study_abroad_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    english_school text,
    study_abroad_type text,
    study_abroad_country text,
    study_abroad_city text,
    study_abroad_history text[],
    current_school text,
    school_history text[],
    majors text[],
    minors text[],
    major_history text[]
);


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    name text,
    parent_id uuid,
    metadata jsonb,
    sort_order smallint
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    title text,
    upper_subtitle text,
    lower_subtitle text,
    description text,
    image_path text,
    start_datetime timestamp without time zone,
    host uuid,
    metadata jsonb,
    end_datetime timestamp without time zone,
    status text
);


--
-- Name: form_question_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_question_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    form_id uuid,
    question_id uuid,
    order_index integer NOT NULL,
    is_required boolean DEFAULT false,
    is_deleted boolean DEFAULT false
);


--
-- Name: form_response_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_response_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    form_id uuid,
    user_id uuid,
    status text DEFAULT 'draft'::text,
    content jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    submitted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL
);


--
-- Name: forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text,
    due_date timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    publish_settings jsonb,
    allow_anonymous boolean,
    allow_multiple_responses boolean DEFAULT false,
    allow_edit_responses boolean DEFAULT true
);


--
-- Name: gallery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gallery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    storage_path text NOT NULL,
    image_type text,
    tags text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    visibility text,
    thumbnail_path text,
    description_generated text[]
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    name text,
    type text,
    description text,
    metadata jsonb
);


--
-- Name: guardian_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guardian_profiles (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    child_id uuid,
    concerns text[]
);


--
-- Name: guardian_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.guardian_profiles ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.guardian_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: member_department_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_department_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    department_id uuid,
    metadata jsonb
);


--
-- Name: permission_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permission_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    grantee_type text,
    grantee_id uuid,
    permission_id uuid
);


--
-- Name: permission_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permission_types (
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    type text,
    description text,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type uuid,
    name text,
    description text,
    metadata jsonb,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource text,
    action text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: post_study_abroad_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_study_abroad_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    english_school text,
    study_abroad_type text,
    study_abroad_country text,
    study_abroad_city text,
    study_abroad_history text[],
    last_overseas_university text,
    school_history text[],
    majors text[],
    minors text[],
    major_history text[]
);


--
-- Name: pre_study_abroad_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pre_study_abroad_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    study_abroad_interest_level text,
    interested_areas text[],
    interested_countries text[],
    interested_majors text[],
    interested_study_abroad_types text[],
    expected_timing text,
    current_school text
);


--
-- Name: questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    primary_category text,
    tags text[],
    question_type text NOT NULL,
    options jsonb DEFAULT '{}'::jsonb,
    parent_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    description text
);


--
-- Name: ryugakusai2026_1on1_mentors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_1on1_mentors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mentor_id uuid,
    metadata jsonb,
    display_order smallint,
    participance_day text,
    study_abroad_area text[],
    ba_or_bs text
);


--
-- Name: ryugakusai2026_checkin_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_checkin_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ryugakusai2026_event_contents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_event_contents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    title text,
    speaker text,
    description text,
    photo_path text,
    event_category text,
    date text,
    start_time text,
    end_time text,
    metadata jsonb
);


--
-- Name: ryugakusai2026_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sender text,
    card_type text,
    message text,
    metadata jsonb
);


--
-- Name: ryugakusai2026_news; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_news (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    title text,
    photo_path text,
    content text,
    email_status text,
    email_sent timestamp with time zone,
    metadata jsonb,
    category text,
    date date
);


--
-- Name: ryugakusai2026_participant_1on1_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_participant_1on1_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    participant_id uuid,
    mentor_id uuid,
    register_type text,
    start_time time without time zone,
    done_at timestamp with time zone,
    day text,
    metadata jsonb
);


--
-- Name: ryugakusai2026_participant_content_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_participant_content_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    content_id uuid,
    type text
);


--
-- Name: ryugakusai2026_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    attendance_days text,
    metadata jsonb,
    attendance_time_day1 timestamp with time zone,
    attendance_time_day2 timestamp with time zone,
    attendance_time_test timestamp with time zone
);


--
-- Name: ryugakusai2026_shift_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_shift_mapping (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    task_id uuid,
    staff_id uuid,
    day text,
    start_time time without time zone,
    end_time time without time zone,
    reservation_id uuid,
    metadata jsonb
);


--
-- Name: ryugakusai2026_shift_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_shift_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    category text,
    title text,
    content_id uuid,
    description text,
    metadata jsonb
);


--
-- Name: ryugakusai2026_sponsors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ryugakusai2026_sponsors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sponsor_name text,
    logo_path text,
    metadata jsonb,
    company_url text
);


--
-- Name: signup_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signup_codes (
    code text NOT NULL,
    memo text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: unified_search_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unified_search_index (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    content text NOT NULL,
    embedding_local public.vector(384),
    embedding_gemini public.vector(768),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    visibility text
);


--
-- Name: user_group_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    group_id uuid
);


--
-- Name: user_role_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_role_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    user_role uuid,
    metadata jsonb,
    is_current_status boolean NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_name text NOT NULL,
    description text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: answers answers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answers
    ADD CONSTRAINT answers_pkey PRIMARY KEY (id);


--
-- Name: basic_profile_info basic_profile_info_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basic_profile_info
    ADD CONSTRAINT basic_profile_info_pkey PRIMARY KEY (id);


--
-- Name: connect_rooms connect_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_rooms
    ADD CONSTRAINT connect_rooms_pkey PRIMARY KEY (id);


--
-- Name: current_study_abroad_profiles current_study_abroad_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_study_abroad_profiles
    ADD CONSTRAINT current_study_abroad_profiles_pkey PRIMARY KEY (id);


--
-- Name: current_study_abroad_profiles current_study_abroad_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_study_abroad_profiles
    ADD CONSTRAINT current_study_abroad_profiles_user_id_key UNIQUE (user_id);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: form_question_mappings form_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_question_mappings
    ADD CONSTRAINT form_questions_pkey PRIMARY KEY (id);


--
-- Name: form_response_mappings form_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_response_mappings
    ADD CONSTRAINT form_responses_pkey PRIMARY KEY (id);


--
-- Name: forms forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms
    ADD CONSTRAINT forms_pkey PRIMARY KEY (id);


--
-- Name: gallery gallery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gallery
    ADD CONSTRAINT gallery_pkey PRIMARY KEY (id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: guardian_profiles guardian_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardian_profiles
    ADD CONSTRAINT guardian_profiles_pkey PRIMARY KEY (id);


--
-- Name: member_department_mappings member_department_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_department_mappings
    ADD CONSTRAINT member_department_mappings_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_participant_1on1_mappings participant_1on1_mappings_unique_slot; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_1on1_mappings
    ADD CONSTRAINT participant_1on1_mappings_unique_slot UNIQUE (participant_id, mentor_id, register_type, day, start_time);


--
-- Name: permission_mappings permission_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permission_mappings
    ADD CONSTRAINT permission_assignments_pkey PRIMARY KEY (id);


--
-- Name: permission_mappings permission_mappings_grantee_permission_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permission_mappings
    ADD CONSTRAINT permission_mappings_grantee_permission_unique UNIQUE (grantee_type, grantee_id, permission_id);


--
-- Name: permission_types permission_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permission_types
    ADD CONSTRAINT permission_types_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: post_study_abroad_profiles post_study_abroad_profiles_duplicate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_study_abroad_profiles
    ADD CONSTRAINT post_study_abroad_profiles_duplicate_pkey PRIMARY KEY (id);


--
-- Name: pre_study_abroad_profiles pre_study_abroad_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pre_study_abroad_profiles
    ADD CONSTRAINT pre_study_abroad_profiles_pkey PRIMARY KEY (id);


--
-- Name: pre_study_abroad_profiles pre_study_abroad_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pre_study_abroad_profiles
    ADD CONSTRAINT pre_study_abroad_profiles_user_id_key UNIQUE (user_id);


--
-- Name: questions questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.questions
    ADD CONSTRAINT questions_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_1on1_mentors ryugakusai2026_1on1_mentors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_1on1_mentors
    ADD CONSTRAINT ryugakusai2026_1on1_mentors_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_checkin_events ryugakusai2026_checkin_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_checkin_events
    ADD CONSTRAINT ryugakusai2026_checkin_events_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_event_contents ryugakusai2026_event_contents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_event_contents
    ADD CONSTRAINT ryugakusai2026_event_contents_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_messages ryugakusai2026_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_messages
    ADD CONSTRAINT ryugakusai2026_messages_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_news ryugakusai2026_news_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_news
    ADD CONSTRAINT ryugakusai2026_news_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_participant_1on1_mappings ryugakusai2026_participant_1on1_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_1on1_mappings
    ADD CONSTRAINT ryugakusai2026_participant_1on1_mappings_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_participant_content_mappings ryugakusai2026_participant_content_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_content_mappings
    ADD CONSTRAINT ryugakusai2026_participant_content_mappings_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_participant_content_mappings ryugakusai2026_participant_content_mappings_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_content_mappings
    ADD CONSTRAINT ryugakusai2026_participant_content_mappings_unique UNIQUE (user_id, content_id, type);


--
-- Name: ryugakusai2026_participants ryugakusai2026_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participants
    ADD CONSTRAINT ryugakusai2026_participants_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_participants ryugakusai2026_participants_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participants
    ADD CONSTRAINT ryugakusai2026_participants_user_id_key UNIQUE (user_id);


--
-- Name: ryugakusai2026_shift_mapping ryugakusai2026_shift_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_shift_mapping
    ADD CONSTRAINT ryugakusai2026_shift_mapping_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_shift_tasks ryugakusai2026_shift_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_shift_tasks
    ADD CONSTRAINT ryugakusai2026_shift_tasks_pkey PRIMARY KEY (id);


--
-- Name: ryugakusai2026_sponsors ryugakusai2026_sponsors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_sponsors
    ADD CONSTRAINT ryugakusai2026_sponsors_pkey PRIMARY KEY (id);


--
-- Name: signup_codes signup_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_codes
    ADD CONSTRAINT signup_codes_pkey PRIMARY KEY (code);


--
-- Name: user_roles system_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT system_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles system_roles_role_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT system_roles_role_name_key UNIQUE (role_name);


--
-- Name: unified_search_index unified_search_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unified_search_index
    ADD CONSTRAINT unified_search_index_pkey PRIMARY KEY (id);


--
-- Name: user_group_mappings user_group_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_mappings
    ADD CONSTRAINT user_group_mappings_pkey PRIMARY KEY (id);


--
-- Name: user_role_mappings user_role_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_mappings
    ADD CONSTRAINT user_role_mappings_pkey PRIMARY KEY (id);


--
-- Name: idx_answers_answer_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_answers_answer_data ON public.answers USING gin (answer_data);


--
-- Name: idx_questions_options; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_questions_options ON public.questions USING gin (options);


--
-- Name: idx_questions_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_questions_tags ON public.questions USING gin (tags);


--
-- Name: idx_search_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_metadata ON public.unified_search_index USING gin (metadata);


--
-- Name: ryugakusai2026_1on1_mappings_favorite_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ryugakusai2026_1on1_mappings_favorite_unique ON public.ryugakusai2026_participant_1on1_mappings USING btree (participant_id, mentor_id) WHERE (register_type = 'favorite'::text);


--
-- Name: ryugakusai2026_1on1_mappings_register_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ryugakusai2026_1on1_mappings_register_unique ON public.ryugakusai2026_participant_1on1_mappings USING btree (participant_id, mentor_id, start_time) WHERE (register_type = 'register'::text);


--
-- Name: unified_search_index_embedding_gemini_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX unified_search_index_embedding_gemini_idx ON public.unified_search_index USING hnsw (embedding_gemini public.vector_cosine_ops);


--
-- Name: unified_search_index_embedding_local_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX unified_search_index_embedding_local_idx ON public.unified_search_index USING hnsw (embedding_local public.vector_cosine_ops);


--
-- Name: gallery gallery-ai-worker; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "gallery-ai-worker" AFTER INSERT ON public.gallery FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://smiringdatabase-backend-276522402007.us-central1.run.app/api/worker/process-gallery', 'POST', '{"Content-type":"application/json"}', '{}', '5000');


--
-- Name: basic_profile_info update_basic_profile_info_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_basic_profile_info_modtime BEFORE UPDATE ON public.basic_profile_info FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: current_study_abroad_profiles update_current_study_abroad_profiles_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_current_study_abroad_profiles_modtime BEFORE UPDATE ON public.current_study_abroad_profiles FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: form_response_mappings update_form_responses_mappings_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_form_responses_mappings_modtime BEFORE UPDATE ON public.form_response_mappings FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: forms update_forms_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_forms_modtime BEFORE UPDATE ON public.forms FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: member_department_mappings update_member_department_mappings_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_member_department_mappings_modtime BEFORE UPDATE ON public.member_department_mappings FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: permission_mappings update_permission_mappings_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_permission_mappings_modtime BEFORE UPDATE ON public.permission_mappings FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: permission_types update_permission_types_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_permission_types_modtime BEFORE UPDATE ON public.permission_types FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: permissions update_permissions_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_permissions_modtime BEFORE UPDATE ON public.permissions FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: post_study_abroad_profiles update_post_study_abroad_profiles_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_post_study_abroad_profiles_modtime BEFORE UPDATE ON public.post_study_abroad_profiles FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: pre_study_abroad_profiles update_pre_study_abroad_profiles_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_pre_study_abroad_profiles_modtime BEFORE UPDATE ON public.pre_study_abroad_profiles FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: signup_codes update_signup_code_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_signup_code_modtime BEFORE UPDATE ON public.signup_codes FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: unified_search_index update_unified_search_index_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_unified_search_index_modtime BEFORE UPDATE ON public.unified_search_index FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: user_role_mappings update_user_role_mappings_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_role_mappings_modtime BEFORE UPDATE ON public.user_role_mappings FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: answers answers_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answers
    ADD CONSTRAINT answers_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.forms(id) ON DELETE SET NULL;


--
-- Name: answers answers_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answers
    ADD CONSTRAINT answers_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.questions(id) ON DELETE CASCADE;


--
-- Name: basic_profile_info basic_profile_info_avatar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basic_profile_info
    ADD CONSTRAINT basic_profile_info_avatar_id_fkey FOREIGN KEY (avatar_id) REFERENCES public.gallery(id) ON DELETE SET NULL;


--
-- Name: basic_profile_info basic_profile_info_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basic_profile_info
    ADD CONSTRAINT basic_profile_info_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: current_study_abroad_profiles current_study_abroad_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.current_study_abroad_profiles
    ADD CONSTRAINT current_study_abroad_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id) ON DELETE CASCADE;


--
-- Name: departments departments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.departments(id);


--
-- Name: events events_host_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_host_fkey FOREIGN KEY (host) REFERENCES public.basic_profile_info(id) ON DELETE SET NULL;


--
-- Name: form_question_mappings form_questions_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_question_mappings
    ADD CONSTRAINT form_questions_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.forms(id) ON DELETE CASCADE;


--
-- Name: form_question_mappings form_questions_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_question_mappings
    ADD CONSTRAINT form_questions_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.questions(id) ON DELETE CASCADE;


--
-- Name: form_response_mappings form_responses_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_response_mappings
    ADD CONSTRAINT form_responses_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.forms(id) ON DELETE CASCADE;


--
-- Name: form_response_mappings form_responses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_response_mappings
    ADD CONSTRAINT form_responses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: gallery gallery_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gallery
    ADD CONSTRAINT gallery_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: guardian_profiles guardian_profiles_child_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardian_profiles
    ADD CONSTRAINT guardian_profiles_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.basic_profile_info(id);


--
-- Name: member_department_mappings member_department_mappings_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_department_mappings
    ADD CONSTRAINT member_department_mappings_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id);


--
-- Name: member_department_mappings member_department_mappings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_department_mappings
    ADD CONSTRAINT member_department_mappings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id);


--
-- Name: permission_mappings permission_mappings_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permission_mappings
    ADD CONSTRAINT permission_mappings_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: permissions permissions_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_type_fkey FOREIGN KEY (type) REFERENCES public.permission_types(id);


--
-- Name: post_study_abroad_profiles post_study_abroad_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_study_abroad_profiles
    ADD CONSTRAINT post_study_abroad_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id) ON DELETE CASCADE;


--
-- Name: pre_study_abroad_profiles pre_study_abroad_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pre_study_abroad_profiles
    ADD CONSTRAINT pre_study_abroad_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id) ON DELETE CASCADE;


--
-- Name: questions questions_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.questions
    ADD CONSTRAINT questions_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.questions(id) ON DELETE SET NULL;


--
-- Name: ryugakusai2026_1on1_mentors ryugakusai2026_1on1_mentors_mentor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_1on1_mentors
    ADD CONSTRAINT ryugakusai2026_1on1_mentors_mentor_id_fkey FOREIGN KEY (mentor_id) REFERENCES public.basic_profile_info(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_participant_1on1_mappings ryugakusai2026_participant_1on1_mappings_mentor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_1on1_mappings
    ADD CONSTRAINT ryugakusai2026_participant_1on1_mappings_mentor_id_fkey FOREIGN KEY (mentor_id) REFERENCES public.ryugakusai2026_1on1_mentors(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_participant_1on1_mappings ryugakusai2026_participant_1on1_mappings_participant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_1on1_mappings
    ADD CONSTRAINT ryugakusai2026_participant_1on1_mappings_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES public.ryugakusai2026_participants(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_participant_content_mappings ryugakusai2026_participant_content_mappings_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_content_mappings
    ADD CONSTRAINT ryugakusai2026_participant_content_mappings_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.ryugakusai2026_event_contents(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_participant_content_mappings ryugakusai2026_participant_content_mappings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participant_content_mappings
    ADD CONSTRAINT ryugakusai2026_participant_content_mappings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_participants ryugakusai2026_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_participants
    ADD CONSTRAINT ryugakusai2026_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_shift_mapping ryugakusai2026_shift_mapping_1on1_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_shift_mapping
    ADD CONSTRAINT ryugakusai2026_shift_mapping_1on1_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.ryugakusai2026_participants(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_shift_mapping ryugakusai2026_shift_mapping_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_shift_mapping
    ADD CONSTRAINT ryugakusai2026_shift_mapping_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.basic_profile_info(id);


--
-- Name: ryugakusai2026_shift_mapping ryugakusai2026_shift_mapping_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_shift_mapping
    ADD CONSTRAINT ryugakusai2026_shift_mapping_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.ryugakusai2026_shift_tasks(id) ON DELETE CASCADE;


--
-- Name: ryugakusai2026_shift_tasks ryugakusai2026_shift_tasks_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ryugakusai2026_shift_tasks
    ADD CONSTRAINT ryugakusai2026_shift_tasks_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.ryugakusai2026_event_contents(id) ON DELETE CASCADE;


--
-- Name: user_group_mappings user_group_mappings_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_mappings
    ADD CONSTRAINT user_group_mappings_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id);


--
-- Name: user_group_mappings user_group_mappings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_mappings
    ADD CONSTRAINT user_group_mappings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id);


--
-- Name: user_role_mappings user_role_mappings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_mappings
    ADD CONSTRAINT user_role_mappings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.basic_profile_info(id) ON DELETE CASCADE;


--
-- Name: user_role_mappings user_role_mappings_user_role_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_mappings
    ADD CONSTRAINT user_role_mappings_user_role_fkey FOREIGN KEY (user_role) REFERENCES public.user_roles(id);


--
-- Name: form_question_mappings Allow authenticated read access on form_questions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated read access on form_questions" ON public.form_question_mappings FOR SELECT TO authenticated USING (true);


--
-- Name: questions Allow authenticated read access on questions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated read access on questions" ON public.questions FOR SELECT TO authenticated USING (true);


--
-- Name: forms Allow delete own forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow delete own forms" ON public.forms FOR DELETE TO authenticated USING ((created_by = auth.uid()));


--
-- Name: answers Allow insert own answers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow insert own answers" ON public.answers FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: forms Allow insert own forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow insert own forms" ON public.forms FOR INSERT TO authenticated WITH CHECK ((created_by = auth.uid()));


--
-- Name: forms Allow read forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow read forms" ON public.forms FOR SELECT TO authenticated USING (((status = 'published'::text) OR (created_by = auth.uid())));


--
-- Name: answers Allow read own answers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow read own answers" ON public.answers FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: answers Allow update own answers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow update own answers" ON public.answers FOR UPDATE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: forms Allow update own forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow update own forms" ON public.forms FOR UPDATE TO authenticated USING ((created_by = auth.uid()));


--
-- Name: ryugakusai2026_checkin_events Anyone can read checkin events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read checkin events" ON public.ryugakusai2026_checkin_events FOR SELECT USING (true);


--
-- Name: ryugakusai2026_messages Enable insert for all user; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for all user" ON public.ryugakusai2026_messages FOR INSERT WITH CHECK (true);


--
-- Name: ryugakusai2026_news Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.ryugakusai2026_news FOR SELECT USING (true);


--
-- Name: gallery Gallery images are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Gallery images are viewable by everyone" ON public.gallery FOR SELECT USING (true);


--
-- Name: basic_profile_info Profiles are viewable by authenticated users.; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Profiles are viewable by authenticated users." ON public.basic_profile_info FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: gallery Users can delete their own gallery images; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own gallery images" ON public.gallery FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: form_response_mappings Users can insert own responses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own responses" ON public.form_response_mappings FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: gallery Users can insert their own gallery images; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own gallery images" ON public.gallery FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: basic_profile_info Users can insert their own profile.; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own profile." ON public.basic_profile_info FOR INSERT WITH CHECK ((auth.uid() = id));


--
-- Name: basic_profile_info Users can update own profile.; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile." ON public.basic_profile_info FOR UPDATE USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: form_response_mappings Users can update own responses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own responses" ON public.form_response_mappings FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: gallery Users can update their own gallery images; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own gallery images" ON public.gallery FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: form_response_mappings Users can view own responses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own responses" ON public.form_response_mappings FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: answers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.answers ENABLE ROW LEVEL SECURITY;

--
-- Name: basic_profile_info; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.basic_profile_info ENABLE ROW LEVEL SECURITY;

--
-- Name: connect_rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.connect_rooms ENABLE ROW LEVEL SECURITY;

--
-- Name: current_study_abroad_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.current_study_abroad_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: departments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: form_question_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_question_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: form_response_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_response_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: forms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.forms ENABLE ROW LEVEL SECURITY;

--
-- Name: gallery; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gallery ENABLE ROW LEVEL SECURITY;

--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: guardian_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guardian_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: member_department_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.member_department_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.permission_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.permission_types ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: post_study_abroad_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.post_study_abroad_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: pre_study_abroad_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pre_study_abroad_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: questions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_1on1_mentors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_1on1_mentors ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_checkin_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_checkin_events ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_event_contents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_event_contents ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_news; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_news ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_participant_1on1_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_participant_1on1_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_participant_content_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_participant_content_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_participants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_shift_mapping; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_shift_mapping ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_shift_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_shift_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_sponsors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ryugakusai2026_sponsors ENABLE ROW LEVEL SECURITY;

--
-- Name: signup_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signup_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: ryugakusai2026_sponsors sponsors_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sponsors_public_read ON public.ryugakusai2026_sponsors FOR SELECT TO authenticated, anon USING (true);


--
-- Name: unified_search_index; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unified_search_index ENABLE ROW LEVEL SECURITY;

--
-- Name: user_group_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_group_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: user_role_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_role_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict O9g34kSoFzKlvKG6bAgQ1lf9LDbHaeV1kD9pi2tuJTVIAYyZCaomzv2mEPvRrRc

