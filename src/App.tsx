import React, { useState, useEffect } from 'react';
import { Sidebar, SidebarTab } from './components/Sidebar';
import { Header } from './components/Header';
import { CalendarView } from './components/CalendarView';
import { TaskListView } from './components/TaskListView';
import { TaskDashboardView } from './components/TaskDashboardView';
import { AIAssistantView } from './components/AIAssistantView';
import { SettingsView, CalendarDiagnosticInfo } from './components/SettingsView';
import { KeepNotesView } from './components/KeepNotesView';
import { AuthModal } from './components/AuthModal';
import { OnboardingModal } from './components/OnboardingModal';
import { TaskModal } from './components/TaskModal';
import { ScheduleResultModal } from './components/ScheduleResultModal';
import { BatchScheduleModal } from './components/BatchScheduleModal';
import { HistoryView } from './components/HistoryView';
import { RescheduleModal } from './components/RescheduleModal';
import { motion, AnimatePresence } from 'framer-motion';
import {
  auditAndTransitionOverdueTasks,
  completeTaskManually,
  dismissMissedTask,
  prepareRescheduledTask,
} from './lib/activityStatusManager';
import {
  Task,
  CalendarEvent,
  UserPreferences,
  ScheduleCalculationResult,
  AIPlanDraft,
  KeepNote,
  TaskScheduleSession,
} from './types';
import {
  INITIAL_PREFERENCES,
  getInitialEvents,
  getInitialTasks,
} from './lib/mockData';
import {
  scheduleTaskDeterministically,
  scheduleAllPendingTasks,
} from './lib/scheduler';
import {
  initAuth,
  googleSignIn,
  logout as firebaseLogout,
  getCachedAccessToken,
  setCachedAccessToken,
  db,
  handleFirestoreError,
  OperationType,
  sanitizeForFirestore,
} from './lib/firebase';
import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from './lib/googleCalendar';
import {
  getInitialKeepNotes,
  convertKeepNoteToTask,
} from './lib/googleKeep';
import { CheckCircle2, AlertCircle, X, AlertTriangle } from 'lucide-react';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';

