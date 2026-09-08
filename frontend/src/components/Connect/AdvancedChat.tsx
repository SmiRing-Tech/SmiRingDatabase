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
} from 'lucide-react';
import type { useAdvancedChat } from '../../hooks/useAdvancedChat';
import type { ChatThread } from '../../types/chat';
import { useAuth } from '../../context/AuthContext';
import ChatRichEditor, { chatContentStyles } from './ChatRichEditor';

const URL_REGEX = /(https?:\/\/[^\s]+)/g;
const HTML_TAG_REGEX = /<[a-z][\s\S]*>/i;

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const memberListRef = useRef<HTMLDivElement>(null);

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

  // Close member list popover on thread switch
  useEffect(() => {
    setShowMemberList(false);
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

  // Other participants in the room available for DM
  const otherParticipants = useMemo(() => {
    return participants.filter((p) => p.identity !== selfIdentity);
  }, [participants, selfIdentity]);

  // Auto-scroll to bottom on messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

      {/* Message List */}
      <div className={`flex-1 overflow-y-auto space-y-2.5 min-h-0 select-text ${isCompact ? 'p-2' : 'p-3'}`}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-1.5 py-8 select-none">
            <MessageSquare className="w-8 h-8 opacity-30" />
            <p className="text-xs font-semibold">まだメッセージはありません</p>
            <p className="text-[10px] text-gray-600">最初のメッセージを送信しましょう</p>
          </div>
        ) : (
          messages.map((m) => {
            const isMe = m.sender.identity === selfIdentity;
            const isCopied = copiedMessageId === m.id;
            const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });

            return (
              <div
                key={m.id}
                className={`flex gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'} items-end`}
              >
                {/* Avatar */}
                {!isMe && (
                  <div className="w-6 h-6 rounded-lg bg-gray-800 overflow-hidden shrink-0 border border-gray-700 flex items-center justify-center mb-0.5 select-none">
                    {m.sender.avatarUrl ? (
                      <img src={m.sender.avatarUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-3.5 h-3.5 text-gray-400" />
                    )}
                  </div>
                )}

                {/* Bubble + Metadata */}
                <div
                  className={`flex flex-col ${
                    isMe ? 'items-end' : 'items-start'
                  } max-w-[80%]`}
                >
                  {!isMe && (
                    <span className="text-[10px] font-semibold text-gray-400 mb-1 ml-1 truncate max-w-[140px] select-none">
                      {!isUuid(m.sender.name) ? m.sender.name : getParticipantMeta(m.sender.identity).name}
                    </span>
                  )}
                  <div className="relative group/bubble flex items-center">
                    <div
                      className={`px-3 py-2 rounded-2xl text-xs break-words whitespace-pre-wrap leading-relaxed shadow-sm select-text ${
                        isMe
                          ? 'bg-sky-500 text-white rounded-br-xs'
                          : 'bg-gray-800 text-gray-100 rounded-bl-xs border border-gray-700/60'
                      }`}
                    >
                      {renderMessageContent(m.text, isMe)}
                    </div>

                    {/* Copy Button (hover to show) */}
                    <button
                      type="button"
                      onClick={() => handleCopyMessage(m.id, m.text)}
                      className={`absolute opacity-0 group-hover/bubble:opacity-100 focus:opacity-100 transition-opacity p-1 rounded-md bg-gray-900/90 text-gray-300 hover:text-white border border-gray-700/80 shadow-md ${
                        isMe ? '-left-7' : '-right-7'
                      }`}
                      title={isCopied ? 'コピーしました' : 'メッセージをコピー'}
                    >
                      {isCopied ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                  <span className="text-[9px] text-gray-500 mt-1 px-1 select-none">{timeStr}</span>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <footer className="p-2 bg-gray-950/95 border-t border-gray-800/90 shrink-0">
        <ChatRichEditor
          key={activeThreadId}
          onSend={(html) => sendMessage(html, activeThreadId)}
          placeholder={
            activeThread.isEveryone
              ? '全体にメッセージを送信...'
              : `${activeThread.name}に送信...`
          }
        />
      </footer>
    </div>
  );
}
