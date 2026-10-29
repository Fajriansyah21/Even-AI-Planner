import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
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
  ArrowRight,
  GripVertical,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import type { CalendarEvent, Priority, Task, TaskScheduleSession, UserPreferences } from '../types';
import {
  normalizeTimezone,
  startOfDayInTimezone,
  endOfDayInTimezone,
  getZonedDateTimeParts,
  formatInTimezone,
  createIsoInTimezone,
} from '../lib/timezone';
import {
  TaskCategory,
  CATEGORY_OPTIONS,
  PRIORITY_OPTIONS,
  ALL_CATEGORIES,
  ALL_PRIORITIES,
  resolveItemCategory,
  resolveItemPriority,
  CalendarFilterPopover,
  CalendarActiveFilterBar,
} from './CalendarFilterPopover';

interface CalendarViewProps {
  events: CalendarEvent[];
  tasks: Task[];
  preferences: UserPreferences;
  onToggleTaskSessionComplete: (taskId: string, sessionId: string) => void;
  onOpenTaskModal: () => void;
  onSelectSlotToSchedule?: (slotDate: Date, hour: number) => void;
  onOpenAIAssistant: () => void;
  onScheduleTaskToSlot?: (taskId: string, startIso: string, endIso: string) => void | Promise<void>;
}

interface SlicedCalendarItem {
  id: string;
  sourceType: 'google' | 'session';
  title: string;
  event?: CalendarEvent;
  task?: Task;
  session?: TaskScheduleSession;
  category: TaskCategory;
  priority: Priority;
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
  isGoogleSynced?: boolean;
  colIndex: number;
  totalCols: number;
  hasConflict: boolean;
}

/**
 * Memeriksa kesamaan identitas antara sesi internal EVEN dan acara Google Calendar
 * secara ketat berdasarkan ID hubungan resmi (googleCalendarEventId vs id acara).
 * Jangan pernah menyatukan dua acara hanya karena waktu atau judulnya sama.
 */
export function isSessionLinkedToGoogleEvent(
  sessionGoogleId: string | undefined,
  calendarEventId: string
): boolean {
  if (!sessionGoogleId || !calendarEventId) return false;
  if (sessionGoogleId === calendarEventId) return true;
  const cleanSessionId = sessionGoogleId.replace(/^gcal-/, '');
  const cleanEventId = calendarEventId.replace(/^gcal-/, '');
  return cleanSessionId === cleanEventId;
}

export const ROW_HEIGHT = 56; // 56px per 1 hour slot
export const PIXELS_PER_MINUTE = ROW_HEIGHT / 60; // Skala standar: 0.9333... px/menit

export interface CalendarVerticalLayoutResult {
  topPx: number;
  heightPx: number;
  startMinutesFromDayStart: number;
  visibleDurationMinutes: number;
  pixelsPerMinute: number;
}

/**
 * Menghitung posisi vertikal (top) dan tinggi (height) kartu kegiatan kalender
 * berdasarkan skala piksel per menit yang konsisten dari awal rentang harian (dayStartMs).
 *
 * Rumus:
 *   skala = rowHeight / 60 (piksel per menit)
 *   top = selisih menit antara waktu mulai kegiatan dan awal rentang harian × skala
 *   height = durasi menit yang terlihat × skala
 *
 * Menghindari offset manual atau pergeseran sembarang agar kartu selalu presisi.
 */
export function calculateVerticalPosition(
  visibleStartMs: number,
  visibleEndMs: number,
  dayStartMs: number,
  rowHeight: number = ROW_HEIGHT
): CalendarVerticalLayoutResult {
  const pixelsPerMinute = rowHeight / 60;
  const startMinutesFromDayStart = Math.max(0, (visibleStartMs - dayStartMs) / 60000);
  const visibleDurationMinutes = Math.max(1, (visibleEndMs - visibleStartMs) / 60000);

  const topPx = startMinutesFromDayStart * pixelsPerMinute;
  const heightPx = visibleDurationMinutes * pixelsPerMinute;

  return {
    topPx,
    heightPx,
    startMinutesFromDayStart,
    visibleDurationMinutes,
    pixelsPerMinute,
  };
}

export interface HourDensityInfo {
  occupiedMinutes: number;
  availableMinutes: number;
  densityPercentage: number;
  status: 'empty' | 'low' | 'medium' | 'full';
}

/**
 * Menghitung kepadatan waktu terisi pada slot jam (0-60 menit)
 * untuk memberi visual feedback instan ketersediaan slot.
 */
export function calculateHourDensity(
  dayDate: Date,
  hour: number,
  slicedItems: SlicedCalendarItem[],
  tz: string
): HourDensityInfo {
  const dayStart = startOfDayInTimezone(dayDate, tz);
  const slotStartMs = dayStart.getTime() + hour * 3600000;
  const slotEndMs = slotStartMs + 3600000;

  let totalOverlapMs = 0;
  for (const item of slicedItems) {
    const itemStartMs = item.visibleStart.getTime();
    const itemEndMs = item.visibleEnd.getTime();
    const overlap = Math.max(0, Math.min(itemEndMs, slotEndMs) - Math.max(itemStartMs, slotStartMs));
    totalOverlapMs += overlap;
  }

  const occupiedMinutes = Math.min(60, Math.round(totalOverlapMs / 60000));
  const availableMinutes = Math.max(0, 60 - occupiedMinutes);
  const densityPercentage = Math.round((occupiedMinutes / 60) * 100);

  let status: 'empty' | 'low' | 'medium' | 'full' = 'empty';
  if (occupiedMinutes >= 50) {
    status = 'full';
  } else if (occupiedMinutes >= 25) {
    status = 'medium';
  } else if (occupiedMinutes > 0) {
    status = 'low';
  }

  return {
    occupiedMinutes,
    availableMinutes,
    densityPercentage,
    status,
  };
}

interface DroppableHourSlotProps {
  id: string;
  date: Date;
  hour: number;
  isLunch?: boolean;
  heightPx: number;
  onSelectSlot?: () => void;
  density?: HourDensityInfo;
  children?: React.ReactNode;
}

