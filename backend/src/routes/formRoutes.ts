import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { resolveAvatarUrl } from '../lib/r2';

const router = Router();

// ==========================================
// 📖 フォーム＆質問の取得 API
// ==========================================
router.get('/api/forms/:id', async (req: Request, res: Response) => {
  const { id: formId } = req.params;

  try {
    const { data: form, error: formError } = await supabase
      .from('forms')
      .select('*')
      .eq('id', formId)
      .single();

    if (formError || !form) return res.status(404).json({ error: 'フォームが見つかりません' });

    const includeDeleted = req.query.includeDeleted === 'true';

    let query = supabase
      .from('form_questions')
      .select('*, questions(*)')
      .eq('form_id', formId)
      .order('order_index', { ascending: true });

    if (!includeDeleted) {
      query = query.eq('is_deleted', false);
    }

    const { data: qLinks, error: qError } = await query;

    if (qError) throw qError;

    const questions = qLinks?.map(link => {
      const q = link.questions;
      return {
        id: q.id,
        title: q.title || '',
        description: q.description || '',
        type: q.question_type || 'radio',
        isRequired: link.is_required,
        options: q.options?.choices || [],
        scale: q.options?.scale || { min: 1, max: 5, minLabel: '', maxLabel: '' },
        gridRows: q.options?.gridRows || [],
        gridCols: q.options?.gridCols || [],
        gridInputType: q.options?.gridInputType || 'radio',
        shortTextValidation: q.options?.validation || { enabled: false },
        dateTimeSettings: q.options?.dateTimeSettings || null,
        dropdownSettings: q.options?.dropdownSettings || null,
        isDeleted: link.is_deleted || false
      };
    }) || [];

    res.json({ ...form, questions });

  } catch (error: any) {
    console.error("Fetch Error:", error);
    res.status(500).json({ error: error.message });
  }
});


