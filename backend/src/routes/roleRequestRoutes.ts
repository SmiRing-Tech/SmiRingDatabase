import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { authenticate } from '../middleware/authenticate';

const router = Router();

// SmiRing内部運営メンバー / 外部協力者ロールの実IDと、内部ロール判定に使う全ID一覧
// (frontend/src/hooks/useIsInternal.ts と対応させること)
const SMIRING_MEMBER_ROLE_ID = 'c7f24039-c537-402e-91db-664684f5f8b3';
const PARTNER_ROLE_ID = 'e9b3b5b3-b95e-4c87-bf1c-6b65603189cf';
const ADMIN_ROLE_ID = 'a6dfbd9b-f64b-446d-b89f-b7d876e26988';
const INTERNAL_ROLE_IDS = [SMIRING_MEMBER_ROLE_ID, PARTNER_ROLE_ID, ADMIN_ROLE_ID];

const REQUESTABLE_ROLES = ['smiring_member', 'partner'] as const;
type RequestableRole = typeof REQUESTABLE_ROLES[number];

router.use(authenticate);

/**
 * 申請フォームの部署選択肢（名前だけの軽量版。management権限が無いユーザーでも取得可能）
 */
router.get('/api/role-requests/departments', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('departments')
      .select('id, name, parent_id')
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    console.error('部署一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 自分の申請状況を取得（未申請 / 申請中 / 既に内部メンバー）
 */
router.get('/api/role-requests/me', async (req: Request, res: Response) => {
  try {
    const { data: mappings, error } = await supabase
      .from('user_role_mappings')
      .select('id, user_role, metadata')
      .eq('user_id', req.user!.id);

    if (error) throw error;

    const alreadyInternal = (mappings || []).some(m => m.user_role && INTERNAL_ROLE_IDS.includes(m.user_role));
    if (alreadyInternal) {
      return res.json({ status: 'already_member' });
    }

    const pending = (mappings || []).find(m => !m.user_role && m.metadata?.requested_role);
    if (pending) {
      return res.json({ status: 'pending', request: pending.metadata });
    }

    res.json({ status: 'none' });
  } catch (error: any) {
    console.error('申請状況取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * メンバー申請の送信（既に申請中なら内容を上書き更新）
 */
router.post('/api/role-requests', async (req: Request, res: Response) => {
  try {
    const { requestedRole, departmentIds, description } = req.body as {
      requestedRole: RequestableRole;
      departmentIds?: string[];
      description?: string;
    };

    if (!REQUESTABLE_ROLES.includes(requestedRole)) {
      return res.status(400).json({ error: '無効な申請区分です' });
    }
    if (requestedRole === 'smiring_member' && (!Array.isArray(departmentIds) || departmentIds.length === 0)) {
      return res.status(400).json({ error: '希望部署を1つ以上選択してください' });
    }
    if (requestedRole === 'partner' && !description?.trim()) {
      return res.status(400).json({ error: '関わり方の説明を入力してください' });
    }

    const { data: mappings, error: fetchError } = await supabase
      .from('user_role_mappings')
      .select('id, user_role, metadata')
      .eq('user_id', req.user!.id);

    if (fetchError) throw fetchError;

    const alreadyInternal = (mappings || []).some(m => m.user_role && INTERNAL_ROLE_IDS.includes(m.user_role));
    if (alreadyInternal) {
      return res.status(400).json({ error: 'すでに内部メンバー/協力者として承認済みです' });
    }

    const metadata = {
      requested_role: requestedRole,
      department_ids: requestedRole === 'smiring_member' ? departmentIds : undefined,
      description: requestedRole === 'partner' ? description?.trim() : undefined,
      requested_at: new Date().toISOString(),
    };

    const existingPending = (mappings || []).find(m => !m.user_role && m.metadata?.requested_role);

    if (existingPending) {
      const { error: updateError } = await supabase
        .from('user_role_mappings')
        .update({ metadata })
        .eq('id', existingPending.id);
      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await supabase
        .from('user_role_mappings')
        .insert({
          user_id: req.user!.id,
          user_role: null,
          is_current_status: false,
          metadata,
        });
      if (insertError) throw insertError;
    }

    res.json({ message: '申請を送信しました' });
  } catch (error: any) {
    console.error('メンバー申請エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
