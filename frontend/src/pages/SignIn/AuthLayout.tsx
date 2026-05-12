import type { ReactNode } from 'react';

type AuthLayoutVariant = 'signin' | 'signup' | 'forgot' | 'reset';

type Props = {
  children: ReactNode;
  variant?: AuthLayoutVariant;
};

const variantConfig = {
  signin: {
    panelTitle: 'Welcome back!',
    panelSub: 'あなたの留学生活を、鮮明に。',
  },
  signup: {
    panelTitle: 'Create Account',
    panelSub: 'ようこそ、SmiRingDatabaseへ！',
  },
  forgot: {
    panelTitle: 'Reset Password',
    panelSub: 'パスワードを再設定しましょう！',
  },
  reset: {
    panelTitle: 'Almost there',
    panelSub: '新しいパスワードを設定しましょう！',
  },
};

export default function AuthLayout({ children, variant = 'signin' }: Props) {
  const config = variantConfig[variant];

  return (
    <div className="flex min-h-screen bg-white">
      {/* ===== LEFT: Brand Panel (PC only) ===== */}
      <div className="hidden md:flex w-[45%] relative flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-sky-300 via-sky-400 to-blue-400">
        {/* Decorative orbs */}
        <div className="absolute -top-32 -left-32 w-[28rem] h-[28rem] bg-white/30 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-[-5rem] right-[-5rem] w-96 h-96 bg-white/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute top-1/4 right-1/4 w-64 h-64 bg-sky-100/30 rounded-full blur-2xl pointer-events-none" />

        {/* Content */}
        <div className="relative z-10 px-14 flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-1000">
          {/* Logo large */}
          <div className="w-28 h-28 rounded-3xl overflow-hidden bg-white/30 backdrop-blur-md flex items-center justify-center shadow-2xl border border-white/40 mb-8 transform hover:scale-105 transition-transform duration-500">
            <img
              src="/assets/images/SmiRing_logo_temp.png"
              alt="SmiRing"
              className="w-20 h-20 object-contain rounded-2xl"
            />
          </div>

          {/* Main Title */}
          <div className="space-y-2">
            <h1 className="text-white font-black text-5xl tracking-tight leading-tight drop-shadow-sm">
              SmiRing<br />Database
            </h1>
            
            {/* Divider simple */}
            <div className="w-12 h-1 bg-white/50 mx-auto rounded-full my-6" />

            {/* Catchphrase smaller & elegant */}
            <p className="text-white text-lg font-bold tracking-[0.1em] drop-shadow-sm">
              Archive Experiences
            </p>
            <p className="text-sky-50 text-sm font-medium mt-1">
              All In One Place
            </p>
          </div>
        </div>
      </div>

      {/* ===== RIGHT: Form Panel ===== */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Mobile header (gradient strip) */}
        <div className="md:hidden bg-gradient-to-br from-sky-400 to-blue-500 pt-14 pb-20 px-6 flex flex-col items-center">
          <div className="w-16 h-16 rounded-2xl overflow-hidden bg-white/30 backdrop-blur-sm flex items-center justify-center shadow-xl mb-4 border border-white/20">
            <img
              src="/assets/images/SmiRing_logo_temp.png"
              alt="SmiRing"
              className="w-11 h-11 object-contain rounded-xl"
            />
          </div>
          <p className="text-white font-black text-xl tracking-wide">SmiRing Database</p>
          <p className="text-sky-100/90 text-[10px] mt-1.5 font-bold tracking-widest">
            Archive Experiences, All In One Place
          </p>
        </div>

        {/* Form card — floats up on mobile */}
        <div className="flex-1 flex flex-col items-center justify-center -mt-10 md:mt-0 px-5 md:px-8 pb-8">
          <div
            className="w-full max-w-md
                        bg-white md:bg-transparent
                        rounded-3xl md:rounded-none
                        shadow-2xl md:shadow-none
                        border border-gray-100/80 md:border-0
                        p-7 md:p-0
                        animate-in fade-in slide-in-from-bottom-6 duration-500"
          >
            {/* Panel title visible only on PC */}
            <div className="hidden md:block mb-8">
              <h2 className="text-3xl font-black text-gray-900 leading-tight">{config.panelTitle}</h2>
              <p className="text-gray-500 text-sm mt-1.5">{config.panelSub}</p>
            </div>

            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
