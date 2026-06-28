"use strict";
/**
 * フロントエンドの basicInfoFields.ts と同期したプロフィール項目の定義
 * 再インデックススクリプトや、バックエンドでのAI処理に使用します。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROFILE_FIELDS = void 0;
exports.PROFILE_FIELDS = {
    name_english: { title: '名前（英語）', type: 'short_text' },
    name_kanji: { title: '名前（漢字）', type: 'short_text' },
    birthday: {
        title: '誕生日',
        type: 'date_time',
        dateTimeSettings: { format: { year: true, month: true, date: true, hour: false, minute: false } }
    },
    hometown: {
        title: '出身地',
        type: 'dropdown',
        options: [
            { id: 2, text: "北海道" }, { id: 4, text: "青森県" }, { id: 5, text: "岩手県" }, { id: 6, text: "宮城県" },
            { id: 7, text: "秋田県" }, { id: 8, text: "山形県" }, { id: 9, text: "福島県" }, { id: 11, text: "茨城県" },
            { id: 12, text: "栃木県" }, { id: 13, text: "群馬県" }, { id: 14, text: "埼玉県" }, { id: 15, text: "千葉県" },
            { id: 16, text: "東京都" }, { id: 17, text: "神奈川県" }, { id: 19, text: "新潟県" }, { id: 20, text: "富山県" },
            { id: 21, text: "石川県" }, { id: 22, text: "福井県" }, { id: 23, text: "山梨県" }, { id: 24, text: "長野県" },
            { id: 25, text: "岐阜県" }, { id: 26, text: "静岡県" }, { id: 27, text: "愛知県" }, { id: 29, text: "三重県" },
            { id: 30, text: "滋賀県" }, { id: 31, text: "京都府" }, { id: 32, text: "大阪府" }, { id: 33, text: "兵庫県" },
            { id: 34, text: "奈良県" }, { id: 35, text: "和歌山県" }, { id: 37, text: "鳥取県" }, { id: 38, text: "島根県" },
            { id: 39, text: "岡山県" }, { id: 40, text: "広島県" }, { id: 41, text: "山口県" }, { id: 43, text: "徳島県" },
            { id: 44, text: "香川県" }, { id: 45, text: "愛媛県" }, { id: 46, text: "高知県" }, { id: 48, text: "福岡県" },
            { id: 49, text: "佐賀県" }, { id: 50, text: "長崎県" }, { id: 51, text: "熊本県" }, { id: 52, text: "大分県" },
            { id: 53, text: "宮崎県" }, { id: 54, text: "鹿児島県" }, { id: 55, text: "沖縄県" }, { id: 57, text: "海外" }
        ]
    },
    english_school: { title: '語学学校', type: 'short_text' },
    study_abroad_type: {
        title: '留学形態',
        type: 'radio',
        options: [{ id: 1, text: "正規・学部留学" }, { id: 2, text: "語学留学" }, { id: 3, text: "交換留学" }]
    },
    study_abroad_country: { title: '留学先（国）', type: 'short_text' },
    study_abroad_city: { title: '留学先（都市）', type: 'short_text' },
    grade_level: {
        title: '学年',
        type: 'radio',
        options: [
            { id: 1, text: "中学生以下" }, { id: 2, text: "高校1年生" }, { id: 3, text: "高校2年生" },
            { id: 4, text: "高校3年生" }, { id: 5, text: "大学1年生" }, { id: 6, text: "大学2年生" },
            { id: 7, text: "大学3年生" }, { id: 8, text: "大学4年生" }, { id: 9, text: "大学5年生以上" },
            { id: 10, text: "大学院生" }, { id: 11, text: "既卒生・社会人" }
        ]
    },
    study_abroad_history: { title: '留学歴', type: 'short_text', shortTextMultiple: { enabled: true, style: 'arrow' } },
    current_school: { title: '現在の学校', type: 'short_text' },
    school_history: { title: '学歴', type: 'short_text', shortTextMultiple: { enabled: true, style: 'arrow' } },
    majors: { title: '専攻', type: 'short_text', shortTextMultiple: { enabled: true, style: 'bullet' } },
    minors: { title: '副専攻', type: 'short_text', shortTextMultiple: { enabled: true, style: 'bullet' } },
    major_history: { title: '専攻歴', type: 'short_text', shortTextMultiple: { enabled: true, style: 'arrow' } },
    personality: {
        title: '自分の強み・特徴',
        type: 'checkbox',
        options: [
            { id: 1, text: "相手から引き出すのが得意" }, { id: 2, text: "相手に寄り添った表現、共感" },
            { id: 3, text: "聞き上手" }, { id: 4, text: "感情を読み取る" }, { id: 5, text: "応援" },
            { id: 6, text: "論理的" }, { id: 7, text: "説得力のある話し方" }, { id: 8, text: "深掘りや本質を考えるのが得意" },
            { id: 9, text: "準備・計画型" }, { id: 10, text: "はっきりとストレートな表現" }, { id: 11, text: "ポジティブ" },
            { id: 12, text: "直感で動く・ひらめき型" }, { id: 13, text: "話好き" }, { id: 14, text: "自分の経験をたくさん語れる" },
            { id: 15, text: "周りに多様な留学状況の知り合いがいる" }
        ]
    },
    important_values: {
        title: '大切にしている価値観',
        type: 'checkbox',
        options: [
            { id: 1, text: "成長・向上心" }, { id: 2, text: "自律・自立" }, { id: 3, text: "挑戦" },
            { id: 4, text: "自由" }, { id: 5, text: "健康・ウェルビーイング" }, { id: 6, text: "家族" },
            { id: 7, text: "友情・仲間" }, { id: 8, text: "愛" }, { id: 9, text: "信頼" },
            { id: 10, text: "正直・誠実さ" }, { id: 11, text: "優しさ・親切さ" }, { id: 12, text: "感謝" },
            { id: 13, text: "貢献・利他" }, { id: 14, text: "責任感" }, { id: 15, text: "情熱" },
            { id: 16, text: "創造性・革新性" }, { id: 17, text: "心の平穏・平穏な人生" }, { id: 18, text: "安定" },
            { id: 19, text: "平等・公正・正義" }, { id: 20, text: "おもしろさ・遊び心" }
        ]
    },
    future_image: {
        title: '将来の展望',
        type: 'checkbox',
        options: [
            { id: 1, text: "ポジティブマインド" }, { id: 2, text: "カリスマ性" }, { id: 3, text: "自分の軸や信念、価値観をしっかり持つ" },
            { id: 4, text: "臨機応変に対応できる能力" }, { id: 5, text: "挑戦心" }, { id: 6, text: "落ち着き" },
            { id: 7, text: "批判的思考" }, { id: 8, text: "行動力" }, { id: 9, text: "深い思考力" },
            { id: 10, text: "外国語を使用する職業" }, { id: 11, text: "海外就職" }, { id: 12, text: "社会や世界を変える" },
            { id: 13, text: "グローバルな視点で物事を見る・働く" }, { id: 14, text: "人に影響を与える" }, { id: 15, text: "ワクワクを追い求める" },
            { id: 16, text: "リーダーシップ" }, { id: 17, text: "平和・穏便" }, { id: 18, text: "困っている人を助ける" },
            { id: 19, text: "自信を持つ" }, { id: 20, text: "自分の身の回りを大切にできる" }, { id: 21, text: "バランスの良い生活" }
        ]
    },
    smiring_department: {
        title: 'SmiRing所属部署',
        type: 'checkbox',
        options: [
            { id: 1, text: "代表" }, { id: 2, text: "副代表" }, { id: 3, text: "広報部署 インスタ メイン" },
            { id: 4, text: "広報部署 インスタ カリフォルニア" }, { id: 5, text: "広報部署 インスタ アジア" },
            { id: 6, text: "広報部署 インスタ マレーシア" }, { id: 7, text: "広報部署 インスタ ヨーロッパ" },
            { id: 8, text: "広報部署 インスタ アメリカ" }, { id: 9, text: "広報部署 Youtube" },
            { id: 10, text: "広報部署 Note" }, { id: 11, text: "イベント部署" }, { id: 12, text: "進学支援部署" },
            { id: 13, text: "コーポレート部署" }, { id: 14, text: "Tech部署" }, { id: 15, text: "留学祭" }, { id: 16, text: "無所属" }
        ]
    },
    smiring_join_date: {
        title: '加入時期',
        type: 'date_time',
        dateTimeSettings: { format: { year: true, month: true, date: true, hour: false, minute: false } }
    }
};
