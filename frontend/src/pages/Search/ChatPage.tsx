import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Send, 
  Bot, 
  User, 
  ChevronLeft, 
  Sparkles,
  RefreshCw,
  MessageSquare
} from 'lucide-react';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
};

export default function ChatPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(location.state?.q || '');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasInitialized = useRef(false);

  // 初回表示時の処理
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    // 初回はメッセージを空にする（コンポーネント側で中央ウェルカム表示）
    setMessages([]);
  }, []);

  // メッセージ追加時にスクロール
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // 入力欄の自動リサイズ
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      // 🚀 バックエンドのRAG検索API (後ほど実装)
      await new Promise(resolve => setTimeout(resolve, 1500));

      const aiMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `「${text}」についてのAI回答（UIプレビュー中）\n\nここには将来的に検索結果に基づいたAIの回答が表示されます。`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      console.error('Chat error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#fdfdfd] text-gray-900 relative overflow-hidden font-sans">
      {/* 背景の装飾的な要素 */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-50 rounded-full blur-[120px] opacity-60 pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-50 rounded-full blur-[120px] opacity-60 pointer-events-none" />
      
      {/* --- Header --- */}
      <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 px-4 py-3 flex items-center justify-between shadow-sm z-20">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-gray-500" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-200">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-none mb-1">SmiRing AI</h1>
              <span className="text-[9px] text-gray-400 font-bold uppercase tracking-widest">Intelligent Assistant</span>
            </div>
          </div>
        </div>
        <button 
          onClick={() => setMessages([])}
          className="text-gray-400 hover:text-blue-600 p-2 transition-colors"
          title="チャットをリセット"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </header>

      {/* --- Messages Area --- */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 md:px-0 scroll-smooth z-10"
      >
        <div className="max-w-3xl mx-auto w-full h-full min-h-[400px]">
          {messages.length === 0 ? (
            /* ✨ センターウェルカム画面 ✨ */
            <div className="h-full flex flex-col items-center justify-center py-20 animate-in fade-in zoom-in-95 duration-1000">
              <div className="w-20 h-20 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-3xl flex items-center justify-center shadow-2xl shadow-blue-200 mb-8">
                <Sparkles className="w-10 h-10 text-white animate-pulse" />
              </div>
              <h2 className="text-3xl font-black text-gray-900 mb-3 tracking-tight">SmiRing AI</h2>
              <p className="text-gray-500 text-center max-w-sm mb-12 leading-relaxed">
                知りたいことを何でも聞いてください。
                <br />
                データベースから最適な情報を探し出します。
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-xl px-4">
                {[
                  { text: "ITに詳しい人はいる？", icon: "💻" },
                  { text: "カナダ留学の経験談を聞きたい", icon: "🇨🇦" },
                  { text: "マーケティング専攻の人を探して", icon: "📈" },
                  { text: "最近参加した新メンバーは？", icon: "✨" }
                ].map((tip, i) => (
                  <button 
                    key={i}
                    onClick={() => {
                      setInput(tip.text);
                      textareaRef.current?.focus();
                    }}
                    className="flex items-center gap-3 p-4 bg-white border border-gray-100 rounded-2xl hover:border-blue-300 hover:bg-blue-50 transition-all text-left group shadow-sm hover:shadow-md"
                  >
                    <span className="text-xl">{tip.icon}</span>
                    <span className="text-sm font-bold text-gray-700 group-hover:text-blue-700">{tip.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-12 pb-32 pt-10">
          {messages.map((msg) => (
            <div 
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-center'} animate-in fade-in slide-in-from-bottom-4 duration-700`}
            >
              {msg.role === 'user' ? (
                /* --- User Message (Lighter Blue Gradient Bubble) --- */
                <div className="flex gap-3 max-w-[85%] md:max-w-[75%] flex-row-reverse">
                  <div className="w-8 h-8 rounded-full bg-white border border-gray-100 flex-shrink-0 flex items-center justify-center shadow-sm">
                    <User className="w-4 h-4 text-gray-400" />
                  </div>
                  <div className="bg-gradient-to-br from-blue-400 to-blue-500 text-white rounded-2xl rounded-tr-none px-5 py-3 text-sm shadow-md shadow-blue-100 leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              ) : (
                /* --- AI Response (Clean Centered Layout, Left Aligned Text) --- */
                <div className="w-full flex flex-col items-center">
                  <div className="w-full max-w-2xl text-left">
                    <div className="text-gray-700 text-sm md:text-base leading-[1.8] whitespace-pre-wrap font-medium tracking-tight">
                      {msg.content}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
          
          {isLoading && (
            <div className="flex flex-col items-center animate-in fade-in duration-500">
              <div className="flex flex-col items-center mb-4">
                <div className="w-12 h-12 bg-gradient-to-tr from-blue-500 to-indigo-500 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-100 mb-2 animate-pulse">
                  <Bot className="w-7 h-7 text-white" />
                </div>
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-500/60">SmiRing Intelligence</span>
              </div>
              <div className="flex gap-2">
                <div className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <div className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-bounce" />
              </div>
            </div>
          )}
          </div>
        )}
      </div>
    </div>

      {/* --- Input Area --- */}
      <div className="p-4 md:p-6 bg-transparent">
        <div className="max-w-3xl mx-auto relative group">
          <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl blur opacity-25 group-focus-within:opacity-40 transition duration-1000 group-focus-within:duration-200"></div>
          <div className="relative flex items-center gap-2 bg-white rounded-xl border border-gray-200 p-2 shadow-lg">
            <div className="pl-3">
              <Sparkles className="w-5 h-5 text-blue-400" />
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend(input);
                }
              }}
              placeholder="質問を入力..."
              rows={1}
              className="flex-1 bg-transparent border-none outline-none text-sm py-2 px-1 focus:ring-0 resize-none max-h-40 min-h-[24px] overflow-y-auto leading-relaxed"
            />
            <button
              onClick={() => handleSend(input)}
              disabled={!input.trim() || isLoading}
              className={`p-2 rounded-lg transition-all ${
                input.trim() && !isLoading
                  ? 'bg-blue-600 text-white shadow-md hover:bg-blue-700 active:scale-95'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>
        <p className="text-[10px] text-center text-gray-400 mt-3 font-medium uppercase tracking-widest flex items-center justify-center gap-1.5">
          <MessageSquare className="w-3 h-3" />
          Powered by Gemini AI Engine
        </p>
      </div>
    </div>
  );
}
