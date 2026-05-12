import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { apiClient } from '../../lib/apiClient';
import HomeSearchBar from '../Search/SearchBar';
import PhotoViewModal from '../../components/ui/PhotoViewModal';
import { 
  Users, 
  Image as ImageIcon, 
  FilePlus, 
  MapPin, 
  School, 
  PartyPopper, 
  CheckCircle2, 
  Clock, 
  Timer,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { useFeedback } from '../../context/FeedbackContext';

export default function HomePage() {
  const navigate = useNavigate();
  const { showFeedback, hideFeedback } = useFeedback();

  useEffect(() => {
    let timer3s: any;
    let timer15s: any;
    let isMounted = true;
    let retryTimeout: any;
    let wasServerDown = false; // 🌟 サーバーが落ちていたかどうかのフラグ

    const checkServer = async () => {
      // 3秒経過しても応答がない場合に「起動中」を表示
      timer3s = setTimeout(() => {
        if (isMounted) {
          showFeedback('サーバー起動中...。10秒程度お待ちください。', {
            mode: 'banner',
            type: 'info',
            duration: 60000
          });
        }
      }, 3000);

      // 15秒経過しても応答がない場合にメッセージを更新
      timer15s = setTimeout(() => {
        if (isMounted) {
          showFeedback('時間がかかっています。ページを更新するか、Techチームにお問い合わせください。', {
            mode: 'banner',
            type: 'warning',
            duration: 60000
          });
        }
      }, 15000);

      const ping = async () => {
        if (!isMounted) return;
        try {
          const res = await apiClient.get('/api/basic_profile_info/me');
          
          if (res.status >= 500) {
            throw new Error(`Server not ready: ${res.status}`);
          }
          
          if (isMounted) {
            clearTimeout(timer3s);
            clearTimeout(timer15s);
            hideFeedback();
            
            // 🌟 サーバーが一度でも落ちていた場合のみ、復帰イベントを発火！
            if (wasServerDown) {
              console.log('[HealthCheck] Server recovered. Dispatching refetch event...');
              window.dispatchEvent(new CustomEvent('server-ready'));
            }
          }
        } catch (err) {
          wasServerDown = true; // 🌟 エラーを検知したのでフラグを立てる
          if (isMounted) {
            retryTimeout = setTimeout(ping, 2000);
          }
        }
      };

      ping();
    };

    checkServer();

    return () => {
      isMounted = false;
      clearTimeout(timer3s);
      clearTimeout(timer15s);
      clearTimeout(retryTimeout);
    };
  }, [showFeedback, hideFeedback]);

  return (
    <div className="h-full w-full overflow-y-auto bg-white text-gray-900 scroll-smooth">
      <div className="flex flex-col lg:flex-row min-h-full">
        {/* --- 左側（メインコンテンツ） --- */}
        <div className="flex-1 min-w-0 p-6 md:p-10">
          <div className="flex justify-center mb-12">
            <img
              src="/assets/images/smiring_logo_side_by_side.png"
              alt="SmiRing Logo"
              className="max-w-[600px] w-full object-contain"
            />
          </div>

          <HomeSearchBar />
          <HomeQuickActionButtons />

          <ProfilesSection onClickMore={() => navigate('/members')} />

          <PhotoGallerySection onClickMore={() => navigate('/gallery')} />
        </div>

        {/* --- 右側：サイドパネル --- */}
        <div className="w-full shrink-0 lg:w-[320px] xl:w-[380px] bg-gray-50 border-t lg:border-t-0 lg:border-l border-gray-200">
          <RightPanel />
        </div>
      </div>
    </div>
  );
}

// ==========================================
// サブコンポーネント群
// ==========================================

function HomeQuickActionButtons() {
  const navigate = useNavigate();

  const handleCreateNewForm = () => {
    const newFormId = crypto.randomUUID();
    navigate(`/form-editor/${newFormId}`);
  };

  return (
    <div className="flex justify-center gap-3 sm:gap-4 mb-12 w-full">
      <QuickActionButton
        label="Members"
        onClick={() => navigate('/members')}
        icon={<Users className="w-5 h-5 text-blue-600" />}
      />
      <QuickActionButton
        label="Gallery"
        onClick={() => navigate('/gallery')}
        icon={<ImageIcon className="w-5 h-5 text-blue-600" />}
      />
      <QuickActionButton
        label="Create Form"
        onClick={() => handleCreateNewForm()}
        icon={<FilePlus className="w-5 h-5 text-blue-600" />}
      />
    </div>
  );
}

function QuickActionButton({ label, icon, onClick }: { label: string, icon: React.ReactNode, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 max-w-[200px] flex items-center justify-center gap-2 px-3 sm:px-6 py-3 bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:bg-blue-50 hover:border-blue-200 transition-all text-gray-700 font-bold"
      title={label} // スマホでアイコンだけになった時のためにtitleをつけておく
    >
      {icon}
      <span className="hidden sm:inline truncate">{label}</span>
    </button>
  );
}

function ProfilesSection({ onClickMore }: { onClickMore: () => void }) {
  const navigate = useNavigate();
  const [members, setMembers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMembers = () => {
    setIsLoading(true);
    apiClient.get('/api/basic_profile_info')
      .then(r => r.json())
      .then((data: any[]) => {
        const sorted = [...data].sort((a, b) =>
          new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime()
        );
        setMembers(sorted);
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    fetchMembers();
    window.addEventListener('server-ready', fetchMembers);
    return () => window.removeEventListener('server-ready', fetchMembers);
  }, []);

  return (
    <div className="mb-12">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold m-0">Profiles</h2>
        <button className="bg-none border-none text-blue-700 cursor-pointer text-sm hover:text-blue-900 font-bold" onClick={onClickMore}>
          もっと見る
        </button>
      </div>
      <div className="flex space-x-4 overflow-x-auto pb-4">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="w-[190px] flex-shrink-0 animate-pulse">
                <div className="aspect-square w-full bg-gray-200 rounded-xl mb-2" />
                <div className="h-3 bg-gray-200 rounded w-3/4 mx-auto" />
              </div>
            ))
          : members.slice(0, 10).map(m => (
              <button
                key={m.id}
                onClick={() => navigate(`/members/${m.id}`)}
                className="w-[190px] flex-shrink-0 text-left group focus:outline-none"
              >
                <div className="aspect-square w-full bg-gray-100 rounded-xl overflow-hidden mb-2 shadow-sm group-hover:shadow-md transition-shadow">
                  <img
                    src={m.avatar_link || '/assets/images/profile_photo_empty.png'}
                    alt={m.name_english || ''}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </div>
                <p className="text-sm font-bold text-gray-800 truncate px-1 group-hover:text-blue-700 transition-colors">
                  {m.name_english || m.name_kanji || 'No Name'}
                </p>
                <p className="text-[11px] text-gray-400 truncate px-1">
                  {m.current_school || m.study_abroad_country || ''}
                </p>
              </button>
            ))
        }
      </div>
    </div>
  );
}

