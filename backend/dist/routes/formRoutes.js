"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../lib/supabase");
const r2_1 = require("../lib/r2");
const ai_1 = require("../lib/ai");
const vectorIndexer_1 = require("../lib/vectorIndexer");
const authenticate_1 = require("../middleware/authenticate");
const router = (0, express_1.Router)();
// ==========================================
// 📖 フォーム＆質問の取得 API
// ==========================================
router.get('/api/forms/:id', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    try {
        const { data: form, error: formError } = await supabase_1.supabase
            .from('forms')
            .select('*')
            .eq('id', formId)
            .single();
        if (formError || !form)
            return res.status(404).json({ error: 'フォームが見つかりません' });
        const includeDeleted = req.query.includeDeleted === 'true';
        let query = supabase_1.supabase
            .from('form_question_mappings')
            .select('*, questions(*)')
            .eq('form_id', formId)
            .order('order_index', { ascending: true });
        if (!includeDeleted) {
            query = query.eq('is_deleted', false);
        }
        const { data: qLinks, error: qError } = await query;
        if (qError)
            throw qError;
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
                checkboxValidation: q.options?.checkboxValidation || { enabled: false },
                shortTextMultiple: q.options?.shortTextMultiple || { enabled: false },
                dateTimeSettings: q.options?.dateTimeSettings || null,
                dropdownSettings: q.options?.dropdownSettings || null,
                fileUploadSettings: q.options?.fileUploadSettings || null,
                isDeleted: link.is_deleted || false
            };
        }) || [];
        res.json({ ...form, questions });
    }
    catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📝 フォーム＆質問の一括保存 API
