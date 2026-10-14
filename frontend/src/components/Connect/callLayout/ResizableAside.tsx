import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { RESIZE_HANDLE_CLASS, RESIZE_HANDLE_LINE_CLASS, readStoredWidth, startWidthDrag, storeWidth } from './dragResize';

const STORAGE_KEY = 'smiring.layout.sidePanelWidth';
const MIN_WIDTH = 280;
const MAX_WIDTH = 900;
/** Never squeeze the video area narrower than this. */
const MIN_VIDEO_WIDTH = 360;

/**
 * The right-hand dock (chat / participants / profile — one at a time), with a drag handle on its
 * left edge. One width for all three, remembered per browser; double-click the handle to go back
 * to the default. Below `sm` the dock is a full-screen page, so there's no handle there.
 */
export default function ResizableAside({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(() => readStoredWidth(STORAGE_KEY));
  const ref = useRef<HTMLElement>(null);
  // Unset = the original sm:w-80 / md:w-96 widths (the var() fallbacks in the class below).
  const style = (width ? { '--side-w': `${width}px` } : undefined) as CSSProperties | undefined;

  return (
    <aside
      ref={ref}
      style={style}
      className="relative w-full sm:w-[var(--side-w,20rem)] md:w-[var(--side-w,24rem)] sm:max-w-[calc(100vw-360px)] h-full shrink-0 z-30 shadow-2xl animate-in slide-in-from-right duration-200"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        title="ドラッグで幅を変更（ダブルクリックで元に戻す）"
        className={`${RESIZE_HANDLE_CLASS} -left-1`}
        onPointerDown={(e) => {
          const el = ref.current;
          if (!el) return;
          startWidthDrag(e, {
            startWidth: el.getBoundingClientRect().width,
            direction: -1,
            min: MIN_WIDTH,
            max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - MIN_VIDEO_WIDTH)),
            apply: (w) => el.style.setProperty('--side-w', `${w}px`),
            commit: (w) => {
              setWidth(w);
              storeWidth(STORAGE_KEY, w);
            },
          });
        }}
        onDoubleClick={() => {
          ref.current?.style.removeProperty('--side-w');
          setWidth(null);
          storeWidth(STORAGE_KEY, null);
        }}
      >
        <div className={RESIZE_HANDLE_LINE_CLASS} />
      </div>
      {children}
    </aside>
  );
}
