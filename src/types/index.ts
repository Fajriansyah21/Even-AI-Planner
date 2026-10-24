export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type TaskStatus = 'UNSCHEDULED' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED';

export type SyncStatus = 'synced' | 'pending' | 'failed' | 'needs_reconciliation';

export interface TaskScheduleSession {
  id: string;
  taskId: string;
  taskTitle: string;
  sessionIndex: number;
  totalSessions: number;
  startAt: string; // ISO date string
  endAt: string;   // ISO date string
  durationMinutes: number;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  syncStatus: SyncStatus;
  googleCalendarEventId?: string;
  htmlLink?: string;
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
  deadlineAt: string; // ISO date string
  priority: Priority;
  status: TaskStatus;
  allowSplit: boolean;
  minimumSessionMinutes?: number;
  preferredTimeOfDay?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY';
  timeConstraintType?: TimeConstraintType;
  requestedStartAt?: string; // ISO string for fixed event
  requestedEndAt?: string;   // ISO string for fixed event
  preferredWindow?: PreferredTimeWindow;
  timezone?: string;
  createdAt: string;
  scheduledSessions?: TaskScheduleSession[];
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
  workStartHour: number; // e.g., 9
  workEndHour: number;   // e.g., 18
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
  proposedSessions: {
    startAt: string;
    endAt: string;
    durationMinutes: number;
    sessionIndex: number;
    totalSessions: number;
  }[];
  explanation: string;
  warning?: string;
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
  deadlineAt?: string;                   // ISO date string
  deadlineDaysFromNow: number;
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
