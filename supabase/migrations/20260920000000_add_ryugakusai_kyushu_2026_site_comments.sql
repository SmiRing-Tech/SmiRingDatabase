CREATE TABLE public.ryugakusai_kyushu_2026_site_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES public.ryugakusai_kyushu_2026_site_comments(id) ON DELETE CASCADE,
  page        text NOT NULL,
  author_name text NOT NULL,
  body        text NOT NULL,
  anchor      jsonb,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ryugakusai_kyushu_2026_site_comments_page_idx
  ON public.ryugakusai_kyushu_2026_site_comments (page, created_at);
ALTER TABLE public.ryugakusai_kyushu_2026_site_comments ENABLE ROW LEVEL SECURITY;
-- backendはservice role keyでアクセスするためポリシーは追加しない（他のconnect_*テーブルと同じ方針）