export default function App() {
  // Navigation tab
  const [currentTab, setCurrentTab] = useState<SidebarTab>('calendar');
  const [rescheduleTaskTarget, setRescheduleTaskTarget] = useState<Task | null>(null);

  // User state - starts unauthenticated until verified
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [hasGoogleAccessToken, setHasGoogleAccessToken] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [preferences, setPreferences] = useState<UserPreferences>(() => {
    try {
      const saved = localStorage.getItem('even_preferences');
      return saved ? JSON.parse(saved) : INITIAL_PREFERENCES;
    } catch {
      return INITIAL_PREFERENCES;
    }
  });

  // Tasks state
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      const saved = localStorage.getItem('even_tasks');
      return saved ? JSON.parse(saved) : getInitialTasks();
    } catch {
      return getInitialTasks();
    }
  });

  // Calendar Events state
  const [events, setEvents] = useState<CalendarEvent[]>(() => {
    try {
      const saved = localStorage.getItem('even_events');
      return saved ? JSON.parse(saved) : getInitialEvents();
    } catch {
      return getInitialEvents();
    }
  });

  // Google Keep Notes state
  const [keepNotes, setKeepNotes] = useState<KeepNote[]>(() => {
    try {
      const saved = localStorage.getItem('even_keep_notes');
      return saved ? JSON.parse(saved) : getInitialKeepNotes();
    } catch {
      return getInitialKeepNotes();
    }
  });

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [diagnosticInfo, setDiagnosticInfo] = useState<CalendarDiagnosticInfo>({
    connectionStatus: 'unconnected',
    accountEmail: null,
    targetCalendar: 'primary',
    queryRangeStart: '',
    queryRangeEnd: '',
    queryTimezone: 'Asia/Jakarta (WIB)',
    lastSyncedAt: null,
    eventsGoogleCount: 0,
    eventsLocalCount: 0,
    eventsCreatedCount: 0,
    eventsFailedCount: 0,
    eventsUnconfirmedCount: 0,
  });

  // Destructive Confirmation Modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    description: string;
    actionLabel: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    description: '',
    actionLabel: 'Hapus',
    onConfirm: () => {},
  });

  // Modals state
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('login');
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [taskToEdit, setTaskToEdit] = useState<Task | null>(null);
  const [singleScheduleResult, setSingleScheduleResult] = useState<ScheduleCalculationResult | null>(null);
  const [batchScheduleResults, setBatchScheduleResults] = useState<ScheduleCalculationResult[]>([]);
  const [pendingBatchTasks, setPendingBatchTasks] = useState<Task[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Setup Firebase Auth listener & browser extension error filter on mount
  useEffect(() => {
    const handleGlobalError = (event: ErrorEvent) => {
      const msg = event.message || '';
      const file = event.filename || '';
      const stack = event.error?.stack || '';
      if (
        msg.includes('Could not establish connection') ||
        msg.includes('Receiving end does not exist') ||
        file.includes('chrome-extension://') ||
        stack.includes('chrome-extension://')
      ) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason?.message || String(event.reason || '');
      const stack = event.reason?.stack || '';
      if (
        reason.includes('Could not establish connection') ||
        reason.includes('Receiving end does not exist') ||
        stack.includes('chrome-extension://')
      ) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
      }
    };

    window.addEventListener('error', handleGlobalError, true);
    window.addEventListener('unhandledrejection', handleUnhandledRejection, true);

    const unsubscribe = initAuth(
      (user, token) => {
        setIsLoggedIn(true);
        setUserId(user.uid);
        if (token) {
          setHasGoogleAccessToken(true);
        } else {
          setHasGoogleAccessToken(false);
        }
        setPreferences((prev) => ({
          ...prev,
          displayName: user.displayName || prev.displayName,
          email: user.email || prev.email,
          googleCalendarConnected: Boolean(token),
        }));
      },
      () => {
        // Unauthenticated or user signed out
        setIsLoggedIn(false);
        setUserId(null);
        setHasGoogleAccessToken(false);
        setPreferences((prev) => ({
          ...prev,
          googleCalendarConnected: false,
        }));
      }
    );
    return () => {
      window.removeEventListener('error', handleGlobalError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      unsubscribe();
    };
  }, []);

  // Persist to localStorage
  useEffect(() => {
    localStorage.setItem('even_preferences', JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    localStorage.setItem('even_tasks', JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    localStorage.setItem('even_events', JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    localStorage.setItem('even_keep_notes', JSON.stringify(keepNotes));
  }, [keepNotes]);

  // Automated audit to transition overdue tasks to missed_auto
  useEffect(() => {
    const runAudit = () => {
      setTasks((prevTasks) => {
        const { updatedTasks, transitionedCount } = auditAndTransitionOverdueTasks(prevTasks);
        if (transitionedCount > 0) {
          if (userId && userId !== 'user-default') {
            for (const t of updatedTasks) {
              const old = prevTasks.find((p) => p.id === t.id);
              if (old && (old.status !== t.status || old.missedAt !== t.missedAt)) {
                setDoc(doc(db, 'users', userId, 'tasks', t.id), sanitizeForFirestore(t)).catch((err) => {
                  handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${t.id}`);
                });
              }
            }
          }
          return updatedTasks;
        }
        return prevTasks;
      });
    };

    runAudit();
    const interval = setInterval(runAudit, 30000);
    const handleFocus = () => runAudit();
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, [userId]);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 3500);
  };

  const handleConnectCalendar = async () => {
    setDiagnosticInfo((prev) => ({ ...prev, connectionStatus: 'connecting' }));
    try {
      const res = await googleSignIn();
      if (res && res.accessToken) {
        setCachedAccessToken(res.accessToken);
        setHasGoogleAccessToken(true);
        setIsLoggedIn(true);
        setUserId(res.user.uid);
        setPreferences((prev) => ({
          ...prev,
          googleCalendarConnected: true,
          email: res.user.email || prev.email,
          displayName: res.user.displayName || prev.displayName,
        }));
        setDiagnosticInfo((prev) => ({
          ...prev,
          connectionStatus: 'connected_unsynced',
          accountEmail: res.user.email || prev.accountEmail,
        }));
        showToast('Google Calendar berhasil dihubungkan!', 'success');
        await handleSyncCalendar();
      }
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        setDiagnosticInfo((prev) => ({ ...prev, connectionStatus: 'unconnected' }));
        showToast('Penghubungan Google Calendar dibatalkan.', 'info');
      } else {
        setDiagnosticInfo((prev) => ({
          ...prev,
          connectionStatus: 'sync_failed',
          lastErrorMessage: err.message,
        }));
        showToast(`Gagal menghubungkan Google Calendar: ${err.message}`, 'error');
      }
    }
  };

  const handleDisconnectCalendar = () => {
    setCachedAccessToken(null);
    setHasGoogleAccessToken(false);
    setPreferences((prev) => ({
      ...prev,
      googleCalendarConnected: false,
      calendarSyncStatus: 'pending',
    }));
    setDiagnosticInfo((prev) => ({
      ...prev,
      connectionStatus: 'unconnected',
      lastErrorMessage: undefined,
    }));
    showToast('Hubungan Google Calendar telah diputuskan.', 'info');
  };

  // Google Calendar Sync
  const handleSyncCalendar = async () => {
    setIsSyncing(true);
    setDiagnosticInfo((prev) => ({ ...prev, connectionStatus: 'syncing' }));
    const token = getCachedAccessToken();

    if (!token) {
      setIsSyncing(false);
      setPreferences((prev) => ({
        ...prev,
        calendarSyncStatus: 'needs_reconciliation',
        googleCalendarConnected: false,
      }));
      setDiagnosticInfo((prev) => ({
        ...prev,
        connectionStatus: 'needs_reauth',
        lastErrorMessage: 'Token Google Calendar tidak aktif. Silakan hubungkan akun Google Calendar di Pengaturan.',
      }));
      showToast('Token Google Calendar tidak aktif. Silakan klik Hubungkan Kalender di Pengaturan.', 'error');
      return;
    }

    try {
      const { events: liveGoogleEvents, rangeStart, rangeEnd } = await fetchGoogleCalendarEvents(token);
      
      // Merge live Google events with internal task sessions
      setEvents((prev) => {
        const internalEvents = prev.filter((e) => e.provider !== 'google');
        return [...liveGoogleEvents, ...internalEvents];
      });

      const updatedTime = new Date().toISOString();
      const localScheduledCount = tasks.filter((t) => t.status === 'SCHEDULED').length;

      setPreferences((prev) => ({
        ...prev,
        calendarSyncStatus: 'synced',
        lastSyncedAt: updatedTime,
        googleCalendarConnected: true,
      }));

      setDiagnosticInfo((prev) => ({
        ...prev,
        connectionStatus: 'sync_success',
        accountEmail: preferences.email,
        targetCalendar: 'primary',
        queryRangeStart: rangeStart,
        queryRangeEnd: rangeEnd,
        queryTimezone: preferences.timezone,
        lastSyncedAt: updatedTime,
        eventsGoogleCount: liveGoogleEvents.length,
        eventsLocalCount: localScheduledCount,
        lastErrorMessage: undefined,
      }));

      if (liveGoogleEvents.length === 0) {
        showToast('Sinkronisasi selesai: 0 agenda ditemukan di rentang Google Calendar.', 'info');
      } else {
        showToast(`Sinkronisasi Google Calendar berhasil! Dimuat ${liveGoogleEvents.length} agenda.`);
      }
    } catch (err: any) {
      console.error('Calendar sync error:', err.message);
      const isAuthError = err.message.includes('401') || err.message.includes('Token');
      const isForbidden = err.message.includes('403');
      const nextStatus = isAuthError ? 'needs_reauth' : 'sync_failed';

      setPreferences((prev) => ({
        ...prev,
        calendarSyncStatus: 'failed',
        googleCalendarConnected: isAuthError ? false : prev.googleCalendarConnected,
      }));

      setDiagnosticInfo((prev) => ({
        ...prev,
        connectionStatus: nextStatus,
        lastErrorMessage: err.message,
      }));

      showToast(`Gagal menyinkronkan Google Calendar: ${err.message}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  // Reset to initial mock data with confirmation
  const handleResetData = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Kembalikan ke Data Awal?',
      description: 'Semua perubahan tugas lokal, catatan Keep, dan acara kalender akan diatur ulang ke kondisi demo awal.',
      actionLabel: 'Reset Data',
      onConfirm: () => {
        setTasks(getInitialTasks());
        setEvents(getInitialEvents());
        setKeepNotes(getInitialKeepNotes());
        setPreferences(INITIAL_PREFERENCES);
        showToast('Data berhasil dikembalikan ke pengaturan dan jadwal awal.', 'info');
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  // Task creation/update
  const handleSaveTask = async (taskData: Omit<Task, 'id' | 'createdAt' | 'status' | 'scheduledSessions'>) => {
    const currentUserId = userId || 'user-default';
    const isEditingExisting = Boolean(taskToEdit && taskToEdit.id && taskToEdit.id.trim().length > 0);

    if (isEditingExisting && taskToEdit && taskToEdit.id) {
      const editTaskId = taskToEdit.id.trim();
      const updatedTask: Task = {
        ...taskToEdit,
        ...taskData,
        id: editTaskId,
        userId: currentUserId,
        status: 'UNSCHEDULED',
        scheduledSessions: [],
      };
      setTasks((prev) =>
        prev.map((t) => (t.id === editTaskId ? updatedTask : t))
      );
      showToast(`Kegiatan "${taskData.title}" berhasil diperbarui.`);

      // Persist to Firestore if user is authenticated and document id is valid
      if (userId && userId !== 'user-default' && editTaskId) {
        try {
          await setDoc(doc(db, 'users', userId, 'tasks', editTaskId), sanitizeForFirestore(updatedTask));
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${editTaskId}`);
        }
      }
    } else {
      const newTaskId = `task-${Date.now()}`;
      const newTask: Task = {
        ...taskData,
        id: newTaskId,
        userId: currentUserId,
        status: 'UNSCHEDULED',
        createdAt: new Date().toISOString(),
        scheduledSessions: [],
      };
      setTasks((prev) => [newTask, ...prev]);
      showToast(`Kegiatan baru "${newTask.title}" berhasil dibuat.`);

      // Persist to Firestore if user is authenticated and document id is valid
      if (userId && userId !== 'user-default' && newTaskId) {
        try {
          await setDoc(doc(db, 'users', userId, 'tasks', newTaskId), sanitizeForFirestore(newTask));
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `users/${userId}/tasks/${newTaskId}`);
        }
      }
    }
    setTaskToEdit(null);
  };

  // Delete task with mandatory confirmation dialog
  const handleDeleteTask = (taskId: string) => {
    const taskToDelete = tasks.find((t) => t.id === taskId);
    if (!taskToDelete) return;

    setConfirmModal({
      isOpen: true,
      title: 'Hapus Kegiatan?',
      description: `Apakah Anda yakin ingin menghapus kegiatan "${taskToDelete.title}"? Sesi pengerjaan yang sudah dijadwalkan juga akan dibatalkan. Tindakan ini tidak dapat dibatalkan.`,
      actionLabel: 'Hapus Kegiatan',
      onConfirm: async () => {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        showToast(`Kegiatan "${taskToDelete.title}" telah dihapus.`, 'info');
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));

        if (userId && userId !== 'user-default') {
          try {
            await deleteDoc(doc(db, 'users', userId, 'tasks', taskId));
          } catch (err) {
            handleFirestoreError(err, OperationType.DELETE, `users/${userId}/tasks/${taskId}`);
          }
        }
      },
    });
  };

  const handleToggleTaskComplete = async (taskId: string) => {
    let changedTask: Task | null = null;
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId) {
          const isDone = t.status === 'completed_manual' || t.status === 'COMPLETED';
          if (isDone) {
            const hasSessions = t.scheduledSessions && t.scheduledSessions.length > 0;
            changedTask = {
              ...t,
              userId: userId || t.userId || 'user-default',
              status: hasSessions ? 'SCHEDULED' : 'UNSCHEDULED',
              completedAt: undefined,
              scheduledSessions: t.scheduledSessions?.map((s) => ({
                ...s,
                status: 'SCHEDULED',
              })),
            };
          } else {
            changedTask = {
              ...completeTaskManually(t),
              userId: userId || t.userId || 'user-default',
            };
          }
          return changedTask;
        }
        return t;
      })
    );

    if (changedTask && userId && userId !== 'user-default') {
      try {
        await setDoc(doc(db, 'users', userId, 'tasks', taskId), sanitizeForFirestore(changedTask));
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${taskId}`);
      }
    }
  };

  const handleToggleTaskSessionComplete = async (taskId: string, sessionId: string) => {
    let changedTask: Task | null = null;
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId) {
          changedTask = {
            ...completeTaskManually(t, new Date(), sessionId),
            userId: userId || t.userId || 'user-default',
          };
          return changedTask;
        }
        return t;
      })
    );

    if (changedTask && userId && userId !== 'user-default') {
      try {
        await setDoc(doc(db, 'users', userId, 'tasks', taskId), sanitizeForFirestore(changedTask));
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${taskId}`);
      }
    }
  };

  const handleDismissMissedTask = async (taskId: string) => {
    const targetTask = tasks.find((t) => t.id === taskId);
    if (!targetTask) return;

    const dismissed = dismissMissedTask(targetTask);
    const updatedWithUser: Task = {
      ...dismissed,
      userId: userId || targetTask.userId || 'user-default',
    };

    setTasks((prev) => prev.map((t) => (t.id === taskId ? updatedWithUser : t)));

    if (userId && userId !== 'user-default') {
      try {
        await setDoc(doc(db, 'users', userId, 'tasks', taskId), sanitizeForFirestore(updatedWithUser));
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${taskId}`);
      }
    }

    showToast(`Kegiatan "${targetTask.title}" diabaikan dan disimpan di Riwayat.`, 'info');
  };

  const handleConfirmReschedule = async (
    originalTask: Task,
    newDeadlineAt: string | null,
    manualTime?: { startAt: string; endAt: string }
  ) => {
    const currentUserId = userId || originalTask.userId || 'user-default';

    let scheduleResult: ScheduleCalculationResult;

    if (manualTime) {
      const dur = Math.round(
        (new Date(manualTime.endAt).getTime() - new Date(manualTime.startAt).getTime()) / 60000
      );
      scheduleResult = {
        success: true,
        taskId: originalTask.id,
        taskTitle: originalTask.title,
        proposedSessions: [
          {
            sessionIndex: 1,
            totalSessions: 1,
            startAt: manualTime.startAt,
            endAt: manualTime.endAt,
            durationMinutes: dur > 0 ? dur : originalTask.estimatedDurationMinutes,
          },
        ],
      };
    } else {
      const candidateTask: Task = {
        ...originalTask,
        deadlineAt: newDeadlineAt,
        status: 'UNSCHEDULED',
      };
      scheduleResult = scheduleTaskDeterministically(
        candidateTask,
        events,
        tasks.filter((t) => t.id !== originalTask.id),
        preferences
      );
    }

    if (!scheduleResult.success || scheduleResult.proposedSessions.length === 0) {
      showToast(
        scheduleResult.failureReason ||
          'Tidak ditemukan slot waktu luang yang cocok. Periksa jam kerja atau tenggat waktu.',
        'error'
      );
      return;
    }

    const { newTask, updatedOriginalTask } = prepareRescheduledTask(
      originalTask,
      scheduleResult,
      newDeadlineAt
    );

    newTask.userId = currentUserId;
    updatedOriginalTask.userId = currentUserId;

    setTasks((prev) => [
      newTask,
      ...prev.map((t) => (t.id === originalTask.id ? updatedOriginalTask : t)),
    ]);

    if (userId && userId !== 'user-default') {
      try {
        await setDoc(doc(db, 'users', userId, 'tasks', originalTask.id), sanitizeForFirestore(updatedOriginalTask));
        await setDoc(doc(db, 'users', userId, 'tasks', newTask.id), sanitizeForFirestore(newTask));
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks`);
      }
    }

    setRescheduleTaskTarget(null);
    showToast(
      `Kegiatan "${originalTask.title}" berhasil dijadwalkan ulang!`,
      'success'
    );
  };

  // Schedule Single Task
  const handleScheduleSingleTask = (task: Task) => {
    const res = scheduleTaskDeterministically(task, events, tasks, preferences);
    setSingleScheduleResult(res);
  };

  const handleConfirmSingleSchedule = async (res: ScheduleCalculationResult) => {
    const token = getCachedAccessToken();
    const sessionIdBase = `sess-${res.taskId}-${Date.now()}`;
    const initialSessions = res.proposedSessions.map((s) => ({
      id: `${sessionIdBase}-${s.sessionIndex}`,
      taskId: res.taskId,
      taskTitle: res.taskTitle,
      sessionIndex: s.sessionIndex,
      totalSessions: s.totalSessions,
      startAt: s.startAt,
      endAt: s.endAt,
      durationMinutes: s.durationMinutes,
      status: 'SCHEDULED' as const,
      syncStatus: 'pending' as const,
    }));

    if (!token) {
      // Save locally only without pretending Google Calendar sync succeeded
      let updatedTaskObj: Task | null = null;
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id === res.taskId) {
            updatedTaskObj = {
              ...t,
              userId: userId || t.userId || 'user-default',
              status: 'SCHEDULED',
              scheduledSessions: initialSessions,
            };
            return updatedTaskObj;
          }
          return t;
        })
      );

      if (updatedTaskObj && userId && userId !== 'user-default') {
        try {
          await setDoc(doc(db, 'users', userId, 'tasks', res.taskId), sanitizeForFirestore(updatedTaskObj));
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${res.taskId}`);
        }
      }

      showToast(`Jadwal kegiatan "${res.taskTitle}" berhasil ditempatkan ke kalender lokal (Google Calendar belum terhubung).`, 'info');
      setSingleScheduleResult(null);
      return;
    }

    // Live Google Calendar push
    let successCount = 0;
    const updatedSessions: TaskScheduleSession[] = [];
    const newCalendarEvents: CalendarEvent[] = [];

    let unconfirmedCount = 0;
    let failCount = 0;

    for (const sess of initialSessions) {
      try {
        const created = await createGoogleCalendarEvent(token, {
          title: `[EVEN] ${sess.taskTitle}`,
          description: `Sesi ${sess.sessionIndex} dari ${sess.totalSessions} (${sess.durationMinutes} menit). Dijadwalkan otomatis oleh EVEN.`,
          startAt: sess.startAt,
          endAt: sess.endAt,
          timezone: preferences.timezone,
        });

        const syncedSess = {
          ...sess,
          syncStatus: 'synced' as const,
          googleCalendarEventId: created.id,
          htmlLink: created.htmlLink,
        };
        updatedSessions.push(syncedSess);
        newCalendarEvents.push({
          id: `gcal-${created.id}`,
          provider: 'google',
          title: `[EVEN] ${sess.taskTitle}`,
          description: `Sesi ${sess.sessionIndex} dari ${sess.totalSessions}`,
          startAt: sess.startAt,
          endAt: sess.endAt,
          htmlLink: created.htmlLink,
          isEditable: false,
          syncStatus: 'synced',
          category: 'focus',
        });
        successCount++;
      } catch (err: any) {
        console.error('Single schedule Google push error:', err.message);
        if (err.message?.includes('tidak dapat dikonfirmasi')) {
          unconfirmedCount++;
        } else {
          failCount++;
        }
        updatedSessions.push({
          ...sess,
          syncStatus: 'failed' as const,
        });
      }
    }

    setDiagnosticInfo((prev) => ({
      ...prev,
      eventsCreatedCount: prev.eventsCreatedCount + successCount,
      eventsFailedCount: prev.eventsFailedCount + failCount,
      eventsUnconfirmedCount: prev.eventsUnconfirmedCount + unconfirmedCount,
    }));

    let finalTaskObj: Task | null = null;
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === res.taskId) {
          finalTaskObj = {
            ...t,
            userId: userId || t.userId || 'user-default',
            status: 'SCHEDULED',
            scheduledSessions: updatedSessions,
          };
          return finalTaskObj;
        }
        return t;
      })
    );

    if (finalTaskObj && userId && userId !== 'user-default') {
      try {
        await setDoc(doc(db, 'users', userId, 'tasks', res.taskId), sanitizeForFirestore(finalTaskObj));
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${res.taskId}`);
      }
    }

    if (newCalendarEvents.length > 0) {
      setEvents((prev) => [...prev, ...newCalendarEvents]);
    }

    if (successCount === initialSessions.length) {
      showToast(`Kegiatan "${res.taskTitle}" dijadwalkan dan disimpan ke Google Calendar Anda!`, 'success');
    } else if (successCount > 0) {
      showToast(`Kegiatan "${res.taskTitle}": ${successCount} dari ${initialSessions.length} sesi tersimpan ke Google Calendar, sebagian gagal.`, 'info');
    } else {
      showToast(`Jadwal disimpan secara lokal, namun gagal terkirim ke Google Calendar.`, 'error');
    }

    setSingleScheduleResult(null);
  };

  // Schedule All Tasks
  const handleScheduleAllTasks = () => {
    const { results, updatedTasks } = scheduleAllPendingTasks(tasks, events, preferences);
    setBatchScheduleResults(results);
    setPendingBatchTasks(updatedTasks);
  };

  const handleApplyBatch = async () => {
    const currentUserId = userId || 'user-default';
    const batchWithUser = pendingBatchTasks.map((t) => ({
      ...t,
      userId: currentUserId,
    }));
    setTasks(batchWithUser);
    const countSuccess = batchScheduleResults.filter((r) => r.success).length;
    showToast(`${countSuccess} kegiatan berhasil dijadwalkan ke kalender.`);

    if (userId && userId !== 'user-default') {
      for (const t of batchWithUser) {
        try {
          await setDoc(doc(db, 'users', userId, 'tasks', t.id), sanitizeForFirestore(t));
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${t.id}`);
        }
      }
    }
  };

  // AI Assistant Plan application
  const handleApplyAIPlan = async (plan: AIPlanDraft, scheduleResult: ScheduleCalculationResult) => {
    let deadlineIso: string | null = plan.deadlineAt || null;
    if (!deadlineIso && typeof plan.deadlineDaysFromNow === 'number') {
      const deadlineDate = new Date();
      deadlineDate.setDate(deadlineDate.getDate() + plan.deadlineDaysFromNow);
      deadlineDate.setHours(plan.preferredTimeOfDay === 'EVENING' ? 23 : 18, 0, 0, 0);
      deadlineIso = deadlineDate.toISOString();
    }

    const taskId = `ai-task-${Date.now()}`;
    const token = getCachedAccessToken();
    const proposedSessions = scheduleResult.success ? scheduleResult.proposedSessions : [];

    const initialSessions = proposedSessions.map((s) => ({
      id: `sess-${taskId}-${s.sessionIndex}-${Date.now()}`,
      taskId: taskId,
      taskTitle: plan.title,
      sessionIndex: s.sessionIndex,
      totalSessions: s.totalSessions,
      startAt: s.startAt,
      endAt: s.endAt,
      durationMinutes: s.durationMinutes,
      occurrenceLabel: s.occurrenceLabel,
      status: 'SCHEDULED' as const,
      syncStatus: 'pending' as const,
    }));

    if (!token || initialSessions.length === 0) {
      const newTask: Task = {
        id: taskId,
        userId: userId || 'user-default',
        title: plan.title,
        description: plan.description,
        estimatedDurationMinutes: plan.estimatedDurationMinutes,
        deadlineAt: deadlineIso,
        priority: plan.priority,
        status: scheduleResult.success ? 'SCHEDULED' : 'UNSCHEDULED',
        allowSplit: plan.allowSplit,
        minimumSessionMinutes: plan.minimumSessionMinutes || 30,
        preferredTimeOfDay: plan.preferredTimeOfDay,
        timeConstraintType: plan.timeConstraintType,
        requestedStartAt: plan.requestedStartAt,
        requestedEndAt: plan.requestedEndAt,
        targetDays: plan.targetDays,
        targetOccurrences: plan.targetOccurrences,
        preferredWindow: plan.preferredWindow,
        timezone: plan.timezone,
        createdAt: new Date().toISOString(),
        scheduledSessions: initialSessions,
      };

      setTasks((prev) => [newTask, ...prev]);
      if (initialSessions.length > 0) {
        showToast(`Rencana "${plan.title}" dijadwalkan secara internal (Google Calendar belum terhubung).`, 'info');
      } else {
        showToast(`Kegiatan "${plan.title}" disimpan sebagai kegiatan belum terjadwal.`);
      }
      return;
    }

    // Google Calendar active write
    let successCount = 0;
    let failCount = 0;
    let unconfirmedCount = 0;
    const updatedSessions: TaskScheduleSession[] = [];
    const newCalendarEvents: CalendarEvent[] = [];

    for (const sess of initialSessions) {
      try {
        const created = await createGoogleCalendarEvent(token, {
          title: `[EVEN] ${sess.taskTitle}`,
          description: plan.description || 'Dijadwalkan oleh Asisten AI EVEN.',
          startAt: sess.startAt,
          endAt: sess.endAt,
          timezone: plan.timezone || preferences.timezone,
        });

        updatedSessions.push({
          ...sess,
          syncStatus: 'synced' as const,
          googleCalendarEventId: created.id,
          htmlLink: created.htmlLink,
        });

        newCalendarEvents.push({
          id: `gcal-${created.id}`,
          provider: 'google',
          title: `[EVEN] ${sess.taskTitle}`,
          description: plan.description || 'Dijadwalkan oleh Asisten AI EVEN.',
          startAt: sess.startAt,
          endAt: sess.endAt,
          htmlLink: created.htmlLink,
          isEditable: false,
          syncStatus: 'synced',
          category: 'focus',
        });
        successCount++;
      } catch (err: any) {
        console.error('AI Calendar event push error:', err.message);
        if (err.message?.includes('tidak dapat dikonfirmasi')) {
          unconfirmedCount++;
        } else {
          failCount++;
        }
        updatedSessions.push({
          ...sess,
          syncStatus: 'failed' as const,
        });
      }
    }

    setDiagnosticInfo((prev) => ({
      ...prev,
      eventsCreatedCount: prev.eventsCreatedCount + successCount,
      eventsFailedCount: prev.eventsFailedCount + failCount,
      eventsUnconfirmedCount: prev.eventsUnconfirmedCount + unconfirmedCount,
    }));

    const newTask: Task = {
      id: taskId,
      userId: userId || 'user-default',
      title: plan.title,
      description: plan.description,
      estimatedDurationMinutes: plan.estimatedDurationMinutes,
      deadlineAt: deadlineIso,
      priority: plan.priority,
      status: scheduleResult.success ? 'SCHEDULED' : 'UNSCHEDULED',
      allowSplit: plan.allowSplit,
      minimumSessionMinutes: plan.minimumSessionMinutes || 30,
      preferredTimeOfDay: plan.preferredTimeOfDay,
      timeConstraintType: plan.timeConstraintType,
      requestedStartAt: plan.requestedStartAt,
      requestedEndAt: plan.requestedEndAt,
      targetDays: plan.targetDays,
      targetOccurrences: plan.targetOccurrences,
      preferredWindow: plan.preferredWindow,
      timezone: plan.timezone,
      createdAt: new Date().toISOString(),
      scheduledSessions: updatedSessions,
    };

    setTasks((prev) => [newTask, ...prev]);

    // Persist to Firestore if user is authenticated
    if (userId && userId !== 'user-default') {
      try {
        await setDoc(doc(db, 'users', userId, 'tasks', taskId), sanitizeForFirestore(newTask));
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${userId}/tasks/${taskId}`);
      }
    }

    if (newCalendarEvents.length > 0) {
      setEvents((prev) => [...prev, ...newCalendarEvents]);
    }

    if (successCount === initialSessions.length) {
      showToast(`Rencana "${plan.title}" berhasil disimpan dan disinkronkan ke Google Calendar!`, 'success');
    } else if (successCount > 0) {
      showToast(`Rencana "${plan.title}": ${successCount} dari ${initialSessions.length} sesi berhasil disimpan ke Google Calendar, beberapa sesi gagal.`, 'info');
    } else {
      showToast(`Rencana "${plan.title}" disimpan lokal, namun gagal disinkronkan ke Google Calendar.`, 'error');
    }
  };

  // Google Keep Handlers
  const handleCreateKeepNote = (noteData: Omit<KeepNote, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newNote: KeepNote = {
      ...noteData,
      id: `keep-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setKeepNotes((prev) => [newNote, ...prev]);
    showToast('Catatan Google Keep berhasil disimpan.');
  };

  const handleUpdateKeepNote = (updatedNote: KeepNote) => {
    setKeepNotes((prev) => prev.map((n) => (n.id === updatedNote.id ? updatedNote : n)));
  };

  const handleDeleteKeepNote = (noteId: string) => {
    const noteToDelete = keepNotes.find((n) => n.id === noteId);
    if (!noteToDelete) return;

    setConfirmModal({
      isOpen: true,
      title: 'Hapus Catatan Keep?',
      description: `Apakah Anda yakin ingin menghapus catatan "${noteToDelete.title || 'Tanpa Judul'}"? Tindakan ini tidak dapat dibatalkan.`,
      actionLabel: 'Hapus Catatan',
      onConfirm: () => {
        setKeepNotes((prev) => prev.filter((n) => n.id !== noteId));
        showToast('Catatan Keep dihapus.', 'info');
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const handleConvertNoteToTask = (note: KeepNote) => {
    const candidate = convertKeepNoteToTask(note);
    setTaskToEdit({
      id: `task-keep-${note.id}-${Date.now()}`,
      userId: 'user-default',
      title: candidate.title || 'Kegiatan Baru',
      description: candidate.description,
      estimatedDurationMinutes: candidate.estimatedDurationMinutes || 45,
      deadlineAt: candidate.deadlineAt || null,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      createdAt: new Date().toISOString(),
    });
    setIsTaskModalOpen(true);
  };

  // Auth & Onboarding Flow
  const handleAuthSuccess = (email: string, name: string, isNewUser: boolean, token?: string) => {
    setIsLoggedIn(true);
    if (token) {
      setCachedAccessToken(token);
      setHasGoogleAccessToken(true);
    } else {
      setHasGoogleAccessToken(false);
    }
    setPreferences((prev) => ({
      ...prev,
      displayName: name || prev.displayName,
      email: email || prev.email,
      googleCalendarConnected: Boolean(token),
    }));

    if (isNewUser) {
      setIsOnboardingOpen(true);
    } else {
      showToast(`Selamat datang kembali di EVEN, ${name || 'Pengguna'}!`);
      // Sync events immediately after login ONLY if token is available
      if (token) {
        handleSyncCalendar();
      }
    }
  };

  const handleLogout = async () => {
    await firebaseLogout();
    setIsLoggedIn(false);
    setUserId(null);
    setHasGoogleAccessToken(false);
    setPreferences((prev) => ({
      ...prev,
      googleCalendarConnected: false,
      calendarSyncStatus: 'pending',
    }));
    showToast('Anda telah keluar dari akun.', 'info');
  };

  const pendingCount = tasks.filter((t) => t.status === 'UNSCHEDULED').length;
  const missedTasksCount = tasks.filter(
    (t) => t.status === 'missed_auto' && t.rescheduleDecision === 'pending'
  ).length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F8FAFC]">
      {/* Toast Notification */}
      {notification && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-white border border-[#D9E3EF] shadow-lg text-xs animate-in fade-in slide-in-from-top-2">
          {notification.type === 'success' && <CheckCircle2 size={16} className="text-[#16856B]" />}
          {notification.type === 'error' && <AlertCircle size={16} className="text-[#C43D4B]" />}
          {notification.type === 'info' && <CheckCircle2 size={16} className="text-[#2457A7]" />}
          <span className="font-medium text-[#172B42]">{notification.message}</span>
          <button
            onClick={() => setNotification(null)}
            className="text-[#53657A] hover:text-[#172B42] ml-1"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Mandatory Destructive Action Confirmation Modal */}
      {confirmModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div
            className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-[#D9E3EF] p-6 space-y-4"
            role="alertdialog"
            aria-modal="true"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 text-[#C43D4B] flex items-center justify-center shrink-0">
                <AlertTriangle size={20} />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-[#172B42] font-editorial">{confirmModal.title}</h3>
                <p className="text-xs text-[#53657A] leading-relaxed">
                  {confirmModal.description}
                </p>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                onClick={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
                className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42] rounded-xl"
              >
                Batal
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#C43D4B] hover:bg-[#a82f3c] rounded-xl transition-colors shadow-xs"
              >
                {confirmModal.actionLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Desktop Sidebar */}
      <div className="hidden md:block">
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          pendingTasksCount={pendingCount}
          keepNotesCount={keepNotes.length}
          missedTasksCount={missedTasksCount}
          preferences={preferences}
          onOpenAuth={(mode) => {
            setAuthModalMode(mode);
            setIsAuthModalOpen(true);
          }}
          onLogout={handleLogout}
          isLoggedIn={isLoggedIn}
          hasGoogleAccessToken={hasGoogleAccessToken}
        />
      </div>

      {/* Mobile Drawer */}
      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
            onClick={() => setIsMobileMenuOpen(false)}
          />
          <div className="relative z-10 w-64 bg-white h-full shadow-2xl">
            <Sidebar
              currentTab={currentTab}
              onSelectTab={(tab) => {
                setCurrentTab(tab);
                setIsMobileMenuOpen(false);
              }}
              pendingTasksCount={pendingCount}
              keepNotesCount={keepNotes.length}
              missedTasksCount={missedTasksCount}
              preferences={preferences}
              onOpenAuth={(mode) => {
                setAuthModalMode(mode);
                setIsAuthModalOpen(true);
                setIsMobileMenuOpen(false);
              }}
              onLogout={() => {
                handleLogout();
                setIsMobileMenuOpen(false);
              }}
              isLoggedIn={isLoggedIn}
              hasGoogleAccessToken={hasGoogleAccessToken}
            />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <Header
          onOpenTaskModal={() => {
            setTaskToEdit(null);
            setIsTaskModalOpen(true);
          }}
          onOpenAIAssistant={() => setCurrentTab('ai')}
          onSyncCalendar={handleSyncCalendar}
          isSyncing={isSyncing}
          preferences={preferences}
          onToggleMobileMenu={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        />

        <main className="flex-1 overflow-hidden flex flex-col relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="flex-1 flex flex-col h-full overflow-hidden"
            >
              {currentTab === 'calendar' && (
                <CalendarView
                  events={events}
                  tasks={tasks}
                  preferences={preferences}
                  onToggleTaskSessionComplete={handleToggleTaskSessionComplete}
                  onOpenTaskModal={() => {
                    setTaskToEdit(null);
                    setIsTaskModalOpen(true);
                  }}
                  onOpenAIAssistant={() => setCurrentTab('ai')}
                />
              )}

              {currentTab === 'tasks' && (
                <TaskListView
                  tasks={tasks}
                  onOpenTaskModal={() => {
                    setTaskToEdit(null);
                    setIsTaskModalOpen(true);
                  }}
                  onEditTask={(task) => {
                    setTaskToEdit(task);
                    setIsTaskModalOpen(true);
                  }}
                  onDeleteTask={handleDeleteTask}
                  onScheduleSingleTask={handleScheduleSingleTask}
                  onScheduleAllTasks={handleScheduleAllTasks}
                  onToggleTaskComplete={handleToggleTaskComplete}
                />
              )}

              {currentTab === 'dashboard' && (
                <TaskDashboardView
                  tasks={tasks}
                  preferences={preferences}
                  onOpenTaskModal={() => {
                    setTaskToEdit(null);
                    setIsTaskModalOpen(true);
                  }}
                  onNavigateToTasks={() => setCurrentTab('tasks')}
                  onNavigateToCalendar={() => setCurrentTab('calendar')}
                />
              )}

              {currentTab === 'history' && (
                <HistoryView
                  tasks={tasks}
                  preferences={preferences}
                  onOpenReschedule={(task) => setRescheduleTaskTarget(task)}
                  onDismissTask={handleDismissMissedTask}
                  onRefreshAudit={() => {
                    const { updatedTasks, transitionedCount } = auditAndTransitionOverdueTasks(tasks);
                    if (transitionedCount > 0) {
                      setTasks(updatedTasks);
                      showToast(`${transitionedCount} kegiatan terlewat dipindahkan ke riwayat.`, 'info');
                    } else {
                      showToast('Riwayat kegiatan sudah mutakhir.', 'info');
                    }
                  }}
                />
              )}

              {currentTab === 'keep' && (
                <KeepNotesView
                  notes={keepNotes}
                  onCreateNote={handleCreateKeepNote}
                  onUpdateNote={handleUpdateKeepNote}
                  onDeleteNote={handleDeleteKeepNote}
                  onConvertNoteToTask={handleConvertNoteToTask}
                />
              )}

              {currentTab === 'ai' && (
                <AIAssistantView
                  tasks={tasks}
                  events={events}
                  preferences={preferences}
                  onApplyAIPlan={handleApplyAIPlan}
                  onNavigateToCalendar={() => setCurrentTab('calendar')}
                />
              )}

              {currentTab === 'settings' && (
                <SettingsView
                  preferences={preferences}
                  onUpdatePreferences={(updated) => {
                    setPreferences((prev) => ({ ...prev, ...updated }));
                    showToast('Pengaturan diperbarui.');
                  }}
                  onResetData={handleResetData}
                  onSyncCalendar={handleSyncCalendar}
                  isSyncing={isSyncing}
                  hasGoogleAccessToken={hasGoogleAccessToken}
                  onConnectCalendar={handleConnectCalendar}
                  onDisconnectCalendar={handleDisconnectCalendar}
                  diagnosticInfo={diagnosticInfo}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Modals */}
      <AuthModal
        isOpen={isAuthModalOpen}
        initialMode={authModalMode}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
      />

      <OnboardingModal
        isOpen={isOnboardingOpen}
        preferences={preferences}
        onComplete={(updated) => {
          setPreferences((prev) => ({ ...prev, ...updated }));
          setIsOnboardingOpen(false);
          showToast('Inisiasi selesai! Selamat datang di ruang kerja EVEN.');
        }}
      />

      <TaskModal
        key={taskToEdit ? `edit-${taskToEdit.id || taskToEdit.title}` : 'new-task'}
        isOpen={isTaskModalOpen}
        taskToEdit={taskToEdit}
        onClose={() => {
          setIsTaskModalOpen(false);
          setTaskToEdit(null);
        }}
        onSave={handleSaveTask}
        userId={userId}
      />

      <ScheduleResultModal
        isOpen={singleScheduleResult !== null}
        result={singleScheduleResult}
        onClose={() => setSingleScheduleResult(null)}
        onConfirmSchedule={handleConfirmSingleSchedule}
      />

      <BatchScheduleModal
        isOpen={batchScheduleResults.length > 0}
        results={batchScheduleResults}
        onClose={() => setBatchScheduleResults([])}
        onApplyBatch={handleApplyBatch}
      />

      <RescheduleModal
        isOpen={rescheduleTaskTarget !== null}
        task={rescheduleTaskTarget}
        onClose={() => setRescheduleTaskTarget(null)}
        onConfirmReschedule={handleConfirmReschedule}
        preferences={preferences}
      />
    </div>
  );
}
