import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, List, ListOrdered, Code, ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';

type Props = {
  value?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  readOnly?: boolean; 
};

export const richTextStyles = 
  'text-sm text-gray-600 prose prose-sm max-w-none ' + 
  'prose-p:my-1 prose-p:leading-normal prose-headings:my-2 ' + 
  'prose-h1:text-lg prose-h1:font-bold prose-h2:text-base prose-h2:font-bold prose-h3:text-sm prose-h3:font-bold ' +
  'prose-code:before:content-none prose-code:after:content-none prose-code:bg-blue-100 prose-code:text-blue-700 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:font-mono prose-code:font-bold';

const headingOptions = [
  { label: 'Normal', value: 'normal' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
];

export default function RichTextEditor({ value = '', onChange, placeholder = '文章を入力。', readOnly = false}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [, setForceUpdate] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder }),
    ],
    content: value,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: `outline-none min-h-[120px] px-4 py-3 ${richTextStyles}`,
      },
    },
    onUpdate: ({ editor }) => onChange?.(editor.getHTML()),
    onFocus: () => setIsFocused(true),
    onBlur: () => setIsFocused(false),
    onSelectionUpdate: () => setForceUpdate(prev => prev + 1),
  });

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      // エディタにフォーカスがないときだけ反映させる
      //（編集中にステート更新が走ってカーソルが飛ぶのを防ぐため）
      if (!editor.isFocused) {
        editor.commands.setContent(value);
      }
    }
  }, [value, editor]);

  if (!editor) return null;

  const getCurrentBlockLabel = () => {
    if (editor.isActive('heading', { level: 1 })) return 'Heading 1';
    if (editor.isActive('heading', { level: 2 })) return 'Heading 2';
    if (editor.isActive('heading', { level: 3 })) return 'Heading 3';
    return 'Normal';
  };

  const applyBlock = (value: string) => {
    setIsOpen(false);
    if (value === 'normal') editor.chain().focus().setParagraph().run();
    else if (value === 'h1') editor.chain().focus().toggleHeading({ level: 1 }).run();
    else if (value === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run();
    else if (value === 'h3') editor.chain().focus().toggleHeading({ level: 3 }).run();
  };

  return (
    <div className={`w-full transition-colors`}>
      
      {(isFocused && !readOnly) && (
        <div className="flex items-center gap-1 mb-1 px-3 py-1.5 border-b border-gray-100 bg-gray-50/50 rounded-t-lg">
          
          <div className="relative">
            <button
              onMouseDown={e => { e.preventDefault(); setIsOpen(o => !o); }}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded transition-colors"
            >
              {getCurrentBlockLabel()}
              <ChevronDown className="w-3 h-3" />
            </button>
            {isOpen && (
              <div className="absolute top-full left-0 mt-1 w-32 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
                {headingOptions.map(opt => (
                  <button
                    key={opt.value}
                    onMouseDown={e => { e.preventDefault(); applyBlock(opt.value); }}
                    className={`block w-full text-left px-4 py-1.5 text-xs hover:bg-blue-50 hover:text-blue-700 transition-colors ${getCurrentBlockLabel() === opt.label ? 'text-blue-600 font-bold' : 'text-gray-700'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="w-px h-4 bg-gray-200 mx-1" />

          {/* Bold */}
          <button
            onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
            className={`p-1.5 rounded transition-colors ${editor.isActive('bold') ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            <Bold className="w-3.5 h-3.5" strokeWidth={2.5} />
          </button>

          {/* Italic */}
          <button
            onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
            className={`p-1.5 rounded transition-colors ${editor.isActive('italic') ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            <Italic className="w-3.5 h-3.5" strokeWidth={2.5} />
          </button>

          <div className="w-px h-4 bg-gray-200 mx-1" />

          {/* Bullet List */}
          <button
            onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }}
            className={`p-1.5 rounded transition-colors ${editor.isActive('bulletList') ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            <List className="w-3.5 h-3.5" strokeWidth={2} />
          </button>

          {/* Ordered List */}
          <button
            onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleOrderedList().run(); }}
            className={`p-1.5 rounded transition-colors ${editor.isActive('orderedList') ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            <ListOrdered className="w-3.5 h-3.5" strokeWidth={2} />
          </button>

          {/* Inline Code */}
          <button
            onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }}
            className={`p-1.5 rounded transition-colors ${editor.isActive('code') ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            <Code className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}