// ==========================================
// 📝 フォーム＆質問の一括保存 API
// ==========================================
router.post('/api/forms/:id/save', async (req: Request, res: Response) => {
  const { id: formId } = req.params;
  const { title, description, questions = [], created_by, allow_multiple_responses, allow_edit_responses } = req.body;

  try {
    // 0. フォームの現在のステータスを確認（なければ draft）
    const { data: existingForm } = await supabase
      .from('forms')
      .select('status')
      .eq('id', formId)
      .single();
    const currentStatus = existingForm?.status || 'draft';

    // 1. フォーム本体を更新 (Upsert)
    const { error: formError } = await supabase.from('forms').upsert({
      id: formId,
      title,
      description,
      status: currentStatus,
      created_by,
      allow_multiple_responses: allow_multiple_responses !== undefined ? allow_multiple_responses : false,
      allow_edit_responses: allow_edit_responses !== undefined ? allow_edit_responses : true,
      updated_at: new Date().toISOString(),
    });
    if (formError) throw formError;

    // 2. 質問の定義自体を更新 (Upsert)
    for (const q of questions) {
      const { error: qError } = await supabase.from('questions').upsert({
        id: q.id,
        title: q.title,
        description: q.description,
        question_type: q.type,
        options: {
          choices: q.options,
          scale: q.scale,
          gridRows: q.gridRows,
          gridCols: q.gridCols,
          gridInputType: q.gridInputType,
          validation: q.shortTextValidation,
          checkboxValidation: q.checkboxValidation,
          shortTextMultiple: q.shortTextMultiple,
          dateTimeSettings: q.dateTimeSettings,
          dropdownSettings: q.dropdownSettings
        }
      });
      if (qError) throw qError;
    }

    // 3. 紐付け (form_questions) の差分更新処理

    // ① 現在DBに保存されている、このフォームの紐付けデータを主キー(id)込みで取得
    const { data: existingLinks, error: fetchError } = await supabase
      .from('form_questions')
      .select('id, question_id')
      .eq('form_id', formId);
    if (fetchError) throw fetchError;

    const existingQuestionIds = existingLinks?.map(link => link.question_id) || [];
    const newQuestionIds = questions.map((q: any) => q.id);

    // ② 削除: 画面から消された質問の紐付けを削除（スマート・ソフトデリート）
    const idsToDelete = existingQuestionIds.filter(id => !newQuestionIds.includes(id));
    if (idsToDelete.length > 0) {
      const { data: responses, error: respError } = await supabase
        .from('form_responses')
        .select('id')
        .eq('form_id', formId)
        .eq('status', 'submitted')
        .limit(1);

      if (respError) throw respError;

      const hasResponses = responses && responses.length > 0;

      if (hasResponses) {
        // 回答がある場合はソフトデリート (is_deleted = true)
        const { error: updateError } = await supabase
          .from('form_questions')
          .update({ is_deleted: true })
          .eq('form_id', formId)
          .in('question_id', idsToDelete);
        if (updateError) throw updateError;
      } else {
        // 回答がない場合は物理削除
        const { error: deleteError } = await supabase
          .from('form_questions')
          .delete()
          .eq('form_id', formId)
          .in('question_id', idsToDelete);
        if (deleteError) throw deleteError;
      }
    }

    // ③ 追加(INSERT) と 更新(UPDATE) の仕分け
    const toInsert: any[] = [];
    const toUpdate: any[] = [];

    questions.forEach((q: any, index: number) => {
      const existingLink = existingLinks?.find(link => link.question_id === q.id);

      if (existingLink) {
        toUpdate.push({
          id: existingLink.id,
          form_id: formId,
          question_id: q.id,
          order_index: index,
          is_required: q.isRequired || false,
          is_deleted: false
        });
      } else {
        toInsert.push({
          form_id: formId,
          question_id: q.id,
          order_index: index,
          is_required: q.isRequired || false,
          is_deleted: false
        });
      }
    });

    // ④ まとめて実行
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase.from('form_questions').insert(toInsert);
      if (insertError) throw insertError;
    }

    if (toUpdate.length > 0) {
      const { error: updateError } = await supabase.from('form_questions').upsert(toUpdate);
      if (updateError) throw updateError;
    }

    res.json({ message: "保存成功" });
  } catch (error: any) {
    console.error("Save Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🚀 フォーム公開（送信完了） API
// ==========================================
router.post('/api/forms/:id/publish', async (req: Request, res: Response) => {
  const { id: formId } = req.params;
  const { assigned_user_ids, due_date, allow_anonymous, allow_multiple_responses, allow_edit_responses, timezone, status } = req.body;

  try {
    const publish_settings = {
      visibility: "restricted",
      assigned_user_ids: assigned_user_ids,
      external_emails: [],
      share_url: `/form-answer/${formId}`,
      timezone: timezone
    };

    const { error } = await supabase
      .from('forms')
      .update({
        status: status,
        due_date: due_date || null,
        allow_anonymous: allow_anonymous,
        allow_multiple_responses: allow_multiple_responses ?? false,
        allow_edit_responses: allow_edit_responses ?? true,
        publish_settings: publish_settings,
        timezone: timezone,
        updated_at: new Date().toISOString()
      })
      .eq('id', formId);

    if (error) throw error;

    res.json({ message: "フォームを公開しました！", share_url: publish_settings.share_url });
  } catch (error: any) {
    console.error("Publish Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 💾 フォーム回答の「下書き」保存 API
// ==========================================
router.post('/api/forms/:id/responses/save', async (req: Request, res: Response) => {
  const { id: formId } = req.params;
  const { content, response_id } = req.body;

  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });
    const user_id = user.id;

    let resultId = response_id;

    if (response_id) {
      const { error } = await supabase
        .from('form_responses')
        .update({
          content: content,
          status: 'draft',
          updated_at: new Date().toISOString()
        })
        .eq('id', response_id)
        .eq('user_id', user_id);
      if (error) throw error;
    } else {
      const { data, error } = await supabase
        .from('form_responses')
        .insert({
          form_id: formId,
          user_id: user_id,
          content: content,
          status: 'draft',
          updated_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (error) throw error;
      resultId = data.id;
    }

    res.json({ message: "下書きを保存しました", response_id: resultId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📥 フォーム回答の送信 API
// ==========================================
router.post('/api/forms/:id/submit', async (req: Request, res: Response) => {
  const { id: formId } = req.params;
  const { answers, turnstileToken, response_id } = req.body;

  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });
    const user_id = user.id;

    // 1. フォーム設定を取得して複数回答と匿名設定の可否を確認
    const { data: form } = await supabase.from('forms').select('allow_multiple_responses, allow_anonymous').eq('id', formId).single();
    const allowMultiple = form?.allow_multiple_responses || false;
    const isAnonymous = form?.allow_anonymous || false;

    // 2. Turnstile検証
    const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: turnstileToken })
    });
    const verifyData = await verifyResponse.json();
    if (!verifyData.success) return res.status(400).json({ error: 'Bot検知失敗' });

    let finalResponseId = response_id;

    // 3. 複数回答不可の場合、既存の回答（下書き含む）がないか念のため再確認してIDを特定する
    if (!allowMultiple && !finalResponseId) {
      const { data: existing } = await supabase
        .from('form_responses')
        .select('id')
        .eq('form_id', formId)
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (existing) {
        finalResponseId = existing.id;
      }
    }

    // 4. form_responses を更新/挿入
    const upsertData: any = {
      form_id: formId,
      user_id: user_id,
      content: answers,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_anonymous: isAnonymous
    };

    if (finalResponseId) {
      upsertData.id = finalResponseId;
    }

    const { error: responseError } = await supabase
      .from('form_responses')
      .upsert(upsertData);

    if (responseError) throw responseError;

    // 5. 個別の回答データ(answersテーブル)の同期
    // 上書きの場合は、一度このユーザーのこのフォームへの古い回答を削除する（重複防止）
    if (!allowMultiple) {
      await supabase.from('answers').delete().eq('form_id', formId).eq('user_id', user_id);
    }

    const answerRecords = Object.entries(answers).map(([qId, value]) => ({
      form_id: formId,
      question_id: qId,
      user_id: user_id || null,
      answer_data: { value },
      created_at: new Date().toISOString()
    }));

    if (answerRecords.length > 0) {
      const { error: saveError } = await supabase.from('answers').insert(answerRecords);
      if (saveError) throw saveError;
    }

    res.json({ message: "回答を受け付けました！ありがとうございます。" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📋 自分のフォーム一覧を取得する API
// ==========================================
router.get('/api/my-forms', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: '認証トークンがありません' });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) throw authError;

    const { data, error } = await supabase
      .from('forms')
      .select('id, title, status, updated_at')
      .eq('created_by', user.id)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json(data);

  } catch (error: any) {
    console.error('マイフォーム取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📄 指定ユーザーのフォーム回答一覧を取得する API
// ==========================================
router.get('/api/users/:id/form-responses', async (req: Request, res: Response) => {
  const { id: userId } = req.params;

  try {
    const { data, error } = await supabase
      .from('form_responses')
      .select(`
        id,
        status,
        submitted_at,
        forms (
          id,
          title
        )
      `)
      .eq('user_id', userId)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    const formattedData = data.map((item: any) => ({
      id: item.id,
      form_id: item.forms?.id,
      form_title: item.forms?.title || 'Unknown Form',
      submitted_at: item.submitted_at,
      status: item.status
    }));

    res.json(formattedData);
  } catch (error: any) {
    console.error("User Form Responses Fetch Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📩 自分にアサインされたフォームを取得する API
// ==========================================
router.get('/api/assigned-forms', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) throw authError;

    const { data, error } = await supabase
      .from('forms')
      .select('id, title, due_date, status, publish_settings')
      .eq('status', 'published')
      .is('deleted_at', null)
      .contains('publish_settings', { assigned_user_ids: [user.id] });

    if (error) throw error;
    res.json(data);

  } catch (error: any) {
    console.error('アサインフォーム取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📊 フォームへの回答者一覧を取得する API
// ==========================================
router.get('/api/forms/:id/responses', async (req: Request, res: Response) => {
  const { id: formId } = req.params;

  try {
    const { data: responses, error: responseError } = await supabase
      .from('form_responses')
      .select('id, user_id, status, submitted_at, updated_at, content, is_anonymous')
      .eq('form_id', formId)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: true });

    if (responseError) throw responseError;
    if (!responses || responses.length === 0) {
      return res.json([]);
    }

    const userIds = responses.map(r => r.user_id).filter(Boolean);
    const { data: profiles, error: profileError } = await supabase
      .from('basic_profile_info')
      .select('id, name_english, name_kanji, avatar_id')
      .in('id', userIds);

    if (profileError) throw profileError;

    // プロフィール情報と、それに対応するアバターの署名付きURLをマッピング
    const profileMap = new Map();
    for (const p of profiles || []) {
      const avatarUrl = await resolveAvatarUrl(p.avatar_id);
      profileMap.set(p.id, { ...p, avatar_link: avatarUrl });
    }

    const result = responses.map(r => {
      const isAnon = r.is_anonymous;
      // 匿名の場合はプロフィール情報を完全に遮断し、user_idもダミーにする
      const profile = isAnon ? null : profileMap.get(r.user_id);
      
      return {
        response_id: r.id,
        user_id: isAnon ? `anon_${r.id}` : r.user_id, // ID推測防止
        is_anonymous: isAnon,
        submitted_at: r.submitted_at,
        updated_at: r.updated_at,
        name_english: isAnon ? '匿名ユーザー' : (profile?.name_english || '不明なユーザー'),
        name_kanji: isAnon ? '' : (profile?.name_kanji || ''),
        avatar_link: isAnon ? null : (profile?.avatar_link || null),
        content: r.content || {},
      };
    });

    res.json(result);
  } catch (error: any) {
    console.error('回答一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📋 特定ユーザーの回答詳細を取得する API
// ==========================================
router.get('/api/forms/:id/responses/:userId', async (req: Request, res: Response) => {
  const { id: formId, userId } = req.params;

  try {
    const { data: response, error: responseError } = await supabase
      .from('form_responses')
      .select('id, content, status, submitted_at')
      .eq('form_id', formId)
      .eq('user_id', userId)
      .eq('status', 'submitted')
      .single();

    if (responseError || !response) {
      return res.status(404).json({ error: '回答が見つかりません' });
    }

    const { data: qLinks, error: qError } = await supabase
      .from('form_questions')
      .select('order_index, is_required, questions(id, title, description, question_type, options)')
      .eq('form_id', formId)
      .order('order_index', { ascending: true });

    if (qError) throw qError;

    const questions = (qLinks || []).map(link => {
      const q = link.questions as any;
      return {
        id: q.id,
        title: q.title || '',
        description: q.description || '',
        type: q.question_type || 'radio',
        is_required: link.is_required,
        options: q.options?.choices || [],
        scale: q.options?.scale || null,
        gridRows: q.options?.gridRows || [],
        gridCols: q.options?.gridCols || [],
        gridInputType: q.options?.gridInputType || 'radio',
        answer: response.content?.[q.id] ?? null,
      };
    });

    const { data: profile } = await supabase
      .from('basic_profile_info')
      .select('id, name_english, name_kanji, avatar_id')
      .eq('id', userId)
      .single();

    const avatarUrl = await resolveAvatarUrl(profile?.avatar_id || null);

    res.json({
      response_id: response.id,
      submitted_at: response.submitted_at,
      user: {
        id: userId,
        name_english: profile?.name_english || '不明なユーザー',
        name_kanji: profile?.name_kanji || '',
        avatar_link: avatarUrl,
      },
      questions,
    });
  } catch (error: any) {
    console.error('回答詳細取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
