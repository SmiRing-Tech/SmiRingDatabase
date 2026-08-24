import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { useIsInternal, getDefaultPathForUser } from '../../hooks/useIsInternal';
import { BASIC_INFO_FIELDS } from '../Profile/basicInfoFields';
import AnswerBox from '../Form/Answer/components/AnswerBox';
import { STAGE_FIELD_KEYS_BY_LABEL } from './stageFields';
import LoadingScreen from '../../components/ui/LoadingScreen';

type StepDef = {
  title: string;
  description: string;
  fieldKeys: string[];
};

// オンボーディングの進捗フラグ（onboarding_completed / onboarding_step）は
// basic_profile_info.metadata (JSONB) に保存する。バックエンド側で既存の
// metadata とマージするので、ここでは差分だけ渡せばよい。
const persistOnboardingMeta = async (metadata: { onboarding_step?: number; onboarding_completed?: boolean }) => {
  const res = await apiClient.patch('/api/basic_profile_info/me', { metadata });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || '保存に失敗しました');
  }
};

function buildSteps(activeStage: string | null): StepDef[] {
  return [
    {
      title: '基本情報',
      description: 'まずはあなたについて教えてください。',
      fieldKeys: ['name_english', 'name_kanji', 'birthday', 'hometown'],
    },
    {
      title: '現在の状況',
      description: '今のあなたに一番近いものを選んでください。',
      fieldKeys: ['active_stage_role_id'],
    },
    {
      title: '留学プロフィール',
      description: '選択に合わせて、詳しく教えてください。',
      fieldKeys: [
        ...(activeStage ? STAGE_FIELD_KEYS_BY_LABEL[activeStage] || [] : []),
        'grade_level',
      ],
    },
    {
      title: 'あなたについて',
      description: 'もう少しだけ、あなたの人柄を聞かせてください。',
      fieldKeys: ['personality', 'important_values', 'future_image'],
    },
  ];
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { onboardingCompleted, refreshPermissions, isPermissionsReady } = useAuth();
  const isInternal = useIsInternal();

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [currentStep, setCurrentStep] = useState(0);
  const [isDone, setIsDone] = useState(false);

  const activeStage: string | null = formData['active_stage_role_id'] || null;
  const steps = useMemo(() => buildSteps(activeStage), [activeStage]);
  const totalSteps = steps.length;

  // ステップが切り替わるたびに、スクロール位置を一番上に戻す
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [currentStep, isDone]);

  useEffect(() => {
    // 権限・オンボーディング状態が判明するまでは判断しない
    // （/onboarding は AppShell の外にある独立ルートなので、直接URLで来た場合に備える）
    if (!isPermissionsReady) return;

    if (onboardingCompleted) {
      navigate(getDefaultPathForUser(isInternal), { replace: true });
      return;
    }

    (async () => {
      try {
        const res = await apiClient.get('/api/basic_profile_info/me');
        if (!res.ok) throw new Error('プロフィールの取得に失敗しました');
        const data = await res.json();
        setFormData(data || {});

        const savedStep = data?.metadata?.onboarding_step;
        setCurrentStep(typeof savedStep === 'number' ? Math.min(Math.max(savedStep, 0), 3) : 0);
      } catch (err: any) {
        setError(err.message || '読み込みに失敗しました');
      } finally {
        setIsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPermissionsReady]);

  const handleChange = (fieldKey: string, value: any) => {
    setFormData(prev => ({ ...prev, [fieldKey]: value }));
  };

  const saveStepAnswers = async (fieldKeys: string[]) => {
    if (fieldKeys.length === 0) return;
    const payload: Record<string, any> = {};
    fieldKeys.forEach(key => {
      payload[key] = formData[key] ?? null;
    });

    const res = await apiClient.patch('/api/basic_profile_info/me', payload);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || '保存に失敗しました');
    }
  };

  const handleNext = async () => {
    setError(null);

    // 各ステップの必須チェック
    if (currentStep === 0 && !formData['name_english']?.trim() && !formData['name_kanji']?.trim()) {
      setError('名前（英語 または 漢字）を入力してください。');
      return;
    }
    if (currentStep === 1 && !formData['active_stage_role_id']) {
      setError('現在の状況を選択してください。');
      return;
    }

    setIsSaving(true);
    try {
      const isLastStep = currentStep === totalSteps - 1;
      const nextStep = isLastStep ? totalSteps : currentStep + 1;
      await saveStepAnswers(steps[currentStep].fieldKeys);

      if (isLastStep) {
        await persistOnboardingMeta({ onboarding_step: nextStep, onboarding_completed: true });
        await refreshPermissions();
        setIsDone(true);
      } else {
        await persistOnboardingMeta({ onboarding_step: nextStep });
        setCurrentStep(nextStep);
      }
    } catch (err: any) {
      setError(err.message || '保存に失敗しました');
    } finally {
      setIsSaving(false);
    }
  };

  const handleBack = async () => {
    if (currentStep === 0 || isSaving) return;
    setError(null);
    const prevStep = currentStep - 1;
    setIsSaving(true);
    try {
      await persistOnboardingMeta({ onboarding_step: prevStep });
      setCurrentStep(prevStep);
    } catch (err: any) {
      setError(err.message || '保存に失敗しました');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) return <LoadingScreen />;

  if (isDone) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-sky-50 flex items-center justify-center mb-5">
            <CheckCircle2 className="w-9 h-9 text-sky-500" />
          </div>
          <h2 className="text-xl font-black text-gray-900 mb-2">ありがとうございます！</h2>
          <p className="text-sm text-gray-500 mb-7 leading-relaxed">
            プロフィールの入力が完了しました。<br />ここからあなたの留学生活を、鮮明に。
          </p>
          <button
            onClick={() => navigate(getDefaultPathForUser(isInternal), { replace: true })}
            className="w-full py-3.5 rounded-xl font-bold text-white text-sm
                       bg-gradient-to-r from-sky-300 to-sky-500
                       hover:from-sky-400 hover:to-sky-600
                       hover:shadow-lg hover:shadow-sky-100
                       active:scale-[0.99]
                       transition-all duration-200 flex items-center justify-center gap-2"
          >
            はじめる
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  const step = steps[currentStep];
  const progressPercent = Math.round(((currentStep) / totalSteps) * 100);

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="w-full max-w-xl mx-auto">
        {/* プログレスバー */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-black text-gray-400 uppercase tracking-wider">
              ステップ {currentStep + 1} / {totalSteps}
            </span>
            <span className="text-[11px] font-black text-sky-500">{progressPercent}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-sky-300 to-sky-500 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* 質問カード群 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 md:p-8">
          <h2 className="text-lg font-black text-gray-900">{step.title}</h2>
          <p className="text-sm text-gray-400 mt-1 mb-6">{step.description}</p>

          <div className="space-y-5">
            {step.fieldKeys.map(fieldKey => {
              const question = BASIC_INFO_FIELDS[fieldKey];
              if (!question) return null;
              return (
                <div key={fieldKey} className="border border-gray-100 rounded-xl p-4 md:p-5 bg-gray-50/50">
                  <h3 className="text-sm font-bold text-gray-700 mb-3">{question.title}</h3>
                  <AnswerBox
                    question={question}
                    answer={formData[fieldKey]}
                    onChange={(value) => handleChange(fieldKey, value)}
                  />
                </div>
              );
            })}
          </div>

          {error && (
            <div className="mt-5 text-sm text-red-500 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          {/* ナビゲーション */}
          <div className="flex items-center justify-between mt-8">
            <button
              type="button"
              onClick={handleBack}
              disabled={currentStep === 0 || isSaving}
              className="py-3 px-4 rounded-xl font-bold text-sm text-gray-500
                         hover:bg-gray-100 disabled:opacity-0 disabled:cursor-not-allowed
                         transition-all duration-200 flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              戻る
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={isSaving}
              className="py-3 px-6 rounded-xl font-bold text-white text-sm
                         bg-gradient-to-r from-sky-300 to-sky-500
                         hover:from-sky-400 hover:to-sky-600
                         hover:shadow-lg hover:shadow-sky-100
                         active:scale-[0.99]
                         disabled:opacity-60 disabled:cursor-not-allowed
                         transition-all duration-200 flex items-center gap-2"
            >
              {isSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  {currentStep === totalSteps - 1 ? '完了' : '次へ'}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