// ==========================================
router.post('/api/forms/:id/save', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    const { title, description, questions = [], created_by, allow_multiple_responses, allow_edit_responses } = req.body;
    try {
        // 0. フォームの現在のステータスを確認（なければ draft）
        const { data: existingForm } = await supabase_1.supabase
            .from('forms')
            .select('status')
            .eq('id', formId)
            .single();
        const currentStatus = existingForm?.status || 'draft';
        // 1. フォーム本体を更新 (Upsert)
        const { error: formError } = await supabase_1.supabase.from('forms').upsert({
            id: formId,
            title,
            description,
            status: currentStatus,
            created_by,
            allow_multiple_responses: allow_multiple_responses !== undefined ? allow_multiple_responses : false,
            allow_edit_responses: allow_edit_responses !== undefined ? allow_edit_responses : true,
            allow_anonymous: req.body.allow_anonymous !== undefined ? req.body.allow_anonymous : false,
        });
        if (formError)
            throw formError;
        // 2. 質問の定義自体を更新 (Upsert)
        for (const q of questions) {
            const { error: qError } = await supabase_1.supabase.from('questions').upsert({
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
            if (qError)
                throw qError;
        }
        // 3. 紐付け (form_question_mappings) の差分更新処理
        // ① 現在DBに保存されている、このフォームの紐付けデータを主キー(id)込みで取得
        const { data: existingLinks, error: fetchError } = await supabase_1.supabase
            .from('form_question_mappings')
            .select('id, question_id')
            .eq('form_id', formId);
        if (fetchError)
            throw fetchError;
        const existingQuestionIds = existingLinks?.map(link => link.question_id) || [];
        const newQuestionIds = questions.map((q) => q.id);
        // ② 削除: 画面から消された質問の紐付けを削除（スマート・ソフトデリート）
        const idsToDelete = existingQuestionIds.filter(id => !newQuestionIds.includes(id));
        if (idsToDelete.length > 0) {
            const { data: responses, error: respError } = await supabase_1.supabase
                .from('form_response_mappings')
                .select('id')
                .eq('form_id', formId)
                .eq('status', 'submitted')
                .limit(1);
            if (respError)
                throw respError;
            const hasResponses = responses && responses.length > 0;
            if (hasResponses) {
                // 回答がある場合はソフトデリート (is_deleted = true)
                const { error: updateError } = await supabase_1.supabase
                    .from('form_question_mappings')
                    .update({ is_deleted: true })
                    .eq('form_id', formId)
                    .in('question_id', idsToDelete);
                if (updateError)
                    throw updateError;
            }
            else {
                // 回答がない場合は物理削除
                const { error: deleteError } = await supabase_1.supabase
                    .from('form_question_mappings')
                    .delete()
                    .eq('form_id', formId)
                    .in('question_id', idsToDelete);
                if (deleteError)
                    throw deleteError;
            }
        }
        // ③ 追加(INSERT) と 更新(UPDATE) の仕分け
        const toInsert = [];
        const toUpdate = [];
        questions.forEach((q, index) => {
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
            }
            else {
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
            const { error: insertError } = await supabase_1.supabase.from('form_question_mappings').insert(toInsert);
            if (insertError)
                throw insertError;
        }
        if (toUpdate.length > 0) {
            const { error: updateError } = await supabase_1.supabase.from('form_question_mappings').upsert(toUpdate);
            if (updateError)
                throw updateError;
        }
        res.json({ message: "保存成功" });
    }
    catch (error) {
        console.error("Save Error:", error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 🚀 フォーム公開（送信完了） API
// ==========================================
router.post('/api/forms/:id/publish', authenticate_1.authenticate, async (req, res) => {
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
        const { error } = await supabase_1.supabase
            .from('forms')
            .update({
            status: status,
            due_date: due_date || null,
            allow_anonymous: allow_anonymous,
            allow_multiple_responses: allow_multiple_responses ?? false,
            allow_edit_responses: allow_edit_responses ?? true,
            publish_settings: publish_settings
        })
            .eq('id', formId);
        if (error)
            throw error;
        res.json({ message: "フォームを公開しました！", share_url: publish_settings.share_url });
    }
    catch (error) {
        console.error("Publish Error:", error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 💾 フォーム回答の「下書き」保存 API
// ==========================================
router.post('/api/forms/:id/responses/save', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    const { content, response_id } = req.body;
    try {
        const user_id = req.user.id;
        let resultId = response_id;
        if (response_id) {
            const { error } = await supabase_1.supabase
                .from('form_response_mappings')
                .update({
                content: content,
                status: 'draft'
            })
                .eq('id', response_id)
                .eq('user_id', user_id);
            if (error)
                throw error;
        }
        else {
            const { data, error } = await supabase_1.supabase
                .from('form_response_mappings')
                .insert({
                form_id: formId,
                user_id: user_id,
                content: content,
                status: 'draft'
            })
                .select('id')
                .single();
            if (error)
                throw error;
            resultId = data.id;
        }
        res.json({ message: "下書きを保存しました", response_id: resultId });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📥 フォーム回答の送信 API
// ==========================================
router.post('/api/forms/:id/submit', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    const { answers, turnstileToken, response_id } = req.body;
    try {
        const user_id = req.user.id;
        // 1. フォーム設定を取得して複数回答と匿名設定の可否を確認
        const { data: form } = await supabase_1.supabase.from('forms').select('allow_multiple_responses, allow_anonymous').eq('id', formId).single();
        const allowMultiple = form?.allow_multiple_responses || false;
        const isAnonymous = form?.allow_anonymous || false;
        // 2. Turnstile検証
        const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: turnstileToken })
        });
        const verifyData = await verifyResponse.json();
        if (!verifyData.success)
            return res.status(400).json({ error: 'Bot検知失敗' });
        let finalResponseId = response_id;
        // 3. 複数回答不可の場合、既存の回答（下書き含む）がないか念のため再確認してIDを特定する
        if (!allowMultiple && !finalResponseId) {
            const { data: existing } = await supabase_1.supabase
                .from('form_response_mappings')
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
        // 4. form_response_mappings を更新/挿入
        const upsertData = {
            form_id: formId,
            user_id: user_id,
            content: answers,
            status: 'submitted',
            submitted_at: new Date().toISOString(),
            is_anonymous: isAnonymous
        };
        if (finalResponseId) {
            upsertData.id = finalResponseId;
        }
        const { data: responseData, error: responseError } = await supabase_1.supabase
            .from('form_response_mappings')
            .upsert(upsertData)
            .select('id')
            .single();
        if (responseError)
            throw responseError;
        const submittedResponseId = responseData.id;
        // 5. 個別の回答データ(answersテーブル)の同期
        // 上書きの場合は、一度このユーザーのこのフォームへの古い回答を削除する（重複防止）
        if (!allowMultiple) {
            await supabase_1.supabase.from('answers').delete().eq('form_id', formId).eq('user_id', user_id);
        }
        const answerRecords = Object.entries(answers).map(([qId, value]) => ({
            form_id: formId,
            question_id: qId,
            user_id: user_id || null,
            answer_data: { value },
            created_at: new Date().toISOString()
        }));
        let savedAnswers = [];
        if (answerRecords.length > 0) {
            const { data, error: saveError } = await supabase_1.supabase
                .from('answers')
                .insert(answerRecords)
                .select('id, question_id');
            if (saveError)
                throw saveError;
            savedAnswers = data || [];
        }
        res.json({ message: "回答を受け付けました！ありがとうございます。" });
        // バックグラウンドでベクトル化とインデックス保存
        (async () => {
            try {
                // フィードバックフォームの場合はベクトル化をスキップ
                if (formId === 'd39c8fee-ec64-474b-bcc9-b7725607ec67') {
                    console.log(`[AI Indexer] Skipping feedback form: ${formId}`);
                    return;
                }
                // 匿名回答のフォームの場合もベクトル化をスキップ
                if (isAnonymous) {
                    console.log(`[AI Indexer] Skipping anonymous form: ${formId}`);
                    return;
                }
                // フォームタイトルと質問一覧を並列取得
                const [formRes, qLinksRes] = await Promise.all([
                    supabase_1.supabase.from('forms').select('title').eq('id', formId).single(),
                    supabase_1.supabase
                        .from('form_question_mappings')
                        .select('questions(id, title, question_type, options)')
                        .eq('form_id', formId)
                        .eq('is_deleted', false)
                ]);
                const formTitle = formRes.data?.title || '';
                const questions = (qLinksRes.data || []).map((link) => ({
                    id: link.questions.id,
                    title: link.questions.title,
                    type: link.questions.question_type,
                    options: link.questions.options,
                }));
                // 再提出時: このユーザーのこのフォームの古いインデックスを削除
                if (!allowMultiple) {
                    await (0, vectorIndexer_1.deleteSearchIndexByMetadata)('form_answer', {
                        user_id: String(user_id),
                        form_id: String(formId)
                    });
                }
                // 質問ごとに個別にベクトル化して保存
                await Promise.all(savedAnswers.map(async (savedAnswer) => {
                    const q = questions.find((q) => q.id === savedAnswer.question_id);
                    if (!q)
                        return;
                    const text = (0, ai_1.answerToText)([q], answers);
                    if (!text)
                        return;
                    await (0, vectorIndexer_1.queueIndexWork)({
                        source_type: 'form_answer',
                        source_id: savedAnswer.id,
                        content: text,
                        metadata: { user_id, form_id: formId, form_title: formTitle, question_id: q.id, response_id: submittedResponseId },
                    });
                }));
            }
            catch (err) {
                console.error('[AI Indexer] ❌ Failed to start indexing:', err);
            }
        })();
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📋 自分のフォーム一覧を取得する API
// ==========================================
router.get('/api/my-forms', authenticate_1.authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase_1.supabase
            .from('forms')
            .select('id, title, status, updated_at')
            .eq('created_by', req.user.id)
            .is('deleted_at', null)
            .order('updated_at', { ascending: false });
        if (error)
            throw error;
        res.json(data);
    }
    catch (error) {
        console.error('マイフォーム取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📄 指定ユーザーのフォーム回答一覧を取得する API
// ==========================================
router.get('/api/users/:id/form-responses', authenticate_1.authenticate, async (req, res) => {
    const { id: userId } = req.params;
    try {
        const { data, error } = await supabase_1.supabase
            .from('form_response_mappings')
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
        if (error)
            throw error;
        const formattedData = data.map((item) => ({
            id: item.id,
            form_id: item.forms?.id,
            form_title: item.forms?.title || 'Unknown Form',
            submitted_at: item.submitted_at,
            status: item.status
        }));
        res.json(formattedData);
    }
    catch (error) {
        console.error("User Form Responses Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📩 自分にアサインされたフォームを取得する API
// ==========================================
router.get('/api/assigned-forms', authenticate_1.authenticate, async (req, res) => {
    try {
        // 1. 自分にアサインされたフォームを取得
        const { data: forms, error: formError } = await supabase_1.supabase
            .from('forms')
            .select('id, title, due_date, status, publish_settings')
            .eq('status', 'published')
            .is('deleted_at', null)
            .contains('publish_settings', { assigned_user_ids: [req.user.id] });
        if (formError)
            throw formError;
        // 2. それらのフォームに対する自分の回答状況を取得
        const formIds = (forms || []).map(f => f.id);
        let responsesData = [];
        if (formIds.length > 0) {
            const { data } = await supabase_1.supabase
                .from('form_response_mappings')
                .select('form_id, status')
                .in('form_id', formIds)
                .eq('user_id', req.user.id);
            responsesData = data || [];
        }
        // 3. マージして返す
        const merged = (forms || []).map(form => {
            const myResponse = responsesData.find(r => r.form_id === form.id);
            return {
                ...form,
                is_submitted: myResponse?.status === 'submitted',
                response_status: myResponse?.status || null
            };
        });
        res.json(merged);
    }
    catch (error) {
        console.error('アサインフォーム取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📋 特定のフォームに対する自分の回答を取得する API
// ==========================================
router.get('/api/forms/:id/my-responses', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    try {
        const { data, error } = await supabase_1.supabase
            .from('form_response_mappings')
            .select('*')
            .eq('form_id', formId)
            .eq('user_id', req.user.id)
            .order('updated_at', { ascending: false });
        if (error)
            throw error;
        res.json(data);
    }
    catch (error) {
        console.error('マイ回答取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📊 フォームの回答数を取得する API
// ==========================================
router.get('/api/forms/:id/responses/count', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    try {
        const { count, error } = await supabase_1.supabase
            .from('form_response_mappings')
            .select('*', { count: 'exact', head: true })
            .eq('form_id', formId)
            .eq('status', 'submitted');
        if (error)
            throw error;
        res.json({ count: count || 0 });
    }
    catch (error) {
        console.error('回答数取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📊 フォームへの回答者一覧を取得する API
// ==========================================
router.get('/api/forms/:id/responses', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    try {
        const { data: responses, error: responseError } = await supabase_1.supabase
            .from('form_response_mappings')
            .select('id, user_id, status, submitted_at, updated_at, content, is_anonymous')
            .eq('form_id', formId)
            .eq('status', 'submitted')
            .order('submitted_at', { ascending: true });
        if (responseError)
            throw responseError;
        if (!responses || responses.length === 0) {
            return res.json([]);
        }
        const userIds = responses.map(r => r.user_id).filter(Boolean);
        const { data: profiles, error: profileError } = await supabase_1.supabase
            .from('basic_profile_info')
            .select('id, name_english, name_kanji, avatar_id')
            .in('id', userIds);
        if (profileError)
            throw profileError;
        // プロフィール情報と、それに対応するアバターの署名付きURLをマッピング
        const profileMap = new Map();
        for (const p of profiles || []) {
            const avatarUrl = await (0, r2_1.resolveAvatarUrl)(p.avatar_id);
            profileMap.set(p.id, { ...p, avatar_link: avatarUrl });
        }
        // 質問一覧を取得して file_upload タイプを特定
        const { data: qData } = await supabase_1.supabase.from('form_question_mappings').select('questions(id, question_type)').eq('form_id', formId);
        const fileQuestionIds = (qData || [])
            .filter((q) => q.questions?.question_type === 'file_upload')
            .map((q) => q.questions.id);
        const result = await Promise.all(responses.map(async (r) => {
            const isAnon = r.is_anonymous;
            const profile = isAnon ? null : profileMap.get(r.user_id);
            const content = { ...(r.content || {}) };
            // ファイルパスを署名付きURLに変換
            for (const qId of fileQuestionIds) {
                if (Array.isArray(content[qId])) {
                    content[qId] = await Promise.all(content[qId].map(async (file) => ({
                        ...file,
                        url: await (0, r2_1.getSignedFileUrl)(file.path),
                        thumbnailUrl: file.thumbnailPath ? await (0, r2_1.getSignedFileUrl)(file.thumbnailPath) : null
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
    }
    catch (error) {
        console.error('回答一覧取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📋 回答IDから詳細を取得する API
// ==========================================
router.get('/api/form-responses/:responseId', authenticate_1.authenticate, async (req, res) => {
    const { responseId } = req.params;
    try {
        // 1. 回答本体を取得
        const { data: response, error: responseError } = await supabase_1.supabase
            .from('form_response_mappings')
            .select('id, form_id, user_id, content, status, submitted_at, is_anonymous')
            .eq('id', responseId)
            .single();
        if (responseError || !response) {
            return res.status(404).json({ error: '回答が見つかりません' });
        }
        const { form_id, user_id, is_anonymous } = response;
        // 2. フォーム情報を取得
        const { data: form } = await supabase_1.supabase
            .from('forms')
            .select('*')
            .eq('id', form_id)
            .single();
        // 3. 質問一覧を取得
        const { data: qLinks, error: qError } = await supabase_1.supabase
            .from('form_question_mappings')
            .select('order_index, is_required, questions(id, title, description, question_type, options)')
            .eq('form_id', form_id)
            .order('order_index', { ascending: true });
        if (qError)
            throw qError;
        // 4. ファイルパスの解決
        const resolvedContent = { ...(response.content || {}) };
        for (const q of (qLinks || [])) {
            const question = q.questions;
            if (question.question_type === 'file_upload' && Array.isArray(resolvedContent[question.id])) {
                resolvedContent[question.id] = await Promise.all(resolvedContent[question.id].map(async (file) => ({
                    ...file,
                    url: await (0, r2_1.getSignedFileUrl)(file.path),
                    thumbnailUrl: file.thumbnailPath ? await (0, r2_1.getSignedFileUrl)(file.thumbnailPath) : null
                })));
            }
        }
        // 5. プロフィール情報の取得
        let profile = null;
        let avatarUrl = null;
        if (!is_anonymous && user_id) {
            const { data: profileData } = await supabase_1.supabase
                .from('basic_profile_info')
                .select('id, name_english, name_kanji, avatar_id')
                .eq('id', user_id)
                .single();
            profile = profileData;
            avatarUrl = await (0, r2_1.resolveAvatarUrl)(profile?.avatar_id || null);
        }
        res.json({
            response_id: response.id,
            form_id: form_id,
            form_title: form?.title || '無題のフォーム',
            form_description: form?.description || '',
            submitted_at: response.submitted_at,
            user: {
                id: user_id,
                name_english: is_anonymous ? '匿名ユーザー' : (profile?.name_english || '不明なユーザー'),
                name_kanji: is_anonymous ? '' : (profile?.name_kanji || ''),
                avatar_link: is_anonymous ? null : avatarUrl,
            },
            questions: (qLinks || []).map(link => {
                const q = link.questions;
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
                    checkboxValidation: q.options?.checkboxValidation || { enabled: false },
                    shortTextMultiple: q.options?.shortTextMultiple || { enabled: false },
                    answer: resolvedContent[q.id] ?? null,
                };
            }),
        });
    }
    catch (error) {
        console.error('回答詳細取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 👥 未回答者一覧を取得する API
// ==========================================
router.get('/api/forms/:id/non-respondents', authenticate_1.authenticate, async (req, res) => {
    const { id: formId } = req.params;
    try {
        // フォームの assigned_user_ids を取得
        const { data: form, error: formError } = await supabase_1.supabase
            .from('forms')
            .select('publish_settings, created_by')
            .eq('id', formId)
            .single();
        if (formError || !form)
            return res.status(404).json({ error: 'フォームが見つかりません' });
        if (form.created_by !== req.user.id)
            return res.status(403).json({ error: '権限がありません' });
        const assignedIds = form.publish_settings?.assigned_user_ids || [];
        if (assignedIds.length === 0)
            return res.json([]);
        // 提出済みの user_id を取得
        const { data: submitted } = await supabase_1.supabase
            .from('form_response_mappings')
            .select('user_id')
            .eq('form_id', formId)
            .eq('status', 'submitted');
        const submittedIds = new Set((submitted || []).map((r) => r.user_id));
        // 未回答者 = assigned - submitted
        const nonRespondentIds = assignedIds.filter(id => !submittedIds.has(id));
        if (nonRespondentIds.length === 0)
            return res.json([]);
        // プロフィール情報を取得
        const { data: profiles } = await supabase_1.supabase
            .from('basic_profile_info')
            .select('id, name_english, name_kanji, avatar_id')
            .in('id', nonRespondentIds);
        const result = await Promise.all((profiles || []).map(async (p) => {
            const avatarUrl = await (0, r2_1.resolveAvatarUrl)(p.avatar_id);
            return { id: p.id, name_english: p.name_english, name_kanji: p.name_kanji, avatar_link: avatarUrl };
        }));
        res.json(result);
    }
    catch (error) {
        console.error('未回答者取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
