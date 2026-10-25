import { CalendarEvent, Task, UserPreferences } from '../types';

export const INITIAL_PREFERENCES: UserPreferences = {
  displayName: 'Fajriansyah Pratama',
  email: 'fajriansyahpratama2103@gmail.com',
  timezone: 'Asia/Jakarta (WIB)',
  workStartHour: 9,
  workEndHour: 18,
  enableLunchBreak: true,
  lunchStartHour: 12,
  lunchEndHour: 13,
  bufferMinutes: 15,
  workDays: [1, 2, 3, 4, 5], // Senin - Jumat
  googleCalendarConnected: false,
  calendarSyncStatus: 'pending',
  lastSyncedAt: null,
  allowAutoSplit: true
};

export function getInitialEvents(): CalendarEvent[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();

  // Create real dates anchored to current calendar days
  const today10 = new Date(year, month, date, 10, 0, 0);
  const today11 = new Date(year, month, date, 11, 0, 0);

  const tomorrow14 = new Date(year, month, date + 1, 14, 0, 0);
  const tomorrow1530 = new Date(year, month, date + 1, 15, 30, 0);

  const dayAfter11 = new Date(year, month, date + 2, 11, 0, 0);
  const dayAfter12 = new Date(year, month, date + 2, 12, 0, 0);

  return [
    {
      id: 'gcal-evt-1',
      provider: 'google',
      title: 'Weekly Sync Tim Produk EVEN',
      description: 'Penyelarasan agenda rilis mingguan dan peninjauan umpan balik pengguna.',
      startAt: today10.toISOString(),
      endAt: today11.toISOString(),
      attendees: ['fajriansyahpratama2103@gmail.com', 'nadia.s@even.app', 'budi.w@even.app'],
      location: 'Google Meet (online)',
      meetUrl: 'https://meet.google.com/eve-napp-prd',
      isEditable: false,
      isRecurring: true,
      syncStatus: 'synced',
      category: 'meeting'
    },
    {
      id: 'gcal-evt-2',
      provider: 'google',
      title: 'Review Desain Sprint & UI Taskly Benchmark',
      description: 'Evaluasi hirarki visual Open Horizon, keterbacaan tipografi DM Sans, dan sidebar.',
      startAt: tomorrow14.toISOString(),
      endAt: tomorrow1530.toISOString(),
      attendees: ['fajriansyahpratama2103@gmail.com', 'rudi.designer@even.app'],
      location: 'Google Meet',
      meetUrl: 'https://meet.google.com/eve-ui-revw',
      isEditable: false,
      syncStatus: 'synced',
      category: 'meeting'
    },
    {
      id: 'gcal-evt-3',
      provider: 'google',
      title: 'Sinkronisasi Arsitektur Database & OAuth',
      description: 'Diskusi pemisahan token, idempotency key, dan token encryption.',
      startAt: dayAfter11.toISOString(),
      endAt: dayAfter12.toISOString(),
      attendees: ['fajriansyahpratama2103@gmail.com', 'tech-lead@even.app'],
      location: 'Google Meet',
      meetUrl: 'https://meet.google.com/eve-arch-sync',
      isEditable: false,
      syncStatus: 'synced',
      category: 'meeting'
    }
  ];
}

export function getInitialTasks(): Task[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();

  const deadlineTomorrow = new Date(year, month, date + 1, 17, 0, 0);
  const deadlineDayAfter = new Date(year, month, date + 2, 17, 0, 0);
  const deadline3Days = new Date(year, month, date + 3, 17, 0, 0);

  // Pre-scheduled session for task 4
  const task4SessionStart = new Date(year, month, date, 15, 0, 0);
  const task4SessionEnd = new Date(year, month, date, 16, 0, 0);

  return [
    {
      id: 'task-1',
      userId: 'user-default',
      title: 'Finalisasi Dokumen Kebutuhan Scheduler',
      description: 'Menuliskan aturan rinci pembagian slot dan penanganan event bentrok.',
      estimatedDurationMinutes: 60,
      deadlineAt: deadlineDayAfter.toISOString(),
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false,
      minimumSessionMinutes: 30,
      preferredTimeOfDay: 'MORNING',
      createdAt: new Date().toISOString()
    },
    {
      id: 'task-2',
      userId: 'user-default',
      title: 'Audit Kontras Aksesibilitas Palet Open Horizon',
      description: 'Memastikan kontras Deep Ink terhadap Cloud White dan Pale Sky lolos WCAG AA.',
      estimatedDurationMinutes: 45,
      deadlineAt: deadlineTomorrow.toISOString(),
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: false,
      minimumSessionMinutes: 30,
      preferredTimeOfDay: 'AFTERNOON',
      createdAt: new Date().toISOString()
    },
    {
      id: 'task-3',
      userId: 'user-default',
      title: 'Uji Integrasi Read-Write Google Calendar API',
      description: 'Validasi token refresh, idempotency payload, dan pencegahan duplikasi event.',
      estimatedDurationMinutes: 90,
      deadlineAt: deadline3Days.toISOString(),
      priority: 'URGENT',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 45,
      preferredTimeOfDay: 'ANY',
      createdAt: new Date().toISOString()
    },
    {
      id: 'task-4',
      userId: 'user-default',
      title: 'Persiapan Rilis PWA & Service Worker Offline',
      description: 'Konfigurasi web app manifest dan cache agenda hari ini untuk mode offline.',
      estimatedDurationMinutes: 60,
      deadlineAt: deadlineTomorrow.toISOString(),
      priority: 'MEDIUM',
      status: 'SCHEDULED',
      allowSplit: false,
      minimumSessionMinutes: 30,
      preferredTimeOfDay: 'AFTERNOON',
      createdAt: new Date().toISOString(),
      scheduledSessions: [
        {
          id: 'sess-task-4-1',
          taskId: 'task-4',
          taskTitle: 'Persiapan Rilis PWA & Service Worker Offline',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: task4SessionStart.toISOString(),
          endAt: task4SessionEnd.toISOString(),
          durationMinutes: 60,
          status: 'SCHEDULED',
          syncStatus: 'synced'
        }
      ]
    }
  ];
}
