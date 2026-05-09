import { useState, useEffect } from 'react';
import { Mail, Lock, Shield, Bell, Globe, Trash2, ChevronRight, Download } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../../config';

// ─── 共通コンポーネント ────────────────────────────────
function SectionCard({ title, icon, children }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 bg-gray-50/60">
        <span className="text-gray-500">{icon}</span>
        <h3 className="font-bold text-gray-700 text-sm">{title}</h3>
      </div>
      <div className="divide-y divide-gray-100">
        {children}
      </div>
    </div>
  );
}

function SettingRow({ label, description, action, danger }: {
  label: string;
  description?: string;
  action: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${danger ? 'text-red-600' : 'text-gray-800'}`}>{label}</p>
        {description && <p className="text-xs text-gray-400 mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{action}</div>
    </div>
  );
}

function ComingSoonBadge() {
  return (
    <span className="text-xs font-bold bg-amber-100 text-amber-600 border border-amber-200 px-2 py-0.5 rounded-full">
      準備中
    </span>
  );
}

function FeedbackMsg({ msg }: { msg: { type: 'success' | 'error'; text: string } | null }) {
  if (!msg) return null;
  return (
    <p className={`text-xs mt-2 font-medium ${msg.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
      {msg.text}
    </p>
  );
}

// ─── メインコンポーネント ─────────────────────────────
export default function AccountSettingTab({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();

  // --- 現在のメールアドレス ---
  const [currentEmail, setCurrentEmail] = useState('');
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentEmail(session?.user?.email ?? '');
    });
  }, []);

  // --- メールアドレス変更 ---
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleEmailUpdate = async () => {
    if (!newEmail || newEmail === currentEmail) return;
    setEmailLoading(true);
    setEmailMsg(null);
    try {
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) throw error;
      setEmailMsg({ type: 'success', text: `${newEmail} に確認メールを送信しました。メール内のリンクを踏むと変更が完了します。` });
      setNewEmail('');
      setIsEditingEmail(false);
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.message || 'メールアドレスの更新に失敗しました。' });
    } finally {
      setEmailLoading(false);
    }
  };

  // --- パスワードリセット ---
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSendResetEmail = async () => {
    if (!currentEmail) return;
    setPasswordLoading(true);
    setPasswordMsg(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(currentEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setPasswordMsg({ type: 'success', text: `${currentEmail} にパスワードリセットメールを送信しました。` });
    } catch (err: any) {
      setPasswordMsg({ type: 'error', text: err.message || 'メールの送信に失敗しました。' });
    } finally {
      setPasswordLoading(false);
    }
  };

  // --- アカウント削除 ---
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return;
    setDeleteLoading(true);
    setDeleteMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('認証情報がありません');

      const res = await fetch(`${API_BASE_URL}/api/account/me`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'アカウントの削除に失敗しました');
      }

      // 削除成功 → ローカルセッションも削除してサインイン画面へ
      await supabase.auth.signOut();
      navigate('/sign-in');
    } catch (err: any) {
      setDeleteMsg({ type: 'error', text: err.message || 'アカウントの削除に失敗しました。' });
      setDeleteLoading(false);
    }
  };

  return (
    <div className="p-4 md:p-10 space-y-6 animate-in fade-in duration-300">
      <div className="max-w-2xl space-y-6">

        {/* ── 戻るボタン ── */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors mb-10"
        >
          <ChevronRight className="w-4 h-4 rotate-180" />
          プロフィールに戻る
        </button>

        {/* ── 1. メールアドレス ── */}
        <SectionCard title="メールアドレス" icon={<Mail className="w-4 h-4" />}>
          <SettingRow
            label="現在のメールアドレス"
            description={currentEmail || '読み込み中...'}
            action={
              <button
                onClick={() => { setIsEditingEmail(!isEditingEmail); setEmailMsg(null); }}
                className="flex items-center gap-1 text-sm text-blue-600 font-medium hover:text-blue-700 transition-colors"
              >
                変更 <ChevronRight className="w-4 h-4" />
              </button>
            }
          />

          {isEditingEmail && (
            <div className="px-5 py-4 bg-blue-50/50 space-y-3">
              <p className="text-xs text-gray-500">新しいメールアドレスを入力してください。確認メールが送信されます。</p>
              <input
                type="email"
                placeholder="new@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleEmailUpdate}
                  disabled={!newEmail || newEmail === currentEmail || emailLoading}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {emailLoading ? '送信中...' : '確認メールを送る'}
                </button>
                <button
                  onClick={() => { setIsEditingEmail(false); setNewEmail(''); setEmailMsg(null); }}
                  className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
          {emailMsg && (
            <div className="px-5 pb-4">
              <FeedbackMsg msg={emailMsg} />
            </div>
          )}
        </SectionCard>

        {/* ── 2. パスワード ── */}
        <SectionCard title="パスワード" icon={<Lock className="w-4 h-4" />}>
          <div className="px-5 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800">パスワードをリセット</p>
                <p className="text-xs text-gray-400 mt-0.5">登録済みのメールアドレスにリセットリンクを送信します</p>
              </div>
              <button
                onClick={handleSendResetEmail}
                disabled={passwordLoading || !currentEmail}
                className="flex-shrink-0 px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 disabled:opacity-50 transition-colors"
              >
                {passwordLoading ? '送信中...' : 'メールを送る'}
              </button>
            </div>
            <FeedbackMsg msg={passwordMsg} />
          </div>
        </SectionCard>

        {/* ── 3. セキュリティ (Coming Soon) ── */}
        <SectionCard title="セキュリティ" icon={<Shield className="w-4 h-4" />}>
          <SettingRow
            label="2段階認証"
            description="認証アプリやSMSを使ってアカウントを保護する"
            action={<ComingSoonBadge />}
          />
          <SettingRow
            label="ログイン中の端末"
            description="現在ログインしているすべてのセッションを確認・管理する"
            action={<ComingSoonBadge />}
          />
          <SettingRow
            label="ログイン履歴"
            description="過去のサインイン履歴を確認する"
            action={<ComingSoonBadge />}
          />
        </SectionCard>

        {/* ── 4. 通知設定 (Coming Soon) ── */}
        <SectionCard title="通知" icon={<Bell className="w-4 h-4" />}>
          <SettingRow
            label="メール通知"
            description="フォームへの回答や重要なお知らせをメールで受け取る"
            action={<ComingSoonBadge />}
          />
        </SectionCard>

        {/* ── 5. プライバシー (Coming Soon) ── */}
        <SectionCard title="プライバシー" icon={<Globe className="w-4 h-4" />}>
          <SettingRow
            label="プロフィールの公開設定"
            description="他のメンバーに自分のプロフィールを表示するかどうか"
            action={<ComingSoonBadge />}
          />
        </SectionCard>

        {/* ── 6. データ管理 (Coming Soon) ── */}
        <SectionCard title="データ管理" icon={<Download className="w-4 h-4" />}>
          <SettingRow
            label="データをエクスポート"
            description="自分のプロフィールと回答履歴をJSON形式でダウンロードする"
            action={<ComingSoonBadge />}
          />
          <SettingRow
            label="言語設定"
            description="アプリの表示言語を変更する"
            action={<ComingSoonBadge />}
          />
        </SectionCard>

        {/* ── 7. Danger Zone ── */}
        <div className="bg-white rounded-xl border border-red-200 shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-red-100 bg-red-50/60">
            <Trash2 className="w-4 h-4 text-red-500" />
            <h3 className="font-bold text-red-600 text-sm">危険な操作</h3>
          </div>
          <div className="px-5 py-5 space-y-4">
            <div>
              <p className="text-sm font-medium text-gray-800">アカウントを削除する</p>
              <p className="text-xs text-gray-400 mt-0.5">
                アカウントとすべてのデータは完全に削除されます。この操作は取り消せません。
              </p>
            </div>

            {!isDeletingAccount ? (
              <button
                onClick={() => setIsDeletingAccount(true)}
                className="px-4 py-2 text-sm text-red-600 border border-red-300 rounded-lg font-medium hover:bg-red-50 transition-colors"
              >
                アカウントを削除する
              </button>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-3">
                <p className="text-sm text-red-700 font-medium">
                  本当に削除しますか？確認のため「DELETE」と入力してください。
                </p>
                <input
                  type="text"
                  placeholder="DELETE"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-red-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400 bg-white"
                />
                <FeedbackMsg msg={deleteMsg} />
                <div className="flex gap-2">
                  <button
                    onClick={handleDeleteAccount}
                    disabled={deleteConfirmText !== 'DELETE' || deleteLoading}
                    className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {deleteLoading ? '削除中...' : '完全に削除する'}
                  </button>
                  <button
                    onClick={() => { setIsDeletingAccount(false); setDeleteConfirmText(''); setDeleteMsg(null); }}
                    disabled={deleteLoading}
                    className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
