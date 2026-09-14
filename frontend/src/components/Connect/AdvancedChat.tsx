import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useParticipants } from '@livekit/components-react';
import {
  Plus,
  Users,
  UsersRound,
  User,
  X,
  MessageSquare,
  Check,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  ArrowDown,
  MoreHorizontal,
  Reply,
  Pencil,
  Trash2,
  CornerDownRight,
  AlertCircle,
  SmilePlus,
} from 'lucide-react';
import type { useAdvancedChat } from '../../hooks/useAdvancedChat';
import type { ChatMessage, ChatThread } from '../../types/chat';
import { useAuth } from '../../context/AuthContext';
import ChatRichEditor, { chatContentStyles } from './ChatRichEditor';
import EmojiPickerPopover from './EmojiPickerPopover';

const URL_REGEX = /(https?:\/\/[^\s]+)/g;
const HTML_TAG_REGEX = /<[a-z][\s\S]*>/i;

function extractPlainText(htmlOrText: string): string {
  if (HTML_TAG_REGEX.test(htmlOrText)) {
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlOrText;
    return tmp.textContent || tmp.innerText || htmlOrText;
  }
  return htmlOrText;
}

function renderMessageContent(text: string, isMe: boolean) {
  if (HTML_TAG_REGEX.test(text)) {
    return (
      <div
        className={`${chatContentStyles} ${
          isMe
            ? 'text-sky-100 prose-invert prose-headings:text-white prose-p:text-sky-100 prose-strong:text-white prose-strong:font-extrabold'
            : 'text-gray-200 prose-strong:text-white prose-strong:font-extrabold'
        }`}
        dangerouslySetInnerHTML={{ __html: text }}
      />
    );
  }

  const parts = text.split(URL_REGEX);
  return (
    <div className="whitespace-pre-wrap break-words antialiased font-normal text-gray-200">
      {parts.map((part, i) => {
        if (part.match(URL_REGEX)) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className={`underline break-all font-semibold transition-colors ${
                isMe
                  ? 'text-sky-200 hover:text-white'
                  : 'text-sky-400 hover:text-sky-300'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {part}
            </a>
          );
        }
        return part;
      })}
    </div>
  );
}

interface AdvancedChatProps {
  chat: ReturnType<typeof useAdvancedChat>;
  onBackToVideo?: () => void;
  isCompact?: boolean;
}

export default function AdvancedChat({
  chat,
  onBackToVideo,
  isCompact = false,
}: AdvancedChatProps) {
  const {
    messages,
    allMessages,
    threads,
    activeThreadId,
    setActiveThreadId,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    createOrOpenDmThread,
    getParticipantInfo,
    isUuid,
  } = chat;

  const { user } = useAuth();
  const selfIdentity = user?.id || '';
  const participants = useParticipants();

  const [showNewDmModal, setShowNewDmModal] = useState(false);
  const [showMemberList, setShowMemberList] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [activeMenuMessageId, setActiveMenuMessageId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<'top' | 'bottom'>('top');
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [reactionPickerPlacement, setReactionPickerPlacement] = useState<'top' | 'bottom'>('top');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const memberListRef = useRef<HTMLDivElement>(null);

  // Scroll and unread tracking
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  const isAtBottomRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const prevMessagesLengthRef = useRef(messages.length);

  const checkIfAtBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    // Within 60px of the bottom is considered "at bottom"
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior,
      });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior });
    }
    setUnreadBelowCount(0);
    isAtBottomRef.current = true;
  }, []);

  const handleScroll = useCallback(() => {
    const atBottom = checkIfAtBottom();
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      setUnreadBelowCount(0);
    }
  }, [checkIfAtBottom]);

  const handleCopyMessage = async (msgId: string, rawText: string) => {
    try {
      let textToCopy = rawText;
      if (HTML_TAG_REGEX.test(rawText)) {
        const tmp = document.createElement('div');
        tmp.innerHTML = rawText;
        textToCopy = tmp.textContent || tmp.innerText || rawText;
      }
      await navigator.clipboard.writeText(textToCopy);
      setCopiedMessageId(msgId);
      setTimeout(() => {
        setCopiedMessageId((prev) => (prev === msgId ? null : prev));
      }, 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  // Close member list and action menus on thread switch
  useEffect(() => {
    setShowMemberList(false);
    setReplyingTo(null);
    setEditingMessageId(null);
    setActiveMenuMessageId(null);
    setReactionPickerMessageId(null);
    setDeleteConfirmId(null);
  }, [activeThreadId]);

  // Close member list popover when clicking outside
  useEffect(() => {
    if (!showMemberList) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (memberListRef.current && !memberListRef.current.contains(e.target as Node)) {
        setShowMemberList(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMemberList]);

  // Close message action menu when clicking outside
  useEffect(() => {
    if (!activeMenuMessageId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (messageMenuRef.current && !messageMenuRef.current.contains(e.target as Node)) {
        setActiveMenuMessageId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [activeMenuMessageId]);

  // Other participants in the room available for DM
  const otherParticipants = useMemo(() => {
    return participants.filter((p) => p.identity !== selfIdentity);
  }, [participants, selfIdentity]);

  // Reset scroll and unread state on thread switch, snap immediately to bottom
  useEffect(() => {
    setUnreadBelowCount(0);
    isAtBottomRef.current = true;
    isInitialLoadRef.current = true;

    // Instantly scroll to bottom without smooth animation
    const frame = requestAnimationFrame(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeThreadId]);

  // Handle messages array updates
  useEffect(() => {
    const prevLen = prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;

    if (messages.length === 0) return;

    // Initial load for this thread: snap instantly to bottom without animation
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
      });
      return;
    }

    // When new message(s) arrive
    if (messages.length > prevLen) {
      const lastMsg = messages[messages.length - 1];
      const isMe = lastMsg.sender.identity === selfIdentity;

      if (isMe) {
        // User sent this message: always scroll down smoothly
        scrollToBottom('smooth');
      } else {
        // Message from another participant
        if (isAtBottomRef.current) {
          // Already at bottom: auto-scroll down smoothly
          scrollToBottom('smooth');
        } else {
          // User is explicitly reading past messages: stay in place and show floating button
          setUnreadBelowCount((prev) => prev + (messages.length - prevLen));
        }
      }
    }
  }, [messages, selfIdentity, scrollToBottom]);

  const activeThread = useMemo(() => {
    return threads.find((t) => t.id === activeThreadId) || threads[0];
  }, [threads, activeThreadId]);

  const getParticipantMeta = useCallback(
    (identity: string) => {
      // 1. Query chat.getParticipantInfo (checks LiveKit participants + cached message senders)
      // Both LiveKit metadata and message history strictly contain the Database avatar and Connect display name.
      const info = getParticipantInfo(identity);
      if (info && info.name && !isUuid(info.name) && info.name !== '参加者') {
        return info;
      }

      // 2. Fallback: inspect allMessages for any sender matching this identity (stored sender_avatar_url from DB)
      const foundInMsg = allMessages?.find((m) => m.sender.identity === identity);
      if (foundInMsg && foundInMsg.sender.name && !isUuid(foundInMsg.sender.name)) {
        return {
          name: foundInMsg.sender.name,
          avatarUrl: foundInMsg.sender.avatarUrl || null,
        };
      }

      // 3. Fallback for self: use Connect participant name if available, otherwise '自分'
      if (identity === selfIdentity) {
        return {
          name: info?.name && !isUuid(info.name) && info.name !== '参加者' ? info.name : '自分',
          avatarUrl: info?.avatarUrl || null,
        };
      }

      // 4. Safe fallback for others: never show raw UUID
      const safeName = info?.name && !isUuid(info.name) ? info.name : '参加者';
      return {
        name: safeName,
        avatarUrl: info?.avatarUrl || null,
      };
    },
    [selfIdentity, getParticipantInfo, isUuid, allMessages],
  );

  const getThreadDisplayName = useCallback(
    (thread: ChatThread) => {
      if (thread.isEveryone) return thread.name;
      if (thread.participantIdentities.length > 0) {
        return thread.participantIdentities.map((id) => getParticipantMeta(id).name).join(', ');
      }
      return !isUuid(thread.name) ? thread.name : 'ダイレクトメッセージ';
    },
    [getParticipantMeta, isUuid],
  );

  // Participant details for active thread (everyone or DM members)
  const threadMembers = useMemo(() => {
    if (activeThread.isEveryone) {
      return participants.map((p) => {
        const meta = getParticipantMeta(p.identity);
        return {
          identity: p.identity,
          name: meta.name,
          avatarUrl: meta.avatarUrl,
          isSelf: p.identity === selfIdentity,
          isOnline: true,
        };
      });
    }

    // DM/Group DM: sender identities + self
    const allIdentities = Array.from(
      new Set([selfIdentity, ...activeThread.participantIdentities]),
    );

    return allIdentities.map((id) => {
      const meta = getParticipantMeta(id);
      const isOnline = participants.some((p) => p.identity === id);
      return {
        identity: id,
        name: meta.name,
        avatarUrl: meta.avatarUrl,
        isSelf: id === selfIdentity,
        isOnline,
      };
    });
  }, [activeThread, participants, selfIdentity, getParticipantMeta]);

  const handleToggleParticipant = (identity: string) => {
    setSelectedParticipants((prev) =>
      prev.includes(identity) ? prev.filter((id) => id !== identity) : [...prev, identity],
    );
  };

  const handleStartDm = () => {
    if (selectedParticipants.length === 0) return;
    createOrOpenDmThread(selectedParticipants);
    setSelectedParticipants([]);
    setShowNewDmModal(false);
  };

  // Everyone -> globe-ish "Users" icon; 1-on-1 DM -> the other person's avatar (falls back
  // to a person icon); group DM (2+ others) -> a distinct "multiple people" icon, so the
  // tab bar reads at a glance instead of every non-broadcast thread looking the same.
  const renderThreadIcon = (t: ChatThread, sizeClass: string) => {
    if (t.isEveryone) {
      return <Users className={`${sizeClass} text-sky-400 shrink-0`} />;
    }
    if (t.participantIdentities.length > 1) {
      return <UsersRound className={`${sizeClass} text-emerald-400 shrink-0`} />;
    }
    const meta = getParticipantMeta(t.participantIdentities[0] ?? '');
    if (meta.avatarUrl) {
      return (
        <img
          src={meta.avatarUrl}
          alt=""
          className={`${sizeClass} rounded-full object-cover shrink-0`}
        />
      );
    }
    return <User className={`${sizeClass} text-emerald-400 shrink-0`} />;
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0d0f14] text-gray-100 select-none overflow-hidden font-sans border-l border-gray-800/80">
      {/* Top Header: Thread Name & Back/Close */}
      <header className="h-11 shrink-0 bg-gray-950/90 border-b border-gray-800/80 px-3 flex items-center justify-between gap-2 z-20">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {onBackToVideo && (
            <button
              onClick={onBackToVideo}
              className="p-1 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors shrink-0"
              title="映像に戻る"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}

          {/* Thread Title with Click-to-Toggle Participant List */}
          <div className="relative min-w-0 flex-1" ref={memberListRef}>
            <button
              type="button"
              onClick={() => setShowMemberList((prev) => !prev)}
              className="flex items-center gap-1.5 max-w-full px-1.5 py-1 -ml-1 rounded-lg hover:bg-gray-800/70 active:bg-gray-800 transition-colors text-left group"
              title="参加メンバー一覧を表示"
            >
              {renderThreadIcon(activeThread, 'w-4 h-4')}
              <span className="font-bold text-xs sm:text-sm text-gray-200 truncate group-hover:text-white min-w-0">
                {getThreadDisplayName(activeThread)}
              </span>
              <span className="text-[10px] text-gray-400 bg-gray-800/90 px-1.5 py-0.5 rounded-full shrink-0 group-hover:bg-gray-700/90 transition-colors">
                {threadMembers.length}
              </span>
              {showMemberList ? (
                <ChevronUp className="w-3.5 h-3.5 text-gray-400 shrink-0 group-hover:text-gray-200" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0 group-hover:text-gray-200" />
              )}
            </button>

            {/* Members Popover Dropdown */}
            {showMemberList && (
              <div className="absolute top-full left-0 mt-1.5 w-64 max-w-[calc(100vw-2rem)] bg-gray-900 border border-gray-700/90 rounded-xl shadow-2xl z-50 p-2.5 space-y-2 animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-center justify-between px-1 pb-1.5 border-b border-gray-800">
                  <span className="text-[11px] font-bold text-gray-400">
                    参加メンバー ({threadMembers.length}名)
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowMemberList(false)}
                    className="text-gray-400 hover:text-gray-200 p-0.5 rounded-md hover:bg-gray-800 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                  {threadMembers.map((member) => (
                    <div
                      key={member.identity}
                      className="flex items-center justify-between p-1.5 rounded-lg hover:bg-gray-800/60 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {member.avatarUrl ? (
                          <img
                            src={member.avatarUrl}
                            alt=""
                            className="w-6 h-6 rounded-lg object-cover shrink-0"
                          />
                        ) : (
                          <div className="w-6 h-6 rounded-lg bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-400 shrink-0">
                            <User className="w-3.5 h-3.5" />
                          </div>
                        )}
                        <span className="text-xs text-gray-200 truncate font-medium">
                          {member.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {member.isSelf && (
                          <span className="text-[10px] text-sky-400 bg-sky-950/60 border border-sky-800/50 px-1 rounded font-medium">
                            自分
                          </span>
                        )}
                        <span
                          className={`w-2 h-2 rounded-full ${
                            member.isOnline ? 'bg-emerald-500' : 'bg-gray-600'
                          }`}
                          title={member.isOnline ? '参加中' : '退出中'}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* New DM Button */}
        <button
          onClick={() => setShowNewDmModal(true)}
          className="flex items-center gap-1 px-2.5 py-1 bg-sky-500/90 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all active:scale-95 shrink-0"
          title="個別・グループDMを作成"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="hidden sm:inline text-[11px]">新規DM</span>
        </button>
      </header>

      {/* Threads Tab Bar */}
      <div className="h-9 shrink-0 bg-gray-950/60 border-b border-gray-800/70 px-2 flex items-center gap-1 overflow-x-auto overflow-y-hidden no-scrollbar">
        {threads.map((t) => {
          const isActive = t.id === activeThreadId;
          return (
            <button
              key={t.id}
              onClick={() => setActiveThreadId(t.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold shrink-0 transition-all ${
                isActive
                  ? 'bg-gray-800 text-white shadow-sm border border-gray-700'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-900/80'
              }`}
            >
              {renderThreadIcon(t, 'w-3.5 h-3.5')}
              <span className="truncate max-w-[90px]">{getThreadDisplayName(t)}</span>
              {t.unreadCount > 0 && (
                <span className="px-1.5 py-0.2 bg-rose-500 text-white text-[10px] font-bold rounded-full animate-pulse">
                  {t.unreadCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* New DM Creation Modal / Popover */}
      {showNewDmModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-sm bg-gray-900 border border-gray-700/80 rounded-2xl p-4 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-gray-800 pb-2.5">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-sky-400" />
                <h4 className="font-bold text-sm text-gray-100">DMの宛先を選択</h4>
              </div>
              <button
                onClick={() => {
                  setShowNewDmModal(false);
                  setSelectedParticipants([]);
                }}
                className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-gray-400">
              複数人を選択するとグループDMを作成できます。
            </p>

            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
              {otherParticipants.length === 0 ? (
                <div className="text-center py-6 text-gray-500 text-xs">
                  他の参加者がまだいません
                </div>
              ) : (
                otherParticipants.map((p) => {
                  const meta = getParticipantMeta(p.identity);
                  const isSelected = selectedParticipants.includes(p.identity);
                  return (
                    <button
                      key={p.identity}
                      onClick={() => handleToggleParticipant(p.identity)}
                      className={`w-full flex items-center justify-between p-2 rounded-xl text-xs transition-colors border ${
                        isSelected
                          ? 'bg-sky-500/20 border-sky-500/50 text-white'
                          : 'bg-gray-800/60 border-transparent text-gray-300 hover:bg-gray-800'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {meta.avatarUrl ? (
                          <img
                            src={meta.avatarUrl}
                            alt=""
                            className="w-6 h-6 rounded-lg object-cover"
                          />
                        ) : (
                          <div className="w-6 h-6 rounded-lg bg-gray-700 flex items-center justify-center text-gray-400">
                            <User className="w-3.5 h-3.5" />
                          </div>
                        )}
                        <span className="font-bold truncate">{meta.name}</span>
                      </div>
                      <div
                        className={`w-4 h-4 rounded-md border flex items-center justify-center ${
                          isSelected
                            ? 'bg-sky-500 border-sky-500 text-white'
                            : 'border-gray-600'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="flex gap-2 pt-2 border-t border-gray-800">
              <button
                disabled={selectedParticipants.length === 0}
                onClick={handleStartDm}
                className="flex-1 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:hover:bg-sky-500 text-white font-bold text-xs rounded-xl shadow transition-all active:scale-95"
              >
                チャットを開始 ({selectedParticipants.length})
              </button>
              <button
                onClick={() => {
                  setShowNewDmModal(false);
                  setSelectedParticipants([]);
                }}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 font-bold text-xs rounded-xl transition-all active:scale-95"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message List Area */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className={`flex-1 overflow-y-auto space-y-2.5 min-h-0 select-text ${isCompact ? 'p-2' : 'p-3'}`}
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-1.5 py-8 select-none">
              <MessageSquare className="w-8 h-8 opacity-30" />
              <p className="text-xs font-semibold">まだメッセージはありません</p>
              <p className="text-[10px] text-gray-600">最初のメッセージを送信しましょう</p>
            </div>
          ) : (
            messages.map((m, idx) => {
              const isMe = m.sender.identity === selfIdentity;
              const isCopied = copiedMessageId === m.id;
              const isEditing = editingMessageId === m.id;
              const isMenuOpen = activeMenuMessageId === m.id;
              const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              });

              // Check if previous message is from the same sender within the same minute (controls avatar & name)
              const prevM = idx > 0 ? messages[idx - 1] : null;
              const prevTimeStr = prevM
                ? new Date(prevM.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : null;
              const isSameSenderAsPrev = Boolean(prevM && prevM.sender.identity === m.sender.identity);
              const isSameMinuteAsPrev =
                isSameSenderAsPrev &&
                timeStr === prevTimeStr &&
                Math.abs(m.timestamp - (prevM?.timestamp ?? 0)) < 60000;
              const isFirstInGroup = !isSameSenderAsPrev || !isSameMinuteAsPrev;

              // Check if next message is from the same sender within the same minute (controls timestamp)
              const nextM = idx < messages.length - 1 ? messages[idx + 1] : null;
              const nextTimeStr = nextM
                ? new Date(nextM.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : null;
              const isSameSenderAsNext = Boolean(nextM && nextM.sender.identity === m.sender.identity);
              const isSameMinuteAsNext =
                isSameSenderAsNext &&
                timeStr === nextTimeStr &&
                Math.abs((nextM?.timestamp ?? 0) - m.timestamp) < 60000;
              const isLastInGroup = !isSameSenderAsNext || !isSameMinuteAsNext;

              return (
                <div
                  key={m.id}
                  className={`flex gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'} items-start ${
                    !isFirstInGroup ? '-mt-1' : ''
                  }`}
                >
                  {/* Avatar: only shown on first message in group */}
                  {!isMe && (
                    !isFirstInGroup ? (
                      <div className="w-6 shrink-0" />
                    ) : (
                      <div className="w-6 h-6 rounded-lg bg-gray-800 overflow-hidden shrink-0 border border-gray-700 flex items-center justify-center mt-3.5 select-none">
                        {m.sender.avatarUrl ? (
                          <img src={m.sender.avatarUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <User className="w-3.5 h-3.5 text-gray-400" />
                        )}
                      </div>
                    )
                  )}

                  {/* Bubble + Metadata */}
                  <div
                    className={`flex flex-col ${
                      isMe ? 'items-end' : 'items-start'
                    } ${isEditing ? 'w-full max-w-full' : 'max-w-[85%]'}`}
                  >
                    {!isMe && isFirstInGroup && (
                      <span className="text-[10px] font-semibold text-gray-400 mb-1 ml-1 truncate max-w-[140px] select-none">
                        {!isUuid(m.sender.name) ? m.sender.name : getParticipantMeta(m.sender.identity).name}
                      </span>
                    )}

                    {isEditing ? (
                      /* Inline Message Editor */
                      <div className="w-full my-1 animate-in fade-in duration-150">
                        <div className="text-[10px] font-semibold text-sky-400 mb-1 flex items-center gap-1">
                          <Pencil className="w-3 h-3 text-white" />
                          <span>メッセージを編集</span>
                        </div>
                        <ChatRichEditor
                          initialContent={m.text}
                          submitLabel="保存"
                          onCancel={() => setEditingMessageId(null)}
                          onSend={async (html) => {
                            await editMessage(m.id, html);
                            setEditingMessageId(null);
                          }}
                        />
                      </div>
                    ) : (
                      /* Regular Message Bubble */
                      <div className="relative group/bubble flex items-center">
                        <div
                          className={`px-3 py-2 rounded-2xl text-xs break-words whitespace-pre-wrap leading-relaxed shadow-sm select-text ${
                            isMe
                              ? 'bg-sky-500 text-white rounded-br-xs'
                              : 'bg-gray-800 text-gray-100 rounded-bl-xs border border-gray-700/60'
                          }`}
                        >
                          {/* 二段構成: 上段 返信元メッセージプレビュー */}
                          {m.replyTo && (
                            <div
                              className={`mb-1.5 p-2 rounded-xl text-xs flex items-start gap-1.5 ${
                                isMe
                                  ? 'bg-sky-600/60 border-l-2 border-white/80 text-sky-100'
                                  : 'bg-gray-900/80 border-l-2 border-sky-400 text-gray-300'
                              }`}
                            >
                              <CornerDownRight
                                className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                                  isMe ? 'text-white' : 'text-sky-400'
                                }`}
                              />
                              <div className="min-w-0 flex-1">
                                <span
                                  className={`font-bold block truncate text-[10px] ${
                                    isMe ? 'text-white' : 'text-sky-300'
                                  }`}
                                >
                                  {m.replyTo.senderName}
                                </span>
                                <span className="opacity-80 line-clamp-2 break-all text-[11px] block">
                                  {extractPlainText(m.replyTo.text)}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* 下段: メッセージ本文 */}
                          {renderMessageContent(m.text, isMe)}
                        </div>

                        {/* Action Buttons: SmilePlus & MoreHorizontal (hover to show) */}
                        <div
                          className={`absolute z-10 flex items-center gap-1 ${
                            isMe ? '-left-14' : '-right-14'
                          }`}
                        >
                          {/* Reaction Button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveMenuMessageId(null);
                              if (reactionPickerMessageId === m.id) {
                                setReactionPickerMessageId(null);
                              } else {
                                const btnRect = e.currentTarget.getBoundingClientRect();
                                const containerRect = scrollContainerRef.current?.getBoundingClientRect();
                                if (containerRect && btnRect.top - containerRect.top < 150) {
                                  setReactionPickerPlacement('bottom');
                                } else {
                                  setReactionPickerPlacement('top');
                                }
                                setReactionPickerMessageId(m.id);
                              }
                            }}
                            className={`p-1 rounded-md bg-gray-900/90 text-gray-300 hover:text-white border border-gray-700/80 shadow-md transition-opacity ${
                              reactionPickerMessageId === m.id
                                ? 'opacity-100 ring-1 ring-sky-500 text-white'
                                : 'opacity-0 group-hover/bubble:opacity-100 focus:opacity-100'
                            }`}
                            title="リアクションを追加"
                          >
                            <SmilePlus className="w-3.5 h-3.5" />
                          </button>

                          {/* Options Button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReactionPickerMessageId(null);
                              if (isMenuOpen) {
                                setActiveMenuMessageId(null);
                              } else {
                                const btnRect = e.currentTarget.getBoundingClientRect();
                                const containerRect = scrollContainerRef.current?.getBoundingClientRect();
                                if (containerRect && btnRect.top - containerRect.top < 150) {
                                  setMenuPlacement('bottom');
                                } else {
                                  setMenuPlacement('top');
                                }
                                setActiveMenuMessageId(m.id);
                              }
                            }}
                            className={`p-1 rounded-md bg-gray-900/90 text-gray-300 hover:text-white border border-gray-700/80 shadow-md transition-opacity ${
                              isMenuOpen
                                ? 'opacity-100 ring-1 ring-sky-500 text-white'
                                : 'opacity-0 group-hover/bubble:opacity-100 focus:opacity-100'
                            }`}
                            title="オプション"
                          >
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Emoji Picker Popover */}
                        {reactionPickerMessageId === m.id && (
                          <EmojiPickerPopover
                            onSelect={(emoji) => {
                              toggleReaction(m.id, emoji);
                              setReactionPickerMessageId(null);
                            }}
                            onClose={() => setReactionPickerMessageId(null)}
                            placement={reactionPickerPlacement}
                            align={isMe ? 'right' : 'left'}
                          />
                        )}

                        {/* Dropdown Actions Popover */}
                        {isMenuOpen && (
                          <div
                            ref={messageMenuRef}
                            className={`absolute z-30 ${
                              menuPlacement === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1'
                            } w-36 bg-gray-900/95 backdrop-blur-md border border-gray-700/90 rounded-xl shadow-2xl py-1 text-xs animate-in fade-in zoom-in-95 duration-100 ${
                              isMe ? 'right-0' : 'left-0'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setReplyingTo(m);
                                setActiveMenuMessageId(null);
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-gray-800 text-gray-200 hover:text-white transition-colors text-left"
                            >
                              <Reply className="w-3.5 h-3.5 text-sky-400" />
                              <span>返信</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                handleCopyMessage(m.id, m.text);
                                setActiveMenuMessageId(null);
                              }}
                              className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-gray-800 text-gray-200 hover:text-white transition-colors text-left"
                            >
                              {isCopied ? (
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="w-3.5 h-3.5 text-gray-400" />
                              )}
                              <span>{isCopied ? 'コピー完了' : 'コピー'}</span>
                            </button>

                            {/* 編集・削除は自分のメッセージのみ */}
                            {isMe && (
                              <>
                                <div className="h-px bg-gray-800 my-1" />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingMessageId(m.id);
                                    setActiveMenuMessageId(null);
                                  }}
                                  className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-gray-800 text-gray-200 hover:text-white transition-colors text-left"
                                >
                                  <Pencil className="w-3.5 h-3.5 text-gray-300" />
                                  <span>編集</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDeleteConfirmId(m.id);
                                    setActiveMenuMessageId(null);
                                  }}
                                  className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 transition-colors text-left"
                                >
                                  <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                                  <span>削除</span>
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Reaction Badges */}
                    {m.reactions && Object.keys(m.reactions).length > 0 && (
                      <div className={`flex flex-wrap gap-1 mt-1 select-none ${isMe ? 'justify-end' : 'justify-start'}`}>
                        {Object.entries(m.reactions).map(([emoji, userIds]) => {
                          if (!userIds || userIds.length === 0) return null;
                          const hasReacted = userIds.includes(selfIdentity);
                          return (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => toggleReaction(m.id, emoji)}
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium border transition-all active:scale-95 ${
                                hasReacted
                                  ? 'bg-sky-500/20 border-sky-500/60 text-sky-200'
                                  : 'bg-gray-800/80 border-gray-700/80 text-gray-300 hover:bg-gray-800 hover:border-gray-600'
                              }`}
                              title={hasReacted ? `${emoji} を取り消す` : `${emoji} を追加`}
                            >
                              <span className="text-sm">{emoji}</span>
                              <span className="text-[10px] font-bold">{userIds.length}</span>
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveMenuMessageId(null);
                            const btnRect = e.currentTarget.getBoundingClientRect();
                            const containerRect = scrollContainerRef.current?.getBoundingClientRect();
                            if (containerRect && btnRect.top - containerRect.top < 150) {
                              setReactionPickerPlacement('bottom');
                            } else {
                              setReactionPickerPlacement('top');
                            }
                            setReactionPickerMessageId(m.id);
                          }}
                          className="px-1.5 py-0.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 border border-transparent hover:border-gray-700 transition-colors flex items-center justify-center"
                          title="リアクションを追加"
                        >
                          <SmilePlus className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    {(m.isEdited || isLastInGroup) && (
                      <div className="flex items-center gap-1 mt-0.5 px-1 select-none">
                        {m.isEdited && (
                          <span className="text-[9px] text-gray-500">(編集済み)</span>
                        )}
                        {isLastInGroup && (
                          <span className="text-[9px] text-gray-500">{timeStr}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Floating "New Messages" Notification Button */}
        {unreadBelowCount > 0 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 pointer-events-auto animate-in fade-in slide-in-from-bottom-2 duration-200">
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-sky-500 hover:bg-sky-400 active:scale-95 text-white text-xs font-semibold shadow-xl shadow-black/40 border border-sky-300/30 backdrop-blur-md transition-all group"
            >
              <span>新規メッセージ{unreadBelowCount > 1 ? ` (${unreadBelowCount})` : ''}</span>
              <ArrowDown className="w-3.5 h-3.5 group-hover:translate-y-0.5 transition-transform" />
            </button>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-xs bg-gray-900 border border-gray-700/90 rounded-2xl p-4 shadow-2xl space-y-3">
            <div className="flex items-center gap-2 text-rose-400">
              <AlertCircle className="w-4 h-4" />
              <h4 className="font-bold text-sm text-gray-100">メッセージを削除</h4>
            </div>
            <p className="text-xs text-gray-300">
              このメッセージを削除しますか？この操作は取り消せません。
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={async () => {
                  await deleteMessage(deleteConfirmId, activeThreadId);
                  setDeleteConfirmId(null);
                }}
                className="flex-1 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl shadow transition-all active:scale-95"
              >
                削除する
              </button>
              <button
                type="button"
                onClick={() => setDeleteConfirmId(null)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-bold text-xs rounded-xl transition-all active:scale-95"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
      <footer className="p-2 bg-gray-950/95 border-t border-gray-800/90 shrink-0">
        {replyingTo && (
          <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900/90 border border-b-0 border-gray-800 rounded-t-xl text-xs animate-in fade-in slide-in-from-bottom-1">
            <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2 text-gray-300">
              <Reply className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span className="font-bold text-sky-400 shrink-0">
                {!isUuid(replyingTo.sender.name)
                  ? replyingTo.sender.name
                  : getParticipantMeta(replyingTo.sender.identity).name}
              </span>
              <span className="text-gray-400 truncate">
                への返信: {extractPlainText(replyingTo.text)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="text-gray-400 hover:text-white p-0.5 rounded-md hover:bg-gray-800 transition-colors shrink-0"
              title="返信をキャンセル"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <ChatRichEditor
          key={`${activeThreadId}_${replyingTo ? replyingTo.id : 'normal'}`}
          onSend={(html) => {
            sendMessage(
              html,
              activeThreadId,
              replyingTo
                ? {
                    id: replyingTo.id,
                    senderName: !isUuid(replyingTo.sender.name)
                      ? replyingTo.sender.name
                      : getParticipantMeta(replyingTo.sender.identity).name,
                    text: extractPlainText(replyingTo.text),
                  }
                : null,
            );
            setReplyingTo(null);
          }}
          placeholder={
            replyingTo
              ? `${
                  !isUuid(replyingTo.sender.name)
                    ? replyingTo.sender.name
                    : getParticipantMeta(replyingTo.sender.identity).name
                }への返信を入力...`
              : activeThread.isEveryone
              ? '全体にメッセージを送信...'
              : `${activeThread.name}に送信...`
          }
        />
      </footer>
    </div>
  );
}
