import React from 'react';
import {
  Calendar,
  CheckSquare,
  Sparkles,
  Settings,
  BookmarkCheck,
  CheckCircle2,
  AlertCircle,
  LogOut,
  StickyNote,
} from 'lucide-react';
import { UserPreferences } from '../types';

interface SidebarProps {
  currentTab: 'calendar' | 'tasks' | 'keep' | 'ai' | 'settings';
  onSelectTab: (tab: 'calendar' | 'tasks' | 'keep' | 'ai' | 'settings') => void;
  pendingTasksCount: number;
  keepNotesCount: number;
  preferences: UserPreferences;
  onOpenAuth: (mode: 'login' | 'register') => void;
  onLogout: () => void;
  isLoggedIn: boolean;
  hasGoogleAccessToken: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  pendingTasksCount,
  keepNotesCount,
  preferences,
  onOpenAuth,
  onLogout,
  isLoggedIn,
  hasGoogleAccessToken,
}) => {
  const navItems = [
    {
      id: 'calendar' as const,
      label: 'Kalender',
      icon: Calendar,
      badge: null,
      subtitle: 'Ruang Kerja Utama',
    },
    {
      id: 'tasks' as const,
      label: 'Daftar Tugas',
      icon: CheckSquare,
      badge: pendingTasksCount > 0 ? pendingTasksCount : null,
      subtitle: 'Durasi & Tenggat',
    },
    {
      id: 'keep' as const,
      label: 'Google Keep',
      icon: StickyNote,
      badge: keepNotesCount > 0 ? keepNotesCount : null,
      badgeClass: 'bg-amber-100 text-[#B86B12]',
      subtitle: 'Catatan & Ide Cepat',
    },
    {
      id: 'ai' as const,
      label: 'Asisten AI',
      icon: Sparkles,
      badge: 'Cerdas',
      badgeClass: 'bg-[#EAF3FC] text-[#2457A7]',
      subtitle: 'Perencana Niat',
    },
    {
      id: 'settings' as const,
      label: 'Pengaturan',
      icon: Settings,
      badge: null,
      subtitle: 'Jam Kerja & Firebase',
    },
  ];

  return (
    <aside className="w-64 h-screen bg-[#F8FAFC] border-r border-[#D9E3EF] flex flex-col justify-between p-4 shrink-0 select-none">
      {/* Top Branding & Product Identity */}
      <div>
        <div className="flex items-center gap-3 px-2 py-3 mb-5">
          <div className="w-9 h-9 rounded-xl bg-[#2457A7] text-white flex items-center justify-center font-editorial text-2xl font-bold shadow-xs">
            E
          </div>
          <div>
            <h1 className="font-editorial text-2xl font-bold text-[#172B42] tracking-tight leading-none">
              EVEN
            </h1>
            <p className="text-[11px] font-sans-ui text-[#53657A] tracking-wide mt-0.5">
              Personal Planner
            </p>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="space-y-1" aria-label="Navigasi Utama">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left transition-all text-sm font-medium ${
                  isActive
                    ? 'bg-[#EAF3FC] text-[#2457A7] shadow-xs'
                    : 'text-[#53657A] hover:text-[#172B42] hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    size={17}
                    className={isActive ? 'text-[#2457A7]' : 'text-[#53657A]'}
                  />
                  <div>
                    <span className="block leading-tight">{item.label}</span>
                    <span className="text-[10px] text-[#53657A]/80 font-normal">
                      {item.subtitle}
                    </span>
                  </div>
                </div>

                {item.badge !== null && (
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      item.badgeClass || (isActive ? 'bg-[#2457A7] text-white' : 'bg-slate-200 text-[#172B42]')
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Integration Status & User Identity */}
      <div className="space-y-3 pt-3 border-t border-[#D9E3EF]">
        {/* Google Calendar Status Badge */}
        <div className="p-3 bg-white border border-[#D9E3EF] rounded-xl text-xs space-y-1.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[#172B42] flex items-center gap-1.5">
              <Calendar size={13} className="text-[#2457A7]" />
              Google Calendar
            </span>
            {hasGoogleAccessToken ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#16856B]">
                <CheckCircle2 size={11} /> Live OAuth
              </span>
            ) : preferences.googleCalendarConnected ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#2457A7]">
                <CheckCircle2 size={11} /> Terhubung
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#B86B12]">
                <AlertCircle size={11} /> Terputus
              </span>
            )}
          </div>
          <p className="text-[11px] text-[#53657A] leading-tight">
            {hasGoogleAccessToken
              ? 'Token Google Calendar aktif untuk sinkronisasi langsung.'
              : 'Firestore & Calendar sinkronisasi tersambung.'}
          </p>
        </div>

        {/* User Profile Card */}
        {isLoggedIn ? (
          <div className="p-2.5 bg-white border border-[#D9E3EF] rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-full bg-[#2457A7] text-white flex items-center justify-center font-bold text-xs shrink-0">
                {preferences.displayName
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#172B42] truncate">
                  {preferences.displayName}
                </p>
                <p className="text-[10px] text-[#53657A] truncate">
                  {preferences.email}
                </p>
              </div>
            </div>
            <button
              onClick={onLogout}
              title="Keluar dari akun"
              className="text-[#53657A] hover:text-[#C43D4B] p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            >
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <button
              onClick={() => onOpenAuth('login')}
              className="w-full py-2 px-3 text-xs font-semibold text-[#2457A7] bg-[#EAF3FC] hover:bg-[#d8e9fa] rounded-xl transition-colors text-center"
            >
              Masuk dengan Google
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
