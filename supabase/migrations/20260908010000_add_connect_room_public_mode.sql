-- connect_rooms に「公開/非公開」の大枠モードを追加。
-- 旧 visibility 列（'all'|'internal'|'custom'）は一覧バッジ表示用のスナップショット推測に
-- すぎず実際のアクセス制御には使っていなかったため、今回の access_mode / public_all /
-- connect_room_visibility_roles / connect_room_visibility_departments に置き換えて廃止する。
ALTER TABLE public.connect_rooms
  ADD COLUMN access_mode text NOT NULL DEFAULT 'private'
    CHECK (access_mode IN ('public', 'private')),
  ADD COLUMN public_all boolean NOT NULL DEFAULT false,
  DROP COLUMN visibility;

COMMENT ON COLUMN public.connect_rooms.access_mode IS
  'public=条件（全員/ロール/部署）に当てはまる人に見える。private=connect_room_viewersに列挙された固定メンバーのみ';
COMMENT ON COLUMN public.connect_rooms.public_all IS
  'access_mode=public のとき、条件を「全員」にしているか（true なら role/department 条件は無視して全員にマッチ）';

-- Public モードで「ロールで絞り込む」を選んだ場合の許可ロール（複数行=複数選択）
CREATE TABLE public.connect_room_visibility_roles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.connect_rooms(id) ON DELETE CASCADE,
  role_group text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, role_group)
);
CREATE INDEX connect_room_visibility_roles_room_id_idx ON public.connect_room_visibility_roles (room_id);
ALTER TABLE public.connect_room_visibility_roles ENABLE ROW LEVEL SECURITY;

-- Public モードで「部署で絞り込む」を選んだ場合の許可部署名（複数行=複数選択）
CREATE TABLE public.connect_room_visibility_departments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.connect_rooms(id) ON DELETE CASCADE,
  department text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, department)
);
CREATE INDEX connect_room_visibility_departments_room_id_idx ON public.connect_room_visibility_departments (room_id);
ALTER TABLE public.connect_room_visibility_departments ENABLE ROW LEVEL SECURITY;
-- どちらもbackendがservice role keyでアクセスするためポリシーは追加しない（他のconnect_*テーブルと同じ方針）

-- connect_room_viewers は既存テーブルをそのまま再利用する。意味づけは connect_rooms.access_mode で
-- 切り替わる: private のときは「見られる固定名簿」、public のときは「条件に当てはまっていても
-- 常に除外する人」の永続除外リストになる。
