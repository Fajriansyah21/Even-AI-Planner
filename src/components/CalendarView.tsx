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
  Layers,
  AlertTriangle,
} from 'lucide-react';
import { CalendarEvent, Task, TaskScheduleSession, UserPreferences } from '../types';
import {
  normalizeTimezone,
  startOfDayInTimezone,
  endOfDayInTimezone,
  getZonedDateTimeParts,
  formatInTimezone,
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

interface SlicedCalendarItem {
  id: string;
  sourceType: 'google' | 'session';
  title: string;
  event?: CalendarEvent;
  task?: Task;
  session?: TaskScheduleSession;
  itemStart: Date;
  itemEnd: Date;
  visibleStart: Date;
  visibleEnd: Date;
  visibleDurationMinutes: number;
  totalDurationMinutes: number;
  topPx: number;
  heightPx: number;
  isContinuedFromYesterday: boolean;
  isContinuedToTomorrow: boolean;
  isDone?: boolean;
  colIndex: number;
  totalCols: number;
  hasConflict: boolean;
}

const ROW_HEIGHT = 56; // 56px per 1 hour slot

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

  // Compute week dates starting from Monday of currentDate
  const getWeekDates = (date: Date): Date[] => {
    const p = getZonedDateTimeParts(date, tz);
    // JS getDay(): 0 is Sunday, 1 is Monday...
    const diffToMonday = p.dayOfWeek === 0 ? -6 : 1 - p.dayOfWeek;
    const monday = new Date(date);
    monday.setDate(date.getDate() + diffToMonday);

    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const nextDay = new Date(monday);
      nextDay.setDate(monday.getDate() + i);
      week.push(nextDay);
    }
    return week;
  };

  const weekDates = getWeekDates(currentDate);

  const isSameCalendarDay = (d1: Date, d2: Date) => {
    const p1 = getZonedDateTimeParts(d1, tz);
    const p2 = getZonedDateTimeParts(d2, tz);
    return p1.year === p2.year && p1.month === p2.month && p1.day === p2.day;
  };

  const isToday = (d: Date) => isSameCalendarDay(d, new Date());

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

  // Collect scheduled sessions from tasks
  const scheduledSessions: { task: Task; session: TaskScheduleSession }[] = [];
  tasks.forEach((t) => {
    if (t.scheduledSessions && t.scheduledSessions.length > 0) {
      t.scheduledSessions.forEach((s) => {
        if (s.status !== 'CANCELLED') {
          scheduledSessions.push({ task: t, session: s });
        }
      });
    }
  });

  // Hours: 01:00 to 24:00 (24 one-hour segments)
  const gridHours = Array.from({ length: 24 }, (_, i) => i + 1);

  // Mathematical slicing of items for any given calendar day [dayStart, dayEnd)
  const getSlicedItemsForDay = (dayDate: Date): SlicedCalendarItem[] => {
    const dayStart = startOfDayInTimezone(dayDate, tz);
    const dayEnd = endOfDayInTimezone(dayDate, tz);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    const rawItems: {
      id: string;
      sourceType: 'google' | 'session';
      title: string;
      event?: CalendarEvent;
      task?: Task;
      session?: TaskScheduleSession;
      start: Date;
      end: Date;
      isDone?: boolean;
    }[] = [];

    // 1. Google & manual calendar events
    for (const evt of events) {
      const s = new Date(evt.startAt);
      const e = new Date(evt.endAt);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
        // Half-open interval intersection: s < dayEnd && e > dayStart
        if (s.getTime() < dayEndMs && e.getTime() > dayStartMs) {
          rawItems.push({
            id: `evt-${evt.id}`,
            sourceType: 'google',
            title: evt.title,
            event: evt,
            start: s,
            end: e,
          });
        }
      }
    }

    // 2. EVEN scheduled sessions
    for (const item of scheduledSessions) {
      const s = new Date(item.session.startAt);
      const e = new Date(item.session.endAt);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
        if (s.getTime() < dayEndMs && e.getTime() > dayStartMs) {
          rawItems.push({
            id: `sess-${item.session.id}`,
            sourceType: 'session',
            title: item.session.taskTitle,
            task: item.task,
            session: item.session,
            start: s,
            end: e,
            isDone: item.session.status === 'COMPLETED',
          });
        }
      }
    }

    // Sort items by start time
    rawItems.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Calculate layout slices
    const slices = rawItems.map((r) => {
      const itemStartMs = r.start.getTime();
      const itemEndMs = r.end.getTime();
      const visibleStartMs = Math.max(itemStartMs, dayStartMs);
      const visibleEndMs = Math.min(itemEndMs, dayEndMs);

      const totalDurationMinutes = Math.round((itemEndMs - itemStartMs) / 60000);
      const visibleDurationMinutes = Math.max(1, Math.round((visibleEndMs - visibleStartMs) / 60000));
      const startMinutesFromMidnight = (visibleStartMs - dayStartMs) / 60000;

      const topPx = (startMinutesFromMidnight / 60) * ROW_HEIGHT;
      // Guarantee minimum height so title & buttons stay legible
      const heightPx = Math.max(26, (visibleDurationMinutes / 60) * ROW_HEIGHT);

      return {
        id: r.id,
        sourceType: r.sourceType,
        title: r.title,
        event: r.event,
        task: r.task,
        session: r.session,
        itemStart: r.start,
        itemEnd: r.end,
        visibleStart: new Date(visibleStartMs),
        visibleEnd: new Date(visibleEndMs),
        visibleDurationMinutes,
        totalDurationMinutes,
        topPx,
        heightPx,
        isContinuedFromYesterday: itemStartMs < dayStartMs,
        isContinuedToTomorrow: itemEndMs > dayEndMs,
        isDone: r.isDone,
        colIndex: 0,
        totalCols: 1,
        hasConflict: false,
      };
    });

    // Conflict detection & column positioning
    for (let i = 0; i < slices.length; i++) {
      const cur = slices[i];
      const overlapping: SlicedCalendarItem[] = [cur];
      for (let j = 0; j < slices.length; j++) {
        if (i === j) continue;
        const other = slices[j];
        if (cur.visibleStart < other.visibleEnd && cur.visibleEnd > other.visibleStart) {
          overlapping.push(other);
          cur.hasConflict = true;
          other.hasConflict = true;
        }
      }
      if (overlapping.length > 1) {
        overlapping.sort((a, b) => a.visibleStart.getTime() - b.visibleStart.getTime());
        overlapping.forEach((item, idx) => {
          item.colIndex = idx;
          item.totalCols = overlapping.length;
        });
      }
    }

    return slices;
  };

  // Format header range
  const formatHeaderRange = () => {
    if (viewMode === 'day') {
      return formatInTimezone(currentDate, tz, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    }
    if (viewMode === 'week') {
      const start = weekDates[0];
      const end = weekDates[6];
      const startMonth = formatInTimezone(start, tz, { month: 'short' });
      const endMonth = formatInTimezone(end, tz, { month: 'short', year: 'numeric' });
      return `${start.getDate()} ${startMonth} — ${end.getDate()} ${endMonth}`;
    }
    return formatInTimezone(currentDate, tz, { month: 'long', year: 'numeric' });
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-hidden select-none">
      {/* Top Toolbar */}
      <div className="h-14 px-6 bg-white border-b border-[#D9E3EF] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={resetToToday}
            className="px-3 py-1.5 text-xs font-semibold text-[#172B42] hover:bg-slate-100 rounded-xl border border-[#D9E3EF] transition-colors"
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

          <h2 className="text-sm sm:text-base font-bold text-[#172B42] font-editorial tracking-tight">
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
        {/* Weekly View (01:00 - 24:00) */}
        {viewMode === 'week' && (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl shadow-xs overflow-hidden flex flex-col min-w-[760px]">
            {/* Day Header Row */}
            <div className="grid grid-cols-[64px_repeat(7,1fr)] border-b border-[#D9E3EF] bg-[#F8FAFC] sticky top-0 z-20">
              <div className="p-3 text-[11px] font-medium text-[#53657A] border-r border-[#D9E3EF] flex items-center justify-center">
                WIB
              </div>
              {weekDates.map((date, idx) => {
                const today = isToday(date);
                const dayName = formatInTimezone(date, tz, { weekday: 'short' });

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

            {/* Time Grid (01:00 to 24:00) */}
            <div className="relative grid grid-cols-[64px_repeat(7,1fr)]" style={{ height: `${24 * ROW_HEIGHT}px` }}>
              {/* Hour Labels Column (Left) */}
              <div className="border-r border-[#D9E3EF] bg-[#F8FAFC] divide-y divide-[#D9E3EF]">
                {gridHours.map((hour) => (
                  <div
                    key={hour}
                    className="text-right pr-2 text-[10px] text-[#53657A] font-mono select-none flex items-start justify-end pt-1"
                    style={{ height: `${ROW_HEIGHT}px` }}
                  >
                    {String(hour).padStart(2, '0')}:00
                  </div>
                ))}
              </div>

              {/* 7 Day Columns with Grid Background Lines & Absolute Positioned Cards */}
              {weekDates.map((dayDate, dayIdx) => {
                const slicedItems = getSlicedItemsForDay(dayDate);
                const enableLunch = preferences.enableLunchBreak !== false;
                const lunchStart = preferences.lunchStartHour ?? 12;
                const lunchEnd = preferences.lunchEndHour ?? 13;

                return (
                  <div
                    key={dayIdx}
                    className="relative border-r border-[#D9E3EF] last:border-r-0 h-full"
                  >
                    {/* Horizontal Guideline Rows */}
                    {gridHours.map((hour) => {
                      const isLunch = enableLunch && hour >= lunchStart && hour < lunchEnd;
                      return (
                        <div
                          key={hour}
                          className={`border-b border-[#D9E3EF]/70 transition-colors group relative ${
                            isLunch ? 'bg-amber-50/30' : 'hover:bg-slate-50/50'
                          }`}
                          style={{ height: `${ROW_HEIGHT}px` }}
                        >
                          {/* Quick Add Button */}
                          <button
                            onClick={() => {
                              if (onSelectSlotToSchedule) {
                                onSelectSlotToSchedule(dayDate, hour);
                              } else {
                                onOpenTaskModal();
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 transition-opacity absolute inset-0 flex items-center justify-center text-[#53657A] hover:text-[#2457A7] text-[10px]"
                            title={`Jadwalkan kegiatan di slot ${String(hour).padStart(2, '0')}:00`}
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                      );
                    })}

                    {/* Sliced Event & Session Cards with Exact Height & Offset */}
                    {slicedItems.map((item) => {
                      const widthPercent = item.totalCols > 1 ? 100 / item.totalCols : 100;
                      const leftPercent = item.colIndex * widthPercent;

                      const isGoogle = item.sourceType === 'google';
                      const isDone = Boolean(item.isDone);

                      return (
                        <div
                          key={item.id}
                          onClick={() => {
                            if (isGoogle && item.event) {
                              setSelectedEventDetails(item.event);
                            } else if (item.task && item.session) {
                              setSelectedSessionDetails({ task: item.task, session: item.session });
                            }
                          }}
                          style={{
                            top: `${item.topPx}px`,
                            height: `${item.heightPx}px`,
                            left: `calc(${leftPercent}% + 2px)`,
                            width: `calc(${widthPercent}% - 4px)`,
                          }}
                          className={`absolute z-10 p-1.5 rounded-lg border-l-3 cursor-pointer transition-all shadow-2xs overflow-hidden flex flex-col justify-between ${
                            item.hasConflict ? 'ring-1 ring-red-400' : ''
                          } ${
                            isGoogle
                              ? 'bg-[#2457A7]/10 hover:bg-[#2457A7]/15 border-[#2457A7] text-[#172B42]'
                              : isDone
                              ? 'bg-slate-100 hover:bg-slate-200 border-slate-400 text-slate-500 line-through'
                              : 'bg-[#EAF3FC] hover:bg-[#d8e9fa] border-[#2457A7] text-[#172B42]'
                          }`}
                          title={`${item.title} (${item.totalDurationMinutes} menit)${item.hasConflict ? ' [Bentrok Jadwal]' : ''}`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-1 leading-tight">
                              <span className="text-[11px] font-bold truncate">
                                {item.title}
                              </span>
                              {isGoogle ? (
                                <Lock size={9} className="text-[#53657A] shrink-0" />
                              ) : (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (item.task && item.session) {
                                      onToggleTaskSessionComplete(item.task.id, item.session.id);
                                    }
                                  }}
                                  className="text-[#2457A7] hover:text-[#16856B] shrink-0"
                                  title={isDone ? 'Tandai belum selesai' : 'Tandai selesai'}
                                >
                                  <CheckCircle2
                                    size={11}
                                    className={isDone ? 'text-[#16856B] fill-[#16856B]/20' : 'text-[#2457A7]'}
                                  />
                                </button>
                              )}
                            </div>

                            {/* Continuation Badges for Cross-Midnight Events */}
                            {item.isContinuedFromYesterday && (
                              <span className="inline-block text-[9px] bg-indigo-100 text-indigo-800 font-semibold px-1 rounded-sm mt-0.5">
                                (Lanjutan kemarin)
                              </span>
                            )}
                            {item.isContinuedToTomorrow && (
                              <span className="inline-block text-[9px] bg-indigo-100 text-indigo-800 font-semibold px-1 rounded-sm mt-0.5">
                                (Bersambung besok)
                              </span>
                            )}
                          </div>

                          {/* Time & Duration Info */}
                          {item.heightPx >= 40 && (
                            <div className="flex items-center justify-between text-[9px] text-[#53657A] font-mono pt-0.5">
                              <span>
                                {formatInTimezone(item.visibleStart, tz, { hour: '2-digit', minute: '2-digit' })}
                                {' - '}
                                {formatInTimezone(item.visibleEnd, tz, { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              <span>{item.visibleDurationMinutes}m</span>
                            </div>
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

        {/* Daily Grid & Agenda View (01:00 - 24:00) */}
        {viewMode === 'day' && (
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="bg-white border border-[#D9E3EF] rounded-2xl shadow-xs overflow-hidden">
              <div className="p-4 border-b border-[#D9E3EF] bg-[#F8FAFC] flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-[#172B42] text-sm flex items-center gap-2">
                    <CalendarIcon size={16} className="text-[#2457A7]" />
                    <span>Jadwal Harian Berurutan (01:00 - 24:00)</span>
                  </h3>
                  <p className="text-xs text-[#53657A] mt-0.5">
                    {formatInTimezone(currentDate, tz, { dateStyle: 'full' })}
                  </p>
                </div>
                <button
                  onClick={onOpenTaskModal}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#2457A7] text-white rounded-xl text-xs font-semibold shadow-2xs hover:bg-[#1E4889]"
                >
                  <Plus size={13} />
                  <span>Tambah Kegiatan</span>
                </button>
              </div>

              {/* Day Time Grid */}
              <div className="relative grid grid-cols-[64px_1fr]" style={{ height: `${24 * ROW_HEIGHT}px` }}>
                {/* Hours column */}
                <div className="border-r border-[#D9E3EF] bg-[#F8FAFC] divide-y divide-[#D9E3EF]">
                  {gridHours.map((hour) => (
                    <div
                      key={hour}
                      className="text-right pr-2 text-[10px] text-[#53657A] font-mono flex items-start justify-end pt-1"
                      style={{ height: `${ROW_HEIGHT}px` }}
                    >
                      {String(hour).padStart(2, '0')}:00
                    </div>
                  ))}
                </div>

                {/* Day Column with Cards */}
                <div className="relative h-full">
                  {gridHours.map((hour) => (
                    <div
                      key={hour}
                      className="border-b border-[#D9E3EF]/70 hover:bg-slate-50/50"
                      style={{ height: `${ROW_HEIGHT}px` }}
                    />
                  ))}

                  {/* Sliced items for day view */}
                  {getSlicedItemsForDay(currentDate).map((item) => {
                    const isGoogle = item.sourceType === 'google';
                    const isDone = Boolean(item.isDone);
                    const widthPercent = item.totalCols > 1 ? 100 / item.totalCols : 100;
                    const leftPercent = item.colIndex * widthPercent;

                    return (
                      <div
                        key={item.id}
                        onClick={() => {
                          if (isGoogle && item.event) {
                            setSelectedEventDetails(item.event);
                          } else if (item.task && item.session) {
                            setSelectedSessionDetails({ task: item.task, session: item.session });
                          }
                        }}
                        style={{
                          top: `${item.topPx}px`,
                          height: `${item.heightPx}px`,
                          left: `calc(${leftPercent}% + 4px)`,
                          width: `calc(${widthPercent}% - 8px)`,
                        }}
                        className={`absolute z-10 p-2.5 rounded-xl border-l-4 cursor-pointer transition-all shadow-xs flex flex-col justify-between ${
                          item.hasConflict ? 'ring-2 ring-red-400' : ''
                        } ${
                          isGoogle
                            ? 'bg-[#2457A7]/10 hover:bg-[#2457A7]/15 border-[#2457A7] text-[#172B42]'
                            : isDone
                            ? 'bg-slate-100 hover:bg-slate-200 border-slate-400 text-slate-500 line-through'
                            : 'bg-[#EAF3FC] hover:bg-[#d8e9fa] border-[#2457A7] text-[#172B42]'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold truncate">{item.title}</span>
                            {isGoogle ? (
                              <span className="text-[10px] bg-white border border-[#D9E3EF] text-[#53657A] px-1.5 py-0.2 rounded font-medium shrink-0">
                                Google
                              </span>
                            ) : (
                              <span className="text-[10px] bg-[#2457A7] text-white px-2 py-0.2 rounded-full font-medium shrink-0">
                                Sesi Fokus
                              </span>
                            )}
                          </div>
                          {item.isContinuedFromYesterday && (
                            <span className="text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.2 rounded mt-1 inline-block">
                              Lanjutan dari hari sebelumnya
                            </span>
                          )}
                          {item.isContinuedToTomorrow && (
                            <span className="text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.2 rounded mt-1 inline-block">
                              Bersambung ke hari berikutnya
                            </span>
                          )}
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-[#53657A] font-mono pt-1">
                          <span>
                            {formatInTimezone(item.visibleStart, tz, { hour: '2-digit', minute: '2-digit' })} -{' '}
                            {formatInTimezone(item.visibleEnd, tz, { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span>{item.visibleDurationMinutes} menit</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Month View Placeholder */}
        {viewMode === 'month' && (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-6 shadow-xs text-center space-y-3">
            <CalendarIcon className="w-10 h-10 text-[#2457A7] mx-auto opacity-70" />
            <h3 className="text-base font-bold text-[#172B42] font-editorial">
              Tinjauan Bulanan {formatInTimezone(currentDate, tz, { month: 'long', year: 'numeric' })}
            </h3>
            <p className="text-xs text-[#53657A] max-w-md mx-auto leading-relaxed">
              Tampilan kalender bulanan mengelompokkan kegiatan Anda secara makro. Gunakan tampilan <strong>Minggu</strong> atau <strong>Hari</strong> untuk melihat skala jam 01:00 sampai 24:00 dengan posisi dan tinggi kartu presisi.
            </p>
            <button
              onClick={() => setViewMode('week')}
              className="px-4 py-2 bg-[#2457A7] text-white text-xs font-semibold rounded-xl hover:bg-[#1E4889]"
            >
              Buka Tampilan Mingguan
            </button>
          </div>
        )}
      </div>

      {/* Google Event Details Modal */}
      {selectedEventDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold bg-[#2457A7]/10 text-[#2457A7] px-2 py-0.5 rounded-full">
                  Acara Google Calendar
                </span>
                <h3 className="text-base font-bold text-[#172B42] mt-1.5">
                  {selectedEventDetails.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedEventDetails(null)}
                className="text-[#53657A] hover:text-[#172B42] p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-[#53657A] space-y-2">
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-[#2457A7]" />
                <span>
                  {formatInTimezone(new Date(selectedEventDetails.startAt), tz, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {' — '}
                  {formatInTimezone(new Date(selectedEventDetails.endAt), tz, {
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

            <div className="flex flex-col gap-2 pt-2">
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

              {selectedEventDetails.htmlLink && (
                <a
                  href={selectedEventDetails.htmlLink}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full flex items-center justify-center gap-2 bg-slate-50 hover:bg-slate-100 border border-[#D9E3EF] text-[#2457A7] py-2 px-4 rounded-xl text-xs font-semibold transition-colors"
                >
                  <ExternalLink size={13} /> Buka di Google Calendar
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Task Session Details Modal */}
      {selectedSessionDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-full">
                  Sesi Kegiatan EVEN
                </span>
                <h3 className="text-base font-bold text-[#172B42] mt-1.5">
                  {selectedSessionDetails.session.taskTitle}
                </h3>
              </div>
              <button
                onClick={() => setSelectedSessionDetails(null)}
                className="text-[#53657A] hover:text-[#172B42] p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-[#53657A] space-y-2">
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-[#2457A7]" />
                <span>
                  {formatInTimezone(new Date(selectedSessionDetails.session.startAt), tz, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {' — '}
                  {formatInTimezone(new Date(selectedSessionDetails.session.endAt), tz, {
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
                {selectedSessionDetails.session.status === 'COMPLETED' ? 'Tandai Belum Selesai' : 'Selesaikan Kegiatan Ini'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
