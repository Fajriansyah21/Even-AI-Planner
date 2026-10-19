import React, { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { CalendarView } from './components/CalendarView';
import { TaskListView } from './components/TaskListView';
import { AIAssistantView } from './components/AIAssistantView';
import { SettingsView } from './components/SettingsView';
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
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

export default function App() {
  // Navigation tab
  const [currentTab, setCurrentTab] = useState<'calendar' | 'tasks' | 'ai' | 'settings'>('calendar');

  // User state
  const [isLoggedIn, setIsLoggedIn] = useState(true);
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

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

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

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 3500);
  };

  // Google Calendar Sync
  const handleSyncCalendar = () => {
    setIsSyncing(true);
    setTimeout(() => {
      setIsSyncing(false);
      const updatedTime = new Date().toISOString();
      setPreferences((prev) => ({
        ...prev,
        calendarSyncStatus: 'synced',
        lastSyncedAt: updatedTime,
      }));
      showToast('Sinkronisasi Google Calendar selesai. Rapat dan slot waktu terkini.');
    }, 1000);
  };

  // Reset to initial mock data
  const handleResetData = () => {
    setTasks(getInitialTasks());
    setEvents(getInitialEvents());
    setPreferences(INITIAL_PREFERENCES);
    showToast('Data berhasil dikembalikan ke pengaturan dan jadwal awal.', 'info');
  };

  // Task creation/update
  const handleSaveTask = (taskData: Omit<Task, 'id' | 'createdAt' | 'status' | 'scheduledSessions'>) => {
    if (taskToEdit) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskToEdit.id
            ? {
                ...t,
                ...taskData,
                // If duration or deadline changed, unschedule to require re-validation
                status: 'UNSCHEDULED',
                scheduledSessions: [],
              }
            : t
        )
      );
      showToast(`Tugas "${taskData.title}" berhasil diperbarui.`);
    } else {
      const newTask: Task = {
        ...taskData,
        id: `task-${Date.now()}`,
        status: 'UNSCHEDULED',
        createdAt: new Date().toISOString(),
        scheduledSessions: [],
      };
      setTasks((prev) => [newTask, ...prev]);
      showToast(`Tugas baru "${newTask.title}" berhasil dibuat.`);
    }
    setTaskToEdit(null);
  };

  const handleDeleteTask = (taskId: string) => {
    const taskToDelete = tasks.find((t) => t.id === taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    showToast(`Tugas "${taskToDelete?.title || ''}" telah dihapus.`, 'info');
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

  const handleConfirmSingleSchedule = (res: ScheduleCalculationResult) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === res.taskId) {
          return {
            ...t,
            status: 'SCHEDULED',
            scheduledSessions: res.proposedSessions.map((s) => ({
              id: `sess-${t.id}-${s.sessionIndex}-${Date.now()}`,
              taskId: t.id,
              taskTitle: t.title,
              sessionIndex: s.sessionIndex,
              totalSessions: s.totalSessions,
              startAt: s.startAt,
              endAt: s.endAt,
              durationMinutes: s.durationMinutes,
              status: 'SCHEDULED',
              syncStatus: preferences.googleCalendarConnected ? 'synced' : 'pending',
            })),
          };
        }
        return t;
      })
    );
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
  const handleApplyAIPlan = (plan: AIPlanDraft, scheduleResult: ScheduleCalculationResult) => {
    const deadlineDate = new Date();
    deadlineDate.setDate(deadlineDate.getDate() + (plan.deadlineDaysFromNow || 1));
    deadlineDate.setHours(17, 0, 0, 0);

    const taskId = `ai-task-${Date.now()}`;
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
      scheduledSessions: scheduleResult.success
        ? scheduleResult.proposedSessions.map((s) => ({
            id: `sess-${taskId}-${s.sessionIndex}-${Date.now()}`,
            taskId: taskId,
            taskTitle: plan.title,
            sessionIndex: s.sessionIndex,
            totalSessions: s.totalSessions,
            startAt: s.startAt,
            endAt: s.endAt,
            durationMinutes: s.durationMinutes,
            status: 'SCHEDULED',
            syncStatus: preferences.googleCalendarConnected ? 'synced' : 'pending',
          }))
        : [],
    };

    setTasks((prev) => [newTask, ...prev]);
    showToast(`Rencana "${plan.title}" berhasil disimpan.`);
  };

  // Auth & Onboarding Flow
  const handleAuthSuccess = (email: string, name: string, isNewUser: boolean) => {
    setIsLoggedIn(true);
    setPreferences((prev) => ({
      ...prev,
      displayName: name,
      email: email,
    }));

    if (isNewUser) {
      setIsOnboardingOpen(true);
    } else {
      showToast(`Selamat datang kembali di EVEN, ${name}!`);
    }
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
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

      {/* Desktop Sidebar */}
      <div className="hidden md:block">
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          pendingTasksCount={pendingCount}
          preferences={preferences}
          onOpenAuth={(mode) => {
            setAuthModalMode(mode);
            setIsAuthModalOpen(true);
          }}
          onLogout={handleLogout}
          isLoggedIn={isLoggedIn}
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
