export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type TaskStatus =
  | 'UNSCHEDULED'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'completed_manual'
  | 'missed_auto';

export type SessionStatus =
  | 'SCHEDULED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'completed_manual'
  | 'missed_auto';

export type SyncStatus = 'synced' | 'pending' | 'failed' | 'needs_reconciliation';

export type RescheduleDecision = 'pending' | 'rescheduled' | 'dismissed';

export interface StatusHistoryEntry {
  status: TaskStatus;
  changedAt: string; // ISO date string
  reason?: string;
}

export interface TaskScheduleSession {
  id: string;
  taskId: string;
  taskTitle: string;
  sessionIndex: number;
  totalSessions: number;
  startAt: string; // ISO date string
  endAt: string;   // ISO date string
  durationMinutes: number;
  status: SessionStatus;
  syncStatus: SyncStatus;
  googleCalendarEventId?: string;
  htmlLink?: string;
  completedAt?: string;
  missedAt?: string;
}

export type TimeConstraintType = 'fixed_event' | 'preferred_window' | 'deadline_only';

export interface PreferredTimeWindow {
  startHour: number;      // e.g. 19 for 7 PM
  startMinute?: number;    // e.g. 0
  endHour: number;        // e.g. 22 for 10 PM
  endMinute?: number;      // e.g. 0
  label?: string;         // e.g. 'Malam (19:00 - 22:00)'
}

export interface Task {
  id: string;
  userId: string;
  title: string;
  description?: string;
  estimatedDurationMinutes: number;
  deadlineAt?: string | null; // ISO date string - strictly optional
  priority: Priority;
  status: TaskStatus;
  allowSplit: boolean;
  minimumSessionMinutes?: number;
  preferredTimeOfDay?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY';
  timeConstraintType?: TimeConstraintType;
  requestedStartAt?: string; // ISO string for fixed event
  requestedEndAt?: string;   // ISO string for fixed event
  isAllDay?: boolean;
  category?: 'work' | 'personal' | 'study' | 'focus';
  preferredWindow?: PreferredTimeWindow;
  timezone?: string;
  createdAt: string;
  scheduledSessions?: TaskScheduleSession[];
  // History & Reschedule Fields
  completedAt?: string;
  missedAt?: string;
  rescheduleDecision?: RescheduleDecision;
  rescheduledToTaskId?: string;
  rescheduledFromTaskId?: string;
  dismissedAt?: string;
  statusHistory?: StatusHistoryEntry[];
}

export interface CalendarEvent {
  id: string;
  provider: 'google' | 'internal';
  title: string;
  description?: string;
  startAt: string; // ISO
  endAt: string;   // ISO
  isAllDay?: boolean;
  attendees?: string[];
  location?: string;
  meetUrl?: string;
  htmlLink?: string;
  isEditable: boolean;
  isRecurring?: boolean;
  syncStatus: SyncStatus;
  category?: 'meeting' | 'focus' | 'personal' | 'deadline';
}

export interface UserPreferences {
  displayName: string;
  email: string;
  timezone: string;
  workStartHour: number; // 1 to 24 (e.g. 9 or 22 for night shift)
  workEndHour: number;   // 1 to 24 (e.g. 18 or 6 for next day)
  enableLunchBreak: boolean; // Lunch break can be disabled
  lunchStartHour: number; // e.g., 12
  lunchEndHour: number;   // e.g., 13
  bufferMinutes: number;  // e.g., 15
  workDays: number[];     // [1,2,3,4,5] (Senin = 1, Minggu = 0)
  googleCalendarConnected: boolean;
  calendarSyncStatus: SyncStatus;
  lastSyncedAt: string | null;
  allowAutoSplit: boolean;
}

export interface ScheduleCalculationResult {
  success: boolean;
  taskId: string;
  taskTitle: string;
  failureCode?:
    | 'TIME_CONFLICT'
    | 'PREFERRED_WINDOW_FULL'
    | 'NO_SLOT_BEFORE_DEADLINE'
    | 'DEADLINE_PASSED'
    | 'INVALID_TIME_RANGE';
  proposedSessions: {
    startAt: string;
    endAt: string;
    durationMinutes: number;
    sessionIndex: number;
    totalSessions: number;
  }[];
  explanation: string;
  warning?: string;
  diagnostics?: {
    freeTimeCalculatedMinutes?: number;
    searchDaysLimit?: number;
    isNightShift?: boolean;
  };
}

export interface AIPlanDraft {
  title: string;
  description?: string;
  estimatedDurationMinutes: number;
  timeConstraintType: TimeConstraintType; // 'fixed_event' | 'preferred_window' | 'deadline_only'
  requestedStartAt?: string;             // ISO date string for fixed event
  requestedEndAt?: string;               // ISO date string for fixed event
  preferredWindow?: PreferredTimeWindow; // Custom window e.g. 19:00 - 22:00
  preferredTimeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY';
  deadlineAt?: string | null;            // ISO date string (optional)
  hasDeadline?: boolean;
  deadlineDaysFromNow?: number;
  timezone: string;                      // e.g. 'Asia/Jakarta'
  priority: Priority;
  allowSplit: boolean;
  minimumSessionMinutes: number;
  reasoning: string;
}

export interface KeepChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface KeepNote {
  id: string;
  userId: string;
  title: string;
  content: string;
  checklist?: KeepChecklistItem[];
  color: 'default' | 'sand' | 'coral' | 'sage' | 'fog' | 'storm';
  isPinned: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}
