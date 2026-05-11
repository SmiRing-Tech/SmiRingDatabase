import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useFeedback } from '../../context/FeedbackContext';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

const FeedbackSystem: React.FC = () => {
  const { state, hideFeedback } = useFeedback();
  const { message, options, isVisible } = state;

  useEffect(() => {
    if (isVisible && options.duration && options.duration > 0) {
      const timer = setTimeout(() => {
        hideFeedback();
      }, options.duration);
      return () => clearTimeout(timer);
    }
  }, [isVisible, options.duration, hideFeedback]);

  const getIcon = () => {
    if (options.emoji) return <span className="text-2xl">{options.emoji}</span>;
    switch (options.type) {
      case 'success': return <CheckCircle2 className="w-5 h-5 text-emerald-500" />;
      case 'error': return <AlertCircle className="w-5 h-5 text-rose-500" />;
      case 'warning': return <AlertTriangle className="w-5 h-5 text-amber-500" />;
      default: return <Info className="w-5 h-5 text-blue-500" />;
    }
  };

  const getColors = () => {
    switch (options.type) {
      case 'success': return 'bg-white/90 border-emerald-100 text-emerald-900 shadow-emerald-100/50';
      case 'error': return 'bg-white/90 border-rose-100 text-rose-900 shadow-rose-100/50';
      case 'warning': return 'bg-white/90 border-amber-100 text-amber-900 shadow-amber-100/50';
      default: return 'bg-white/90 border-blue-100 text-blue-900 shadow-blue-100/50';
    }
  };

  return (
    <AnimatePresence mode="wait">
      {isVisible && (
        <>
          {/* Backdrop for Splash mode */}
          {options.mode === 'splash' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={hideFeedback}
              className="fixed inset-0 bg-black/20 backdrop-blur-sm z-[100]"
            />
          )}

          <div className={`fixed inset-0 pointer-events-none z-[101] flex flex-col items-center 
            ${options.mode === 'toast' ? 'justify-start items-end p-6' : 
              options.mode === 'banner' ? 'justify-start p-4' : 'justify-center p-6'}`}>
            
            <motion.div
              layout
              initial={
                options.mode === 'toast' ? { x: 100, opacity: 0 } :
                options.mode === 'banner' ? { y: -100, opacity: 0 } :
                { scale: 0.8, opacity: 0 }
              }
              animate={
                options.mode === 'toast' ? { x: 0, opacity: 1 } :
                options.mode === 'banner' ? { y: 0, opacity: 1 } :
                { scale: 1, opacity: 1 }
              }
              exit={
                options.mode === 'toast' ? { x: 100, opacity: 0 } :
                options.mode === 'banner' ? { y: -100, opacity: 0 } :
                { scale: 0.8, opacity: 0, transition: { duration: 0.2 } }
              }
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              className={`
                pointer-events-auto
                max-w-md w-full
                flex items-center gap-4 p-4 rounded-2xl border
                backdrop-blur-md shadow-xl
                ${getColors()}
                ${options.mode === 'splash' ? 'flex-col text-center p-8 border-none bg-white/95 scale-110' : ''}
              `}
            >
              <div className={`${options.mode === 'splash' ? 'mb-2' : ''}`}>
                {getIcon()}
              </div>

              <div className="flex-1">
                {options.mode === 'splash' && (
                  <div className="text-xs font-bold uppercase tracking-widest text-emerald-500 mb-1">
                    Success
                  </div>
                )}
                <p className={`font-medium leading-relaxed ${options.mode === 'splash' ? 'text-lg' : 'text-sm'}`}>
                  {message}
                </p>
              </div>

              {options.mode !== 'splash' && (
                <button
                  onClick={hideFeedback}
                  className="p-1 hover:bg-black/5 rounded-full transition-colors"
                >
                  <X className="w-4 h-4 opacity-40" />
                </button>
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
};

export default FeedbackSystem;
