import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { resolveAvatarUrl, getSignedFileUrl } from '../lib/r2';
import { getLocalEmbedding, getGeminiEmbedding, answerToText } from '../lib/ai';

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
        fileUploadSettings: q.options?.fileUploadSettings || null,
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
      allow_anonymous: req.body.allow_anonymous !== undefined ? req.body.allow_anonymous : false,
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
          dropdownSettings: q.dropdownSettings,
          fileUploadSettings: q.fileUploadSettings
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

    const { data: responseData, error: responseError } = await supabase
      .from('form_responses')
      .upsert(upsertData)
      .select('id')
      .single();

    if (responseError) throw responseError;
    const submittedResponseId = responseData.id;

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

    let savedAnswers: { id: string; question_id: string }[] = [];
    if (answerRecords.length > 0) {
      const { data, error: saveError } = await supabase
        .from('answers')
        .insert(answerRecords)
        .select('id, question_id');
      if (saveError) throw saveError;
      savedAnswers = data || [];
    }

    res.json({ message: "回答を受け付けました！ありがとうございます。" });

    // バックグラウンドでベクトル化とインデックス保存（ユーザーを待たせない）
    (async () => {
      try {
        console.log(`[AI Indexer] 回答(response_id: ${submittedResponseId})のインデックス化を開始...`);

        // フォームタイトルと質問一覧を並列取得
        const [formRes, qLinksRes] = await Promise.all([
          supabase.from('forms').select('title').eq('id', formId).single(),
          supabase
            .from('form_questions')
            .select('questions(id, title, question_type, options)')
            .eq('form_id', formId)
            .eq('is_deleted', false)
        ]);

        const formTitle = formRes.data?.title || '';
        const questions = (qLinksRes.data || []).map((link: any) => ({
          id: link.questions.id,
          title: link.questions.title,
          type: link.questions.question_type,
          options: link.questions.options,
        }));

        // 再提出時: このユーザーのこのフォームの古いインデックスを削除
        if (!allowMultiple) {
          await supabase
            .from('unified_search_index')
            .delete()
            .eq('source_type', 'form_answer')
            .eq('metadata->>user_id', user_id)
            .eq('metadata->>form_id', formId);
        }

        // 質問ごとに個別にベクトル化して保存
        await Promise.all(
          savedAnswers.map(async (savedAnswer) => {
            const q = questions.find((q) => q.id === savedAnswer.question_id);
            if (!q) return;

            const text = answerToText([q], answers);
            if (!text) return;

            const [localVector, geminiVector] = await Promise.all([
              getLocalEmbedding(text),
              getGeminiEmbedding(text),
            ]);

            const { error: indexError } = await supabase
              .from('unified_search_index')
              .insert({
                source_type: 'form_answer',
                source_id: savedAnswer.id,
                content: text,
                embedding_local: localVector,
                embedding_gemini: geminiVector,
                metadata: { user_id, form_id: formId, form_title: formTitle, question_id: q.id },
              });

            if (indexError) throw indexError;
          })
        );

        console.log(`[AI Indexer] ✅ ${savedAnswers.length}件のインデックス保存完了 (response_id: ${submittedResponseId})`);
      } catch (err) {
        console.error('[AI Indexer] ❌ インデックス保存エラー:', err);
      }
    })();

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

    // 質問一覧を取得して file_upload タイプを特定
    const { data: qData } = await supabase.from('form_questions').select('questions(id, question_type)').eq('form_id', formId);
    const fileQuestionIds = (qData || [])
      .filter((q: any) => q.questions?.question_type === 'file_upload')
      .map((q: any) => q.questions.id);

    const result = await Promise.all(responses.map(async r => {
      const isAnon = r.is_anonymous;
      const profile = isAnon ? null : profileMap.get(r.user_id);
      
      const content = { ...(r.content || {}) };
      // ファイルパスを署名付きURLに変換
      for (const qId of fileQuestionIds) {
        if (Array.isArray(content[qId])) {
          content[qId] = await Promise.all(content[qId].map(async (file: any) => ({
            ...file,
            url: await getSignedFileUrl(file.path)
          })));
        }
      }

      return {
        response_id: r.id,
        user_id: isAnon ? `anon_${r.id}` : r.user_id,
        is_anonymous: isAnon,
        submitted_at: r.submitted_at,
        updated_at: r.updated_at,
        name_english: isAnon ? '匿名ユーザー' : (profile?.name_english || '不明なユーザー'),
        name_kanji: isAnon ? '' : (profile?.name_kanji || ''),
        avatar_link: isAnon ? null : (profile?.avatar_link || null),
        content: content,
      };
    }));

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

    // 回答詳細のファイルパスも解決
    const resolvedContent = { ...(response.content || {}) };
    for (const q of (qLinks || [])) {
      const question = q.questions as any;
      if (question.question_type === 'file_upload' && Array.isArray(resolvedContent[question.id])) {
        resolvedContent[question.id] = await Promise.all(resolvedContent[question.id].map(async (file: any) => ({
          ...file,
          url: await getSignedFileUrl(file.path)
        })));
      }
    }

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
      questions: (qLinks || []).map(link => {
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
          dateTimeSettings: q.options?.dateTimeSettings || null,
          dropdownSettings: q.options?.dropdownSettings || null,
          fileUploadSettings: q.options?.fileUploadSettings || null,
          answer: resolvedContent[q.id] ?? null,
        };
      }),
    });
  } catch (error: any) {
    console.error('回答詳細取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
