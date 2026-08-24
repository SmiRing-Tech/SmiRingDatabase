import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useInactivityLogout } from '../../hooks/useInactivityLogout';
import AppHeader from './AppHeader';
import ExternalSidebar from './ExternalSidebar';

export default function ExternalLayout() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const location = useLocation();
  const isInConnectRoom = location.pathname.startsWith('/connect/room/');
  useInactivityLogout(!isInConnectRoom);

  return (
    <div className="flex flex-col h-screen w-full bg-slate-50/50 text-gray-900 font-sans">
      <AppHeader onMenuClick={() => setIsSidebarOpen(true)} />

      <div className="flex flex-1 overflow-hidden">
        <ExternalSidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
        <main className="flex-1 overflow-y-auto relative bg-white/50">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
