export interface ReactionEmoji {
  id: string;
  label: string;
  char: string;
  src: string;
}

export const REACTION_EMOJIS: ReactionEmoji[] = [
  { id: 'thumbs_up', label: 'いいね', char: '👍', src: '/emojis/reactions/thumbs_up.png' },
  { id: 'clapping', label: '拍手', char: '👏', src: '/emojis/reactions/clapping.png' },
  { id: 'heart', label: 'ハート', char: '❤️', src: '/emojis/reactions/heart.png' },
  { id: 'party', label: '祝', char: '🎉', src: '/emojis/reactions/party.png' },
  { id: 'rofl', label: '大笑い', char: '🤣', src: '/emojis/reactions/rofl.png' },
  { id: 'fire', label: '炎', char: '🔥', src: '/emojis/reactions/fire.png' },
  { id: 'open_mouth', label: 'びっくり', char: '😮', src: '/emojis/reactions/open_mouth.png' },
  { id: 'exploding_head', label: '衝撃', char: '🤯', src: '/emojis/reactions/exploding_head.png' },
  { id: 'heart_eyes', label: 'キュン', char: '😍', src: '/emojis/reactions/heart_eyes.png' },
  { id: 'folded_hands', label: 'お願い・感謝', char: '🙏', src: '/emojis/reactions/folded_hands.png' },
  { id: 'hundred', label: '満点', char: '💯', src: '/emojis/reactions/hundred.png' },
  { id: 'crying', label: '泣き', char: '😭', src: '/emojis/reactions/crying.png' },
];

export const REACTION_EMOJI_MAP = new Map<string, ReactionEmoji>(
  REACTION_EMOJIS.map((e) => [e.id, e])
);

export const PIP_REACTION_EMOJI_IDS = ['thumbs_up', 'clapping', 'heart', 'crying'] as const;
export const PIP_REACTION_EMOJIS: ReactionEmoji[] = PIP_REACTION_EMOJI_IDS
  .map((id) => REACTION_EMOJI_MAP.get(id))
  .filter((e): e is ReactionEmoji => !!e);

export interface ReactionPacket {
  type: 'reaction';
  emojiId: string;
  senderIdentity: string;
  id: string;
  timestamp: number;
}

export interface ActiveReaction {
  id: string;
  emojiId: string;
  timestamp: number;
}

export interface StreamReaction {
  id: string;
  emojiId: string;
  timestamp: number;
  startX: number;
  startY: number;
}
