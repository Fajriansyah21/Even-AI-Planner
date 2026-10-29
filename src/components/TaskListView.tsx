import React, { useState } from 'react';
import {
  Plus,
  Calendar,
  Clock,
  Layers,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  MoreVertical,
  Trash2,
  Edit2,
  ArrowRight,
  Zap,
  ExternalLink,
} from 'lucide-react';
import { Task, Priority, ScheduleCalculationResult, TaskStatus, TaskScheduleSession, SyncStatus } from '../types';

interface TaskListViewProps {
  tasks: Task[];
  onOpenTaskModal: () => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onScheduleSingleTask: (task: Task) => void;
  onScheduleAllTasks: () => void;
  onToggleTaskComplete: (taskId: string) => void;
}

export const TaskListView: React.FC<TaskListViewProps> = ({
  tasks,
  onOpenTaskModal,
  onEditTask,
  onDeleteTask,
  onScheduleSingleTask,
  onScheduleAllTasks,
  onToggleTaskComplete,
}) => {
  // Multi-select Priority filters: 'HIGH' (includes URGENT & HIGH), 'MEDIUM', 'LOW'
  const [selectedPriorities, setSelectedPriorities] = useState<Priority[]>([
    'URGENT',
    'HIGH',
    'MEDIUM',
    'LOW',
  ]);

  // Multi-select Status filters: 'SCHEDULED', 'UNSCHEDULED', 'COMPLETED'
  const [selectedStatuses, setSelectedStatuses] = useState<('SCHEDULED' | 'UNSCHEDULED' | 'COMPLETED')[]>([
    'SCHEDULED',
    'UNSCHEDULED',
    'COMPLETED',
  ]);

  const [searchQuery, setSearchQuery] = useState('');

  const priorityStyles: Record<Priority, { label: string; badgeClass: string }> = {
    LOW: { label: 'Rendah', badgeClass: 'bg-slate-100 text-slate-700 border-slate-200' },
    MEDIUM: { label: 'Sedang', badgeClass: 'bg-[#EAF3FC] text-[#2457A7] border-[#8DBCEB]/50' },
    HIGH: { label: 'Tinggi', badgeClass: 'bg-amber-50 text-[#B86B12] border-amber-200' },
    URGENT: { label: 'Mendesak', badgeClass: 'bg-red-50 text-[#C43D4B] border-red-200 font-semibold' },
  };

  const getSyncStatusMeta = (sessions?: TaskScheduleSession[]) => {
    if (!sessions || sessions.length === 0) return null;

    const hasFailed = sessions.some((s) => s.syncStatus === 'failed');
    const allSynced = sessions.every((s) => s.syncStatus === 'synced');

    if (hasFailed) {
      return {
        status: 'failed' as const,
        label: 'Gagal Sinkron',
        badgeClass: 'bg-[#FCEBEB] text-[#A32D2D] border-[#F7C1C1]',
        icon: AlertCircle,
        tooltip: 'Sebagian atau seluruh sesi gagal disinkronkan ke Google Calendar.',
      };
    }

    if (allSynced) {
      return {
        status: 'synced' as const,
        label: 'Tersinkron Google Calendar',
        badgeClass: 'bg-[#E1F5EE] text-[#0F6B56] border-[#9FE1D0]',
        icon: CheckCircle2,
        tooltip: 'Semua sesi kegiatan telah berhasil disinkronkan ke Google Calendar.',
      };
    }

    return {
      status: 'pending' as const,
      label: 'Sinkronisasi Tertunda (Lokal)',
      badgeClass: 'bg-[#FEF7EC] text-[#8F520A] border-[#FBDCA8]',
      icon: Clock,
      tooltip: 'Sesi tersimpan di kalender lokal dan belum tersinkron ke Google Calendar.',
    };
  };

  const getSessionSyncBadge = (syncStatus?: SyncStatus) => {
    switch (syncStatus) {
      case 'synced':
        return {
          label: 'Tersinkron',
          badgeClass: 'bg-[#E1F5EE] text-[#0F6B56] border-[#9FE1D0]',
          icon: CheckCircle2,
          tooltip: 'Tersinkron ke Google Calendar',
        };
      case 'failed':
        return {
          label: 'Gagal',
          badgeClass: 'bg-[#FCEBEB] text-[#A32D2D] border-[#F7C1C1]',
          icon: AlertCircle,
          tooltip: 'Gagal sinkronisasi ke Google Calendar',
        };
      case 'pending':
      default:
        return {
          label: 'Tertunda',
          badgeClass: 'bg-[#FEF7EC] text-[#8F520A] border-[#FBDCA8]',
          icon: Clock,
          tooltip: 'Tersimpan lokal (sinkronisasi tertunda)',
        };
    }
  };

  // Active tasks excluding missed_auto archive
  const activeTasks = tasks.filter((t) => t.status !== 'missed_auto');

  // Status counts
  const unscheduledCount = activeTasks.filter((t) => t.status === 'UNSCHEDULED').length;
  const scheduledCount = activeTasks.filter((t) => t.status === 'SCHEDULED').length;
  const completedCount = activeTasks.filter((t) => t.status === 'COMPLETED' || t.status === 'completed_manual').length;

  // Priority counts
  const highPriorityCount = activeTasks.filter((t) => t.priority === 'HIGH' || t.priority === 'URGENT').length;
  const mediumPriorityCount = activeTasks.filter((t) => t.priority === 'MEDIUM' || !t.priority).length;
  const lowPriorityCount = activeTasks.filter((t) => t.priority === 'LOW').length;

  // Toggle Handlers
  const handleTogglePriority = (prioGroup: 'HIGH' | 'MEDIUM' | 'LOW') => {
    if (prioGroup === 'HIGH') {
      const isHighActive = selectedPriorities.includes('HIGH') || selectedPriorities.includes('URGENT');
      if (isHighActive) {
        setSelectedPriorities((prev) => prev.filter((p) => p !== 'HIGH' && p !== 'URGENT'));
      } else {
        setSelectedPriorities((prev) => [...prev, 'HIGH', 'URGENT']);
      }
    } else {
      if (selectedPriorities.includes(prioGroup)) {
        setSelectedPriorities((prev) => prev.filter((p) => p !== prioGroup));
      } else {
        setSelectedPriorities((prev) => [...prev, prioGroup]);
      }
    }
  };

  const handleToggleStatus = (status: 'SCHEDULED' | 'UNSCHEDULED' | 'COMPLETED') => {
    if (selectedStatuses.includes(status)) {
      setSelectedStatuses((prev) => prev.filter((s) => s !== status));
    } else {
      setSelectedStatuses((prev) => [...prev, status]);
    }
  };

  const isAllPrioritiesSelected = selectedPriorities.length === 4;
  const isAllStatusesSelected = selectedStatuses.length === 3;
  const hasActiveFilterModifications =
    !isAllPrioritiesSelected || !isAllStatusesSelected || searchQuery.trim().length > 0;

  const handleResetAllFilters = () => {
    setSelectedPriorities(['URGENT', 'HIGH', 'MEDIUM', 'LOW']);
    setSelectedStatuses(['SCHEDULED', 'UNSCHEDULED', 'COMPLETED']);
    setSearchQuery('');
  };

  const handleSelectAllPriorities = () => {
    if (isAllPrioritiesSelected) {
      setSelectedPriorities([]);
    } else {
      setSelectedPriorities(['URGENT', 'HIGH', 'MEDIUM', 'LOW']);
    }
  };

  const handleSelectAllStatuses = () => {
    if (isAllStatusesSelected) {
      setSelectedStatuses([]);
    } else {
      setSelectedStatuses(['SCHEDULED', 'UNSCHEDULED', 'COMPLETED']);
    }
  };

  const filteredTasks = activeTasks.filter((t) => {
    // 1. Status Filter
    const taskStatusGroup: 'SCHEDULED' | 'UNSCHEDULED' | 'COMPLETED' =
      t.status === 'COMPLETED' || t.status === 'completed_manual'
        ? 'COMPLETED'
        : t.status === 'SCHEDULED'
        ? 'SCHEDULED'
        : 'UNSCHEDULED';

    if (!selectedStatuses.includes(taskStatusGroup)) {
      return false;
    }

    // 2. Priority Filter
    const taskPrio = t.priority || 'MEDIUM';
    if (!selectedPriorities.includes(taskPrio)) {
      return false;
    }

    // 3. Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        t.title.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-y-auto p-4 sm:p-6">
      <div className="max-w-4xl mx-auto w-full space-y-5">
        {/* Header & Quick stats */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-[#172B42] font-editorial tracking-tight">
              Daftar Kegiatan & Komitmen
            </h2>
            <p className="text-xs text-[#53657A] mt-0.5">
              Atur durasi, tenggat waktu opsional, dan biarkan scheduler deterministik menyusun jadwal realistis.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {unscheduledCount > 0 && (
              <button
                onClick={onScheduleAllTasks}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#2457A7] bg-[#EAF3FC] hover:bg-[#d8ebfd] border border-[#8DBCEB]/60 rounded-xl transition-all shadow-2xs"
              >
                <Zap size={14} className="text-[#2457A7]" />
                <span>Jadwalkan Semua ({unscheduledCount})</span>
              </button>
            )}

            <button
              onClick={onOpenTaskModal}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] rounded-xl transition-colors shadow-xs"
            >
              <Plus size={15} />
              <span>Tambah Kegiatan</span>
            </button>
          </div>
        </div>

        {/* Filter bar & Search */}
        <div className="bg-white p-4 border border-[#D9E3EF] rounded-2xl shadow-xs space-y-3.5">
          {/* Top row: Search and Reset */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <input
                type="text"
                placeholder="Cari kegiatan berdasarkan nama atau catatan..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-3.5 py-2 text-xs rounded-xl border border-[#D9E3EF] bg-[#F8FAFC] focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-[#2457A7] transition-all"
              />
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#53657A]">
                Menampilkan <strong className="text-[#172B42]">{filteredTasks.length}</strong> dari{' '}
                <strong className="text-[#172B42]">{activeTasks.length}</strong> kegiatan
              </span>
              {hasActiveFilterModifications && (
                <button
                  onClick={handleResetAllFilters}
                  className="px-2.5 py-1 text-xs font-semibold text-[#C43D4B] hover:bg-red-50 rounded-lg transition-colors border border-red-200/60"
                >
                  Reset Filter
                </button>
              )}
            </div>
          </div>

          {/* Toggle Groups: Status & Priority */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 border-t border-[#D9E3EF]/60">
            {/* Status Toggles */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="flex items-center justify-between sm:justify-start gap-1.5 shrink-0">
                <span className="text-xs font-bold text-[#172B42] flex items-center gap-1">
                  <Layers size={13} className="text-[#2457A7]" /> Status:
                </span>
                <button
                  onClick={handleSelectAllStatuses}
                  className="text-[11px] text-[#2457A7] hover:underline"
                >
                  {isAllStatusesSelected ? 'Batal' : 'Semua'}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {/* Unscheduled Toggle */}
                <button
                  onClick={() => handleToggleStatus('UNSCHEDULED')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 ${
                    selectedStatuses.includes('UNSCHEDULED')
                      ? 'bg-amber-500 text-white border-amber-600 shadow-2xs font-semibold'
                      : 'bg-white text-[#53657A] border-[#D9E3EF] hover:bg-slate-50 opacity-60'
                  }`}
                  title="Toggle filter: Belum Terjadwal"
                >
                  <AlertCircle size={12} />
                  <span>Belum Terjadwal</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      selectedStatuses.includes('UNSCHEDULED')
                        ? 'bg-amber-600 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {unscheduledCount}
                  </span>
                </button>

                {/* Scheduled Toggle */}
                <button
                  onClick={() => handleToggleStatus('SCHEDULED')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 ${
                    selectedStatuses.includes('SCHEDULED')
                      ? 'bg-[#2457A7] text-white border-[#1E4889] shadow-2xs font-semibold'
                      : 'bg-white text-[#53657A] border-[#D9E3EF] hover:bg-slate-50 opacity-60'
                  }`}
                  title="Toggle filter: Terjadwal"
                >
                  <Clock size={12} />
                  <span>Terjadwal</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      selectedStatuses.includes('SCHEDULED')
                        ? 'bg-[#1E4889] text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {scheduledCount}
                  </span>
                </button>

                {/* Completed Toggle */}
                <button
                  onClick={() => handleToggleStatus('COMPLETED')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 ${
                    selectedStatuses.includes('COMPLETED')
                      ? 'bg-emerald-600 text-white border-emerald-700 shadow-2xs font-semibold'
                      : 'bg-white text-[#53657A] border-[#D9E3EF] hover:bg-slate-50 opacity-60'
                  }`}
                  title="Toggle filter: Selesai"
                >
                  <CheckCircle2 size={12} />
                  <span>Selesai</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      selectedStatuses.includes('COMPLETED')
                        ? 'bg-emerald-700 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {completedCount}
                  </span>
                </button>
              </div>
            </div>

            {/* Priority Toggles */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="flex items-center justify-between sm:justify-start gap-1.5 shrink-0">
                <span className="text-xs font-bold text-[#172B42] flex items-center gap-1">
                  <Sparkles size={13} className="text-[#B86B12]" /> Prioritas:
                </span>
                <button
                  onClick={handleSelectAllPriorities}
                  className="text-[11px] text-[#2457A7] hover:underline"
                >
                  {isAllPrioritiesSelected ? 'Batal' : 'Semua'}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {/* High / Urgent Toggle */}
                <button
                  onClick={() => handleTogglePriority('HIGH')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 ${
                    selectedPriorities.includes('HIGH') || selectedPriorities.includes('URGENT')
                      ? 'bg-red-500 text-white border-red-600 shadow-2xs font-semibold'
                      : 'bg-white text-[#53657A] border-[#D9E3EF] hover:bg-slate-50 opacity-60'
                  }`}
                  title="Toggle filter prioritas: Tinggi / Mendesak"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                  <span>Tinggi</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      selectedPriorities.includes('HIGH') || selectedPriorities.includes('URGENT')
                        ? 'bg-red-700 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {highPriorityCount}
                  </span>
                </button>

                {/* Medium Toggle */}
                <button
                  onClick={() => handleTogglePriority('MEDIUM')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 ${
                    selectedPriorities.includes('MEDIUM')
                      ? 'bg-[#2457A7] text-white border-[#1E4889] shadow-2xs font-semibold'
                      : 'bg-white text-[#53657A] border-[#D9E3EF] hover:bg-slate-50 opacity-60'
                  }`}
                  title="Toggle filter prioritas: Sedang"
                >
                  <span>Sedang</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      selectedPriorities.includes('MEDIUM')
                        ? 'bg-[#1E4889] text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {mediumPriorityCount}
                  </span>
                </button>

                {/* Low Toggle */}
                <button
                  onClick={() => handleTogglePriority('LOW')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 ${
                    selectedPriorities.includes('LOW')
                      ? 'bg-slate-700 text-white border-slate-800 shadow-2xs font-semibold'
                      : 'bg-white text-[#53657A] border-[#D9E3EF] hover:bg-slate-50 opacity-60'
                  }`}
                  title="Toggle filter prioritas: Rendah"
                >
                  <span>Rendah</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      selectedPriorities.includes('LOW')
                        ? 'bg-slate-800 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {lowPriorityCount}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Task List */}
        {filteredTasks.length === 0 ? (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-10 text-center space-y-2">
            <Clock className="w-8 h-8 text-[#8DBCEB] mx-auto opacity-70" />
            <h4 className="text-sm font-bold text-[#172B42]">Tidak ada kegiatan dalam kategori ini</h4>
            <p className="text-xs text-[#53657A]">
              Buat kegiatan baru dan tentukan durasi serta jadwal agar agenda Anda selalu realistis.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredTasks.map((task) => {
              const isDone = task.status === 'COMPLETED' || task.status === 'completed_manual';
              const pInfo = priorityStyles[task.priority];
              const hasDl = Boolean(task.deadlineAt && task.deadlineAt.trim().length > 0);
              const deadlineDate = hasDl && task.deadlineAt ? new Date(task.deadlineAt) : null;
              const syncMeta = getSyncStatusMeta(task.scheduledSessions);
              const SyncMetaIcon = syncMeta?.icon;

              return (
                <div
                  key={task.id}
                  className={`bg-white border rounded-2xl p-4 sm:p-5 shadow-xs transition-all hover:shadow-sm ${
                    isDone
                      ? 'border-[#D9E3EF] bg-slate-50/60 opacity-70'
                      : 'border-[#D9E3EF] hover:border-[#8DBCEB]'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    {/* Left: Status Checkbox & Title */}
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => onToggleTaskComplete(task.id)}
                        className="mt-0.5 text-[#53657A] hover:text-[#16856B] shrink-0"
                        title={isDone ? 'Tandai belum selesai' : 'Tandai selesai'}
                      >
                        <CheckCircle2
                          size={20}
                          className={isDone ? 'text-[#16856B] fill-[#16856B]/20' : 'text-slate-300 hover:text-[#2457A7]'}
                        />
                      </button>

                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className={`text-sm font-bold ${isDone ? 'line-through text-slate-500' : 'text-[#172B42]'}`}>
                            {task.title}
                          </h3>
                          <span className={`text-[10px] px-2 py-0.5 rounded-md border font-medium ${pInfo.badgeClass}`}>
                            {pInfo.label}
                          </span>

                          {task.rescheduledFromTaskId && (
                            <span className="text-[10px] px-2 py-0.5 rounded-md bg-[#EAF3FC] text-[#2457A7] border border-[#8DBCEB]/50 font-medium">
                              Hasil Jadwal Ulang
                            </span>
                          )}

                          {/* Aggregate Google Calendar Sync Status Badge */}
                          {syncMeta && SyncMetaIcon && (
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border font-medium ${syncMeta.badgeClass}`}
                              title={syncMeta.tooltip}
                            >
                              <SyncMetaIcon size={11} className="shrink-0" />
                              <span>{syncMeta.label}</span>
                            </span>
                          )}
                        </div>

                        {task.description && (
                          <p className="text-xs text-[#53657A] leading-relaxed">
                            {task.description}
                          </p>
                        )}

                        {/* Metadata badges: Duration, Deadline, Split */}
                        <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-[#53657A]">
                          <span className="flex items-center gap-1 font-mono">
                            <Clock size={12} className="text-[#2457A7]" />
                            {task.estimatedDurationMinutes} menit
                          </span>

                          <span className="flex items-center gap-1">
                            <Calendar size={12} className="text-[#2457A7]" />
                            Tenggat:{' '}
                            <strong className="text-[#172B42]">
                              {deadlineDate && !isNaN(deadlineDate.getTime())
                                ? deadlineDate.toLocaleDateString('id-ID', {
                                    weekday: 'short',
                                    day: 'numeric',
                                    month: 'short',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : 'Tanpa tenggat'}
                            </strong>
                          </span>

                          {task.allowSplit && (
                            <span className="flex items-center gap-1 bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-md font-medium text-[10px]">
                              <Layers size={11} /> Boleh dibagi (min. {task.minimumSessionMinutes || 30}m)
                            </span>
                          )}
                        </div>

                        {/* Scheduled Session Details if any */}
                        {task.scheduledSessions && task.scheduledSessions.length > 0 && (
                          <div className="pt-2">
                            <span className="text-[11px] font-semibold text-[#16856B] block mb-1">
                              Sesi Terjadwal ({task.scheduledSessions.length}):
                            </span>
                            <div className="flex flex-wrap gap-2">
                              {task.scheduledSessions.map((sess) => {
                                const sessBadge = getSessionSyncBadge(sess.syncStatus);
                                const SessIcon = sessBadge.icon;
                                const startDate = new Date(sess.startAt);

                                return (
                                  <div
                                    key={sess.id}
                                    className="flex items-center gap-2 text-[11px] bg-slate-50 border border-[#D9E3EF] px-2.5 py-1.5 rounded-xl text-[#172B42]"
                                  >
                                    <div>
                                      <span className="font-medium">
                                        {startDate.toLocaleDateString('id-ID', {
                                          weekday: 'short',
                                          day: 'numeric',
                                          month: 'short',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                      <span className="text-[#53657A] ml-1 font-mono text-[10px]">
                                        ({sess.durationMinutes} mnt)
                                      </span>
                                    </div>

                                    {/* Individual session sync badge */}
                                    <span
                                      className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-md border font-semibold ${sessBadge.badgeClass}`}
                                      title={sessBadge.tooltip}
                                    >
                                      <SessIcon size={9} className="shrink-0" />
                                      <span>{sessBadge.label}</span>
                                    </span>

                                    {sess.htmlLink && (
                                      <a
                                        href={sess.htmlLink}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-[#2457A7] hover:text-[#1E4889] ml-0.5"
                                        title="Buka sesi di Google Calendar"
                                      >
                                        <ExternalLink size={11} />
                                      </a>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                      {task.status === 'UNSCHEDULED' && (
                        <button
                          onClick={() => onScheduleSingleTask(task)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#2457A7] hover:bg-[#1E4889] text-white rounded-xl text-xs font-semibold transition-colors shadow-2xs"
                        >
                          <Zap size={13} />
                          <span>Jadwalkan</span>
                        </button>
                      )}

                      <button
                        onClick={() => onEditTask(task)}
                        className="p-1.5 text-[#53657A] hover:text-[#2457A7] rounded-lg hover:bg-slate-100 transition-colors"
                        title="Ubah rincian kegiatan"
                      >
                        <Edit2 size={15} />
                      </button>

                      <button
                        onClick={() => onDeleteTask(task.id)}
                        className="p-1.5 text-[#53657A] hover:text-[#C43D4B] rounded-lg hover:bg-slate-100 transition-colors"
                        title="Hapus kegiatan"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
