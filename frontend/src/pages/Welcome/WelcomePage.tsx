import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function WelcomePage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [phase, setPhase] = useState<'enter' | 'visible' | 'exit'>('enter');

  useEffect(() => {
    // Sequence:
    // 0ms    → 'enter' (everything hidden/scaled-down)
    // 100ms  → 'visible' (logo pops in, tagline fades in)
    // 1900ms → 'exit' (fade out)
    // 2400ms → navigate to next destination
    const t1 = setTimeout(() => setPhase('visible'), 100);
    const t2 = setTimeout(() => setPhase('exit'), 2400);
    
    const t3 = setTimeout(() => {
      if (session) {
        navigate('/home');
      } else {
        navigate('/sign-in');
      }
    }, 2900);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [navigate, session]);

  const isVisible = phase === 'visible';
  const isExit = phase === 'exit';

  return (
    <div
      className={`fixed inset-0 flex flex-col items-center justify-center transition-opacity duration-500 ease-in-out ${isExit ? 'opacity-0' : 'opacity-100'}`}
      style={{ background: 'radial-gradient(ellipse at 50% 45%, #dbeafe 0%, #eff6ff 40%, #ffffff 75%)' }}
    >
      {/* Background decorative orbs */}
      <div className="absolute top-1/4 left-1/4 w-72 h-72 bg-blue-100 rounded-full blur-3xl opacity-70 pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-56 h-56 bg-indigo-100 rounded-full blur-3xl opacity-50 pointer-events-none" />
      <div className="absolute top-2/3 left-1/3 w-40 h-40 bg-sky-100 rounded-full blur-2xl opacity-60 pointer-events-none" />

      {/* Logo container */}
      <div
        className={`transition-all duration-700 ease-out ${
          isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-75'
        }`}
      >
        <div className="w-28 h-28 rounded-3xl overflow-hidden bg-white shadow-2xl shadow-blue-200/60 flex items-center justify-center border border-blue-50">
          <img
            src="/assets/images/SmiRing_logo_temp.png"
            alt="SmiRing"
            className="w-20 h-20 object-contain rounded-2xl"
          />
        </div>
      </div>

      {/* Title & Tagline */}
      <div
        className={`mt-8 text-center transition-all duration-700 delay-200 ease-out ${
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
        }`}
      >
        <h1 className="text-3xl font-black tracking-tight text-gray-900">SmiRing Database</h1>
        <p
          className={`mt-2 text-blue-500 font-bold text-sm tracking-[0.3em] transition-all duration-700 delay-[400ms] ${
            isVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          Archive Experiences, <br/>
          All In One Place
        </p>
      </div>

      {/* Loading dots */}
      <div
        className={`mt-16 flex items-center gap-2 transition-all duration-500 delay-[600ms] ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:0ms]" />
        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:150ms]" />
        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:300ms]" />
      </div>

      {/* Bottom version badge */}
      <div
        className={`absolute bottom-10 transition-all duration-700 delay-[700ms] ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <span className="text-[10px] text-gray-300 font-bold uppercase tracking-[0.2em]">
          SmiRing © 2026
        </span>
      </div>
    </div>
  );
}