import { useRef, useMemo, useEffect } from 'react';
import { UploadCloud, X, Paperclip, AlertCircle, CheckCircle2, FileWarning, FileText } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import heic2any from 'heic2any';

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type FileItem = {
  id: string;
  file?: File;
  preview?: string;
  path?: string;
  name: string;
  type: string;
  size: number;
  error?: string;
};

type Props = {
  formId: string;
  questionId: string;
  settings: {
    maxFiles: number;
    maxSizeMB: number;
    allowedTypes: string[];
  };
  value: FileItem[];
  onChange: (value: FileItem[]) => void;
  readOnly?: boolean;
};

const TYPE_LABELS: Record<string, string> = {
  image: '画像',
  pdf: 'PDF',
  doc: '文書',
  spreadsheet: '表計算',
  zip: '圧縮',
};

const ACCEPT_TYPES: Record<string, string> = {
  image: 'image/*,.heic,.heif',
  pdf: '.pdf,application/pdf',
  doc: '.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  spreadsheet: '.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: '.zip,application/zip,application/x-zip-compressed',
};

export default function FileUploadField({ settings, value, onChange, readOnly }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const safeSettings = useMemo(() => ({
    maxFiles: settings?.maxFiles ?? 1,
    maxSizeMB: settings?.maxSizeMB ?? 10,
    allowedTypes: settings?.allowedTypes ?? ['image', 'pdf']
  }), [settings]);

  const currentItems = Array.isArray(value) ? value : [];

  useEffect(() => {
    return () => {
      currentItems.forEach(item => {
        if (item.preview && item.preview.startsWith('blob:')) {
          URL.revokeObjectURL(item.preview);
        }
      });
    };
  }, []);

  // PDFの表紙を生成する関数
  const generatePdfThumbnail = async (file: File): Promise<string | undefined> => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      
      const viewport = page.getViewport({ scale: 0.5 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return undefined;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await (page as any).render({ canvasContext: context, viewport } as any).promise;
      return canvas.toDataURL();
    } catch (err) {
      console.error('PDF thumbnail generation failed:', err);
      return undefined;
    }
  };

  const validateFile = (file: File) => {
    if (file.size > safeSettings.maxSizeMB * 1024 * 1024) {
      return `サイズが大きすぎます (${safeSettings.maxSizeMB}MB以下)`;
    }

    const isAllowed = safeSettings.allowedTypes.some(type => {
      if (type === 'image') return file.type.startsWith('image/');
      if (type === 'pdf') return file.type === 'application/pdf' || file.name.endsWith('.pdf');
      if (type === 'doc') return file.name.match(/\.(doc|docx)$/i);
      if (type === 'spreadsheet') return file.name.match(/\.(xls|xlsx)$/i);
      if (type === 'zip') return file.name.endsWith('.zip');
      return false;
    });

    if (!isAllowed) {
      return `許可されていない形式です`;
    }

    return null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawFiles = Array.from(e.target.files || []);
    if (rawFiles.length === 0) return;

    // 🌟 HEIC 変換処理を先行して行う
    const files = await Promise.all(rawFiles.map(async (file) => {
      const isHeic = file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
      
      if (isHeic) {
        try {
          console.log(`[HEIC] Converting ${file.name}...`);
          const resultBlob = await heic2any({
            blob: file,
            toType: 'image/jpeg',
            quality: 0.8
          });
          
          const blob = Array.isArray(resultBlob) ? resultBlob[0] : resultBlob;
          const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
          return new File([blob], newName, { type: 'image/jpeg' });
        } catch (err) {
          console.error('[HEIC Error] Conversion failed, falling back to original:', err);
          return file;
        }
      }
      return file;
    }));

    const newItems: FileItem[] = [...currentItems];

    for (const file of files) {
      const fileError = validateFile(file);
      const isImage = file.type.startsWith('image/');
      const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');
      
      let preview: string | undefined = undefined;
      if (isImage) {
        preview = URL.createObjectURL(file);
      } else if (isPdf && !fileError) {
        preview = await generatePdfThumbnail(file);
      }
      
      newItems.push({
        id: crypto.randomUUID(),
        file: file,
        preview,
        name: file.name,
        type: file.type,
        size: file.size,
        error: fileError || undefined
      });
    }

    onChange(newItems);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeItem = (id: string) => {
    const item = currentItems.find(i => i.id === id);
    if (item?.preview && item.preview.startsWith('blob:')) {
      URL.revokeObjectURL(item.preview);
    }
    
    const newItems = currentItems.filter(i => i.id !== id);
    onChange(newItems);
  };

  const acceptString = safeSettings.allowedTypes.map(t => ACCEPT_TYPES[t]).filter(Boolean).join(',');

  const totalError = useMemo(() => {
    if (currentItems.length > safeSettings.maxFiles) {
      return `最大 ${safeSettings.maxFiles} 個までです（現在 ${currentItems.length} 個選択中）`;
    }
    return null;
  }, [currentItems.length, safeSettings.maxFiles]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {safeSettings.allowedTypes.map(t => (
          <span key={t} className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded font-bold uppercase tracking-wider">
            {TYPE_LABELS[t] || t}
          </span>
        ))}
      </div>

      {currentItems.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {currentItems.map((item, idx) => {
            const isError = !!item.error || (idx >= safeSettings.maxFiles);
            const errorMessage = item.error || (idx >= safeSettings.maxFiles ? "上限数を超えています" : null);
            const isPdf = item.type === 'application/pdf' || item.name.endsWith('.pdf');
            const isImage = item.type?.startsWith('image/');

            return (
              <div 
                key={item.id} 
                className={`relative flex flex-col p-2 bg-white border rounded-2xl group transition-all shadow-sm ${
                  isError ? 'border-red-200 bg-red-50/30' : 'border-gray-200 hover:border-blue-300'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* サムネイル/アイコン */}
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden ${
                    isError ? 'bg-red-100 text-red-500' : 'bg-gray-50 text-blue-500'
                  }`}>
                    {(item.preview || (isImage && (item as any).thumbnailUrl) || (isImage && (item as any).url)) ? (
                      <img src={item.preview || (item as any).thumbnailUrl || (item as any).url} className="w-full h-full object-cover" alt="" />
                    ) : isError ? (
                      <FileWarning className="w-5 h-5" />
                    ) : isPdf ? (
                      <FileText className="w-5 h-5" />
                    ) : (
                      <Paperclip className="w-5 h-5" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-bold truncate ${isError ? 'text-red-700' : 'text-gray-700'}`}>
                      {item.name}
                    </p>
                    <p className={`text-[10px] font-medium ${isError ? 'text-red-400' : 'text-gray-400'}`}>
                      {errorMessage || `${(item.size / 1024 / 1024).toFixed(2)} MB`}
                    </p>
                  </div>

                  {!readOnly && (
                    <button
                      onClick={() => removeItem(item.id)}
                      className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors mr-1"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!readOnly && (
        <div 
          onClick={() => fileInputRef.current?.click()}
          className={`
            relative p-8 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 transition-all cursor-pointer
            bg-gray-50/50 border-gray-200 hover:border-blue-400 hover:bg-blue-50 group
            ${totalError ? 'border-red-300 bg-red-50/20' : ''}
          `}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            className="hidden"
            accept={acceptString}
            multiple={true}
          />
          
          <div className={`w-12 h-12 bg-white rounded-2xl shadow-sm border flex items-center justify-center group-hover:scale-110 transition-transform ${
            totalError ? 'border-red-200' : 'border-gray-100'
          }`}>
            <UploadCloud className={`w-6 h-6 ${totalError ? 'text-red-400' : 'text-gray-400 group-hover:text-blue-500'}`} />
          </div>
          <div className="text-center">
            <p className={`text-sm font-bold ${totalError ? 'text-red-600' : 'text-gray-600 group-hover:text-blue-700'}`}>
              ファイルを選択
            </p>
            <p className="text-xs text-gray-400 mt-1">
              最大 {safeSettings.maxFiles} 個（1ファイル最大 {safeSettings.maxSizeMB}MB）
            </p>
          </div>
        </div>
      )}

      {totalError && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 animate-in fade-in slide-in-from-top-1">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <p className="text-xs font-bold">{totalError}</p>
        </div>
      )}

      {!readOnly && currentItems.length === safeSettings.maxFiles && !totalError && (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-100 rounded-xl text-green-700">
          <CheckCircle2 className="w-4 h-4" />
          <p className="text-xs font-bold">上限数に達しました</p>
        </div>
      )}
    </div>
  );
}
