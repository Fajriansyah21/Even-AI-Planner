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
  const [viewMode, setViewMode] = useState<'day' | 'week' | 'month'>('week');
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [selectedEventDetails, setSelectedEventDetails] = useState<CalendarEvent | null>(null);
  const [selectedSessionDetails, setSelectedSessionDetails] = useState<{ task: Task; session: TaskScheduleSession } | null>(null);

  // Compute week days starting from Monday of currentDate's week
  const getWeekDates = (date: Date): Date[] => {
    const current = new Date(date);
    const day = current.getDay();
    // In JS: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(current);
    monday.setDate(current.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);

    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const nextDay = new Date(monday);
      nextDay.setDate(monday.getDate() + i);
      week.push(nextDay);
    }
    return week;
  };

  const weekDates = getWeekDates(currentDate);

  const isSameDay = (d1: Date, d2: Date) => {
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
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

  // Hours to render on weekly grid (08:00 to 19:00)
  const gridHours = Array.from({ length: 12 }, (_, i) => i + 8);

  const getEventsForDay = (day: Date) => {
    return events.filter((e) => {
      const start = new Date(e.startAt);
      return isSameDay(start, day);
    });
  };

  const getSessionsForDay = (day: Date) => {
    return scheduledSessions.filter((item) => {
      const start = new Date(item.session.startAt);
      return isSameDay(start, day);
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
                  </div>
                );
              })}
            </div>

            {/* Time Grid */}
            <div className="relative divide-y divide-[#D9E3EF]">
              {gridHours.map((hour) => {
                const isLunchHour = hour >= preferences.lunchStartHour && hour < preferences.lunchEndHour;

                return (
                  <div key={hour} className="grid grid-cols-[64px_repeat(7,1fr)] min-h-[64px]">
                    {/* Time Label */}
                    <div className="p-2 text-right pr-3 text-[11px] text-[#53657A] font-mono border-r border-[#D9E3EF] select-none bg-[#F8FAFC]">
                      {String(hour).padStart(2, '0')}:00
                    </div>

                    {/* Columns for each day */}
                    {weekDates.map((dayDate, dayIdx) => {
                      const dayEvents = getEventsForDay(dayDate);
                      const daySessions = getSessionsForDay(dayDate);

                      // Events matching this hour slot
                      const hourEvents = dayEvents.filter((e) => {
                        const s = new Date(e.startAt).getHours();
                        return s === hour;
                      });

                      // Sessions matching this hour slot
                      const hourSessions = daySessions.filter((s) => {
                        const sTime = new Date(s.session.startAt).getHours();
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
                          {hourEvents.map((evt) => (
                            <div
                              key={evt.id}
                              onClick={() => setSelectedEventDetails(evt)}
                              className="mb-1 p-2 bg-[#2457A7]/10 hover:bg-[#2457A7]/15 border-l-3 border-[#2457A7] rounded-md cursor-pointer transition-all shadow-2xs text-left"
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-xs font-semibold text-[#172B42] truncate">
                                  {evt.title}
                                </span>
                                <span title="Read-only Google Event">
                                  <Lock size={10} className="text-[#53657A] shrink-0" />
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-[#53657A]">
                                <span className="font-mono">
                                  {new Date(evt.startAt).toLocaleTimeString('id-ID', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                                {evt.meetUrl && (
                                  <span className="flex items-center gap-0.5 text-[#2457A7] font-medium">
                                    <Video size={10} /> Meet
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}

                          {/* Render EVEN Scheduled Task Sessions */}
                          {hourSessions.map(({ task, session }) => {
                            const isDone = session.status === 'COMPLETED';

                            return (
                              <div
                                key={session.id}
                                onClick={() => setSelectedSessionDetails({ task, session })}
                                className={`mb-1 p-2 rounded-md border-l-3 cursor-pointer transition-all shadow-2xs text-left ${
                                  isDone
                                    ? 'bg-slate-100 border-slate-400 text-slate-500 line-through'
                                    : 'bg-[#EAF3FC] hover:bg-[#d8e9fa] border-[#2457A7] text-[#172B42]'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-1">
                                  <span className="text-xs font-semibold truncate leading-tight">
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
                                <div className="flex items-center gap-1.5 mt-1 text-[10px] text-[#53657A]">
                                  <span className="font-mono">
                                    {session.durationMinutes} mnt
                                  </span>
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
        {viewMode === 'day' && (
          <div className="max-w-2xl mx-auto space-y-3">
            <div className="p-4 bg-white border border-[#D9E3EF] rounded-2xl shadow-xs">
              <h3 className="font-bold text-[#172B42] text-sm mb-3 flex items-center justify-between">
                <span>Agenda Hari Ini</span>
                <span className="text-xs text-[#53657A] font-normal">
                  {new Intl.DateTimeFormat('id-ID', { dateStyle: 'full' }).format(currentDate)}
                </span>
              </h3>

              {getEventsForDay(currentDate).length === 0 && getSessionsForDay(currentDate).length === 0 ? (
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
                          {new Date(evt.startAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} -{' '}
                          {new Date(evt.endAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
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
                          </div>
                          <p className="text-[11px] text-[#53657A] mt-0.5">
                            {new Date(session.startAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} -{' '}
                            {new Date(session.endAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
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
        )}

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
                const isCurrent = dayNum === new Date().getDate();

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
                <Clock size={14} className="text-[#2457A7]" />
                <span>
                  {new Date(selectedEventDetails.startAt).toLocaleDateString('id-ID', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {' — '}
                  {new Date(selectedEventDetails.endAt).toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

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
                <Clock size={14} className="text-[#2457A7]" />
                <span>
                  {new Date(selectedSessionDetails.session.startAt).toLocaleDateString('id-ID', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {' — '}
                  {new Date(selectedSessionDetails.session.endAt).toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
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