function DroppableHourSlot({
  id,
  date,
  hour,
  isLunch,
  heightPx,
  onSelectSlot,
  density,
  children,
}: DroppableHourSlotProps) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { date, hour },
  });

  const occupied = density?.occupiedMinutes ?? 0;
  const percentage = density?.densityPercentage ?? 0;
  const isFull = density?.status === 'full' || occupied >= 50;
  const isMedium = density?.status === 'medium';

  const barColor = isFull
    ? 'bg-[#C43D4B] dark:bg-rose-500' // Penuh / Padat
    : isMedium
    ? 'bg-[#B86B12] dark:bg-amber-500' // Sedang
    : 'bg-[#16856B] dark:bg-emerald-500'; // Ringan / Tersedia

  return (
    <div
      ref={setNodeRef}
      className={`border-b border-[#D9E3EF]/70 dark:border-slate-800/80 transition-all group relative ${
        isOver
          ? 'bg-[#2457A7]/20 ring-2 ring-[#2457A7] ring-inset z-10'
          : isLunch
          ? 'bg-amber-50/30 dark:bg-amber-950/20'
          : 'hover:bg-slate-50/50 dark:hover:bg-slate-800/30'
      }`}
      style={{ height: `${heightPx}px` }}
    >
      {/* Visual Density Progress Bar per Jam */}
      {occupied > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 h-1.5 bg-slate-200/50 dark:bg-slate-700/50 overflow-hidden pointer-events-none z-5"
          title={`Kepadatan jadwal: ${occupied}/60 menit (${percentage}%)`}
        >
          <div
            className={`h-full transition-all duration-300 ${barColor}`}
            style={{ width: `${Math.min(100, percentage)}%` }}
          />
        </div>
      )}

      {/* Mini hover badge showing occupied and available minutes */}
      <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute right-1.5 top-1 z-15 pointer-events-none flex items-center gap-1 bg-white/95 dark:bg-slate-800/95 border border-[#D9E3EF] dark:border-slate-700 px-1.5 py-0.5 rounded-md text-[9px] shadow-2xs backdrop-blur-xs">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            occupied === 0
              ? 'bg-slate-300 dark:bg-slate-600'
              : isFull
              ? 'bg-[#C43D4B]'
              : isMedium
              ? 'bg-[#B86B12]'
              : 'bg-[#16856B]'
          }`}
        />
        <span className="font-semibold text-[#172B42] dark:text-slate-200 font-mono">
          {occupied > 0 ? `${occupied}/60 mnt` : 'Slot Kosong'}
        </span>
        <span className="text-[#53657A] dark:text-slate-400">
          ({density?.availableMinutes ?? 60}m luang)
        </span>
      </div>

      {isOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
          <span className="text-[10px] font-bold text-[#2457A7] dark:text-blue-300 bg-white/95 dark:bg-slate-900/95 px-2 py-0.5 rounded-full shadow-xs border border-[#2457A7]/40">
            Jadwalkan di {String(hour).padStart(2, '0')}:00 WIB
          </span>
        </div>
      )}
      {onSelectSlot && (
        <button
          onClick={onSelectSlot}
          className="opacity-0 group-hover:opacity-100 transition-opacity absolute inset-0 flex items-center justify-center text-[#53657A] hover:text-[#2457A7] dark:hover:text-blue-400 text-[10px]"
          title={`Jadwalkan kegiatan di slot ${String(hour).padStart(2, '0')}:00`}
        >
          <Plus size={12} />
        </button>
      )}
      {children}
    </div>
  );
}

interface DroppableMonthDayCellProps {
  id: string;
  date: Date;
  hour?: number;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}

function DroppableMonthDayCell({
  id,
  date,
  hour = 9,
  onClick,
  className = '',
  children,
}: DroppableMonthDayCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { date, hour },
  });

  return (
    <div
      ref={setNodeRef}
      onClick={onClick}
      className={`${className} ${
        isOver ? 'ring-2 ring-[#2457A7] ring-inset bg-[#2457A7]/15 z-10' : ''
      }`}
    >
      {children}
    </div>
  );
}

interface DraggableTaskCardProps {
  task: Task;
}

function DraggableTaskCard({ task }: DraggableTaskCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `task-drag-${task.id}`,
    data: { task },
  });

  const priorityColor =
    task.priority === 'HIGH' || task.priority === 'URGENT'
      ? 'bg-red-50 text-red-700 border-red-200'
      : task.priority === 'MEDIUM'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-slate-100 text-slate-600 border-slate-200';

  const priorityLabel =
    task.priority === 'HIGH' || task.priority === 'URGENT'
      ? 'Tinggi'
      : task.priority === 'MEDIUM'
      ? 'Sedang'
      : 'Rendah';

  return (
    <div
      ref={setNodeRef}
      className={`p-2.5 bg-white border border-[#D9E3EF] rounded-xl shadow-2xs hover:shadow-xs transition-all flex flex-col gap-1.5 cursor-grab active:cursor-grabbing select-none ${
        isDragging ? 'opacity-30 ring-2 ring-[#2457A7]' : 'hover:border-[#2457A7]/50'
      }`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <GripVertical size={13} className="text-[#53657A] shrink-0" />
          <h4 className="text-xs font-semibold text-[#172B42] truncate" title={task.title}>
            {task.title}
          </h4>
        </div>
        <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded border shrink-0 ${priorityColor}`}>
          {priorityLabel}
        </span>
      </div>

      <div className="flex items-center gap-2 text-[10px] text-[#53657A] pl-5">
        <div className="flex items-center gap-1">
          <Clock size={11} className="text-[#2457A7]" />
          <span>{task.estimatedDurationMinutes || 60}m</span>
        </div>
        {task.deadlineAt && (
          <div className="flex items-center gap-1 text-red-600 font-medium">
            <AlertCircle size={11} />
            <span>Tenggat</span>
          </div>
        )}
        <span className="text-[10px] text-[#2457A7] font-medium ml-auto">
          Tarik ke jam &rarr;
        </span>
      </div>
    </div>
  );
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  events,
  tasks,
  preferences,
  onToggleTaskSessionComplete,
  onOpenTaskModal,
  onSelectSlotToSchedule,
  onOpenAIAssistant,
  onScheduleTaskToSlot,
}) => {
  const tz = normalizeTimezone(preferences.timezone);
  const [viewMode, setViewMode] = useState<'day' | 'week' | 'month'>('week');
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [selectedEventDetails, setSelectedEventDetails] = useState<CalendarEvent | null>(null);
  const [selectedSessionDetails, setSelectedSessionDetails] = useState<{ task: Task; session: TaskScheduleSession } | null>(null);
  const [selectedDayOverview, setSelectedDayOverview] = useState<{ date: Date; items: SlicedCalendarItem[] } | null>(null);
  const [hoveredTooltip, setHoveredTooltip] = useState<{
    item: SlicedCalendarItem;
    x: number;
    y: number;
  } | null>(null);

  // Drag and drop state for unscheduled tasks
  const [activeDragTask, setActiveDragTask] = useState<Task | null>(null);
  const [isUnscheduledDrawerOpen, setIsUnscheduledDrawerOpen] = useState(false);

  const unscheduledTasks = tasks.filter((t) => t.status === 'UNSCHEDULED');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = event.active.data.current?.task as Task | undefined;
    if (task) {
      setActiveDragTask(task);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragTask(null);
    const { active, over } = event;
    if (!over || !active) return;
    const task = active.data.current?.task as Task | undefined;
    const dropData = over.data.current as { date: Date; hour: number } | undefined;
    if (!task || !dropData) return;

    const targetDate = dropData.date;
    const targetHour = dropData.hour;
    const startParts = getZonedDateTimeParts(targetDate, tz);
    const startIso = createIsoInTimezone(
      startParts.year,
      startParts.month,
      startParts.day,
      targetHour,
      0,
      0,
      tz
    );

    const durationMinutes =
      task.estimatedDurationMinutes && task.estimatedDurationMinutes > 0
        ? task.estimatedDurationMinutes
        : 60;

    const startDate = new Date(startIso);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
    const endIso = endDate.toISOString();

    if (onScheduleTaskToSlot) {
      onScheduleTaskToSlot(task.id, startIso, endIso);
    }
  };

  // Real-time filter states for category and priority
  const [selectedCategories, setSelectedCategories] = useState<TaskCategory[]>(ALL_CATEGORIES);
  const [selectedPriorities, setSelectedPriorities] = useState<Priority[]>(ALL_PRIORITIES);

  const handleToggleCategory = (cat: TaskCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const handleTogglePriority = (prio: Priority) => {
    setSelectedPriorities((prev) =>
      prev.includes(prio) ? prev.filter((p) => p !== prio) : [...prev, prio]
    );
  };

  const handleSelectAllCategories = () => {
    if (selectedCategories.length === ALL_CATEGORIES.length) {
      setSelectedCategories([]);
    } else {
      setSelectedCategories([...ALL_CATEGORIES]);
    }
  };

  const handleSelectAllPriorities = () => {
    if (selectedPriorities.length === ALL_PRIORITIES.length) {
      setSelectedPriorities([]);
    } else {
      setSelectedPriorities([...ALL_PRIORITIES]);
    }
  };

  const handleResetFilters = () => {
    setSelectedCategories([...ALL_CATEGORIES]);
    setSelectedPriorities([...ALL_PRIORITIES]);
  };

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

  // Collect scheduled sessions from active tasks only (history is isolated)
  const scheduledSessions: { task: Task; session: TaskScheduleSession }[] = [];
  tasks.forEach((t) => {
    // Only active tasks: Exclude tasks that have transitioned to history
    if (t.status === 'completed_manual' || t.status === 'missed_auto' || t.status === 'COMPLETED') {
      return;
    }
    if (t.scheduledSessions && t.scheduledSessions.length > 0) {
      t.scheduledSessions.forEach((s) => {
        if (
          s.status !== 'CANCELLED' &&
          s.status !== 'completed_manual' &&
          s.status !== 'missed_auto' &&
          s.status !== 'COMPLETED'
        ) {
          scheduledSessions.push({ task: t, session: s });
        }
      });
    }
  });

  // Hours: 00:00 to 23:00 (24 one-hour segments covering a full 24-hour day)
  const gridHours = Array.from({ length: 24 }, (_, i) => i);

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
      category: TaskCategory;
      priority: Priority;
      start: Date;
      end: Date;
      isDone?: boolean;
    }[] = [];

    // 1. Identifikasi sesi lokal yang terhubung dengan acara Google Calendar via ID unik resmi (googleCalendarEventId)
    const linkedGoogleIds = new Set<string>();
    for (const item of scheduledSessions) {
      if (item.session.googleCalendarEventId) {
        const rawId = item.session.googleCalendarEventId;
        const cleanId = rawId.replace(/^gcal-/, '');
        linkedGoogleIds.add(rawId);
        linkedGoogleIds.add(cleanId);
        linkedGoogleIds.add(`gcal-${cleanId}`);
      }
    }

    // 1. Google & manual calendar events
    for (const evt of events) {
      const s = new Date(evt.startAt);
      const e = new Date(evt.endAt);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
        // Half-open interval intersection: s < dayEnd && e > dayStart
        if (s.getTime() < dayEndMs && e.getTime() > dayStartMs) {
          const cleanEvtId = evt.id.replace(/^gcal-/, '');
          // Jika acara Google ini sudah memiliki sesi lokal yang terhubung via ID hubungan googleCalendarEventId,
          // lewati untuk menampilkan satu kartu representasi terpadu tanpa duplikasi visual.
          if (
            linkedGoogleIds.has(evt.id) ||
            linkedGoogleIds.has(cleanEvtId) ||
            linkedGoogleIds.has(`gcal-${cleanEvtId}`)
          ) {
            continue;
          }

          const cat = resolveItemCategory({ event: evt });
          const prio = resolveItemPriority({ event: evt });

          // Real-time filter: skip if category or priority is not selected
          if (!selectedCategories.includes(cat) || !selectedPriorities.includes(prio)) {
            continue;
          }

          rawItems.push({
            id: `evt-${evt.id}`,
            sourceType: 'google',
            title: evt.title,
            event: evt,
            category: cat,
            priority: prio,
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
          // Cari acara Google Calendar pasangannya jika ada untuk tautan/metadata
          const matchedEvt = events.find((evt) =>
            isSessionLinkedToGoogleEvent(item.session.googleCalendarEventId, evt.id)
          );

          const cat = resolveItemCategory({ task: item.task, event: matchedEvt });
          const prio = resolveItemPriority({ task: item.task, event: matchedEvt });

          // Real-time filter: skip if category or priority is not selected
          if (!selectedCategories.includes(cat) || !selectedPriorities.includes(prio)) {
            continue;
          }

          rawItems.push({
            id: `sess-${item.session.id}`,
            sourceType: 'session',
            title: item.session.taskTitle,
            task: item.task,
            session: item.session,
            event: matchedEvt,
            category: cat,
            priority: prio,
            start: s,
            end: e,
            isDone: item.session.status === 'COMPLETED' || item.session.status === 'completed_manual',
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
      const { topPx, heightPx, visibleDurationMinutes } = calculateVerticalPosition(
        visibleStartMs,
        visibleEndMs,
        dayStartMs,
        ROW_HEIGHT
      );

      return {
        id: r.id,
        sourceType: r.sourceType,
        title: r.title,
        event: r.event,
        task: r.task,
        session: r.session,
        category: r.category,
        priority: r.priority,
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
        isGoogleSynced: Boolean(
          r.event ||
          r.session?.googleCalendarEventId ||
          r.session?.syncStatus === 'synced'
        ),
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

  // Compute month cells starting from Monday covering the full month grid
  const getMonthGrid = (date: Date) => {
    const p = getZonedDateTimeParts(date, tz);
    const year = p.year;
    const month = p.month; // 1-12

    const firstDayIso = createIsoInTimezone(year, month, 1, 0, 0, 0, tz);
    const firstDay = new Date(firstDayIso);
    const firstParts = getZonedDateTimeParts(firstDay, tz);

    // Monday is index 0, Sunday is index 6
    const diffToMonday = firstParts.dayOfWeek === 0 ? 6 : firstParts.dayOfWeek - 1;

    // Date UTC for number of days in this month
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const start = new Date(firstDay);
    start.setDate(firstDay.getDate() - diffToMonday);

    const totalCells = Math.ceil((diffToMonday + daysInMonth) / 7) * 7;
    const cells: {
      date: Date;
      dayNumber: number;
      isCurrentMonth: boolean;
      isToday: boolean;
      items: SlicedCalendarItem[];
    }[] = [];

    for (let i = 0; i < totalCells; i++) {
      const cellDate = new Date(start);
      cellDate.setDate(start.getDate() + i);
      const cp = getZonedDateTimeParts(cellDate, tz);
      const isCurrentMonth = cp.month === month && cp.year === year;
      const today = isSameCalendarDay(cellDate, new Date());
      const items = getSlicedItemsForDay(cellDate);

      cells.push({
        date: cellDate,
        dayNumber: cp.day,
        isCurrentMonth,
        isToday: today,
        items,
      });
    }

    return cells;
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
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] dark:bg-[#0B1120] overflow-hidden select-none transition-colors duration-200">
      {/* Top Toolbar */}
      <div className="h-14 px-6 bg-white dark:bg-[#0F172A] border-b border-[#D9E3EF] dark:border-slate-800 flex items-center justify-between shrink-0 transition-colors">
        <div className="flex items-center gap-3">
          <button
            onClick={resetToToday}
            className="px-3 py-1.5 text-xs font-semibold text-[#172B42] dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl border border-[#D9E3EF] dark:border-slate-700 transition-colors"
          >
            Hari Ini
          </button>

          <div className="flex items-center border border-[#D9E3EF] dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-800">
            <button
              onClick={() => navigateDate('prev')}
              className="p-1.5 hover:bg-slate-50 dark:hover:bg-slate-700 text-[#53657A] dark:text-slate-400 hover:text-[#172B42] dark:hover:text-white transition-colors"
              aria-label="Sebelumnya"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => navigateDate('next')}
              className="p-1.5 hover:bg-slate-50 dark:hover:bg-slate-700 text-[#53657A] dark:text-slate-400 hover:text-[#172B42] dark:hover:text-white transition-colors"
              aria-label="Berikutnya"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <h2 className="text-sm sm:text-base font-bold text-[#172B42] dark:text-slate-100 font-editorial tracking-tight">
            {formatHeaderRange()}
          </h2>
        </div>

        {/* Actions & View Mode Toggle */}
        <div className="flex items-center gap-2">
          {/* UI Filter Real-time Kategori & Prioritas */}
          <CalendarFilterPopover
            selectedCategories={selectedCategories}
            selectedPriorities={selectedPriorities}
            onToggleCategory={handleToggleCategory}
            onTogglePriority={handleTogglePriority}
            onSelectAllCategories={handleSelectAllCategories}
            onSelectAllPriorities={handleSelectAllPriorities}
            onResetFilters={handleResetFilters}
            totalItemsCount={scheduledSessions.length + events.length}
          />

          {/* Unscheduled Tasks Drawer Toggle Button */}
          <button
            onClick={() => setIsUnscheduledDrawerOpen(!isUnscheduledDrawerOpen)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
              isUnscheduledDrawerOpen
                ? 'bg-[#2457A7] text-white border-[#2457A7] shadow-xs'
                : 'bg-white dark:bg-slate-800 text-[#172B42] dark:text-slate-200 border-[#D9E3EF] dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
            title="Buka panel antrean tugas untuk drag-and-drop ke kalender"
          >
            <GripVertical size={14} />
            <span className="hidden sm:inline">Tugas Antrean</span>
            {unscheduledTasks.length > 0 && (
              <span
                className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                  isUnscheduledDrawerOpen ? 'bg-white text-[#2457A7]' : 'bg-[#2457A7] text-white'
                }`}
              >
                {unscheduledTasks.length}
              </span>
            )}
          </button>

          {/* View Mode Toggle */}
          <div className="flex items-center gap-1 p-1 bg-[#F8FAFC] dark:bg-slate-800/80 border border-[#D9E3EF] dark:border-slate-700 rounded-xl text-xs font-medium">
            <button
              onClick={() => setViewMode('day')}
              className={`px-3 py-1 rounded-lg transition-all ${
                viewMode === 'day'
                  ? 'bg-white dark:bg-slate-700 text-[#2457A7] dark:text-blue-300 font-semibold shadow-2xs'
                  : 'text-[#53657A] dark:text-slate-400 hover:text-[#172B42] dark:hover:text-white'
              }`}
            >
              Hari
            </button>
            <button
              onClick={() => setViewMode('week')}
              className={`px-3 py-1 rounded-lg transition-all ${
                viewMode === 'week'
                  ? 'bg-white dark:bg-slate-700 text-[#2457A7] dark:text-blue-300 font-semibold shadow-2xs'
                  : 'text-[#53657A] dark:text-slate-400 hover:text-[#172B42] dark:hover:text-white'
              }`}
            >
              Minggu
            </button>
            <button
              onClick={() => setViewMode('month')}
              className={`px-3 py-1 rounded-lg transition-all ${
                viewMode === 'month'
                  ? 'bg-white dark:bg-slate-700 text-[#2457A7] dark:text-blue-300 font-semibold shadow-2xs'
                  : 'text-[#53657A] dark:text-slate-400 hover:text-[#172B42] dark:hover:text-white'
              }`}
            >
              Bulan
            </button>
          </div>
        </div>
      </div>

      {/* Active Filter Chips Bar */}
      <CalendarActiveFilterBar
        selectedCategories={selectedCategories}
        selectedPriorities={selectedPriorities}
        onToggleCategory={handleToggleCategory}
        onTogglePriority={handleTogglePriority}
        onResetFilters={handleResetFilters}
      />

      {/* Main Calendar Content Area with Collapsible Unscheduled Tasks Drawer */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Weekly View (01:00 - 24:00) */}
        {viewMode === 'week' && (
          <div className="bg-white dark:bg-[#0F172A] border border-[#D9E3EF] dark:border-slate-800 rounded-2xl shadow-xs overflow-hidden flex flex-col min-w-[760px] transition-colors">
            {/* Day Header Row */}
            <div className="grid grid-cols-[64px_repeat(7,1fr)] border-b border-[#D9E3EF] dark:border-slate-800 bg-[#F8FAFC] dark:bg-slate-900 sticky top-0 z-20">
              <div className="p-3 text-[11px] font-medium text-[#53657A] dark:text-slate-400 border-r border-[#D9E3EF] dark:border-slate-800 flex items-center justify-center">
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
                    {/* Horizontal Guideline Rows with Droppable Support & Density Bar */}
                    {gridHours.map((hour) => {
                      const isLunch = enableLunch && hour >= lunchStart && hour < lunchEnd;
                      const density = calculateHourDensity(dayDate, hour, slicedItems, tz);
                      return (
                        <DroppableHourSlot
                          key={hour}
                          id={`week-slot-${dayDate.toISOString().slice(0, 10)}-${hour}`}
                          date={dayDate}
                          hour={hour}
                          isLunch={isLunch}
                          heightPx={ROW_HEIGHT}
                          density={density}
                          onSelectSlot={() => {
                            if (onSelectSlotToSchedule) {
                              onSelectSlotToSchedule(dayDate, hour);
                            } else {
                              onOpenTaskModal();
                            }
                          }}
                        />
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
                          onMouseEnter={(e) => {
                            setHoveredTooltip({
                              item,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                          onMouseMove={(e) => {
                            setHoveredTooltip({
                              item,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                          onMouseLeave={() => {
                            setHoveredTooltip(null);
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
                        >
                          <div>
                            <div className="flex items-center justify-between gap-1 leading-tight">
                              <span className="text-[11px] font-bold truncate">
                                {item.title}
                              </span>
                              <div className="flex items-center gap-1 shrink-0">
                                {item.isGoogleSynced && !isGoogle && (
                                  <span
                                    title="Tersinkronisasi dengan Google Calendar"
                                    className="text-[8px] bg-blue-100 text-[#2457A7] px-1 py-0.2 rounded font-semibold"
                                  >
                                    GCal
                                  </span>
                                )}
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

        {/* Daily Grid & Agenda View (00:00 - 24:00) */}
        {viewMode === 'day' && (
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="bg-white border border-[#D9E3EF] rounded-2xl shadow-xs overflow-hidden">
              <div className="p-4 border-b border-[#D9E3EF] bg-[#F8FAFC] flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-[#172B42] text-sm flex items-center gap-2">
                    <CalendarIcon size={16} className="text-[#2457A7]" />
                    <span>Jadwal Harian Berurutan (00:00 - 24:00)</span>
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

                  {/* Day Column with Cards & Droppable Slots */}
                  <div className="relative h-full">
                    {(() => {
                      const daySlicedItems = getSlicedItemsForDay(currentDate);
                      return (
                        <>
                          {gridHours.map((hour) => {
                            const enableLunch = preferences.enableLunchBreak !== false;
                            const lunchStart = preferences.lunchStartHour ?? 12;
                            const lunchEnd = preferences.lunchEndHour ?? 13;
                            const isLunch = enableLunch && hour >= lunchStart && hour < lunchEnd;
                            const density = calculateHourDensity(currentDate, hour, daySlicedItems, tz);
                            return (
                              <DroppableHourSlot
                                key={hour}
                                id={`day-slot-${currentDate.toISOString().slice(0, 10)}-${hour}`}
                                date={currentDate}
                                hour={hour}
                                isLunch={isLunch}
                                heightPx={ROW_HEIGHT}
                                density={density}
                                onSelectSlot={() => {
                                  if (onSelectSlotToSchedule) {
                                    onSelectSlotToSchedule(currentDate, hour);
                                  } else {
                                    onOpenTaskModal();
                                  }
                                }}
                              />
                            );
                          })}

                          {/* Sliced items for day view */}
                          {daySlicedItems.map((item) => {
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
                        onMouseEnter={(e) => {
                          setHoveredTooltip({
                            item,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        onMouseMove={(e) => {
                          setHoveredTooltip({
                            item,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        onMouseLeave={() => {
                          setHoveredTooltip(null);
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
                            <div className="flex items-center gap-1.5 shrink-0">
                              {item.isGoogleSynced && !isGoogle && (
                                <span className="text-[9px] bg-blue-100 border border-blue-200 text-[#2457A7] px-1.5 py-0.2 rounded font-medium">
                                  Google Synced
                                </span>
                              )}
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

                          {/* Category & Priority Badges */}
                          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-white/80 border border-[#D9E3EF]">
                              <span className={`w-1.5 h-1.5 rounded-full ${CATEGORY_OPTIONS.find((c) => c.id === item.category)?.dotClass}`} />
                              <span>{CATEGORY_OPTIONS.find((c) => c.id === item.category)?.label}</span>
                            </span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${PRIORITY_OPTIONS.find((p) => p.id === item.priority)?.badgeClass}`}>
                              Prioritas {PRIORITY_OPTIONS.find((p) => p.id === item.priority)?.label}
                            </span>
                          </div>
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
                </>
              );
            })()}
          </div>
              </div>
            </div>
          </div>
        )}

        {/* Real Interactive Month Calendar Grid */}
        {viewMode === 'month' && (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl shadow-xs overflow-hidden flex flex-col min-w-[760px]">
            {/* Weekday Header Row (Senin - Minggu) */}
            <div className="grid grid-cols-7 border-b border-[#D9E3EF] bg-[#F8FAFC]">
              {['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'].map((dayName, idx) => (
                <div
                  key={idx}
                  className="py-2.5 px-3 text-center border-r border-[#D9E3EF] last:border-r-0 text-xs font-semibold text-[#53657A] uppercase tracking-wider"
                >
                  <span className="hidden sm:inline">{dayName}</span>
                  <span className="sm:hidden">{dayName.slice(0, 3)}</span>
                </div>
              ))}
            </div>

            {/* Calendar Cells Grid */}
            <div className="grid grid-cols-7 divide-y divide-[#D9E3EF] bg-[#D9E3EF]/30 gap-[1px]">
              {getMonthGrid(currentDate).map((cell, idx) => {
                const maxVisible = 3;
                const visibleItems = cell.items.slice(0, maxVisible);
                const overflowCount = cell.items.length - maxVisible;

                return (
                  <DroppableMonthDayCell
                    key={idx}
                    id={`month-slot-${cell.date.toISOString().slice(0, 10)}`}
                    date={cell.date}
                    hour={9}
                    onClick={() => {
                      setCurrentDate(cell.date);
                      setViewMode('day');
                    }}
                    className={`min-h-[115px] p-2 flex flex-col justify-between transition-colors cursor-pointer group ${
                      cell.isCurrentMonth
                        ? cell.isToday
                          ? 'bg-[#EAF3FC]/40 hover:bg-[#EAF3FC]/70'
                          : 'bg-white hover:bg-slate-50/80'
                        : 'bg-[#F8FAFC]/90 text-slate-400 hover:bg-slate-100/60'
                    }`}
                  >
                    <div>
                      {/* Cell Header: Day Number & Add button */}
                      <div className="flex items-center justify-between mb-1.5">
                        <span
                          className={`text-xs font-bold w-6 h-6 leading-6 rounded-full inline-flex items-center justify-center transition-transform group-hover:scale-105 ${
                            cell.isToday
                              ? 'bg-[#2457A7] text-white shadow-2xs'
                              : cell.isCurrentMonth
                              ? 'text-[#172B42]'
                              : 'text-slate-400'
                          }`}
                        >
                          {cell.dayNumber}
                        </span>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onSelectSlotToSchedule) {
                              onSelectSlotToSchedule(cell.date, 9);
                            } else {
                              onOpenTaskModal();
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-[#53657A] hover:text-[#2457A7] hover:bg-slate-100 rounded-lg"
                          title={`Tambah kegiatan pada ${cell.dayNumber}`}
                        >
                          <Plus size={12} />
                        </button>
                      </div>

                      {/* Event Chips List */}
                      <div className="space-y-1">
                        {visibleItems.map((item) => {
                          const isGoogle = item.sourceType === 'google';
                          const isDone = Boolean(item.isDone);
                          const startTimeStr = formatInTimezone(item.visibleStart, tz, {
                            hour: '2-digit',
                            minute: '2-digit',
                          });

                          return (
                            <div
                              key={item.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isGoogle && item.event) {
                                  setSelectedEventDetails(item.event);
                                } else if (item.task && item.session) {
                                  setSelectedSessionDetails({ task: item.task, session: item.session });
                                }
                              }}
                              onMouseEnter={(e) => {
                                setHoveredTooltip({
                                  item,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                              onMouseMove={(e) => {
                                setHoveredTooltip({
                                  item,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                              onMouseLeave={() => {
                                setHoveredTooltip(null);
                              }}
                              className={`px-1.5 py-0.5 rounded-md text-[11px] leading-tight font-medium truncate flex items-center gap-1 cursor-pointer transition-all ${
                                isGoogle
                                  ? 'bg-[#2457A7]/10 text-[#2457A7] hover:bg-[#2457A7]/20 border border-[#2457A7]/20'
                                  : isDone
                                  ? 'bg-slate-100 text-slate-400 line-through border border-slate-200'
                                  : 'bg-[#EAF3FC] text-[#172B42] hover:bg-[#d5e7fa] border border-[#8DBCEB]/50'
                              }`}
                            >
                              <span className="font-mono text-[9px] shrink-0 opacity-80">
                                {startTimeStr}
                              </span>
                              <span className="truncate">{item.title}</span>
                              {(item.isContinuedFromYesterday || item.isContinuedToTomorrow) && (
                                <span className="text-[8px] bg-indigo-100 text-indigo-700 font-bold px-1 rounded shrink-0">
                                  {item.isContinuedFromYesterday ? '↩' : '↪'}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Overflow More Indicator */}
                    {overflowCount > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDayOverview({ date: cell.date, items: cell.items });
                        }}
                        className="text-[10px] font-semibold text-[#2457A7] hover:underline pt-1 text-left"
                      >
                        +{overflowCount} lainnya
                      </button>
                    )}
                  </DroppableMonthDayCell>
                );
              })}
            </div>
          </div>
        )}
      </div>

        {/* Collapsible Unscheduled Tasks Drawer */}
        <AnimatePresence>
          {isUnscheduledDrawerOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 288, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="w-72 shrink-0 border-l border-[#D9E3EF] bg-white flex flex-col h-full overflow-hidden shadow-xs z-20"
            >
              {/* Drawer header */}
              <div className="p-3.5 border-b border-[#D9E3EF] flex items-center justify-between bg-[#F8FAFC]">
                <div className="flex items-center gap-2 min-w-0">
                  <GripVertical size={16} className="text-[#2457A7] shrink-0" />
                  <span className="text-xs font-bold text-[#172B42] truncate">Tugas Antrean</span>
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#2457A7] text-white shrink-0">
                    {unscheduledTasks.length}
                  </span>
                </div>
                <button
                  onClick={() => setIsUnscheduledDrawerOpen(false)}
                  className="p-1 text-[#53657A] hover:text-[#172B42] hover:bg-slate-200/50 rounded-lg transition-colors"
                  title="Tutup panel antrean"
                >
                  <PanelRightClose size={15} />
                </button>
              </div>

              {/* Drawer info note */}
              <div className="px-3.5 py-2.5 bg-blue-50/60 border-b border-blue-100 text-[11px] text-[#2457A7] leading-relaxed">
                Tarik kegiatan dan letakkan pada slot jam di kalender untuk menjadwalkannya secara langsung.
              </div>

              {/* Drawer tasks list */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
                {unscheduledTasks.length === 0 ? (
                  <div className="py-12 text-center text-xs text-[#53657A] flex flex-col items-center justify-center gap-2 px-2">
                    <CheckCircle2 size={32} className="text-[#16856B]" />
                    <p className="font-semibold text-[#172B42]">Semua kegiatan terjadwal!</p>
                    <p className="text-[11px] text-[#53657A]">
                      Tidak ada tugas dalam antrean belum terjadwal.
                    </p>
                    <button
                      onClick={onOpenTaskModal}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#2457A7] text-white text-xs font-semibold hover:bg-[#1d4685] transition-colors shadow-xs"
                    >
                      <Plus size={13} />
                      Tambah Kegiatan Baru
                    </button>
                  </div>
                ) : (
                  unscheduledTasks.map((task) => (
                    <DraggableTaskCard key={task.id} task={task} />
                  ))
                )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {/* Day Overview Modal for Month View */}
      {selectedDayOverview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-start justify-between border-b border-[#D9E3EF] pb-3">
              <div>
                <span className="text-[10px] font-semibold bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-full">
                  Agenda Tanggal
                </span>
                <h3 className="text-base font-bold text-[#172B42] font-editorial mt-1">
                  {formatInTimezone(selectedDayOverview.date, tz, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </h3>
              </div>
              <button
                onClick={() => setSelectedDayOverview(null)}
                className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100"
              >
                ✕
              </button>
            </div>

            <div className="overflow-y-auto space-y-2 flex-1 pr-1">
              {selectedDayOverview.items.map((item) => {
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
                      setSelectedDayOverview(null);
                    }}
                    className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                      isGoogle
                        ? 'bg-[#2457A7]/5 border-[#2457A7]/20 hover:bg-[#2457A7]/10'
                        : isDone
                        ? 'bg-slate-50 border-slate-200 text-slate-400 line-through'
                        : 'bg-[#EAF3FC]/60 border-[#8DBCEB]/50 hover:bg-[#EAF3FC]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-[#172B42] truncate">
                          {item.title}
                        </span>
                        {isGoogle ? (
                          <span className="text-[9px] bg-white border border-[#D9E3EF] text-[#53657A] px-1.5 py-0.2 rounded font-medium">
                            Google
                          </span>
                        ) : (
                          <span className="text-[9px] bg-[#2457A7] text-white px-1.5 py-0.2 rounded-full font-medium">
                            Sesi EVEN
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-[#53657A] font-mono mt-1">
                        <Clock size={12} className="text-[#2457A7]" />
                        <span>
                          {formatInTimezone(item.visibleStart, tz, { hour: '2-digit', minute: '2-digit' })} -{' '}
                          {formatInTimezone(item.visibleEnd, tz, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span>({item.visibleDurationMinutes}m)</span>
                      </div>
                    </div>
                    <ArrowRight size={14} className="text-[#53657A] shrink-0" />
                  </div>
                );
              })}
            </div>

            <div className="pt-3 border-t border-[#D9E3EF] flex items-center justify-between">
              <button
                onClick={() => {
                  setCurrentDate(selectedDayOverview.date);
                  setViewMode('day');
                  setSelectedDayOverview(null);
                }}
                className="px-3.5 py-2 bg-[#2457A7] text-white text-xs font-semibold rounded-xl hover:bg-[#1E4889] transition-colors"
              >
                Buka di Tampilan Hari
              </button>
              <button
                onClick={() => setSelectedDayOverview(null)}
                className="px-3.5 py-2 text-xs font-medium text-[#53657A] hover:bg-slate-100 rounded-xl"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Google Event Details Modal */}
      {selectedEventDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold bg-[#2457A7]/10 text-[#2457A7] px-2 py-0.5 rounded-full">
                  Acara Google Calendar
                </span>
                <h3 className="text-base font-bold text-[#172B42] font-editorial mt-1.5">
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
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] font-semibold bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-full">
                    Sesi Kegiatan EVEN
                  </span>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${CATEGORY_OPTIONS.find((c) => c.id === (selectedSessionDetails.task.category || 'personal'))?.badgeClass}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${CATEGORY_OPTIONS.find((c) => c.id === (selectedSessionDetails.task.category || 'personal'))?.dotClass}`} />
                    {CATEGORY_OPTIONS.find((c) => c.id === (selectedSessionDetails.task.category || 'personal'))?.label}
                  </span>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${PRIORITY_OPTIONS.find((p) => p.id === selectedSessionDetails.task.priority)?.badgeClass}`}>
                    Prioritas {PRIORITY_OPTIONS.find((p) => p.id === selectedSessionDetails.task.priority)?.label}
                  </span>
                </div>
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

              {(selectedSessionDetails.session.googleCalendarEventId || selectedSessionDetails.session.syncStatus === 'synced') && (
                <div className="p-2.5 bg-blue-50/70 border border-blue-200/80 rounded-xl flex items-center justify-between text-xs text-[#2457A7] mt-2">
                  <div className="flex items-center gap-1.5 font-medium">
                    <CalendarIcon size={13} className="text-[#2457A7]" />
                    <span>Tersinkronisasi dengan Google Calendar</span>
                  </div>
                  {selectedSessionDetails.session.htmlLink && (
                    <a
                      href={selectedSessionDetails.session.htmlLink}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold underline hover:text-[#1E4889] flex items-center gap-1 text-[11px]"
                    >
                      <ExternalLink size={12} /> Buka
                    </a>
                  )}
                </div>
              )}
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
      {/* Floating Tooltip Component via Framer Motion */}
      <AnimatePresence>
        {hoveredTooltip && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            style={{
              position: 'fixed',
              top: `${Math.min(window.innerHeight - 250, Math.max(16, hoveredTooltip.y - 12))}px`,
              left: `${Math.min(window.innerWidth - 320, Math.max(16, hoveredTooltip.x + 14))}px`,
            }}
            className="z-50 pointer-events-none w-72 rounded-xl bg-white/95 backdrop-blur-md p-3.5 shadow-2xl border border-slate-200/90 text-slate-800 space-y-2 text-xs"
          >
            {/* Header Badge & Title */}
            <div>
              <div className="flex items-center gap-1.5 flex-wrap mb-1">
                <span
                  className={`text-[9px] font-semibold px-2 py-0.5 rounded-full ${
                    hoveredTooltip.item.sourceType === 'google'
                      ? 'bg-blue-50 text-[#2457A7] border border-blue-200'
                      : 'bg-[#EAF3FC] text-[#2457A7] border border-[#8DBCEB]/50'
                  }`}
                >
                  {hoveredTooltip.item.sourceType === 'google' ? 'Google Calendar' : 'Tugas EVEN'}
                </span>
                {hoveredTooltip.item.isGoogleSynced && hoveredTooltip.item.sourceType !== 'google' && (
                  <span className="text-[9px] font-semibold bg-blue-100 text-[#2457A7] px-1.5 py-0.5 rounded-full">
                    Tersinkron GCal
                  </span>
                )}
                {hoveredTooltip.item.hasConflict && (
                  <span className="text-[9px] font-semibold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                    <AlertTriangle size={9} /> Bentrok Jadwal
                  </span>
                )}
                {hoveredTooltip.item.isDone && (
                  <span className="text-[9px] font-semibold bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                    <CheckCircle2 size={9} /> Selesai
                  </span>
                )}
              </div>

              <h4 className="font-bold text-sm text-[#172B42] leading-snug line-clamp-2">
                {hoveredTooltip.item.title}
              </h4>
            </div>

            {/* Time and Duration */}
            <div className="flex items-center gap-1.5 text-[#53657A] text-[11px] font-medium">
              <Clock size={12} className="text-[#2457A7] shrink-0" />
              <span>
                {formatInTimezone(hoveredTooltip.item.itemStart, tz, {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
                {' - '}
                {formatInTimezone(hoveredTooltip.item.itemEnd, tz, {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}{' '}
                WIB ({hoveredTooltip.item.totalDurationMinutes} mnt)
              </span>
            </div>

            {/* Badges for Category and Priority */}
            <div className="flex items-center gap-1.5 pt-0.5 flex-wrap">
              <span
                className={`inline-flex items-center gap-1 text-[9px] font-medium px-2 py-0.5 rounded-full border ${
                  CATEGORY_OPTIONS.find((c) => c.id === hoveredTooltip.item.category)?.badgeClass ||
                  'bg-slate-100 text-slate-700 border-slate-200'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    CATEGORY_OPTIONS.find((c) => c.id === hoveredTooltip.item.category)?.dotClass || 'bg-slate-400'
                  }`}
                />
                {CATEGORY_OPTIONS.find((c) => c.id === hoveredTooltip.item.category)?.label || 'Kegiatan'}
              </span>

              <span
                className={`text-[9px] font-medium px-2 py-0.5 rounded-full border ${
                  PRIORITY_OPTIONS.find((p) => p.id === hoveredTooltip.item.priority)?.badgeClass ||
                  'bg-slate-100 text-slate-700 border-slate-200'
                }`}
              >
                Prioritas {PRIORITY_OPTIONS.find((p) => p.id === hoveredTooltip.item.priority)?.label || 'Sedang'}
              </span>
            </div>

            {/* Location or Meet URL if present */}
            {hoveredTooltip.item.event?.location && (
              <p className="text-[10px] text-[#53657A] truncate">
                📍 {hoveredTooltip.item.event.location}
              </p>
            )}
            {hoveredTooltip.item.event?.meetUrl && (
              <div className="flex items-center gap-1 text-[10px] text-[#2457A7] font-medium">
                <Video size={11} /> Google Meet Video
              </div>
            )}

            {/* Description or Notes Preview */}
            {(hoveredTooltip.item.task?.description || hoveredTooltip.item.event?.description) && (
              <p className="text-[10px] text-slate-500 line-clamp-2 border-t border-slate-100 pt-1.5 mt-1 italic">
                "{hoveredTooltip.item.task?.description || hoveredTooltip.item.event?.description}"
              </p>
            )}

            <div className="text-[9px] text-slate-400 pt-0.5 flex items-center justify-between">
              <span>Klik untuk membuka detail lengkap</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>

    <DragOverlay>
      {activeDragTask && (
        <div className="p-3 bg-white border-2 border-[#2457A7] rounded-xl shadow-xl flex flex-col gap-1.5 w-60 rotate-2 scale-105 pointer-events-none opacity-95">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-[#172B42] truncate">{activeDragTask.title}</h4>
            <span className="text-[10px] font-bold px-1.5 py-0.2 bg-[#2457A7] text-white rounded">
              {activeDragTask.estimatedDurationMinutes || 60}m
            </span>
          </div>
          <p className="text-[10px] text-[#53657A] line-clamp-1">
            {activeDragTask.description || 'Lepaskan pada slot waktu untuk menjadwalkan'}
          </p>
        </div>
      )}
    </DragOverlay>
  </DndContext>
  );
};
