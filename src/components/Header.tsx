import React from 'react';
import { Plus, Sparkles, RefreshCw, Menu, Sun, Moon } from 'lucide-react';
import { UserPreferences } from '../types';

interface HeaderProps {
  onOpenTaskModal: () => void;
  onOpenAIAssistant: () => void;
  onSyncCalendar: () => void;
  isSyncing: boolean;
  preferences: UserPreferences;
  onToggleMobileMenu: () => void;
  isDarkMode?: boolean;
  onToggleDarkMode?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenTaskModal,
  onOpenAIAssistant,
  onSyncCalendar,
  isSyncing,
  preferences,
  onToggleMobileMenu,
  isDarkMode = false,
  onToggleDarkMode,
}) => {
  const todayFormatted = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

  return (
    <header className="h-16 px-6 bg-white dark:bg-[#0F172A] border-b border-[#D9E3EF] dark:border-slate-800 flex items-center justify-between shrink-0 transition-colors duration-200">
      <div className="flex items-center gap-3">
        {/* Mobile menu button */}
        <button
          onClick={onToggleMobileMenu}
          className="md:hidden text-[#53657A] dark:text-slate-400 hover:text-[#172B42] dark:hover:text-white p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Buka menu navigasi"
        >
          <Menu size={20} />
        </button>

        {/* Date and timezone */}
        <div>
          <div className="flex items-center gap-2">
            <span className="font-editorial text-lg text-[#172B42] dark:text-slate-100 tracking-tight capitalize">
              {todayFormatted}
            </span>
            <span className="text-[11px] font-sans-ui bg-[#EAF3FC] dark:bg-slate-800 text-[#2457A7] dark:text-blue-400 font-semibold px-2 py-0.5 rounded-md">
              {preferences.timezone.includes('WIB') ? 'WIB' : preferences.timezone}
            </span>
          </div>
          <p className="text-[11px] text-[#53657A] dark:text-slate-400">
            Jam kerja: {String(preferences.workStartHour).padStart(2, '0')}:00 - {String(preferences.workEndHour).padStart(2, '0')}:00
          </p>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 sm:gap-2.5">
        {/* Dark Mode Toggle Button */}
        {onToggleDarkMode && (
          <button
            onClick={onToggleDarkMode}
            title={isDarkMode ? 'Ganti ke Tema Terang' : 'Ganti ke Tema Gelap'}
            className="p-2 rounded-xl text-[#53657A] dark:text-slate-300 hover:text-[#172B42] dark:hover:text-white border border-[#D9E3EF] dark:border-slate-700 bg-white dark:bg-slate-800/80 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
            aria-label={isDarkMode ? 'Tema Terang' : 'Tema Gelap'}
          >
            {isDarkMode ? <Sun size={15} className="text-amber-400" /> : <Moon size={15} className="text-slate-600 dark:text-slate-300" />}
          </button>
        )}

        {/* Manual Sync Button */}
        {preferences.googleCalendarConnected && (
          <button
            onClick={onSyncCalendar}
            disabled={isSyncing}
            title="Sinkronkan data dengan Google Calendar"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-[#53657A] dark:text-slate-300 hover:text-[#172B42] dark:hover:text-white border border-[#D9E3EF] dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={isSyncing ? 'animate-spin text-[#2457A7] dark:text-blue-400' : ''} />
            <span className="hidden sm:inline">{isSyncing ? 'Menyinkronkan...' : 'Sinkron Kalender'}</span>
          </button>
        )}

        {/* AI Planner Quick Action */}
        <button
          onClick={onOpenAIAssistant}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-[#2457A7] dark:text-blue-300 bg-[#EAF3FC] dark:bg-blue-950/60 hover:bg-[#d9ecfd] dark:hover:bg-blue-900/60 transition-colors shadow-2xs border border-transparent dark:border-blue-800/50"
        >
          <Sparkles size={14} />
          <span className="hidden sm:inline">Rencanakan dengan AI</span>
          <span className="sm:hidden">AI</span>
        </button>

        {/* New Activity Button */}
        <button
          onClick={onOpenTaskModal}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] dark:bg-blue-600 dark:hover:bg-blue-700 transition-colors shadow-xs"
        >
          <Plus size={15} />
          <span>Kegiatan Baru</span>
        </button>
      </div>
    </header>
  );
};
