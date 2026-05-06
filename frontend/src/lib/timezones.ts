export type LocationInfo = {
  locationName: string;
  cityId: string;
  emoji: string;
  names: string[];
  timeZone: string[];
  countryCode: string;
};

export const WorldLocations: LocationInfo[] = [
  { locationName: 'Tokyo (Japan)', cityId: 'Asia/Tokyo', emoji: '🇯🇵', names: ['JP', 'Japan', '日本'], timeZone: ['JST', 'JST'], countryCode: 'jp' },
  { locationName: 'Hawaii (USA)', cityId: 'Pacific/Honolulu', emoji: '🇺🇸', names: ['Haw(US)', 'Hawaii', 'ハワイ', 'HW'], timeZone: ['HST', 'HST'], countryCode: 'us' },
  { locationName: 'California (USA)', cityId: 'America/Los_Angeles', emoji: '🇺🇸', names: ['Cal(US)', 'California', 'カリフォルニア', 'CA'], timeZone: ['PST', 'PDT'], countryCode: 'us' },
  { locationName: 'Chicago (USA)', cityId: 'America/Chicago', emoji: '🇺🇸', names: ['Chi(US)', 'Chicago', 'シカゴ', 'CH'], timeZone: ['CST', 'CDT'], countryCode: 'us' },
  { locationName: 'New York (USA)', cityId: 'America/New_York', emoji: '🇺🇸', names: ['NY(US)', 'New York', 'ニューヨーク', 'NY'], timeZone: ['EST', 'EDT'], countryCode: 'us' },
  { locationName: 'Toronto (Canada)', cityId: 'America/Toronto', emoji: '🇨🇦', names: ['Tor(CA)', 'Toronto', 'トロント', 'TR'], timeZone: ['EST', 'EDT'], countryCode: 'ca' },
  { locationName: 'London (UK)', cityId: 'Europe/London', emoji: '🇬🇧', names: ['UK', 'London', 'イギリス'], timeZone: ['GMT', 'BST'], countryCode: 'gb' },
  { locationName: 'Madrid (Spain)', cityId: 'Europe/Madrid', emoji: '🇪🇸', names: ['ES', 'Spain', 'スペイン'], timeZone: ['CET', 'CEST'], countryCode: 'es' },
  { locationName: 'Paris (France)', cityId: 'Europe/Paris', emoji: '🇫🇷', names: ['FR', 'France', 'フランス'], timeZone: ['CET', 'CEST'], countryCode: 'fr' },
  { locationName: 'Bangkok (Thailand)', cityId: 'Asia/Bangkok', emoji: '🇹🇭', names: ['TH', 'Thailand', 'タイ'], timeZone: ['ICT', 'ICT'], countryCode: 'th' },
  { locationName: 'Kuala Lumpur (Malaysia)', cityId: 'Asia/Kuala_Lumpur', emoji: '🇲🇾', names: ['MY', 'Malaysia', 'マレーシア'], timeZone: ['MYT', 'MYT'], countryCode: 'my' },
  { locationName: 'Shanghai (China)', cityId: 'Asia/Shanghai', emoji: '🇨🇳', names: ['Sha(CN)', 'Shanghai', '上海', 'SH'], timeZone: ['CST', 'CST'], countryCode: 'cn' },
  { locationName: 'Taipei (Taiwan)', cityId: 'Asia/Taipei', emoji: '🇹🇼', names: ['TW', 'Taiwan', '台湾'], timeZone: ['CST', 'CST'], countryCode: 'tw' },
  { locationName: 'Sydney (Australia)', cityId: 'Australia/Sydney', emoji: '🇦🇺', names: ['Syd(AU)', 'Sydney', 'シドニー', 'SY'], timeZone: ['AEST', 'AEDT'], countryCode: 'au' },
];