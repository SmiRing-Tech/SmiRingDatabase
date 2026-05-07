import { useState, useEffect, useRef } from 'react';
import { Copy, ChevronDown, Check, FileText, Code, Type } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── 📋 コピーユーティリティ ──────────────────────────
export const htmlToMarkdown = (html: string) => {
  let md = html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<ul[^>]*>(.*?)<\/ul>/gi, '$1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<ol[^>]*>(.*?)<\/ol>/gi, '$1\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, ''); // 残りのタグを削除
  return md.trim();
};

type Props = {
  html: string;
  className?: string;
};

export const ResponseCopyButton = ({ html, className = '' }: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleCopy = async (format: 'rich' | 'md' | 'html' | 'plain') => {
    try {
      if (format === 'rich') {
        const blob = new Blob([html], { type: 'text/html' });
        const plainBlob = new Blob([html.replace(/<[^>]*>/g, '')], { type: 'text/plain' });
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': blob,
            'text/plain': plainBlob,
          })
        ]);
      } else if (format === 'md') {
        await navigator.clipboard.writeText(htmlToMarkdown(html));
      } else if (format === 'html') {
        await navigator.clipboard.writeText(html);
      } else {
        await navigator.clipboard.writeText(html.replace(/<[^>]*>/g, ''));
      }
      
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setIsOpen(false);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className={`relative inline-flex items-center ${className}`} ref={menuRef}>
      <div className="flex items-center bg-gray-50/80 border border-gray-100 rounded-lg overflow-hidden hover:border-blue-200 transition-colors shadow-sm backdrop-blur-sm">
        <button
          onClick={() => handleCopy('rich')}
          className="p-1.5 hover:bg-white text-gray-400 hover:text-blue-500 transition-all flex items-center gap-1"
          title="書式付きでコピー"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          <span className="text-[10px] font-bold pr-1">Copy</span>
        </button>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`p-1.5 border-l border-gray-100 hover:bg-white text-gray-400 hover:text-blue-500 transition-all ${isOpen ? 'bg-white text-blue-500' : ''}`}
        >
          <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="absolute bottom-full right-0 mb-2 w-48 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-100 overflow-hidden z-20 py-1"
          >
            <button onClick={() => handleCopy('md')} className="w-full px-4 py-2 text-left text-xs font-medium text-gray-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 transition-colors">
              <FileText className="w-3.5 h-3.5" /> Markdown形式
            </button>
            <button onClick={() => handleCopy('html')} className="w-full px-4 py-2 text-left text-xs font-medium text-gray-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 transition-colors">
              <Code className="w-3.5 h-3.5" /> HTML形式
            </button>
            <button onClick={() => handleCopy('plain')} className="w-full px-4 py-2 text-left text-xs font-medium text-gray-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 transition-colors">
              <Type className="w-3.5 h-3.5" /> プレーンテキスト
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
