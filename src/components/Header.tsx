import React from 'react';
import { Plus, Sparkles, RefreshCw, Menu, Calendar } from 'lucide-react';
import { UserPreferences } from '../types';

interface HeaderProps {
  onOpenTaskModal: () => void;
  onOpenAIAssistant: () => void;
  onSyncCalendar: () => void;
  isSyncing: boolean;
  preferences: UserPreferences;
  onToggleMobileMenu: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenTaskModal,
  onOpenAIAssistant,
  onSyncCalendar,
  isSyncing,
  preferences,
  onToggleMobileMenu,
}) => {
  const todayFormatted = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

  return (
    <header className="h-16 px-6 bg-white border-b border-[#D9E3EF] flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3">
        {/* Mobile menu button */}
        <button
          onClick={onToggleMobileMenu}
          className="md:hidden text-[#53657A] hover:text-[#172B42] p-2 rounded-lg hover:bg-slate-100"
          aria-label="Buka menu navigasi"
        >
          <Menu size={20} />
        </button>

        {/* Date and timezone */}
        <div>
          <div className="flex items-center gap-2">
            <span className="font-editorial text-lg text-[#172B42] tracking-tight capitalize">
              {todayFormatted}
            </span>
            <span className="text-[11px] font-sans-ui bg-[#EAF3FC] text-[#2457A7] font-semibold px-2 py-0.5 rounded-md">
              {preferences.timezone.includes('WIB') ? 'WIB' : preferences.timezone}
            </span>
          </div>
          <p className="text-[11px] text-[#53657A]">
            Jam kerja: {String(preferences.workStartHour).padStart(2, '0')}:00 - {String(preferences.workEndHour).padStart(2, '0')}:00
          </p>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2.5">
        {/* Manual Sync Button */}
        {preferences.googleCalendarConnected && (
          <button
            onClick={onSyncCalendar}
            disabled={isSyncing}
            title="Sinkronkan data dengan Google Calendar"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-[#53657A] hover:text-[#172B42] border border-[#D9E3EF] hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={isSyncing ? 'animate-spin text-[#2457A7]' : ''} />
            <span className="hidden sm:inline">{isSyncing ? 'Menyinkronkan...' : 'Sinkron Kalender'}</span>
          </button>
        )}

        {/* AI Planner Quick Action */}
        <button
          onClick={onOpenAIAssistant}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-[#2457A7] bg-[#EAF3FC] hover:bg-[#d9ecfd] transition-colors shadow-2xs"
        >
          <Sparkles size={14} />
          <span className="hidden sm:inline">Rencanakan dengan AI</span>
          <span className="sm:hidden">AI</span>
        </button>

        {/* New Activity Button */}
        <button
          onClick={onOpenTaskModal}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] transition-colors shadow-xs"
        >
          <Plus size={15} />
          <span>Kegiatan Baru</span>
        </button>
      </div>
    </header>
  );
};
