import React, { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Video,
  Users,
  CheckCircle2,
  Clock,
  Sparkles,
  AlertCircle,
  ExternalLink,
  Plus,
  Lock,
} from 'lucide-react';
import { CalendarEvent, Task, TaskScheduleSession, UserPreferences } from '../types';
import {
  normalizeTimezone,
  getZonedDateTimeParts,
  formatInUserTimezone,
  createIsoFromLocalZoned,
} from '../lib/timezone';

interface CalendarViewProps {
  events: CalendarEvent[];
  tasks: Task[];
  preferences: UserPreferences;
  onToggleTaskSessionComplete: (taskId: string, sessionId: string) => void;
  onOpenTaskModal: () => void;
  onSelectSlotToSchedule?: (slotDate: Date, hour: number) => void;
  onOpenAIAssistant: () => void;
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  events,
  tasks,
  preferences,
  onToggleTaskSessionComplete,
  onOpenTaskModal,
  onSelectSlotToSchedule,
  onOpenAIAssistant,
}) => {
  const tz = normalizeTimezone(preferences.timezone);
  const [viewMode, setViewMode] = useState<'day' | 'week' | 'month'>('week');
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [selectedEventDetails, setSelectedEventDetails] = useState<CalendarEvent | null>(null);
  const [selectedSessionDetails, setSelectedSessionDetails] = useState<{ task: Task; session: TaskScheduleSession } | null>(null);

  // Compute week days starting from Monday of currentDate's week in user's timezone
  const getWeekDates = (date: Date): Date[] => {
    const p = getZonedDateTimeParts(date, tz);
    const dUtc = new Date(Date.UTC(p.year, p.month - 1, p.day));
    const dayOfWeek = dUtc.getUTCDay(); // 0 = Sun, 1 = Mon ... 6 = Sat
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const nextUtc = new Date(Date.UTC(p.year, p.month - 1, p.day + diffToMonday + i));
      const wY = nextUtc.getUTCFullYear();
      const wM = nextUtc.getUTCMonth() + 1;
      const wD = nextUtc.getUTCDate();
      const dayIso = createIsoFromLocalZoned(wY, wM, wD, 0, 0, 0, tz);
      week.push(new Date(dayIso));
    }
    return week;
  };

  const weekDates = getWeekDates(currentDate);

  const isSameDay = (d1: Date | string, d2: Date | string) => {
    const p1 = getZonedDateTimeParts(typeof d1 === 'string' ? new Date(d1) : d1, tz);
    const p2 = getZonedDateTimeParts(typeof d2 === 'string' ? new Date(d2) : d2, tz);
    return p1.year === p2.year && p1.month === p2.month && p1.day === p2.day;
  };

  const isToday = (d: Date) => isSameDay(d, new Date());

  const navigateDate = (direction: 'prev' | 'next') => {
    const copy = new Date(currentDate);
    if (viewMode === 'day') {
      copy.setDate(copy.getDate() + (direction === 'next' ? 1 : -1));
    } else if (viewMode === 'week') {
      copy.setDate(copy.getDate() + (direction === 'next' ? 7 : -7));
    } else {
      copy.setMonth(copy.getMonth() + (direction === 'next' ? 1 : -1));
    }
    setCurrentDate(copy);
  };

  const resetToToday = () => {
    setCurrentDate(new Date());
  };

  // Collect all scheduled sessions
  const scheduledSessions: { task: Task; session: TaskScheduleSession }[] = [];
  tasks.forEach((t) => {
    if (t.scheduledSessions) {
      t.scheduledSessions.forEach((s) => {
        if (s.status !== 'CANCELLED') {
          scheduledSessions.push({ task: t, session: s });
        }
      });
    }
  });

  // Hours to render on weekly grid (07:00 to 24:00) so evening & full work commitments are visible
  const gridHours = Array.from({ length: 18 }, (_, i) => i + 7);

  const getEventsForDay = (day: Date) => {
    return events.filter((e) => {
      return isSameDay(e.startAt, day);
    });
  };

  const getSessionsForDay = (day: Date) => {
    return scheduledSessions.filter((item) => {
      return isSameDay(item.session.startAt, day);
    });
  };

  // Format header range
  const formatHeaderRange = () => {
    if (viewMode === 'day') {
      return new Intl.DateTimeFormat('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(currentDate);
    }
    if (viewMode === 'week') {
      const start = weekDates[0];
      const end = weekDates[6];
      const startMonth = start.toLocaleDateString('id-ID', { month: 'short' });
      const endMonth = end.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });
      return `${start.getDate()} ${startMonth} — ${end.getDate()} ${endMonth}`;
    }
    return new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(currentDate);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-hidden">
      {/* Top Toolbar */}
      <div className="p-4 bg-white border-b border-[#D9E3EF] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={resetToToday}
            className="px-3 py-1.5 text-xs font-semibold text-[#172B42] bg-[#F8FAFC] hover:bg-slate-100 border border-[#D9E3EF] rounded-xl transition-colors shadow-2xs"
          >
            Hari Ini
          </button>

          <div className="flex items-center border border-[#D9E3EF] rounded-xl overflow-hidden bg-white">
            <button
              onClick={() => navigateDate('prev')}
              className="p-1.5 hover:bg-slate-50 text-[#53657A] hover:text-[#172B42] transition-colors"
              aria-label="Sebelumnya"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => navigateDate('next')}
              className="p-1.5 hover:bg-slate-50 text-[#53657A] hover:text-[#172B42] transition-colors"
              aria-label="Berikutnya"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <h2 className="text-sm sm:text-base font-bold text-[#172B42] tracking-tight">
            {formatHeaderRange()}
          </h2>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-1 p-1 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl text-xs font-medium">
          <button
            onClick={() => setViewMode('day')}
            className={`px-3 py-1 rounded-lg transition-all ${
              viewMode === 'day'
                ? 'bg-white text-[#2457A7] font-semibold shadow-2xs'
                : 'text-[#53657A] hover:text-[#172B42]'
            }`}
          >
            Hari
          </button>
          <button
            onClick={() => setViewMode('week')}
            className={`px-3 py-1 rounded-lg transition-all ${
              viewMode === 'week'
                ? 'bg-white text-[#2457A7] font-semibold shadow-2xs'
                : 'text-[#53657A] hover:text-[#172B42]'
            }`}
          >
            Minggu
          </button>
          <button
            onClick={() => setViewMode('month')}
            className={`px-3 py-1 rounded-lg transition-all ${
              viewMode === 'month'
                ? 'bg-white text-[#2457A7] font-semibold shadow-2xs'
                : 'text-[#53657A] hover:text-[#172B42]'
            }`}
          >
            Bulan
          </button>
        </div>
      </div>

      {/* Main Calendar Content Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Weekly View (Primary Desktop Experience) */}
        {viewMode === 'week' && (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl shadow-xs overflow-hidden flex flex-col min-w-[700px]">
            {/* Day Header Row */}
            <div className="grid grid-cols-[64px_repeat(7,1fr)] border-b border-[#D9E3EF] bg-[#F8FAFC]">
              <div className="p-3 text-[11px] font-medium text-[#53657A] border-r border-[#D9E3EF] flex items-center justify-center">
                WIB
              </div>
              {weekDates.map((date, idx) => {
                const today = isToday(date);
                const dayName = new Intl.DateTimeFormat('id-ID', { weekday: 'short' }).format(date);

                // Check if any overnight event or task from previous day finishes on this day
                const dParts = getZonedDateTimeParts(date, tz);
                const hasContinuingOvernight = scheduledSessions.some(({ session }) => {
                  const sParts = getZonedDateTimeParts(new Date(session.startAt), tz);
                  const eParts = getZonedDateTimeParts(new Date(session.endAt), tz);
                  const isEndToday = eParts.year === dParts.year && eParts.month === dParts.month && eParts.day === dParts.day;
                  const isStartEarlier = sParts.year !== dParts.year || sParts.month !== dParts.month || sParts.day !== dParts.day;
                  return isEndToday && isStartEarlier;
                }) || events.some((evt) => {
                  const sParts = getZonedDateTimeParts(new Date(evt.startAt), tz);
                  const eParts = getZonedDateTimeParts(new Date(evt.endAt), tz);
                  const isEndToday = eParts.year === dParts.year && eParts.month === dParts.month && eParts.day === dParts.day;
                  const isStartEarlier = sParts.year !== dParts.year || sParts.month !== dParts.month || sParts.day !== dParts.day;
                  return isEndToday && isStartEarlier;
                });

                return (
                  <div
                    key={idx}
                    className={`p-2.5 text-center border-r border-[#D9E3EF] last:border-r-0 ${
                      today ? 'bg-[#EAF3FC]/50' : ''
                    }`}
                  >
                    <span className="block text-[11px] font-medium text-[#53657A] uppercase tracking-wider">
                      {dayName}
                    </span>
                    <span
                      className={`inline-block mt-0.5 text-sm font-bold w-7 h-7 leading-7 rounded-full ${
                        today
                          ? 'bg-[#2457A7] text-white shadow-xs'
                          : 'text-[#172B42]'
                      }`}
                    >
                      {date.getDate()}
                    </span>
                    {hasContinuingOvernight && (
                      <span
                        className="block mx-auto mt-1 text-[9px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200/80 px-1.5 py-0.2 rounded-full w-fit leading-tight"
                        title="Ada kegiatan malam yang berlanjut hingga pagi hari ini"
                      >
                        🌙 Lanjutan
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Time Grid */}
            <div className="relative divide-y divide-[#D9E3EF]">
              {gridHours.map((hour) => {
                const isLunchHour =
                  preferences.lunchBreakEnabled !== false &&
                  typeof preferences.lunchStartHour === 'number' &&
                  typeof preferences.lunchEndHour === 'number' &&
                  hour >= preferences.lunchStartHour &&
                  hour < preferences.lunchEndHour;

                return (
                  <div key={hour} className="grid grid-cols-[64px_repeat(7,1fr)] min-h-[64px]">
                    {/* Time Label */}
                    <div className="p-2 text-right pr-3 text-[11px] text-[#53657A] font-mono border-r border-[#D9E3EF] select-none bg-[#F8FAFC]">
                      {hour === 24 ? '24:00' : `${String(hour).padStart(2, '0')}:00`}
                    </div>

                    {/* Columns for each day */}
                    {weekDates.map((dayDate, dayIdx) => {
                      const dayEvents = getEventsForDay(dayDate);
                      const daySessions = getSessionsForDay(dayDate);

                      // Events matching this hour slot in user's timezone
                      const hourEvents = dayEvents.filter((e) => {
                        const s = getZonedDateTimeParts(new Date(e.startAt), tz).hour;
                        return s === hour;
                      });

                      // Sessions matching this hour slot in user's timezone
                      const hourSessions = daySessions.filter((s) => {
                        const sTime = getZonedDateTimeParts(new Date(s.session.startAt), tz).hour;
                        return sTime === hour;
                      });

                      return (
                        <div
                          key={dayIdx}
                          className={`p-1 border-r border-[#D9E3EF] last:border-r-0 relative group transition-colors ${
                            isLunchHour ? 'bg-amber-50/40' : 'hover:bg-slate-50/70'
                          }`}
                        >
                          {/* Lunch hour label on first day or subtle watermark */}
                          {isLunchHour && hour === preferences.lunchStartHour && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-40">
                              <span className="text-[10px] font-semibold text-[#B86B12] uppercase tracking-wider">
                                Istirahat
                              </span>
                            </div>
                          )}

                          {/* Render Google Calendar Events */}
                          {hourEvents.map((evt) => {
                            const sParts = getZonedDateTimeParts(new Date(evt.startAt), tz);
                            const eParts = getZonedDateTimeParts(new Date(evt.endAt), tz);
                            const isCross = eParts.day !== sParts.day || eParts.month !== sParts.month || eParts.year !== sParts.year;
                            const startStr = formatInUserTimezone(evt.startAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false });
                            const endStr = formatInUserTimezone(evt.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false });

                            return (
                              <div
                                key={evt.id}
                                onClick={() => setSelectedEventDetails(evt)}
                                className="mb-1 p-2 bg-[#2457A7]/10 hover:bg-[#2457A7]/15 border-l-3 border-[#2457A7] rounded-md cursor-pointer transition-all shadow-2xs text-left"
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-xs font-semibold text-[#172B42] truncate" title={evt.title}>
                                    {evt.title}
                                  </span>
                                  <span title="Read-only Google Event">
                                    <Lock size={10} className="text-[#53657A] shrink-0" />
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-1 mt-0.5 text-[10px] text-[#53657A]">
                                  <span className="font-mono">
                                    {startStr} - {endStr}
                                  </span>
                                  {isCross && (
                                    <span className="bg-indigo-100 text-indigo-800 text-[9px] px-1 py-0.2 rounded font-semibold shrink-0">
                                      🌙 +1 hr
                                    </span>
                                  )}
                                  {evt.meetUrl && (
                                    <span className="flex items-center gap-0.5 text-[#2457A7] font-medium shrink-0">
                                      <Video size={10} /> Meet
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}

                          {/* Render EVEN Scheduled Task Sessions */}
                          {hourSessions.map(({ task, session }) => {
                            const isDone = session.status === 'COMPLETED';
                            const sParts = getZonedDateTimeParts(new Date(session.startAt), tz);
                            const eParts = getZonedDateTimeParts(new Date(session.endAt), tz);
                            const isCross = eParts.day !== sParts.day || eParts.month !== sParts.month || eParts.year !== sParts.year;
                            const startStr = formatInUserTimezone(session.startAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false });
                            const endStr = formatInUserTimezone(session.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false });

                            return (
                              <div
                                key={session.id}
                                onClick={() => setSelectedSessionDetails({ task, session })}
                                className={`mb-1 p-2 rounded-md border-l-3 cursor-pointer transition-all shadow-2xs text-left relative z-10 ${
                                  isDone
                                    ? 'bg-slate-100 border-slate-400 text-slate-500 line-through'
                                    : 'bg-[#EAF3FC] hover:bg-[#d8e9fa] border-[#2457A7] text-[#172B42]'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-1">
                                  <span className="text-xs font-semibold truncate leading-tight" title={session.taskTitle}>
                                    {session.taskTitle}
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onToggleTaskSessionComplete(task.id, session.id);
                                    }}
                                    className="text-[#2457A7] hover:text-[#16856B] shrink-0 mt-0.5"
                                    title={isDone ? 'Tandai belum selesai' : 'Tandai selesai'}
                                  >
                                    <CheckCircle2
                                      size={13}
                                      className={isDone ? 'text-[#16856B] fill-[#16856B]/20' : 'text-[#2457A7]'}
                                    />
                                  </button>
                                </div>
                                <div className="flex items-center justify-between gap-1 mt-0.5 text-[10px] text-[#53657A] font-mono">
                                  <span>{startStr} - {endStr}</span>
                                  {isCross && (
                                    <span className="bg-indigo-100 text-indigo-800 text-[9px] px-1.5 py-0.2 rounded font-semibold font-sans shrink-0">
                                      🌙 +1 hr
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px] text-[#53657A]">
                                  <span className="font-mono">
                                    {session.durationMinutes} mnt
                                  </span>
                                  {isCross && (
                                    <span className="text-indigo-700 text-[9px] font-medium">
                                      (Selesai esok {endStr})
                                    </span>
                                  )}
                                  {session.totalSessions > 1 && (
                                    <span className="bg-white/80 px-1 rounded text-[9px] font-medium text-[#2457A7]">
                                      Sesi {session.sessionIndex}/{session.totalSessions}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}

                          {/* Quick Add Button on Hover when slot is empty */}
                          {hourEvents.length === 0 && hourSessions.length === 0 && !isLunchHour && (
                            <button
                              onClick={() => {
                                if (onSelectSlotToSchedule) {
                                  onSelectSlotToSchedule(dayDate, hour);
                                } else {
                                  onOpenTaskModal();
                                }
                              }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity w-full h-full min-h-[30px] flex items-center justify-center text-[#53657A] hover:text-[#2457A7] hover:bg-[#EAF3FC]/40 rounded-sm text-[11px]"
                              title="Jadwalkan tugas di slot ini"
                            >
                              <Plus size={14} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Daily Agenda View (Mobile priority) */}
        {viewMode === 'day' && (() => {
          const curParts = getZonedDateTimeParts(currentDate, tz);
          const dayEvents = getEventsForDay(currentDate);
          const daySessions = getSessionsForDay(currentDate);

          // Find activities from yesterday night that continue into today
          const continuingIntoToday = [
            ...scheduledSessions
              .filter(({ session }) => {
                const sParts = getZonedDateTimeParts(new Date(session.startAt), tz);
                const eParts = getZonedDateTimeParts(new Date(session.endAt), tz);
                const isEndToday = eParts.year === curParts.year && eParts.month === curParts.month && eParts.day === curParts.day;
                const isStartEarlier = sParts.year !== curParts.year || sParts.month !== curParts.month || sParts.day !== curParts.day;
                return isEndToday && isStartEarlier;
              })
              .map(({ session, task }) => ({
                id: session.id,
                title: session.taskTitle,
                type: 'Fokus EVEN',
                startTime: formatInUserTimezone(session.startAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false }),
                endTime: formatInUserTimezone(session.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false }),
                duration: session.durationMinutes,
                task,
                session,
              })),
            ...events
              .filter((evt) => {
                const sParts = getZonedDateTimeParts(new Date(evt.startAt), tz);
                const eParts = getZonedDateTimeParts(new Date(evt.endAt), tz);
                const isEndToday = eParts.year === curParts.year && eParts.month === curParts.month && eParts.day === curParts.day;
                const isStartEarlier = sParts.year !== curParts.year || sParts.month !== curParts.month || sParts.day !== curParts.day;
                return isEndToday && isStartEarlier;
              })
              .map((evt) => ({
                id: evt.id,
                title: evt.title,
                type: 'Rapat Google',
                startTime: formatInUserTimezone(evt.startAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false }),
                endTime: formatInUserTimezone(evt.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false }),
                duration: Math.round((new Date(evt.endAt).getTime() - new Date(evt.startAt).getTime()) / 60000),
                evt,
              })),
          ];

          const isDayEmpty = dayEvents.length === 0 && daySessions.length === 0 && continuingIntoToday.length === 0;

          return (
            <div className="max-w-2xl mx-auto space-y-3">
              <div className="p-4 bg-white border border-[#D9E3EF] rounded-2xl shadow-xs">
                <h3 className="font-bold text-[#172B42] text-sm mb-3 flex items-center justify-between">
                  <span>Agenda Hari Ini</span>
                  <span className="text-xs text-[#53657A] font-normal">
                    {new Intl.DateTimeFormat('id-ID', { dateStyle: 'full' }).format(currentDate)}
                  </span>
                </h3>

                {/* Overnight continuation banner if activities from yesterday continue into today */}
                {continuingIntoToday.length > 0 && (
                  <div className="p-3 bg-indigo-50/80 border border-indigo-200/80 rounded-xl space-y-2 mb-3">
                    <div className="flex items-center gap-1.5 font-bold text-indigo-900 text-[11px] uppercase tracking-wider">
                      <Clock size={13} className="text-indigo-600" />
                      <span>Lanjutan Kegiatan dari Kemarin Malam</span>
                    </div>
                    <div className="space-y-1.5">
                      {continuingIntoToday.map((c) => (
                        <div
                          key={c.id}
                          onClick={() => {
                            if ('session' in c && c.task && c.session) {
                              setSelectedSessionDetails({ task: c.task, session: c.session });
                            } else if ('evt' in c && c.evt) {
                              setSelectedEventDetails(c.evt);
                            }
                          }}
                          className="flex items-center justify-between text-xs bg-white/90 p-2.5 rounded-lg border border-indigo-100 hover:border-indigo-300 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.2 rounded font-medium">
                              🌙 Lanjutan
                            </span>
                            <span className="font-semibold text-[#172B42]">{c.title}</span>
                          </div>
                          <span className="text-[11px] font-mono text-[#53657A]">
                            Mulai kemarin {c.startTime} → Selesai hari ini pukul {c.endTime} WIB
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {isDayEmpty ? (
                  <div className="py-10 text-center text-[#53657A]">
                    <CalendarIcon className="w-8 h-8 mx-auto text-[#8DBCEB] mb-2 opacity-60" />
                    <p className="text-xs font-medium text-[#172B42]">Tidak ada agenda atau tugas hari ini.</p>
                    <p className="text-[11px] mt-1">Gunakan tombol &ldquo;+ Tugas Baru&rdquo; atau minta AI merencanakan hari Anda.</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                  {/* Google Events */}
                  {getEventsForDay(currentDate).map((evt) => (
                    <div
                      key={evt.id}
                      onClick={() => setSelectedEventDetails(evt)}
                      className="p-3 bg-[#2457A7]/5 border-l-4 border-[#2457A7] rounded-xl flex items-center justify-between cursor-pointer hover:bg-[#2457A7]/10 transition-colors"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-[#172B42]">{evt.title}</span>
                          <span className="text-[10px] bg-white border border-[#D9E3EF] text-[#53657A] px-1.5 py-0.2 rounded font-medium">
                            Rapat Google
                          </span>
                        </div>
                        <p className="text-[11px] text-[#53657A] mt-0.5">
                          {formatInUserTimezone(evt.startAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false })} -{' '}
                          {formatInUserTimezone(evt.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false })} WIB
                          {evt.location && ` • ${evt.location}`}
                        </p>
                      </div>
                      {evt.meetUrl && (
                        <a
                          href={evt.meetUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1 text-xs text-[#2457A7] bg-white px-2.5 py-1.5 rounded-lg border border-[#D9E3EF] font-medium"
                        >
                          <Video size={13} /> Gabung Meet
                        </a>
                      )}
                    </div>
                  ))}

                  {/* EVEN Task Sessions */}
                  {getSessionsForDay(currentDate).map(({ task, session }) => {
                    const isDone = session.status === 'COMPLETED';
                    const sParts = getZonedDateTimeParts(new Date(session.startAt), tz);
                    const eParts = getZonedDateTimeParts(new Date(session.endAt), tz);
                    const isCross = eParts.day !== sParts.day || eParts.month !== sParts.month;

                    return (
                      <div
                        key={session.id}
                        onClick={() => setSelectedSessionDetails({ task, session })}
                        className={`p-3 border-l-4 rounded-xl flex items-center justify-between cursor-pointer transition-colors ${
                          isDone
                            ? 'bg-slate-50 border-slate-300 opacity-60'
                            : 'bg-[#EAF3FC] border-[#2457A7] hover:bg-[#d8e9fa]'
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-bold ${isDone ? 'line-through text-slate-500' : 'text-[#172B42]'}`}>
                              {session.taskTitle}
                            </span>
                            <span className="text-[10px] bg-[#2457A7] text-white px-1.5 py-0.2 rounded-full font-medium">
                              Fokus EVEN
                            </span>
                            {isCross && (
                              <span className="text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.2 rounded-md font-medium">
                                🌙 +1 hari
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-[#53657A] mt-0.5">
                            {formatInUserTimezone(session.startAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false })} -{' '}
                            {formatInUserTimezone(session.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false })} WIB
                            {isCross && ' (+1 hari)'}
                            {` • ${session.durationMinutes} menit`}
                            {session.totalSessions > 1 && ` (Sesi ${session.sessionIndex}/${session.totalSessions})`}
                          </p>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleTaskSessionComplete(task.id, session.id);
                          }}
                          className="p-1.5 text-[#2457A7] hover:text-[#16856B]"
                        >
                          <CheckCircle2 size={18} className={isDone ? 'text-[#16856B]' : 'text-[#2457A7]'} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

        {/* Monthly View */}
        {viewMode === 'month' && (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl shadow-xs p-4">
            <div className="grid grid-cols-7 gap-2 text-center text-xs font-medium text-[#53657A] mb-2 pb-2 border-b border-[#D9E3EF]">
              <span>Sen</span>
              <span>Sel</span>
              <span>Rab</span>
              <span>Kam</span>
              <span>Jum</span>
              <span>Sab</span>
              <span>Min</span>
            </div>
            <div className="grid grid-cols-7 gap-2">
              {Array.from({ length: 35 }).map((_, i) => {
                const dayNum = (i % 31) + 1;
                const isCurrent = dayNum === getZonedDateTimeParts(new Date(), tz).day;

                return (
                  <div
                    key={i}
                    onClick={() => {
                      const d = new Date(currentDate);
                      d.setDate(dayNum);
                      setCurrentDate(d);
                      setViewMode('day');
                    }}
                    className={`min-h-[75px] p-2 border rounded-xl cursor-pointer hover:border-[#2457A7] transition-all flex flex-col justify-between ${
                      isCurrent ? 'bg-[#EAF3FC]/50 border-[#2457A7]' : 'border-[#D9E3EF]/70 bg-white'
                    }`}
                  >
                    <span className={`text-xs font-bold ${isCurrent ? 'text-[#2457A7]' : 'text-[#172B42]'}`}>
                      {dayNum}
                    </span>
                    <div className="space-y-1">
                      {isCurrent && (
                        <div className="text-[10px] bg-[#2457A7] text-white px-1 py-0.5 rounded-sm truncate">
                          Hari ini
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Event Details Drawer/Modal */}
      {selectedEventDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold bg-[#2457A7]/10 text-[#2457A7] px-2 py-0.5 rounded-full">
                  Google Calendar
                </span>
                <h3 className="text-base font-bold text-[#172B42] mt-1.5">
                  {selectedEventDetails.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedEventDetails(null)}
                className="text-[#53657A] hover:text-[#172B42] p-1"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-[#53657A] space-y-2">
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-[#2457A7] shrink-0" />
                <span>
                  {formatInUserTimezone(selectedEventDetails.startAt, tz, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                  {' — '}
                  {formatInUserTimezone(selectedEventDetails.endAt, tz, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })} WIB
                </span>
              </div>

              {(() => {
                const sParts = getZonedDateTimeParts(new Date(selectedEventDetails.startAt), tz);
                const eParts = getZonedDateTimeParts(new Date(selectedEventDetails.endAt), tz);
                const isCross = eParts.day !== sParts.day || eParts.month !== sParts.month || eParts.year !== sParts.year;
                if (!isCross) return null;
                return (
                  <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center gap-2 text-xs text-indigo-900">
                    <Clock size={14} className="text-indigo-600 shrink-0" />
                    <span>
                      Rapat ini berlangsung melintasi tengah malam hingga pagi hari berikutnya (berakhir pukul{' '}
                      {formatInUserTimezone(selectedEventDetails.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false })} WIB).
                    </span>
                  </div>
                );
              })()}

              {selectedEventDetails.attendees && (
                <div className="flex items-start gap-2 pt-1">
                  <Users size={14} className="text-[#2457A7] mt-0.5" />
                  <div>
                    <span className="font-semibold text-[#172B42] block">Peserta ({selectedEventDetails.attendees.length}):</span>
                    <ul className="list-disc list-inside mt-0.5 space-y-0.5 text-slate-600">
                      {selectedEventDetails.attendees.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>

            {selectedEventDetails.meetUrl && (
              <a
                href={selectedEventDetails.meetUrl}
                target="_blank"
                rel="noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-[#2457A7] hover:bg-[#1E4889] text-white py-2.5 px-4 rounded-xl text-xs font-semibold transition-colors"
              >
                <Video size={14} /> Buka Google Meet
              </a>
            )}
          </div>
        </div>
      )}

      {/* Task Session Details Drawer/Modal */}
      {selectedSessionDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-full">
                  Jadwal Sesi EVEN
                </span>
                <h3 className="text-base font-bold text-[#172B42] mt-1.5">
                  {selectedSessionDetails.session.taskTitle}
                </h3>
              </div>
              <button
                onClick={() => setSelectedSessionDetails(null)}
                className="text-[#53657A] hover:text-[#172B42] p-1"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-[#53657A] space-y-2">
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-[#2457A7] shrink-0" />
                <span>
                  {formatInUserTimezone(selectedSessionDetails.session.startAt, tz, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                  {' — '}
                  {formatInUserTimezone(selectedSessionDetails.session.endAt, tz, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })} WIB
                </span>
              </div>

              {(() => {
                const sParts = getZonedDateTimeParts(new Date(selectedSessionDetails.session.startAt), tz);
                const eParts = getZonedDateTimeParts(new Date(selectedSessionDetails.session.endAt), tz);
                const isCross = eParts.day !== sParts.day || eParts.month !== sParts.month || eParts.year !== sParts.year;
                if (!isCross) return null;
                return (
                  <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center gap-2 text-xs text-indigo-900">
                    <Clock size={14} className="text-indigo-600 shrink-0" />
                    <span>
                      Kegiatan ini berlangsung melintasi tengah malam hingga pagi hari berikutnya (berakhir pukul{' '}
                      {formatInUserTimezone(selectedSessionDetails.session.endAt, tz, { hour: '2-digit', minute: '2-digit', hour12: false })} WIB).
                    </span>
                  </div>
                );
              })()}

              <p>
                Durasi pengerjaan: <strong className="text-[#172B42]">{selectedSessionDetails.session.durationMinutes} menit</strong>
                {selectedSessionDetails.session.totalSessions > 1 && ` (Bagian ${selectedSessionDetails.session.sessionIndex} dari ${selectedSessionDetails.session.totalSessions} sesi)`}
              </p>
            </div>

            <div className="pt-2 flex items-center gap-2">
              <button
                onClick={() => {
                  onToggleTaskSessionComplete(
                    selectedSessionDetails.task.id,
                    selectedSessionDetails.session.id
                  );
                  setSelectedSessionDetails(null);
                }}
                className="flex-1 py-2.5 px-4 bg-[#16856B] hover:bg-[#126E58] text-white rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
              >
                <CheckCircle2 size={14} />
                {selectedSessionDetails.session.status === 'COMPLETED' ? 'Tandai Belum Selesai' : 'Selesaikan Sesi Ini'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
