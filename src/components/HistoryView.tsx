import React, { useState } from 'react';
import {
  History,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCw,
  Search,
  Filter,
  ArrowUpDown,
  Calendar,
  X,
  Sparkles,
  Info,
  Layers,
  ChevronRight,
  ExternalLink,
  Ban,
  Check,
} from 'lucide-react';
import { Task, UserPreferences, Priority, TaskScheduleSession } from '../types';
import { formatInTimezone } from '../lib/timezone';
import { getTaskEffectiveStartTime, getTaskEffectiveEndTime } from '../lib/activityStatusManager';
import { HistoryStatsSummary } from './HistoryStatsSummary';

interface HistoryViewProps {
  tasks: Task[];
  preferences: UserPreferences;
  onOpenReschedule: (task: Task) => void;
  onDismissTask: (taskId: string) => void;
  onRefreshAudit: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  tasks,
  preferences,
  onOpenReschedule,
  onDismissTask,
  onRefreshAudit,
}) => {
  const [filterType, setFilterType] = useState<'ALL' | 'COMPLETED_MANUAL' | 'MISSED_AUTO' | 'PENDING_ACTION'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'NEWEST' | 'OLDEST'>('NEWEST');
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<Task | null>(null);

  const tz = preferences.timezone || 'Asia/Jakarta';

  // Filter tasks that belong to history
  const historyTasks = tasks.filter((t) => {
    return (
      t.status === 'completed_manual' ||
      t.status === 'missed_auto' ||
      t.status === 'COMPLETED'
    );
  });

  const completedCount = historyTasks.filter(
    (t) => t.status === 'completed_manual' || t.status === 'COMPLETED'
  ).length;

  const missedCount = historyTasks.filter((t) => t.status === 'missed_auto').length;

  const pendingActionCount = historyTasks.filter(
    (t) => t.status === 'missed_auto' && (!t.rescheduleDecision || t.rescheduleDecision === 'pending')
  ).length;

  // Filter by user selection
  const filteredTasks = historyTasks.filter((t) => {
    const isCompleted = t.status === 'completed_manual' || t.status === 'COMPLETED';
    const isMissed = t.status === 'missed_auto';

    if (filterType === 'COMPLETED_MANUAL' && !isCompleted) return false;
    if (filterType === 'MISSED_AUTO' && !isMissed) return false;
    if (filterType === 'PENDING_ACTION') {
      if (!isMissed) return false;
      if (t.rescheduleDecision && t.rescheduleDecision !== 'pending') return false;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = t.title.toLowerCase().includes(q);
      const matchDesc = Boolean(t.description && t.description.toLowerCase().includes(q));
      return matchTitle || matchDesc;
    }

    return true;
  });

  // Sort
  filteredTasks.sort((a, b) => {
    const getTime = (task: Task) => {
      const dateStr = task.completedAt || task.missedAt || task.createdAt;
      return new Date(dateStr).getTime() || 0;
    };
    const tA = getTime(a);
    const tB = getTime(b);
    return sortOrder === 'NEWEST' ? tB - tA : tA - tB;
  });

  const priorityStyles: Record<Priority, { label: string; badgeClass: string }> = {
    LOW: { label: 'Rendah', badgeClass: 'bg-slate-100 text-slate-700 border-slate-200' },
    MEDIUM: { label: 'Sedang', badgeClass: 'bg-[#EAF3FC] text-[#2457A7] border-[#8DBCEB]/50' },
    HIGH: { label: 'Tinggi', badgeClass: 'bg-amber-50 text-[#B86B12] border-amber-200' },
    URGENT: { label: 'Mendesak', badgeClass: 'bg-red-50 text-[#C43D4B] border-red-200 font-semibold' },
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-y-auto p-4 sm:p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-semibold bg-[#EAF3FC] text-[#2457A7] px-2.5 py-0.5 rounded-full">
                Arsip & Riwayat
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold font-editorial text-[#172B42] tracking-tight">
              Riwayat Kegiatan
            </h2>
            <p className="text-xs text-[#53657A] mt-0.5">
              Kelola kegiatan yang telah diselesaikan manual atau terlewat otomatis oleh sistem waktu.
            </p>
          </div>

          <button
            onClick={onRefreshAudit}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#53657A] hover:text-[#172B42] bg-white border border-[#D9E3EF] hover:bg-slate-50 rounded-xl transition-colors shadow-2xs self-start sm:self-auto"
            title="Periksa apakah ada jadwal aktif yang telah lewat waktu selesai"
          >
            <RotateCw size={13} />
            <span>Periksa Status Waktu</span>
          </button>
        </div>

        {/* Ringkasan Statistik Rasio Selesai vs Terlewat */}
        <HistoryStatsSummary historyTasks={historyTasks} />

        {/* Stats Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-4 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#53657A]">Total Riwayat</span>
              <History size={16} className="text-[#2457A7]" />
            </div>
            <p className="text-2xl font-bold text-[#172B42] mt-1.5">{historyTasks.length}</p>
            <span className="text-[11px] text-[#53657A]/80">Kegiatan diarsipkan</span>
          </div>

          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-4 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#53657A]">Selesai (Manual)</span>
              <CheckCircle2 size={16} className="text-[#16856B]" />
            </div>
            <p className="text-2xl font-bold text-[#16856B] mt-1.5">{completedCount}</p>
            <span className="text-[11px] text-[#53657A]/80">Diselesaikan pengguna</span>
          </div>

          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-4 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#53657A]">Terlewat (Otomatis)</span>
              <AlertCircle size={16} className="text-[#B86B12]" />
            </div>
            <div className="flex items-baseline gap-2 mt-1.5">
              <p className="text-2xl font-bold text-[#B86B12]">{missedCount}</p>
              {pendingActionCount > 0 && (
                <span className="text-[10px] font-semibold bg-amber-100 text-[#B86B12] px-1.5 py-0.5 rounded-full">
                  {pendingActionCount} butuh tindakan
                </span>
              )}
            </div>
            <span className="text-[11px] text-[#53657A]/80">Waktu selesai telah lewat</span>
          </div>
        </div>

        {/* Filter, Search & Sort Bar */}
        <div className="bg-white border border-[#D9E3EF] rounded-2xl p-3 shadow-2xs space-y-3">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
            {/* Filter Tabs */}
            <div className="flex flex-wrap items-center gap-1 p-1 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl text-xs font-medium">
              <button
                onClick={() => setFilterType('ALL')}
                className={`px-3 py-1 rounded-lg transition-all ${
                  filterType === 'ALL'
                    ? 'bg-white text-[#2457A7] font-semibold shadow-2xs'
                    : 'text-[#53657A] hover:text-[#172B42]'
                }`}
              >
                Semua ({historyTasks.length})
              </button>
              <button
                onClick={() => setFilterType('COMPLETED_MANUAL')}
                className={`px-3 py-1 rounded-lg transition-all ${
                  filterType === 'COMPLETED_MANUAL'
                    ? 'bg-white text-[#16856B] font-semibold shadow-2xs'
                    : 'text-[#53657A] hover:text-[#172B42]'
                }`}
              >
                Selesai Manual ({completedCount})
              </button>
              <button
                onClick={() => setFilterType('MISSED_AUTO')}
                className={`px-3 py-1 rounded-lg transition-all ${
                  filterType === 'MISSED_AUTO'
                    ? 'bg-white text-[#B86B12] font-semibold shadow-2xs'
                    : 'text-[#53657A] hover:text-[#172B42]'
                }`}
              >
                Terlewat ({missedCount})
              </button>
              {pendingActionCount > 0 && (
                <button
                  onClick={() => setFilterType('PENDING_ACTION')}
                  className={`px-3 py-1 rounded-lg transition-all ${
                    filterType === 'PENDING_ACTION'
                      ? 'bg-white text-[#C43D4B] font-semibold shadow-2xs'
                      : 'text-[#53657A] hover:text-[#172B42]'
                  }`}
                >
                  Butuh Tindakan ({pendingActionCount})
                </button>
              )}
            </div>

            {/* Sort Toggle */}
            <div className="flex items-center gap-1.5 self-end sm:self-auto text-xs text-[#53657A]">
              <ArrowUpDown size={13} />
              <span>Urutan:</span>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as any)}
                className="bg-transparent font-semibold text-[#172B42] focus:outline-hidden cursor-pointer"
              >
                <option value="NEWEST">Terbaru</option>
                <option value="OLDEST">Terlama</option>
              </select>
            </div>
          </div>

          {/* Search Box */}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#53657A]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari kegiatan riwayat berdasarkan judul atau catatan..."
              className="w-full pl-8 pr-4 py-2 text-xs rounded-xl border border-[#D9E3EF] bg-[#F8FAFC] text-[#172B42] placeholder:text-[#53657A]/60 focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-[#2457A7] transition-all"
            />
          </div>
        </div>

        {/* History List */}
        {filteredTasks.length === 0 ? (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-8 text-center space-y-3 shadow-2xs">
            <History className="w-10 h-10 text-[#53657A]/40 mx-auto" />
            <h4 className="text-base font-bold text-[#172B42] font-editorial">
              Belum Ada Kegiatan pada Filter Ini
            </h4>
            <p className="text-xs text-[#53657A] max-w-sm mx-auto leading-relaxed">
              {filterType === 'COMPLETED_MANUAL'
                ? 'Kegiatan yang Anda tandai selesai secara manual akan otomatis diarsipkan di sini.'
                : filterType === 'MISSED_AUTO'
                ? 'Kegiatan yang waktu selesainya telah berlalu tanpa penandaan selesai akan masuk ke sini.'
                : 'Belum ada kegiatan yang tersimpan di riwayat. Kegiatan selesai atau terlewat akan muncul di sini.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredTasks.map((item) => {
              const isManual = item.status === 'completed_manual' || item.status === 'COMPLETED';
              const isMissed = item.status === 'missed_auto';

              const startTime = getTaskEffectiveStartTime(item);
              const endTime = getTaskEffectiveEndTime(item);

              const eventTimestamp = item.completedAt || item.missedAt || item.createdAt;

              return (
                <div
                  key={item.id}
                  onClick={() => setSelectedTaskDetail(item)}
                  className="bg-white border border-[#D9E3EF] hover:border-[#8DBCEB] rounded-2xl p-4 shadow-2xs transition-all hover:shadow-xs cursor-pointer space-y-3 group"
                >
                  {/* Top Status & Timestamp Row */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {isManual ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-[#E1F5EE] text-[#0F6B56] border border-[#9FE1D0]">
                          <CheckCircle2 size={13} />
                          <span>Selesai (Manual)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-[#B86B12] border border-amber-200">
                          <AlertCircle size={13} />
                          <span>Terlewat (Otomatis)</span>
                        </span>
                      )}

                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                          priorityStyles[item.priority]?.badgeClass || ''
                        }`}
                      >
                        {priorityStyles[item.priority]?.label || item.priority}
                      </span>
                    </div>

                    <div className="text-[11px] text-[#53657A] font-mono flex items-center gap-1">
                      <Clock size={12} className="text-[#53657A]/80" />
                      <span>
                        {isManual ? 'Diselesaikan: ' : 'Ditandai terlewat: '}
                        {formatInTimezone(new Date(eventTimestamp), tz, {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>

                  {/* Title & Description */}
                  <div>
                    <h3 className="font-bold text-sm sm:text-base text-[#172B42] group-hover:text-[#2457A7] transition-colors">
                      {item.title}
                    </h3>
                    {item.description && (
                      <p className="text-xs text-[#53657A] mt-1 line-clamp-2">
                        {item.description}
                      </p>
                    )}
                  </div>

                  {/* Scheduled Time Information */}
                  <div className="p-2.5 bg-[#F8FAFC] border border-[#D9E3EF]/80 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-[#53657A]">
                    <div className="flex items-center gap-2">
                      <Calendar size={13} className="text-[#2457A7] shrink-0" />
                      <span>
                        Jadwal Semula:{' '}
                        {startTime && endTime ? (
                          <strong className="text-[#172B42] font-mono">
                            {formatInTimezone(startTime, tz, {
                              weekday: 'short',
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                            {' — '}
                            {formatInTimezone(endTime, tz, {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </strong>
                        ) : (
                          <span className="italic">Belum memiliki slot tetap</span>
                        )}
                      </span>
                    </div>

                    <div className="text-[11px] font-mono text-[#53657A]">
                      Durasi: <strong>{item.estimatedDurationMinutes} menit</strong>
                    </div>
                  </div>

                  {/* Actions for Missed Task */}
                  {isMissed && (
                    <div
                      className="pt-2 border-t border-[#D9E3EF]/60 flex flex-wrap items-center justify-between gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {item.rescheduledToTaskId ? (
                        <div className="flex items-center gap-2 text-xs text-[#16856B]">
                          <Check size={14} />
                          <span>Telah dijadwalkan ulang ke jadwal baru</span>
                        </div>
                      ) : item.rescheduleDecision === 'dismissed' ? (
                        <div className="flex items-center gap-1.5 text-xs text-[#53657A] italic">
                          <Ban size={13} />
                          <span>Penjadwalan ulang diabaikan</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 w-full sm:w-auto">
                          <button
                            type="button"
                            onClick={() => onOpenReschedule(item)}
                            className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-1.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl shadow-2xs transition-colors"
                          >
                            <RotateCw size={12} />
                            <span>Jadwalkan Ulang</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onDismissTask(item.id)}
                            className="px-3 py-1.5 text-xs font-medium text-[#53657A] hover:text-[#C43D4B] hover:bg-slate-100 rounded-xl transition-colors"
                          >
                            Abaikan
                          </button>
                        </div>
                      )}

                      <button
                        onClick={() => setSelectedTaskDetail(item)}
                        className="text-xs text-[#2457A7] hover:underline flex items-center gap-1 ml-auto"
                      >
                        <span>Lihat Detail</span>
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* History Detail Modal */}
      {selectedTaskDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-start justify-between border-b border-[#D9E3EF] pb-3">
              <div>
                <span className="text-[10px] font-semibold bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-full">
                  Detail Riwayat Kegiatan
                </span>
                <h3 className="text-base font-bold font-editorial text-[#172B42] mt-1">
                  {selectedTaskDetail.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedTaskDetail(null)}
                className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3 text-xs text-[#53657A]">
              <div>
                <span className="font-semibold text-[#172B42] block mb-0.5">Deskripsi:</span>
                <p className="bg-[#F8FAFC] p-3 rounded-xl border border-[#D9E3EF] leading-relaxed text-[#172B42]">
                  {selectedTaskDetail.description || 'Tidak ada deskripsi tambahan.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]">
                  <span className="text-[11px] text-[#53657A] block">Durasi Asal:</span>
                  <strong className="text-sm text-[#172B42]">
                    {selectedTaskDetail.estimatedDurationMinutes} menit
                  </strong>
                </div>

                <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]">
                  <span className="text-[11px] text-[#53657A] block">Status Akhir:</span>
                  <strong
                    className={`text-sm ${
                      selectedTaskDetail.status === 'completed_manual' ||
                      selectedTaskDetail.status === 'COMPLETED'
                        ? 'text-[#16856B]'
                        : 'text-[#B86B12]'
                    }`}
                  >
                    {selectedTaskDetail.status === 'completed_manual' ||
                    selectedTaskDetail.status === 'COMPLETED'
                      ? 'Selesai Manual'
                      : 'Terlewat Otomatis'}
                  </strong>
                </div>
              </div>

              {/* Status History Log Timeline */}
              {selectedTaskDetail.statusHistory && selectedTaskDetail.statusHistory.length > 0 && (
                <div className="space-y-1.5 pt-2">
                  <span className="font-semibold text-[#172B42] block">
                    Kronologi Perubahan Status:
                  </span>
                  <div className="border border-[#D9E3EF] rounded-xl p-3 bg-[#F8FAFC] space-y-2">
                    {selectedTaskDetail.statusHistory.map((h, i) => (
                      <div key={i} className="flex items-start gap-2 text-[11px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#2457A7] mt-1.5 shrink-0" />
                        <div>
                          <div className="flex items-center gap-2">
                            <strong className="text-[#172B42]">{h.status}</strong>
                            <span className="font-mono text-[#53657A]">
                              {formatInTimezone(new Date(h.changedAt), tz, {
                                day: 'numeric',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                          {h.reason && <p className="text-[#53657A] mt-0.5">{h.reason}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-[#D9E3EF] flex items-center justify-between">
              {selectedTaskDetail.status === 'missed_auto' &&
                !selectedTaskDetail.rescheduledToTaskId &&
                selectedTaskDetail.rescheduleDecision !== 'dismissed' && (
                  <button
                    onClick={() => {
                      const taskToReschedule = selectedTaskDetail;
                      setSelectedTaskDetail(null);
                      onOpenReschedule(taskToReschedule);
                    }}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-[#2457A7] text-white text-xs font-semibold rounded-xl hover:bg-[#1E4889]"
                  >
                    <RotateCw size={13} />
                    <span>Jadwalkan Ulang Kegiatan Ini</span>
                  </button>
                )}

              <button
                onClick={() => setSelectedTaskDetail(null)}
                className="px-4 py-2 text-xs font-medium text-[#53657A] hover:bg-slate-100 rounded-xl ml-auto"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
