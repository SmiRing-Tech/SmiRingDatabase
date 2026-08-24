// TypeScript definitions for Document Picture-in-Picture API (Chrome/Edge 116+)

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPictureEventMap {
  enter: Event;
}

interface DocumentPictureInPicture extends EventTarget {
  readonly window: Window | null;
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  onenter: ((this: DocumentPictureInPicture, ev: Event) => any) | null;
  addEventListener<K extends keyof DocumentPictureInPictureEventMap>(
    type: K,
    listener: (this: DocumentPictureInPicture, ev: DocumentPictureInPictureEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof DocumentPictureInPictureEventMap>(
    type: K,
    listener: (this: DocumentPictureInPicture, ev: DocumentPictureInPictureEventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export {};
