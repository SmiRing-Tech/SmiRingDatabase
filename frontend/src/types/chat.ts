export interface ChatSender {
  identity: string;
  name: string;
  avatarUrl?: string | null;
}

export interface ChatReplyTarget {
  id: string;
  senderName: string;
  text: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  text: string;
  sender: ChatSender;
  recipients: string[]; // Destination identities. Empty array means everyone/broadcast.
  timestamp: number;
  replyTo?: ChatReplyTarget | null;
  isEdited?: boolean;
  reactions?: Record<string, string[]>; // { [emoji: string]: userId[] }
}

export interface ChatThread {
  id: string;
  name: string;
  isEveryone: boolean;
  participantIdentities: string[]; // All member identities in this thread
  lastMessage?: ChatMessage;
  unreadCount: number;
}
