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
  History,
  BarChart2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { UserPreferences } from '../types';

export type SidebarTab = 'calendar' | 'tasks' | 'dashboard' | 'keep' | 'ai' | 'settings' | 'history';

interface SidebarProps {
  currentTab: SidebarTab;
  onSelectTab: (tab: SidebarTab) => void;
  pendingTasksCount: number;
  keepNotesCount: number;
  missedTasksCount?: number;
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
  missedTasksCount = 0,
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
      label: 'Daftar Kegiatan',
      icon: CheckSquare,
      badge: pendingTasksCount > 0 ? pendingTasksCount : null,
      subtitle: 'Durasi & Jadwal',
    },
    {
      id: 'dashboard' as const,
      label: 'Dashboard',
      icon: BarChart2,
      badge: null,
      subtitle: 'Distribusi & Beban',
    },
    {
      id: 'history' as const,
      label: 'Riwayat Kegiatan',
      icon: History,
      badge: missedTasksCount > 0 ? missedTasksCount : null,
      badgeClass: 'bg-amber-100 text-[#B86B12]',
      subtitle: 'Selesai & Terlewat',
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
    <aside className="w-64 h-screen bg-[#F8FAFC] dark:bg-[#0B1120] border-r border-[#D9E3EF] dark:border-slate-800 flex flex-col justify-between p-4 shrink-0 select-none transition-colors duration-200">
      {/* Top Branding & Product Identity */}
      <div>
        <div className="flex items-center gap-3 px-2 py-3 mb-5">
          <div className="w-9 h-9 rounded-xl bg-[#2457A7] text-white flex items-center justify-center font-logo text-2xl font-bold shadow-xs">
            E
          </div>
          <div>
            <h1 className="font-logo text-2xl font-bold text-[#172B42] dark:text-slate-100 tracking-tight leading-none">
              EVEN
            </h1>
            <p className="text-[11px] font-sans-ui text-[#53657A] dark:text-slate-400 tracking-wide mt-0.5">
              Personal Planner
            </p>
          </div>
        </div>

        {/* Navigation Items with Framer Motion transitions */}
        <nav className="space-y-1 relative" aria-label="Navigasi Utama">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;

            return (
              <motion.button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                whileHover={{ x: 2 }}
                whileTap={{ scale: 0.98 }}
                className={`relative w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-[#2457A7] dark:text-blue-400'
                    : 'text-[#53657A] dark:text-slate-400 hover:text-[#172B42] dark:hover:text-slate-100 hover:bg-slate-100/60 dark:hover:bg-slate-800/40'
                }`}
              >
                {/* Framer Motion Active Tab Indicator */}
                {isActive && (
                  <motion.div
                    layoutId="sidebarActivePill"
                    className="absolute inset-0 bg-[#EAF3FC] dark:bg-slate-800/90 border border-[#2457A7]/15 dark:border-blue-500/20 rounded-xl shadow-xs"
                    transition={{ type: 'spring', stiffness: 450, damping: 32 }}
                  />
                )}

                <div className="relative z-10 flex items-center gap-2.5">
                  <Icon
                    size={17}
                    className={isActive ? 'text-[#2457A7] dark:text-blue-400' : 'text-[#53657A] dark:text-slate-400'}
                  />
                  <div>
                    <span className="block leading-tight font-medium">{item.label}</span>
                    <span className="text-[10px] text-[#53657A]/80 dark:text-slate-400/80 font-normal">
                      {item.subtitle}
                    </span>
                  </div>
                </div>

                {item.badge !== null && (
                  <motion.span
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    className={`relative z-10 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      item.badgeClass || (isActive ? 'bg-[#2457A7] text-white' : 'bg-slate-200 dark:bg-slate-700 text-[#172B42] dark:text-slate-200')
                    }`}
                  >
                    {item.badge}
                  </motion.span>
                )}
              </motion.button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Integration Status & User Identity */}
      <div className="space-y-3 pt-3 border-t border-[#D9E3EF] dark:border-slate-800">
        {/* Google Calendar Status Badge */}
        <div className="p-3 bg-white dark:bg-[#0F172A] border border-[#D9E3EF] dark:border-slate-800 rounded-xl text-xs space-y-1.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[#172B42] dark:text-slate-200 flex items-center gap-1.5">
              <Calendar size={13} className="text-[#2457A7] dark:text-blue-400" />
              Google Calendar
            </span>
            {hasGoogleAccessToken ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#16856B] dark:text-emerald-400">
                <CheckCircle2 size={11} /> Terhubung
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#B86B12] dark:text-amber-400">
                <AlertCircle size={11} /> Belum Terhubung
              </span>
            )}
          </div>
          <p className="text-[11px] text-[#53657A] dark:text-slate-400 leading-tight">
            {hasGoogleAccessToken
              ? 'Token Google Calendar aktif untuk sinkronisasi langsung.'
              : 'Hubungkan Google Calendar untuk mendeteksi agenda & mencegah konflik.'}
          </p>
        </div>

        {/* User Profile Card */}
        {isLoggedIn ? (
          <div className="p-2.5 bg-white dark:bg-[#0F172A] border border-[#D9E3EF] dark:border-slate-800 rounded-xl flex items-center justify-between">
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
                <p className="text-xs font-semibold text-[#172B42] dark:text-slate-200 truncate">
                  {preferences.displayName}
                </p>
                <p className="text-[10px] text-[#53657A] dark:text-slate-400 truncate">
                  {preferences.email}
                </p>
              </div>
            </div>
            <button
              onClick={onLogout}
              title="Keluar dari akun"
              className="text-[#53657A] dark:text-slate-400 hover:text-[#C43D4B] p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <button
              onClick={() => onOpenAuth('login')}
              className="w-full py-2 px-3 text-xs font-semibold text-[#2457A7] dark:text-blue-300 bg-[#EAF3FC] dark:bg-blue-950/60 hover:bg-[#d8e9fa] dark:hover:bg-blue-900/60 rounded-xl transition-colors text-center border border-transparent dark:border-blue-800/40"
            >
              Masuk dengan Google
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