function PhotoGallerySection({ onClickMore }: { onClickMore: () => void }) {
  const [photos, setPhotos] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<any | null>(null);
  const { user } = useAuth();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const fetchPhotos = async () => {
    try {
      setIsLoading(true);
      if (user) setCurrentUserId(user.id);

      const response = await apiClient.get('/api/gallery');
      if (response.ok) {
        const data = await response.json();
        setPhotos(data);
      }
    } catch (error) {
      console.error('ギャラリーの取得に失敗:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPhotos();
    window.addEventListener('server-ready', fetchPhotos);
    return () => window.removeEventListener('server-ready', fetchPhotos);
  }, []);

  return (
    <div className="mb-12">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold m-0 flex items-center gap-2">
          Photo Gallery
        </h2>
        <button className="bg-none border-none text-blue-700 cursor-pointer text-sm hover:text-blue-900 font-bold" onClick={onClickMore}>
          もっと見る
        </button>
      </div>
      <div className="flex space-x-4 overflow-x-auto pb-4 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="w-[190px] flex-shrink-0">
              <div className="aspect-square w-full bg-gray-200 rounded-xl animate-pulse" />
            </div>
          ))
        ) : photos.length > 0 ? (
          photos.map((photo) => (
            <div key={photo.id} className="w-[190px] flex-shrink-0">
              <div 
                className="aspect-square w-full bg-gray-100 rounded-xl overflow-hidden cursor-pointer group shadow-sm hover:shadow-md transition-all"
                onClick={() => {
                  setSelectedPhoto(photo);
                  setViewModalOpen(true);
                }}
              >
                <img
                  src={photo.thumbnail_url || photo.view_url}
                  alt={photo.image_type || '写真'}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  loading="lazy"
                />
              </div>
            </div>
          ))
        ) : (
          <div className="w-full py-8 text-center text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-xl">
            まだ写真がありません
          </div>
        )}
      </div>

      <PhotoViewModal
        isOpen={viewModalOpen}
        imageUrl={selectedPhoto?.view_url ?? null}
        description={selectedPhoto?.description}
        isOwner={selectedPhoto?.user_id === currentUserId}
        photo={selectedPhoto}
        onPhotoUpdated={fetchPhotos}
        onPhotoDeleted={fetchPhotos}
        onClose={() => setViewModalOpen(false)}
      />
    </div>
  );
}

