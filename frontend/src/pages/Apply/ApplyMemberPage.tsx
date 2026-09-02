import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, CheckCircle2, Clock, Loader2, Users } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { useIsInternal, getDefaultPathForUser } from '../../hooks/useIsInternal';
import { CustomDropdown, type DropdownOption } from '../../components/ui/CustomDropdown';

type RequestedRole = 'smiring_member' | 'partner';

interface Department {
  id: string;
  name: string;
  parent_id: string | null;
}

type PageState = 'loading' | 'form' | 'submitted' | 'pending' | 'already_member';

export default function ApplyMemberPage() {
  const navigate = useNavigate();
  const { isLoading: isAuthLoading, session } = useAuth();
  const isInternal = useIsInternal();

  const [pageState, setPageState] = useState<PageState>('loading');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [requestedRole, setRequestedRole] = useState<RequestedRole>('smiring_member');
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!session) {
      navigate('/sign-in', { state: { from: { pathname: '/apply-member' } } });
      return;
    }

    (async () => {
      try {
        const [statusRes, deptRes] = await Promise.all([
          apiClient.get('/api/role-requests/me'),
          apiClient.get('/api/role-requests/departments'),
        ]);

        if (deptRes.ok) {
          setDepartments(await deptRes.json());
        }

        if (statusRes.ok) {
          const data = await statusRes.json();
          if (data.status === 'already_member') {
            setPageState('already_member');
          } else if (data.status === 'pending') {
            setPageState('pending');
          } else {
            setPageState('form');
          }
        } else {
          setPageState('form');
        }
      } catch {
        setPageState('form');
      }
    })();
  }, [isAuthLoading, session, navigate]);

  const departmentOptions = useMemo<DropdownOption[]>(() => {
    return departments.map(d => ({ label: d.name, value: d.id }));
  }, [departments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (requestedRole === 'smiring_member' && departmentIds.length === 0) {
      setError('希望する部署を1つ以上選択してください。');
      return;
    }
    if (requestedRole === 'partner' && !description.trim()) {
      setError('どのように関わっているか・関わりたいかを入力してください。');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await apiClient.post('/api/role-requests', {
        requestedRole,
        departmentIds: requestedRole === 'smiring_member' ? departmentIds : undefined,
        description: requestedRole === 'partner' ? description.trim() : undefined,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '送信に失敗しました');
      }

      setPageState('submitted');
    } catch (err: any) {
      setError(err.message || '送信に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
      </div>
    );
  }

  const goHome = () => navigate(getDefaultPathForUser(isInternal), { replace: true });

  if (pageState === 'already_member') {
    return (
      <StatusCard
        icon={<CheckCircle2 className="w-9 h-9 text-emerald-500" />}
        iconBg="bg-emerald-50"
        title="すでに承認済みです"
        message={<>あなたはすでにSmiRingの内部運営メンバー／協力者として登録されています。</>}
        onHome={goHome}
      />
    );
  }

  if (pageState === 'pending' || pageState === 'submitted') {
    return (
      <StatusCard
        icon={<Clock className="w-9 h-9 text-sky-500" />}
        iconBg="bg-sky-50"
        title={pageState === 'submitted' ? '申請を送信しました' : 'すでに申請済みです'}
        message={<>管理者の承認をお待ちください。承認されると、SmiRing内部運営メンバー（または協力者）としての機能が使えるようになります。</>}
        onHome={goHome}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="w-full max-w-xl mx-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 md:p-8">
          <h1 className="text-lg font-black text-gray-900">SmiRingメンバー申請</h1>
          <p className="text-sm text-gray-400 mt-1 mb-6">
            SmiRingの運営に関わっている方・関わりたい方はこちらから申請してください。
          </p>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* 区分選択 */}
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-gray-700">申請区分</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <RoleOptionCard
                  icon={<Users className="w-5 h-5" />}
                  label="SmiRing内部運営メンバー"
                  description="SmiRingの運営チームの一員として活動しています"
                  selected={requestedRole === 'smiring_member'}
                  onClick={() => setRequestedRole('smiring_member')}
                />
                <RoleOptionCard
                  icon={<Building2 className="w-5 h-5" />}
                  label="外部協力者"
                  description="団体外から特定の形でSmiRingに関わっています"
                  selected={requestedRole === 'partner'}
                  onClick={() => setRequestedRole('partner')}
                />
              </div>
            </div>

            {requestedRole === 'smiring_member' ? (
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-gray-700">希望部署（複数選択可）</h3>
                <CustomDropdown
                  multiple
                  searchable
                  options={departmentOptions}
                  value={departmentIds}
                  onChange={setDepartmentIds}
                  placeholder="部署を選択"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-gray-700">どのように関わっていますか？</h3>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={4}
                  placeholder="例: 留学祭のスポンサー窓口を担当しています"
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm
                             focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 focus:bg-white
                             transition-all duration-200 placeholder:text-gray-300 resize-none"
                />
              </div>
            )}

            {error && (
              <div className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3.5 rounded-xl font-bold text-white text-sm
                         bg-gradient-to-r from-sky-300 to-sky-500
                         hover:from-sky-400 hover:to-sky-600
                         hover:shadow-lg hover:shadow-sky-100
                         active:scale-[0.99]
                         disabled:opacity-60 disabled:cursor-not-allowed
                         transition-all duration-200 flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  申請する
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function RoleOptionCard({ icon, label, description, selected, onClick }: {
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-4 rounded-xl border transition-all duration-200 ${
        selected
          ? 'border-sky-400 bg-sky-50/60 ring-2 ring-sky-500/20'
          : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-2 ${selected ? 'bg-sky-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
        {icon}
      </div>
      <div className="text-sm font-bold text-gray-800">{label}</div>
      <div className="text-xs text-gray-400 mt-1 leading-relaxed">{description}</div>
    </button>
  );
}

function StatusCard({ icon, iconBg, title, message, onHome }: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  message: React.ReactNode;
  onHome: () => void;
}) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
        <div className={`mx-auto w-16 h-16 rounded-full ${iconBg} flex items-center justify-center mb-5`}>
          {icon}
        </div>
        <h2 className="text-xl font-black text-gray-900 mb-2">{title}</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-7">{message}</p>
        <button
          onClick={onHome}
          className="w-full py-3.5 rounded-xl font-bold text-white text-sm
                     bg-gradient-to-r from-sky-300 to-sky-500
                     hover:from-sky-400 hover:to-sky-600
                     hover:shadow-lg hover:shadow-sky-100
                     active:scale-[0.99]
                     transition-all duration-200 flex items-center justify-center gap-2"
        >
          ホームに戻る
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
