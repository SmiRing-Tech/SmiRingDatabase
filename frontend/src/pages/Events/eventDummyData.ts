export interface EventHost {
  id: string;
  name: string;
  name_english?: string | null;
  avatar_url?: string | null;
}

export interface EventItem {
  id: string;
  title: string;
  upper_subtitle?: string | null;
  lower_subtitle?: string | null;
  description: string;
  start_datetime?: string | null;
  event_date_text: string;
  image_path?: string | null;
  image_url?: string | null;
  image_placeholder_text?: string;
  host?: EventHost | null;
  requirements?: string | null;
  metadata?: Record<string, any>;
}

export const DUMMY_EVENTS: EventItem[] = [
  {
    id: 'event-1',
    upper_subtitle: '先輩留学生と直接話せる',
    title: '秋の留学フェア2026',
    lower_subtitle: null,
    description: '実際に留学経験のある先輩たちが集まり、大学選びや準備の進め方について相談できるフェアです。個別相談ブースもあります。',
    event_date_text: '8月22日(土) 13:00-16:00',
    image_placeholder_text: 'photo: フェア会場の様子',
    host: {
      id: 'mentor-1',
      name: '田中 美咲',
    },
    requirements: 'SmiRing会員限定',
  },
  {
    id: 'event-2',
    upper_subtitle: null,
    title: 'TOEFL対策ワークショップ',
    lower_subtitle: '初めての受験でも安心のレベル別構成',
    description: 'スコアアップに直結する勉強法とテスト形式ごとの対策を、講師経験のあるメンバーが解説します。',
    event_date_text: '8月29日(土) 10:00-12:30',
    image_placeholder_text: 'photo: ワークショップ風景',
    host: {
      id: 'mentor-2',
      name: '佐藤 健一',
    },
    requirements: '留学検討中の方・スコアアップを目指す方',
  },
  {
    id: 'event-3',
    upper_subtitle: '出願スケジュールの立て方',
    title: '海外大学院進学セミナー',
    lower_subtitle: '出願書類の書き方まで一気に解説',
    description: '大学院進学を目指す方向けに、出願スケジュールの立て方からSOP・推薦状の準備までを解説します。',
    event_date_text: '9月5日(土) 14:00-16:00',
    image_placeholder_text: 'photo: セミナー登壇の様子',
    host: {
      id: 'mentor-3',
      name: '鈴木 翔太',
    },
    requirements: '大学生・大学院生・社会人',
  },
  {
    id: 'event-4',
    upper_subtitle: null,
    title: '留学経験者座談会',
    lower_subtitle: null,
    description: '現地でのリアルな生活費や住まい探し、カルチャーショックの乗り越え方を本音で語り合う座談会です。',
    event_date_text: '9月12日(土) 15:00-17:00',
    image_placeholder_text: 'photo: 座談会の様子',
    host: {
      id: 'mentor-4',
      name: '高橋 陽菜',
    },
    requirements: '誰でも参加可能',
  },
  {
    id: 'event-5',
    upper_subtitle: '書類不備で足止めされないために',
    title: 'ビザ申請サポートセッション',
    lower_subtitle: null,
    description: 'アメリカ・カナダ・イギリス等の学生ビザ申請の最新情報と、よくあるミス・注意点を網羅的にチェックします。',
    event_date_text: '9月19日(土) 18:00-19:30',
    image_placeholder_text: 'photo: 申請書類の準備風景',
    host: {
      id: 'mentor-5',
      name: '渡辺 大樹',
    },
    requirements: '渡航予定のある方',
  },
  {
    id: 'event-6',
    upper_subtitle: null,
    title: '卒業生キャリアトークイベント',
    lower_subtitle: null,
    description: '海外大学卒業後に外資系企業やグローバルスタートアップで活躍する先輩たちが登壇します。',
    event_date_text: '9月26日(土) 14:00-16:00',
    image_placeholder_text: 'photo: トークイベントの様子',
    host: {
      id: 'mentor-6',
      name: '伊藤 さくら',
    },
    requirements: 'SmiRing会員限定',
  },
];
