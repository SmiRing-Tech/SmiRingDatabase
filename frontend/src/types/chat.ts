export interface ChatSender {
  identity: string;
  name: string;
  avatarUrl?: string | null;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  text: string;
  sender: ChatSender;
  recipients: string[]; // Destination identities. Empty array means everyone/broadcast.
  timestamp: number;
}

export interface ChatThread {
  id: string;
  name: string;
  isEveryone: boolean;
  participantIdentities: string[]; // All member identities in this thread
  lastMessage?: ChatMessage;
  unreadCount: number;
}
