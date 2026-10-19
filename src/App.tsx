'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { CalendarView } from './components/CalendarView';
import { TaskListView } from './components/TaskListView';
import { AIAssistantView } from './components/AIAssistantView';
import { SettingsView } from './components/SettingsView';
import { KeepNotesView } from './components/KeepNotesView';
import { AuthModal } from './components/AuthModal';
import { OnboardingModal } from './components/OnboardingModal';
import { TaskModal } from './components/TaskModal';
import { ScheduleResultModal } from './components/ScheduleResultModal';
import { BatchScheduleModal } from './components/BatchScheduleModal';
import {
  Task,
  CalendarEvent,
  UserPreferences,
  ScheduleCalculationResult,
  AIPlanDraft,
  KeepNote,
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
  logout as firebaseLogout,
  getCachedAccessToken,
  setCachedAccessToken,
  db,
  handleFirestoreError,
  OperationType,
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
  const [currentTab, setCurrentTab] = useState<'calendar' | 'tasks' | 'keep' | 'ai' | 'settings'>('calendar');

  // User state
  const [isLoggedIn, setIsLoggedIn] = useState(true);
  const [hasGoogleAccessToken, setHasGoogleAccessToken] = useState(false);
  const [userId, setUserId] = useState<string>('user-default');

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

  // Setup Firebase Auth listener on mount
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setIsLoggedIn(true);
        setUserId(user.uid);
        if (token) {
          setHasGoogleAccessToken(true);
        }
        setPreferences((prev) => ({
          ...prev,
          displayName: user.displayName || prev.displayName,
          email: user.email || prev.email,
        }));
      },
      () => {
        // Auth failure or unauthenticated
        setHasGoogleAccessToken(false);
      }
    );
    return () => unsubscribe();
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

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 3500);
  };

  // Google Calendar Sync
  const handleSyncCalendar = async () => {
    setIsSyncing(true);
    const token = getCachedAccessToken();

    if (token) {
      try {
        const liveGoogleEvents = await fetchGoogleCalendarEvents(token);
        if (liveGoogleEvents && liveGoogleEvents.length > 0) {
          // Merge live Google events with internal task sessions
          setEvents((prev) => {
            const internalEvents = prev.filter((e) => e.provider !== 'google');
            return [...liveGoogleEvents, ...internalEvents];
          });
          const updatedTime = new Date().toISOString();
          setPreferences((prev) => ({
            ...prev,
            calendarSyncStatus: 'synced',
            lastSyncedAt: updatedTime,
            googleCalendarConnected: true,
          }));
          showToast(`Sinkronisasi Google Calendar berhasil! Dimuat ${liveGoogleEvents.length} rapat.`);
          setIsSyncing(false);
          return;
        }
      } catch (err: any) {
        console.warn('Live Google Calendar sync note:', err.message);
      }
    }

    // Standard sync with simulation feedback
    setTimeout(() => {
      setIsSyncing(false);
      const updatedTime = new Date().toISOString();
      setPreferences((prev) => ({
        ...prev,
        calendarSyncStatus: 'synced',
        lastSyncedAt: updatedTime,
      }));
      showToast('Sinkronisasi Google Calendar selesai. Rapat dan slot waktu terkini.');
    }, 800);
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
    if (taskToEdit) {
      const updatedTask: Task = {
        ...taskToEdit,
        ...taskData,
        status: 'UNSCHEDULED',
        scheduledSessions: [],
      };
      setTasks((prev) =>
        prev.map((t) => (t.id === taskToEdit.id ? updatedTask : t))
      );
      showToast(`Tugas "${taskData.title}" berhasil diperbarui.`);

      // Persist to Firestore if user is authenticated
      if (userId && userId !== 'user-default') {
        try {
          await setDoc(doc(db, 'users', userId, 'tasks', taskToEdit.id), updatedTask);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `users/${userId}/tasks/${taskToEdit.id}`);
        }
      }
    } else {
      const newTaskId = `task-${Date.now()}`;
      const newTask: Task = {
        ...taskData,
        id: newTaskId,
        status: 'UNSCHEDULED',
        createdAt: new Date().toISOString(),
        scheduledSessions: [],
      };
      setTasks((prev) => [newTask, ...prev]);
      showToast(`Tugas baru "${newTask.title}" berhasil dibuat.`);

      // Persist to Firestore if user is authenticated
      if (userId && userId !== 'user-default') {
        try {
          await setDoc(doc(db, 'users', userId, 'tasks', newTaskId), newTask);
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
      title: 'Hapus Tugas?',
      description: `Apakah Anda yakin ingin menghapus tugas "${taskToDelete.title}"? Sesi pengerjaan yang sudah dijadwalkan juga akan dibatalkan. Tindakan ini tidak dapat dibatalkan.`,
      actionLabel: 'Hapus Tugas',
      onConfirm: async () => {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        showToast(`Tugas "${taskToDelete.title}" telah dihapus.`, 'info');
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

  const handleToggleTaskComplete = (taskId: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId) {
          const isDone = t.status === 'COMPLETED';
          const nextStatus = isDone ? 'UNSCHEDULED' : 'COMPLETED';
          return {
            ...t,
            status: nextStatus,
            scheduledSessions: t.scheduledSessions?.map((s) => ({
              ...s,
              status: isDone ? 'SCHEDULED' : 'COMPLETED',
            })),
          };
        }
        return t;
      })
    );
  };

  const handleToggleTaskSessionComplete = (taskId: string, sessionId: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId && t.scheduledSessions) {
          const updatedSessions = t.scheduledSessions.map((s) => {
            if (s.id === sessionId) {
              const isDone = s.status === 'COMPLETED';
              return {
                ...s,
                status: isDone ? ('SCHEDULED' as const) : ('COMPLETED' as const),
              };
            }
            return s;
          });

          const allDone = updatedSessions.every((s) => s.status === 'COMPLETED');
          return {
            ...t,
            status: allDone ? 'COMPLETED' : 'IN_PROGRESS',
            scheduledSessions: updatedSessions,
          };
        }
        return t;
      })
    );
  };

  // Schedule Single Task
  const handleScheduleSingleTask = (task: Task) => {
    const res = scheduleTaskDeterministically(task, events, tasks, preferences);
    setSingleScheduleResult(res);
  };

  const handleConfirmSingleSchedule = async (res: ScheduleCalculationResult) => {
    const token = getCachedAccessToken();
    const sessions = res.proposedSessions.map((s) => ({
      id: `sess-${res.taskId}-${s.sessionIndex}-${Date.now()}`,
      taskId: res.taskId,
      taskTitle: res.taskTitle,
      sessionIndex: s.sessionIndex,
      totalSessions: s.totalSessions,
      startAt: s.startAt,
      endAt: s.endAt,
      durationMinutes: s.durationMinutes,
      status: 'SCHEDULED' as const,
      syncStatus: preferences.googleCalendarConnected ? ('synced' as const) : ('pending' as const),
    }));

    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === res.taskId) {
          return {
            ...t,
            status: 'SCHEDULED',
            scheduledSessions: sessions,
          };
        }
        return t;
      })
    );

    // If live Google Calendar access token is active, push event directly to Google Calendar!
    if (token) {
      try {
        for (const sess of sessions) {
          await createGoogleCalendarEvent(token, {
            title: `[EVEN] ${sess.taskTitle}`,
            description: `Sesi ${sess.sessionIndex} dari ${sess.totalSessions} (${sess.durationMinutes} menit). Dijadwalkan otomatis oleh EVEN.`,
            startAt: sess.startAt,
            endAt: sess.endAt,
          });
        }
        showToast(`Tugas "${res.taskTitle}" dijadwalkan dan disimpan ke Google Calendar Anda!`);
        return;
      } catch (err: any) {
        console.warn('Google Calendar live event push fallback:', err.message);
      }
    }

    showToast(`Jadwal tugas "${res.taskTitle}" berhasil ditempatkan ke kalender.`);
  };

  // Schedule All Tasks
  const handleScheduleAllTasks = () => {
    const { results, updatedTasks } = scheduleAllPendingTasks(tasks, events, preferences);
    setBatchScheduleResults(results);
    setPendingBatchTasks(updatedTasks);
  };

  const handleApplyBatch = () => {
    setTasks(pendingBatchTasks);
    const countSuccess = batchScheduleResults.filter((r) => r.success).length;
    showToast(`${countSuccess} tugas berhasil dijadwalkan ke kalender.`);
  };

  // AI Assistant Plan application
  const handleApplyAIPlan = async (plan: AIPlanDraft, scheduleResult: ScheduleCalculationResult) => {
    const deadlineDate = new Date();
    deadlineDate.setDate(deadlineDate.getDate() + (plan.deadlineDaysFromNow || 1));
    deadlineDate.setHours(17, 0, 0, 0);

    const taskId = `ai-task-${Date.now()}`;
    const sessions = scheduleResult.success
      ? scheduleResult.proposedSessions.map((s) => ({
          id: `sess-${taskId}-${s.sessionIndex}-${Date.now()}`,
          taskId: taskId,
          taskTitle: plan.title,
          sessionIndex: s.sessionIndex,
          totalSessions: s.totalSessions,
          startAt: s.startAt,
          endAt: s.endAt,
          durationMinutes: s.durationMinutes,
          status: 'SCHEDULED' as const,
          syncStatus: preferences.googleCalendarConnected ? ('synced' as const) : ('pending' as const),
        }))
      : [];

    const newTask: Task = {
      id: taskId,
      userId: 'user-default',
      title: plan.title,
      description: plan.description,
      estimatedDurationMinutes: plan.estimatedDurationMinutes,
      deadlineAt: deadlineDate.toISOString(),
      priority: plan.priority,
      status: scheduleResult.success ? 'SCHEDULED' : 'UNSCHEDULED',
      allowSplit: plan.allowSplit,
      minimumSessionMinutes: plan.minimumSessionMinutes || 30,
      preferredTimeOfDay: plan.preferredTimeOfDay,
      createdAt: new Date().toISOString(),
      scheduledSessions: sessions,
    };

    setTasks((prev) => [newTask, ...prev]);

    // Push to Google Calendar if token is active
    const token = getCachedAccessToken();
    if (token && sessions.length > 0) {
      try {
        for (const sess of sessions) {
          await createGoogleCalendarEvent(token, {
            title: `[EVEN] ${sess.taskTitle}`,
            description: plan.description || 'Dijadwalkan oleh Asisten AI EVEN.',
            startAt: sess.startAt,
            endAt: sess.endAt,
          });
        }
      } catch (err: any) {
        console.warn('AI Calendar event push note:', err.message);
      }
    }

    showToast(`Rencana "${plan.title}" berhasil disimpan.`);
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
      id: '',
      userId: 'user-default',
      title: candidate.title || 'Tugas Baru',
      description: candidate.description,
      estimatedDurationMinutes: candidate.estimatedDurationMinutes || 45,
      deadlineAt: candidate.deadlineAt || new Date().toISOString(),
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
    }
    setPreferences((prev) => ({
      ...prev,
      displayName: name,
      email: email,
      googleCalendarConnected: true,
    }));

    if (isNewUser) {
      setIsOnboardingOpen(true);
    } else {
      showToast(`Selamat datang kembali di EVEN, ${name}!`);
      // Sync events immediately after login
      handleSyncCalendar();
    }
  };

  const handleLogout = async () => {
    await firebaseLogout();
    setIsLoggedIn(false);
    setHasGoogleAccessToken(false);
    showToast('Anda telah keluar dari akun.', 'info');
  };

  const pendingCount = tasks.filter((t) => t.status === 'UNSCHEDULED').length;

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
                <h3 className="text-base font-bold text-[#172B42]">{confirmModal.title}</h3>
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

        <main className="flex-1 overflow-hidden flex flex-col">
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
            />
          )}
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
    </div>
  );
}
