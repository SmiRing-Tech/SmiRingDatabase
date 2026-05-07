import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';
import { 
  UserCircle, 
  User, 
  Image as ImageIcon, 
  Calendar, 
  Trophy, 
  GraduationCap, 
  Utensils, 
  Sun, 
  MoreHorizontal,
} from 'lucide-react';

type Props = {
  searchQuery: string;
  setSearchQuery: (val: string) => void;
  filterType: string[];
  setFilterType: (val: string[]) => void;
  filterPerson: string[];
  setFilterPerson: (val: string[]) => void;
  photos: any[];
  isOpen?: boolean;
  onClose?: () => void;
  onClear: () => void;
};

export default function GallerySidebar({
  searchQuery,
  setSearchQuery,
  filterType,
  setFilterType,
  filterPerson,
  setFilterPerson,
  photos,
  isOpen = false,
  onClose,
  onClear,
}: Props) {
  const isFiltered = searchQuery !== '' || filterType.length > 0 || filterPerson.length > 0;

  // 種類フィルターのオプション定義（'all'を削除し、空配列を「すべて」として扱う）
  const typeOptions: DropdownOption[] = [
    { value: "avatar", label: "アバター", icon: <UserCircle className="w-4 h-4" /> },
    { value: "portrait", label: "人物", icon: <User className="w-4 h-4" /> },
    { value: "landscape", label: "風景", icon: <ImageIcon className="w-4 h-4" /> },
    { value: "event", label: "イベント", icon: <Calendar className="w-4 h-4" /> },
    { value: "extracurricular", label: "課外活動", icon: <Trophy className="w-4 h-4" /> },
    { value: "academic", label: "学業", icon: <GraduationCap className="w-4 h-4" /> },
    { value: "food", label: "食事", icon: <Utensils className="w-4 h-4" /> },
    { value: "daily", label: "日常", icon: <Sun className="w-4 h-4" /> },
    { value: "other", label: "その他", icon: <MoreHorizontal className="w-4 h-4" /> },
  ];

  // 人フィルターの動的オプション生成
  const personOptions: DropdownOption[] = Array.from(new Set(photos.map(p => p.user_id))).map(id => {
    const p = photos.find(ph => ph.user_id === id);
    const name = (p?.basic_profile_info as any)?.name_english || 'Unknown';
    return { 
      value: id, 
      label: name,
      icon: <User className="w-4 h-4" />
    };
  });
  return (
    // md:flex でPC画面の時は表示し、w-80 (320px) くらいで固定します
    <aside className={`
      fixed inset-y-0 left-0 z-40 w-80 bg-white border-r border-gray-200 transform transition-transform duration-300 ease-in-out flex flex-col
      md:relative md:translate-x-0 md:bg-gray-50
      ${isOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}
    `}>
      <div className="p-6 border-b border-gray-100 flex justify-between items-center md:hidden">
        <h2 className="text-xl font-bold text-gray-800">Gallery Filters</h2>
        <div className="flex items-center gap-2">
          {isFiltered && (
            <button 
              onClick={onClear}
              className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors"
            >
              Clear
            </button>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-2">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        {/* 検索バー */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider hidden md:block">
              Search
            </h3>
            {isFiltered && (
              <button 
                onClick={onClear}
                className="text-xs font-bold text-blue-600 hover:text-blue-800 transition-colors hidden md:block"
              >
                Clear All
              </button>
            )}
          </div>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm bg-white"
              placeholder="Search photos..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* フィルター群 */}
        <div className="space-y-6">
          <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-3">
            Filters
          </h3>
          <div className="space-y-5">
            <div className="z-[30]">
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">種類</label>
              <CustomDropdown
                options={typeOptions}
                value={filterType}
                onChange={(val) => setFilterType(val as string[])}
                multiple={true}
                searchable={false}
                placeholder="すべての種類"
              />
            </div>
            <div className="z-[20]">
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">人</label>
              <CustomDropdown
                options={personOptions}
                value={filterPerson}
                onChange={(val) => setFilterPerson(val as string[])}
                multiple={true}
                searchable={true}
                placeholder="すべての人"
              />
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}