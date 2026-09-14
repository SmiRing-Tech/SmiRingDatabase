-- 保存確定時に「誰がこの録画を見られるか」を指定できるようにする。
--
-- viewers_restricted = false（デフォルト。このマイグレーション以前の既存録画すべてが該当）:
--   従来通り、connect_recording.read を持つ人なら誰でも見られる。
-- viewers_restricted = true（このマイグレーション以降にconfirmされた録画は必ずこちら）:
--   connect_recording_viewers に列挙された人 + 開始者(started_by) + 停止者(stopped_by) だけが
--   見られる。connect_recording.read は引き続き前提条件として必要（閲覧者候補も read を
--   持つ人からしか選べない — GET /api/connect/recordings/:id/viewer-candidates 参照）。

ALTER TABLE public.connect_recordings
    ADD COLUMN viewers_restricted boolean NOT NULL DEFAULT false;

CREATE TABLE public.connect_recording_viewers (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    recording_id uuid NOT NULL REFERENCES public.connect_recordings(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recording_id, user_id)
);
CREATE INDEX connect_recording_viewers_recording_id_idx ON public.connect_recording_viewers (recording_id);
ALTER TABLE public.connect_recording_viewers ENABLE ROW LEVEL SECURITY;
-- backendはservice role keyでアクセスするためRLSは有効化のみでポリシーは追加しない（他のconnect_*テーブルと同じ方針）

-- resource+action を実際に持つユーザーidを返す、get_user_permissions の逆引き版。
-- 「そもそも connect_recording.read を持っている人」に閲覧者候補を絞り込むために使う
-- （backend/src/routes/connectRoutes.ts の GET /recordings/:id/viewer-candidates、
-- および confirm 時のサーバー側バリデーション）。action の包含関係は requirePermission.ts と
-- 同じ規則（admin は全て包含、write は read を包含）。
CREATE FUNCTION public.get_permission_grantee_user_ids(p_resource text, p_action text)
RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH matched_permissions AS (
    SELECT id FROM permissions
    WHERE resource = p_resource
      AND (action = p_action OR action = 'admin' OR (p_action = 'read' AND action = 'write'))
  ),
  grantees AS (
    SELECT grantee_type, grantee_id
    FROM permission_mappings
    WHERE permission_id IN (SELECT id FROM matched_permissions)
  )
  SELECT grantee_id AS user_id FROM grantees WHERE grantee_type = 'user'
  UNION
  SELECT urm.user_id FROM user_role_mappings urm
    JOIN grantees g ON g.grantee_type = 'role' AND g.grantee_id = urm.user_role
  UNION
  SELECT mdm.user_id FROM member_department_mappings mdm
    JOIN grantees g ON g.grantee_type = 'department' AND g.grantee_id = mdm.department_id
  UNION
  SELECT ugm.user_id FROM user_group_mappings ugm
    JOIN groups gr ON gr.id = ugm.group_id AND gr.deleted_at IS NULL
    JOIN grantees g ON g.grantee_type = 'group' AND g.grantee_id = ugm.group_id
$$;
