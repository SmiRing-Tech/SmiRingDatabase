import { useState, useRef, useEffect, useMemo } from 'react';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import {
  Send,
  Plus,
  Users,
  User,
  X,
  MessageSquare,
  Check,
  ArrowLeft,
} from 'lucide-react';
import type { useAdvancedChat } from '../../hooks/useAdvancedChat';

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
    threads,
    activeThreadId,
    setActiveThreadId,
    sendMessage,
    createOrOpenDmThread,
  } = chat;

  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();

  const [inputVal, setInputVal] = useState('');
  const [showNewDmModal, setShowNewDmModal] = useState(false);
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Other participants in the room available for DM
  const otherParticipants = useMemo(() => {
    return participants.filter((p) => p.identity !== localParticipant?.identity);
  }, [participants, localParticipant?.identity]);

  // Auto-scroll to bottom on messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const activeThread = useMemo(() => {
    return threads.find((t) => t.id === activeThreadId) || threads[0];
  }, [threads, activeThreadId]);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputVal.trim()) return;
    const text = inputVal;
    setInputVal('');
    await sendMessage(text, activeThreadId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Ignore Enter while an IME composition (e.g. Japanese input) is still in
    // progress — that Enter confirms the conversion, it doesn't submit the form.
    // keyCode 229 is the legacy fallback some browsers still report during composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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

  const getParticipantMeta = (identity: string) => {
    const p = participants.find((part) => part.identity === identity);
    let avatarUrl: string | null = null;
    if (p?.metadata) {
      try {
        const parsed = JSON.parse(p.metadata);
        avatarUrl = parsed.avatar_url || null;
      } catch {}
    }
    return {
      name: p?.name || p?.identity || identity,
      avatarUrl,
    };
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0d0f14] text-gray-100 select-none overflow-hidden font-sans border-l border-gray-800/80">
      {/* Top Header: Thread Name & Back/Close */}
      <header className="h-11 shrink-0 bg-gray-950/90 border-b border-gray-800/80 px-3 flex items-center justify-between gap-2 z-20">
        <div className="flex items-center gap-2 min-w-0">
          {onBackToVideo && (
            <button
              onClick={onBackToVideo}
              className="p-1 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
              title="映像に戻る"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="flex items-center gap-1.5 min-w-0">
            {activeThread.isEveryone ? (
              <Users className="w-4 h-4 text-indigo-400 shrink-0" />
            ) : (
              <MessageSquare className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <h3 className="font-bold text-xs sm:text-sm text-gray-200 truncate">
              {activeThread.name}
            </h3>
          </div>
        </div>

        {/* New DM Button */}
        <button
          onClick={() => setShowNewDmModal(true)}
          className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600/90 hover:bg-indigo-600 text-white rounded-lg text-xs font-semibold shadow-sm transition-all active:scale-95 shrink-0"
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
              <span className="truncate max-w-[90px]">{t.name}</span>
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
                <MessageSquare className="w-4 h-4 text-indigo-400" />
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
                          ? 'bg-indigo-600/20 border-indigo-500/50 text-white'
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
                            ? 'bg-indigo-600 border-indigo-500 text-white'
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
                className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white font-bold text-xs rounded-xl shadow transition-all active:scale-95"
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
      <div className={`flex-1 overflow-y-auto space-y-2.5 min-h-0 ${isCompact ? 'p-2' : 'p-3'}`}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-1.5 py-8">
            <MessageSquare className="w-8 h-8 opacity-30" />
            <p className="text-xs font-semibold">まだメッセージはありません</p>
            <p className="text-[10px] text-gray-600">最初のメッセージを送信しましょう</p>
          </div>
        ) : (
          messages.map((m) => {
            const isMe = m.sender.identity === localParticipant?.identity;
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
                  <div className="w-6 h-6 rounded-lg bg-gray-800 overflow-hidden shrink-0 border border-gray-700 flex items-center justify-center mb-0.5">
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
                    <span className="text-[10px] font-semibold text-gray-400 mb-1 ml-1 truncate max-w-[140px]">
                      {m.sender.name}
                    </span>
                  )}
                  <div
                    className={`px-3 py-2 rounded-2xl text-xs break-words whitespace-pre-wrap leading-relaxed shadow-sm ${
                      isMe
                        ? 'bg-indigo-600 text-white rounded-br-xs'
                        : 'bg-gray-800 text-gray-100 rounded-bl-xs border border-gray-700/60'
                    }`}
                  >
                    {m.text}
                  </div>
                  <span className="text-[9px] text-gray-500 mt-1 px-1">{timeStr}</span>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <footer className="p-2.5 bg-gray-950/95 border-t border-gray-800/90 shrink-0">
        <form onSubmit={handleSend} className="flex items-center gap-1.5">
          <input
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              activeThread.isEveryone
                ? '全体にメッセージを送信...'
                : `${activeThread.name}に送信...`
            }
            className="flex-1 bg-gray-900 border border-gray-700/90 rounded-xl px-3 py-2 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          <button
            type="submit"
            disabled={!inputVal.trim()}
            className="p-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white rounded-xl shadow-md transition-all active:scale-95 shrink-0"
            title="送信"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </footer>
    </div>
  );
}
