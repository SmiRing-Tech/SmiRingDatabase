import { useCallback, useEffect, useState } from 'react';

export function useDocumentPiP() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [isPipActive, setIsPipActive] = useState(false);

  const isSupported =
    typeof window !== 'undefined' &&
    'documentPictureInPicture' in window &&
    typeof window.documentPictureInPicture?.requestWindow === 'function';

  const copyStylesToWindow = useCallback((targetWindow: Window) => {
    // 1. Copy all <link rel="stylesheet"> elements and wait for them to finish
    // loading before the caller renders content into the window — otherwise the
    // portal content paints before the CSS is ready and the layout looks broken
    // for a frame (or more, on a slow network).
    const linkLoadPromises: Promise<void>[] = [];
    document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const clonedLink = link.cloneNode(true) as HTMLLinkElement;
      linkLoadPromises.push(
        new Promise<void>((resolve) => {
          clonedLink.addEventListener('load', () => resolve(), { once: true });
          clonedLink.addEventListener('error', () => resolve(), { once: true });
        }),
      );
      targetWindow.document.head.appendChild(clonedLink);
    });

    // 2. Copy all inline <style> elements
    document.querySelectorAll('style').forEach((style) => {
      const clonedStyle = style.cloneNode(true) as HTMLStyleElement;
      targetWindow.document.head.appendChild(clonedStyle);
    });

    // 3. Fallback: Copy rules from document.styleSheets for dynamic CSS (e.g. CSS-in-JS, Tailwind)
    try {
      Array.from(document.styleSheets).forEach((sheet) => {
        try {
          if (sheet.cssRules) {
            const newStyle = targetWindow.document.createElement('style');
            const rules = Array.from(sheet.cssRules)
              .map((rule) => rule.cssText)
              .join('\n');
            newStyle.textContent = rules;
            targetWindow.document.head.appendChild(newStyle);
          }
        } catch {
          // Ignore CORS-restricted external stylesheets (already handled via <link>)
        }
      });
    } catch (e) {
      console.warn('[PiP] Error copying stylesheet rules:', e);
    }

    // Inline <style> and cssRules copies above are synchronous, so as long as we
    // wait for the <link> stylesheets the window is fully styled once this resolves.
    return Promise.all(linkLoadPromises);
  }, []);

  const openPip = useCallback(
    async (options?: { width?: number; height?: number }) => {
      if (!isSupported || !window.documentPictureInPicture) {
        console.warn('[PiP] Document Picture-in-Picture API is not supported in this browser.');
        return null;
      }

      try {
        // If already open, close the old one
        if (pipWindow && !pipWindow.closed) {
          pipWindow.close();
        }

        const win = await window.documentPictureInPicture.requestWindow({
          width: options?.width ?? 380,
          height: options?.height ?? 620,
        });

        // Copy styles and wait for them to load before showing content, to avoid
        // a flash of unstyled / broken layout in the PiP window.
        await copyStylesToWindow(win);

        // Basic body styling for dark mode consistency
        win.document.body.style.margin = '0';
        win.document.body.style.padding = '0';
        win.document.body.style.backgroundColor = '#0f1115';
        win.document.body.style.color = '#ffffff';
        win.document.body.style.height = '100vh';
        win.document.body.style.overflow = 'hidden';
        win.document.body.setAttribute('data-lk-theme', 'default');
        win.document.title = 'SmiRing Connect (PiP)';

        const handlePageHide = () => {
          try {
            window.focus();
          } catch {}
          setPipWindow(null);
          setIsPipActive(false);
        };

        win.addEventListener('pagehide', handlePageHide);

        setPipWindow(win);
        setIsPipActive(true);
        return win;
      } catch (err) {
        console.error('[PiP] Failed to open Document Picture-in-Picture window:', err);
        return null;
      }
    },
    [isSupported, pipWindow, copyStylesToWindow],
  );

  const closePip = useCallback(() => {
    try {
      window.focus();
    } catch {}
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }
    setPipWindow(null);
    setIsPipActive(false);
  }, [pipWindow]);

  const togglePip = useCallback(
    async (options?: { width?: number; height?: number }) => {
      if (isPipActive && pipWindow && !pipWindow.closed) {
        closePip();
      } else {
        await openPip(options);
      }
    },
    [isPipActive, pipWindow, closePip, openPip],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pipWindow && !pipWindow.closed) {
        pipWindow.close();
      }
    };
  }, [pipWindow]);

  return {
    isSupported,
    isPipActive,
    pipWindow,
    openPip,
    closePip,
    togglePip,
  };
}
