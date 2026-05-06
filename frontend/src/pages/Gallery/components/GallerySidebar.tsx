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
};

export default function GallerySidebar({
  searchQuery,
  setSearchQuery,
  filterType,
  setFilterType,
  filterPerson,
  setFilterPerson,
  photos,
}: Props) {
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
    // md:flex でPC画面の時は表示し、w-80 (320px) くらいで固定します（全体の1/3ほどのイメージ）
    <aside className="hidden md:flex flex-col w-80 flex-shrink-0 bg-gray-50 border-r border-gray-200 p-6 h-full overflow-y-auto">
      
      {/* 検索バー */}
      <div className="mb-8">
        <h2 className="text-xl font-bold mb-4 text-gray-800">Gallery Filters</h2>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            {/* 虫眼鏡アイコン */}
            <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            placeholder="Search photos..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* フィルター群 */}
      <div className="flex-1 space-y-8">
        <div>
          <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-3">
            Filters
          </h3>
          <div className="space-y-4">
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