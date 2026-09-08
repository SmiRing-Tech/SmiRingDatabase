import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold,
  Italic,
  Heading3,
  List,
  ListOrdered,
  Code,
  Send,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface ChatRichEditorProps {
  onSend: (html: string, plainText: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const chatContentStyles =
  'text-xs text-gray-200 prose prose-sm prose-invert max-w-none antialiased ' +
  'prose-p:my-0.5 prose-p:leading-relaxed prose-p:font-normal ' +
  'prose-strong:font-extrabold prose-strong:text-white ' +
  'prose-headings:my-1 prose-headings:font-black prose-headings:text-white prose-h1:text-base prose-h2:text-sm prose-h3:text-xs ' +
  'prose-ul:my-1 prose-ul:pl-4 prose-ul:list-disc ' +
  'prose-ol:my-1 prose-ol:pl-4 prose-ol:list-decimal ' +
  'prose-li:my-0.5 ' +
  'prose-code:bg-gray-800/90 prose-code:text-sky-300 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[11px] prose-code:font-mono prose-code:before:content-none prose-code:after:content-none';

export default function ChatRichEditor({
  onSend,
  placeholder = 'メッセージを送信...',
  disabled = false,
}: ChatRichEditorProps) {
  const [, setForceUpdate] = useState(0);
  const [isEmpty, setIsEmpty] = useState(true);
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [2, 3],
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
    ],
    editorProps: {
      attributes: {
        class: `outline-none min-h-[38px] max-h-32 overflow-y-auto px-3 py-2 text-xs ${chatContentStyles}`,
      },
      handleKeyDown: (_view, event) => {
        // IME (Japanese input) composition handling
        if (event.isComposing || event.keyCode === 229) {
          return false;
        }

        // Shift + Enter handling:
        // Inside lists: split list item, or lift out if current item is empty.
        // In normal paragraphs: split block so each line is an independent paragraph block,
        // allowing bullet lists or markdown rules ('- ', '1. ') to apply to that line alone.
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
            const { $from } = editor.state.selection;
            const isItemEmpty = $from.parent.textContent.length === 0;
            if (isItemEmpty) {
              editor.commands.liftListItem('listItem');
            } else {
              editor.commands.splitListItem('listItem');
            }
          } else {
            editor.commands.splitBlock();
          }
          return true;
        }

        // Enter without shift sends message
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          handleSendSubmit();
          return true;
        }

        return false;
      },
    },
    onUpdate: ({ editor }) => {
      setIsEmpty(editor.getText().trim().length === 0);
    },
    onSelectionUpdate: () => setForceUpdate((prev) => prev + 1),
    onTransaction: () => setForceUpdate((prev) => prev + 1),
  });

  const handleSendSubmit = () => {
    if (!editor) return;
    const text = editor.getText().trim();
    if (!text) return;

    const html = editor.getHTML();
    onSendRef.current(html, text);
    editor.commands.clearContent();
    setIsEmpty(true);
  };

  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [disabled, editor]);

  if (!editor) return null;

  return (
    <div className="flex flex-col bg-gray-900 border border-gray-700/90 rounded-xl overflow-hidden transition-colors focus-within:border-sky-500">
      {/* Editor Content Area */}
      <EditorContent editor={editor} className="select-text" />

      {/* Bottom Action / Formatting Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 bg-gray-950/40 border-t border-gray-800/80">
        {/* Formatting Buttons */}
        <div className="flex items-center gap-0.5 text-gray-400">
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().toggleBold().run();
            }}
            className={`p-1 rounded-md transition-all ${
              editor.isActive('bold')
                ? 'bg-sky-500 text-white font-bold shadow-xs'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            title="太字 (Cmd/Ctrl + B)"
          >
            <Bold className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().toggleItalic().run();
            }}
            className={`p-1 rounded-md transition-all ${
              editor.isActive('italic')
                ? 'bg-sky-500 text-white font-bold shadow-xs'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            title="斜体 (Cmd/Ctrl + I)"
          >
            <Italic className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().toggleHeading({ level: 3 }).run();
            }}
            className={`p-1 rounded-md transition-all ${
              editor.isActive('heading', { level: 3 })
                ? 'bg-sky-500 text-white font-bold shadow-xs'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            title="見出し"
          >
            <Heading3 className="w-3.5 h-3.5" />
          </button>

          <span className="w-px h-3 bg-gray-800 mx-1" />

          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().toggleBulletList().run();
            }}
            className={`p-1 rounded-md transition-all ${
              editor.isActive('bulletList')
                ? 'bg-sky-500 text-white font-bold shadow-xs'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            title="箇条書きリスト"
          >
            <List className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().toggleOrderedList().run();
            }}
            className={`p-1 rounded-md transition-all ${
              editor.isActive('orderedList')
                ? 'bg-sky-500 text-white font-bold shadow-xs'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            title="番号付きリスト"
          >
            <ListOrdered className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              editor.chain().focus().toggleCode().run();
            }}
            className={`p-1 rounded-md transition-all ${
              editor.isActive('code')
                ? 'bg-sky-500 text-white font-bold shadow-xs'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            title="インラインコード"
          >
            <Code className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Send Button & Hint */}
        <div className="flex items-center gap-1.5">
          <span className="hidden sm:inline text-[9px] text-gray-500">
            Shift+Enterで改行
          </span>
          <button
            type="button"
            disabled={isEmpty || disabled}
            onClick={handleSendSubmit}
            className="p-1.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-30 disabled:hover:bg-sky-500 text-white rounded-lg shadow-sm transition-all active:scale-95"
            title="送信 (Enter)"
          >
            <Send className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