function RightPanel() {
  const navigate = useNavigate();
  return (
    <div className="p-6 md:p-8 flex flex-col h-full">
      <UserProfileCard />
      <h3 className="text-xl font-bold m-0 mb-3 text-gray-800">Calendar</h3>
      <MiniCalendar />
      <div className="flex justify-between items-center mt-8 mb-3">
        <h3 className="text-xl font-bold m-0 text-gray-800">My Forms</h3>
        <button
          onClick={() => navigate('/form-list')}
          className="text-sm font-bold text-blue-600 hover:text-blue-800 transition-colors"
        >
          もっと見る
        </button>
      </div>
      <MyRecentForms />
      <h3 className="text-xl font-bold m-0 mb-3 mt-8 text-gray-800">Timeline</h3>
      <div>
        <AssignedFormsTimeline />
      </div>
    </div>
  );
}

function MiniCalendar() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [isSelectingMonth, setIsSelectingMonth] = useState(false);
  const [unansweredDueDates, setUnansweredDueDates] = useState<string[]>([]);

  const fetchDueDates = async () => {
    try {
      const response = await apiClient.get('/api/assigned-forms');
      if (!response.ok) return;

      const formsData = await response.json();
      
      // バックエンドで判定済みの is_submitted を使用
      const dueDates = formsData
        .filter((f: any) => f.due_date && !f.is_submitted)
        .map((f: any) => f.due_date as string);

      setUnansweredDueDates(dueDates);
    } catch (e) {
      console.error('カレンダー用期限の取得に失敗:', e);
    }
  };

  useEffect(() => {
    fetchDueDates();
    window.addEventListener('server-ready', fetchDueDates);
    return () => window.removeEventListener('server-ready', fetchDueDates);
  }, []);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const days = Array.from({ length: 42 }, (_, i) => {
    const dayNum = i - firstDay + 1;
    return dayNum > 0 && dayNum <= daysInMonth ? dayNum : null;
  });

  const handlePrevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const handleNextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  if (isSelectingMonth) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm h-[280px] flex flex-col">
        <div className="flex justify-between items-center mb-4 px-2">
          <input
            type="number"
            value={year}
            onChange={(e) => setCurrentDate(new Date(Number(e.target.value), month, 1))}
            className="w-20 font-bold text-gray-800 border-b-2 border-blue-500 focus:outline-none text-center"
          />
          <button
            onClick={() => setIsSelectingMonth(false)}
            className="text-xs font-bold bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full hover:bg-gray-200"
          >
            完了
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 flex-1">
          {monthNames.map((m, i) => (
            <button
              key={m}
              onClick={() => { setCurrentDate(new Date(year, i, 1)); setIsSelectingMonth(false); }}
              className={`text-sm font-medium rounded-lg transition-colors ${i === month ? 'bg-blue-600 text-white' : 'hover:bg-blue-50 text-gray-700'}`}
            >
              {m.substring(0, 3)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div className="flex justify-between items-center mb-4 px-2">
        <button
          onClick={() => setIsSelectingMonth(true)}
          className="font-bold text-gray-800 hover:text-blue-600 transition-colors"
        >
          {monthNames[month]} {year}
        </button>
        <div className="flex gap-2">
          <button onClick={handlePrevMonth} className="text-gray-400 hover:text-blue-600 p-1"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={handleNextMonth} className="text-gray-400 hover:text-blue-600 p-1"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-bold text-gray-400 mb-2">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-sm">
        {days.map((day, index) => {
          const isToday = day === new Date().getDate() && month === new Date().getMonth() && year === new Date().getFullYear();
          const hasDue = day != null && unansweredDueDates.some(ds => {
            const d = new Date(ds);
            return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
          });
          return (
            <div
              key={index}
              className={`py-1 rounded-full flex flex-col items-center justify-center cursor-default transition-colors
                ${day && !isToday ? 'hover:bg-gray-100 text-gray-700' : ''}
                ${isToday ? 'bg-blue-600 text-white font-bold hover:bg-blue-700 shadow-sm' : ''}
              `}
            >
              <span className="leading-none text-sm">{day || ''}</span>
              <span className={`mt-0.5 w-1 h-1 rounded-full flex-shrink-0 ${
                day && hasDue
                  ? (isToday ? 'bg-white' : 'bg-red-500')
                  : 'invisible'
              }`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UserProfileCard() {
  const navigate = useNavigate();
  const [profileData, setProfileData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMyProfile = async () => {
    try {
      setIsLoading(true);
      const response = await apiClient.get('/api/basic_profile_info/me');

      if (response.ok) {
        const data = await response.json();
        setProfileData(data);
      }
    } catch (error) {
      console.error('プロフィールの取得に失敗しました:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMyProfile();
    window.addEventListener('server-ready', fetchMyProfile);
    return () => window.removeEventListener('server-ready', fetchMyProfile);
  }, []);

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl p-4 flex items-center shadow-sm border border-gray-100 mb-6 h-28 animate-pulse">
        <div className="w-20 h-20 rounded-xl bg-gray-200 mr-4 flex-shrink-0"></div>
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-gray-200 rounded w-1/2"></div>
          <div className="h-3 bg-gray-200 rounded w-1/3"></div>
        </div>
      </div>
    );
  }
  const displayName = profileData?.name_english || 'No Name';
  const country = profileData?.study_abroad_country || '未設定';
  const school = profileData?.current_school || '未設定';
  const avatarUrl = profileData?.avatar_link && profileData.avatar_link !== ''
    ? profileData.avatar_link
    : '/assets/images/profile_photo_empty.png';

  return (
    <div
      className="bg-white rounded-xl p-4 flex items-center shadow-sm border border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors duration-200 mb-6"
      onClick={() => navigate('/profile')}
    >
      <img src={avatarUrl} alt="Profile" className="w-20 h-20 rounded-xl object-cover bg-gray-100 mr-4 flex-shrink-0 border border-gray-200" />
      <div className="flex-1 overflow-hidden">
        <h4 className="text-lg font-bold text-gray-900 m-0 mb-2 truncate">{displayName}</h4>
        <p className="text-xs text-gray-600 m-0 mb-1 flex items-center gap-1.5 truncate">
          <MapPin className="w-3 h-3 text-gray-400" />
          {country}
        </p>
        <p className="text-xs text-gray-600 m-0 mb-1 flex items-center gap-1.5 truncate">
          <School className="w-3 h-3 text-gray-400" />
          {school}
        </p>
      </div>
    </div>
  );
}

function MyRecentForms() {
  const navigate = useNavigate();
  const [recentForms, setRecentForms] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchRecentForms = async () => {
    try {
      setIsLoading(true);
      const response = await apiClient.get('/api/my-forms');

      if (response.ok) {
        const data = await response.json();
        setRecentForms(data.slice(0, 3));
      }
    } catch (error) {
      console.error('フォームの取得に失敗しました:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecentForms();
    window.addEventListener('server-ready', fetchRecentForms);
    return () => window.removeEventListener('server-ready', fetchRecentForms);
  }, []);

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-3/4"></div>
        <div className="h-4 bg-gray-100 rounded w-1/2"></div>
      </div>
    );
  }

  if (recentForms.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 text-center text-gray-500 text-sm shadow-sm">
        まだフォームはありません
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm flex flex-col">
      <ul className="divide-y divide-gray-100">
        {recentForms.map((form) => (
          <li
            key={form.id}
            onClick={() => navigate(`/form-editor/${form.id}`)}
            className="p-3 hover:bg-blue-50 cursor-pointer transition-colors flex justify-between items-center group"
          >
            <div className="overflow-hidden flex-1 pr-2">
              <h4 className="text-sm font-bold text-gray-800 m-0 truncate group-hover:text-blue-700 transition-colors">
                {form.title || '無題のフォーム'}
              </h4>
              <p className="text-[10px] text-gray-400 mt-1">
                更新: {new Date(form.updated_at).toLocaleDateString()}
              </p>
            </div>
            <div className={`text-[10px] font-bold px-2 py-1 rounded-md flex-shrink-0 ${form.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
              }`}>
              {form.status === 'published' ? '公開中' : '下書き'}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssignedFormsTimeline() {
  const navigate = useNavigate();
  const [assignedForms, setAssignedForms] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAssignedForms = async () => {
    try {
      setIsLoading(true);
      const response = await apiClient.get('/api/assigned-forms');

      if (response.ok) {
        const formsData = await response.json();

        const sorted = formsData.sort((a: any, b: any) => {
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
        });

        setAssignedForms(sorted);
      }
    } catch (error) {
      console.error('アサインフォームの取得に失敗:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAssignedForms();
    window.addEventListener('server-ready', fetchAssignedForms);
    return () => window.removeEventListener('server-ready', fetchAssignedForms);
  }, []);

  const handleFormClick = (id: string) => {
    navigate(`/form-answer/${id}`);
  };

  if (isLoading) {
    return (
      <div className="p-4 space-y-6 animate-pulse">
        <div className="flex gap-4"><div className="w-4 h-4 bg-gray-200 rounded-full" /><div className="h-4 bg-gray-200 rounded w-3/4" /></div>
        <div className="flex gap-4"><div className="w-4 h-4 bg-gray-200 rounded-full" /><div className="h-4 bg-gray-200 rounded w-1/2" /></div>
      </div>
    );
  }

  if (assignedForms.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 border-dashed p-8 text-center shadow-sm">
        <PartyPopper className="w-10 h-10 text-gray-300 mx-auto mb-2" />
        <p className="text-gray-500 font-bold text-sm">現在アサインされている<br />タスクはありません！</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div className="flex flex-col space-y-4">
        {assignedForms.map((form, index) => {
          const isSubmitted = form.is_submitted;
          const isOverdue = !isSubmitted && form.due_date && new Date(form.due_date) < new Date();
          const isSoon = !isSubmitted && form.due_date && (new Date(form.due_date).getTime() - new Date().getTime()) / (1000 * 3600 * 24) <= 3;

          return (
            <div
              key={form.id}
              className={`flex items-start group cursor-pointer transition-all ${isSubmitted ? 'opacity-60 hover:opacity-100' : ''}`}
              onClick={() => handleFormClick(form.id)}
            >
              <div className="flex flex-col items-center mr-4 mt-1 flex-shrink-0">
                <div className={`w-3.5 h-3.5 rounded-full border-2 transition-colors flex items-center justify-center ${isSubmitted ? 'border-green-500 bg-green-50' :
                    isOverdue ? 'border-red-500 bg-red-100' :
                      isSoon ? 'border-orange-500 bg-orange-100' :
                        'border-blue-500 bg-blue-100'
                  }`}>
                  {isSubmitted && <CheckCircle2 className="w-2.5 h-2.5 text-green-600" />}
                </div>
                {index !== assignedForms.length - 1 && (
                  <div className="w-[2px] h-12 bg-gray-100 mt-2"></div>
                )}
              </div>

              <div className={`flex-1 rounded-lg p-3 transition-colors border border-transparent 
                ${isSubmitted ? 'bg-gray-50/50' : 'bg-gray-50 group-hover:bg-blue-50 group-hover:border-blue-100'}
              `}>
                <h5 className={`font-bold text-sm m-0 mb-1 transition-colors ${isSubmitted ? 'text-gray-400 line-through' : 'text-gray-800 group-hover:text-blue-800'
                  }`}>
                  {form.title || '無題のフォーム'}
                </h5>

                <div className="flex items-center gap-2 text-[11px] font-bold">
                  {isSubmitted ? (
                    <span className="text-green-600 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3 h-3" />
                      回答済み
                    </span>
                  ) : form.due_date ? (
                    <span className={`flex items-center gap-1.5 ${isOverdue ? 'text-red-600' : isSoon ? 'text-orange-600' : 'text-gray-500'}`}>
                      <Clock className="w-3 h-3" />
                      期限: {new Date(form.due_date).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} {isOverdue && '(期限切れ)'}
                    </span>
                  ) : (
                    <span className="text-gray-400 flex items-center gap-1.5">
                      <Timer className="w-3 h-3" />
                      期限なし
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}