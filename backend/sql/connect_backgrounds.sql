-- SmiRing Connect: ユーザーごとのバーチャル背景画像
--
-- 実行方法: Supabase ダッシュボード → SQL Editor に貼り付けて実行する。
-- このテーブルが無いと /api/connect/backgrounds 系が 500 を返す。

create table if not exists public.connect_backgrounds (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  storage_path text        not null,
  created_at   timestamptz not null default now()
);

-- 一覧は常に「自分の分だけを新しい順」で引くので、その形に合わせる
create index if not exists connect_backgrounds_user_created_idx
  on public.connect_backgrounds (user_id, created_at desc);

-- アクセスは全てバックエンド（service role キー）経由なので RLS は素通りするが、
-- 万一 anon キーで直接叩かれても他人の背景が漏れないように保険をかけておく。
alter table public.connect_backgrounds enable row level security;

drop policy if exists "own backgrounds" on public.connect_backgrounds;
create policy "own backgrounds"
  on public.connect_backgrounds
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
