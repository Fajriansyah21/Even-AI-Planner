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
} from 'lucide-react';
import { Task, Priority, ScheduleCalculationResult, TaskStatus } from '../types';

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
  const [filter, setFilter] = useState<'ALL' | 'UNSCHEDULED' | 'SCHEDULED' | 'COMPLETED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const priorityStyles: Record<Priority, { label: string; badgeClass: string }> = {
    LOW: { label: 'Rendah', badgeClass: 'bg-slate-100 text-slate-700 border-slate-200' },
    MEDIUM: { label: 'Sedang', badgeClass: 'bg-[#EAF3FC] text-[#2457A7] border-[#8DBCEB]/50' },
    HIGH: { label: 'Tinggi', badgeClass: 'bg-amber-50 text-[#B86B12] border-amber-200' },
    URGENT: { label: 'Mendesak', badgeClass: 'bg-red-50 text-[#C43D4B] border-red-200 font-semibold' },
  };

  const filteredTasks = tasks.filter((t) => {
    if (filter === 'UNSCHEDULED' && t.status !== 'UNSCHEDULED') return false;
    if (filter === 'SCHEDULED' && t.status !== 'SCHEDULED') return false;
    if (filter === 'COMPLETED' && t.status !== 'COMPLETED') return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        t.title.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const unscheduledCount = tasks.filter((t) => t.status === 'UNSCHEDULED').length;

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
        <div className="bg-white p-3 border border-[#D9E3EF] rounded-2xl shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
          {/* Status Tabs */}
          <div className="flex items-center gap-1 w-full sm:w-auto overflow-x-auto text-xs font-medium">
            <button
              onClick={() => setFilter('ALL')}
              className={`px-3 py-1.5 rounded-xl transition-colors whitespace-nowrap ${
                filter === 'ALL'
                  ? 'bg-[#2457A7] text-white font-semibold'
                  : 'text-[#53657A] hover:text-[#172B42] hover:bg-slate-100'
              }`}
            >
              Semua ({tasks.length})
            </button>
            <button
              onClick={() => setFilter('UNSCHEDULED')}
              className={`px-3 py-1.5 rounded-xl transition-colors whitespace-nowrap ${
                filter === 'UNSCHEDULED'
                  ? 'bg-[#2457A7] text-white font-semibold'
                  : 'text-[#53657A] hover:text-[#172B42] hover:bg-slate-100'
              }`}
            >
              Belum Terjadwal ({unscheduledCount})
            </button>
            <button
              onClick={() => setFilter('SCHEDULED')}
              className={`px-3 py-1.5 rounded-xl transition-colors whitespace-nowrap ${
                filter === 'SCHEDULED'
                  ? 'bg-[#2457A7] text-white font-semibold'
                  : 'text-[#53657A] hover:text-[#172B42] hover:bg-slate-100'
              }`}
            >
              Terjadwal ({tasks.filter((t) => t.status === 'SCHEDULED').length})
            </button>
            <button
              onClick={() => setFilter('COMPLETED')}
              className={`px-3 py-1.5 rounded-xl transition-colors whitespace-nowrap ${
                filter === 'COMPLETED'
                  ? 'bg-[#2457A7] text-white font-semibold'
                  : 'text-[#53657A] hover:text-[#172B42] hover:bg-slate-100'
              }`}
            >
              Selesai ({tasks.filter((t) => t.status === 'COMPLETED').length})
            </button>
          </div>

          {/* Search input */}
          <input
            type="text"
            placeholder="Cari kegiatan..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:w-48 px-3 py-1.5 text-xs rounded-xl border border-[#D9E3EF] bg-[#F8FAFC] focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
          />
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
              const isDone = task.status === 'COMPLETED';
              const pInfo = priorityStyles[task.priority];
              const hasDl = Boolean(task.deadlineAt && task.deadlineAt.trim().length > 0);
              const deadlineDate = hasDl && task.deadlineAt ? new Date(task.deadlineAt) : null;

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
                            <span className="text-[11px] font-semibold text-[#16856B] block">
                              Terjadwal pada:
                            </span>
                            <div className="space-y-1 mt-1">
                              {task.scheduledSessions.map((sess) => (
                                <div
                                  key={sess.id}
                                  className="text-[11px] bg-slate-50 border border-[#D9E3EF] px-2.5 py-1 rounded-lg text-[#172B42] inline-block mr-2"
                                >
                                  {new Date(sess.startAt).toLocaleDateString('id-ID', {
                                    weekday: 'short',
                                    day: 'numeric',
                                    month: 'short',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}{' '}
                                  ({sess.durationMinutes} mnt)
                                </div>
                              ))}
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
