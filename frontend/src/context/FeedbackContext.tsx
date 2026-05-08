import React, { createContext, useContext, useState, useCallback } from 'react';

export type FeedbackMode = 'toast' | 'banner' | 'splash';
export type FeedbackType = 'success' | 'error' | 'info' | 'warning';

interface FeedbackOptions {
  mode?: FeedbackMode;
  type?: FeedbackType;
  duration?: number;
  emoji?: string;
}

interface FeedbackState {
  message: string;
  options: FeedbackOptions;
  isVisible: boolean;
}

interface FeedbackContextType {
  showFeedback: (message: string, options?: FeedbackOptions) => void;
  hideFeedback: () => void;
  state: FeedbackState;
}

const FeedbackContext = createContext<FeedbackContextType | undefined>(undefined);

export const FeedbackProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<FeedbackState>({
    message: '',
    options: {},
    isVisible: false,
  });

  const showFeedback = useCallback((message: string, options: FeedbackOptions = {}) => {
    // デフォルト設定
    const mode = options.mode || (options.type === 'error' ? 'banner' : 'toast');
    const type = options.type || 'info';
    const duration = options.duration || (mode === 'splash' ? 4000 : 3000);

    setState({
      message,
      options: {
        mode,
        type,
        duration,
        emoji: options.emoji,
      },
      isVisible: true,
    });
  }, []);

  const hideFeedback = useCallback(() => {
    setState((prev) => ({ ...prev, isVisible: false }));
  }, []);

  return (
    <FeedbackContext.Provider value={{ showFeedback, hideFeedback, state }}>
      {children}
    </FeedbackContext.Provider>
  );
};

export const useFeedback = () => {
  const context = useContext(FeedbackContext);
  if (!context) {
    throw new Error('useFeedback must be used within a FeedbackProvider');
  }
  return context;
};
