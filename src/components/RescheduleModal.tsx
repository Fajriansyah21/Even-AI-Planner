import React, { useState, useEffect } from 'react';
import {
  X,
  RotateCw,
  Calendar,
  Clock,
  AlertTriangle,
  Sparkles,
  Layers,
  ArrowRight,
  CheckCircle2,
} from 'lucide-react';
import { Task, UserPreferences, Priority } from '../types';
import { formatInTimezone } from '../lib/timezone';

interface RescheduleModalProps {
  isOpen: boolean;
  task: Task | null;
  onClose: () => void;
  onConfirmReschedule: (
    originalTask: Task,
    newDeadlineAt: string | null,
    manualTime?: { startAt: string; endAt: string }
  ) => Promise<void> | void;
  preferences: UserPreferences;
}

export const RescheduleModal: React.FC<RescheduleModalProps> = ({
  isOpen,
  task,
  onClose,
  onConfirmReschedule,
  preferences,
}) => {
  const [scheduleMode, setScheduleMode] = useState<'auto' | 'manual'>('auto');
  const [deadlineMode, setDeadlineMode] = useState<'none' | 'keep_or_new'>('none');
  const [newDeadlineDate, setNewDeadlineDate] = useState('');
  const [newDeadlineTime, setNewDeadlineTime] = useState('18:00');

  // Manual specific time pickers
  const [manualDate, setManualDate] = useState('');
  const [manualStartTime, setManualStartTime] = useState('09:00');
  const [manualEndTime, setManualEndTime] = useState('10:00');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState('');

  const tz = preferences.timezone || 'Asia/Jakarta';

  useEffect(() => {
    if (!task) return;

    setScheduleMode('auto');
    setValidationError('');

    // Pre-populate tomorrow's date for manual pick
    const tmr = new Date();
    tmr.setDate(tmr.getDate() + 1);
    const tmrStr = tmr.toISOString().split('T')[0];
    setManualDate(tmrStr);

    // Check if original task had a deadline
    if (task.deadlineAt) {
      const isPast = new Date(task.deadlineAt).getTime() <= Date.now();
      if (isPast) {
        // Deadline expired! Default to none, but allow picking new one
        setDeadlineMode('none');
      } else {
        setDeadlineMode('keep_or_new');
        const dlDate = new Date(task.deadlineAt);
        setNewDeadlineDate(dlDate.toISOString().split('T')[0]);
      }
    } else {
      setDeadlineMode('none');
    }
  }, [task]);

  if (!isOpen || !task) return null;

  const isOldDeadlinePassed = Boolean(
    task.deadlineAt && new Date(task.deadlineAt).getTime() <= Date.now()
  );

  const priorityStyles: Record<Priority, { label: string; badgeClass: string }> = {
    LOW: { label: 'Rendah', badgeClass: 'bg-slate-100 text-slate-700 border-slate-200' },
    MEDIUM: { label: 'Sedang', badgeClass: 'bg-[#EAF3FC] text-[#2457A7] border-[#8DBCEB]/50' },
    HIGH: { label: 'Tinggi', badgeClass: 'bg-amber-50 text-[#B86B12] border-amber-200' },
    URGENT: { label: 'Mendesak', badgeClass: 'bg-red-50 text-[#C43D4B] border-red-200 font-semibold' },
  };

  const handleConfirm = async () => {
    setValidationError('');

    let finalDeadline: string | null = null;
    if (deadlineMode === 'keep_or_new') {
      if (!newDeadlineDate) {
        setValidationError('Silakan pilih tanggal tenggat waktu baru.');
        return;
      }
      const combined = new Date(`${newDeadlineDate}T${newDeadlineTime || '23:59'}:00`);
      if (isNaN(combined.getTime())) {
        setValidationError('Format tenggat waktu tidak valid.');
        return;
      }
      if (combined.getTime() <= Date.now()) {
        setValidationError('Tenggat waktu baru harus berada di masa mendatang.');
        return;
      }
      finalDeadline = combined.toISOString();
    }

    let manualSlot: { startAt: string; endAt: string } | undefined = undefined;
    if (scheduleMode === 'manual') {
      if (!manualDate || !manualStartTime || !manualEndTime) {
        setValidationError('Silakan lengkapi tanggal dan jam mulai/selesai.');
        return;
      }
      const startObj = new Date(`${manualDate}T${manualStartTime}:00`);
      const endObj = new Date(`${manualDate}T${manualEndTime}:00`);
      if (isNaN(startObj.getTime()) || isNaN(endObj.getTime()) || endObj <= startObj) {
        setValidationError('Waktu selesai harus lebih besar dari waktu mulai.');
        return;
      }
      manualSlot = {
        startAt: startObj.toISOString(),
        endAt: endObj.toISOString(),
      };
    }

    setIsSubmitting(true);
    try {
      await onConfirmReschedule(task, finalDeadline, manualSlot);
      onClose();
    } catch (err: any) {
      setValidationError(err.message || 'Gagal menjadwalkan ulang kegiatan.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div className="w-full max-w-lg bg-white rounded-2xl p-6 shadow-xl border border-[#D9E3EF] space-y-5 max-h-[90vh] overflow-y-auto">
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-[#D9E3EF] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#EAF3FC] text-[#2457A7] flex items-center justify-center">
              <RotateCw size={17} />
            </div>
            <div>
              <h3 className="text-lg font-bold font-editorial text-[#172B42]">
                Jadwalkan Ulang Kegiatan Terlewat
              </h3>
              <p className="text-xs text-[#53657A]">
                Buat jadwal baru tanpa menghapus catatan historis kegiatan semula.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Original Task Summary Card */}
        <div className="p-3.5 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-[#53657A] uppercase tracking-wider">
              Kegiatan Semula
            </span>
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                priorityStyles[task.priority]?.badgeClass || ''
              }`}
            >
              {priorityStyles[task.priority]?.label || task.priority}
            </span>
          </div>

          <h4 className="font-bold text-sm text-[#172B42]">{task.title}</h4>
          {task.description && (
            <p className="text-xs text-[#53657A] line-clamp-2">{task.description}</p>
          )}

          <div className="flex items-center gap-4 text-[11px] text-[#53657A] pt-1">
            <span className="flex items-center gap-1 font-mono">
              <Clock size={12} className="text-[#2457A7]" />
              Durasi: <strong>{task.estimatedDurationMinutes} menit</strong>
            </span>
            {task.scheduledSessions && task.scheduledSessions.length > 0 && (
              <span className="font-mono">
                {task.scheduledSessions.length} sesi terbagi
              </span>
            )}
          </div>
        </div>

        {/* Deadline Status & Resolution */}
        {isOldDeadlinePassed && (
          <div className="p-3.5 bg-amber-50/80 border border-amber-200 rounded-xl space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="text-[#B86B12] shrink-0 mt-0.5" />
              <div className="text-xs text-[#172B42] space-y-1">
                <span className="font-bold block">Tenggat Waktu Lama Telah Berlalu</span>
                <p className="text-[#53657A] leading-relaxed">
                  Tenggat waktu semula (
                  {formatInTimezone(new Date(task.deadlineAt!), tz, {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  ) sudah lewat. Tentukan pilihan perlakuan tenggat:
                </p>
              </div>
            </div>

            <div className="space-y-1.5 pl-6 pt-1 text-xs">
              <label className="flex items-center gap-2 cursor-pointer text-[#172B42]">
                <input
                  type="radio"
                  name="deadlineChoice"
                  checked={deadlineMode === 'none'}
                  onChange={() => setDeadlineMode('none')}
                  className="text-[#2457A7]"
                />
                <span>Lanjutkan tanpa tenggat waktu (jadwalkan di slot luang terdekat)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-[#172B42]">
                <input
                  type="radio"
                  name="deadlineChoice"
                  checked={deadlineMode === 'keep_or_new'}
                  onChange={() => setDeadlineMode('keep_or_new')}
                  className="text-[#2457A7]"
                />
                <span>Tetapkan tenggat waktu baru di masa depan</span>
              </label>
            </div>

            {deadlineMode === 'keep_or_new' && (
              <div className="grid grid-cols-2 gap-2 pt-2 pl-6">
                <div>
                  <label className="block text-[11px] font-semibold text-[#53657A] mb-1">
                    Tanggal Tenggat Baru
                  </label>
                  <input
                    type="date"
                    value={newDeadlineDate}
                    onChange={(e) => setNewDeadlineDate(e.target.value)}
                    className="w-full text-xs p-2 rounded-lg border border-[#D9E3EF] bg-white text-[#172B42]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-[#53657A] mb-1">
                    Jam Tenggat
                  </label>
                  <input
                    type="time"
                    value={newDeadlineTime}
                    onChange={(e) => setNewDeadlineTime(e.target.value)}
                    className="w-full text-xs p-2 rounded-lg border border-[#D9E3EF] bg-white text-[#172B42]"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Scheduling Mode Selection */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-[#172B42]">
            Metode Penjadwalan Baru
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setScheduleMode('auto')}
              className={`p-3 rounded-xl border text-left transition-all ${
                scheduleMode === 'auto'
                  ? 'border-[#2457A7] bg-[#EAF3FC]/50 text-[#172B42] ring-1 ring-[#2457A7]'
                  : 'border-[#D9E3EF] bg-white hover:bg-slate-50 text-[#53657A]'
              }`}
            >
              <div className="flex items-center gap-1.5 font-bold text-xs text-[#2457A7] mb-1">
                <Sparkles size={14} /> Otomatis (Rekomendasi)
              </div>
              <p className="text-[11px] leading-tight text-[#53657A]">
                Scheduler cerdas mencari slot bebas konflik terdekat di jam kerja Anda.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setScheduleMode('manual')}
              className={`p-3 rounded-xl border text-left transition-all ${
                scheduleMode === 'manual'
                  ? 'border-[#2457A7] bg-[#EAF3FC]/50 text-[#172B42] ring-1 ring-[#2457A7]'
                  : 'border-[#D9E3EF] bg-white hover:bg-slate-50 text-[#53657A]'
              }`}
            >
              <div className="flex items-center gap-1.5 font-bold text-xs text-[#172B42] mb-1">
                <Calendar size={14} className="text-[#53657A]" /> Waktu Spesifik
              </div>
              <p className="text-[11px] leading-tight text-[#53657A]">
                Tentukan langsung tanggal, jam mulai, dan jam selesai secara manual.
              </p>
            </button>
          </div>
        </div>

        {/* Manual Time Inputs */}
        {scheduleMode === 'manual' && (
          <div className="p-3 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-2.5">
            <div>
              <label className="block text-[11px] font-semibold text-[#53657A] mb-1">
                Tanggal Jadwal Baru
              </label>
              <input
                type="date"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
                className="w-full text-xs p-2 rounded-lg border border-[#D9E3EF] bg-white text-[#172B42]"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold text-[#53657A] mb-1">
                  Jam Mulai
                </label>
                <input
                  type="time"
                  value={manualStartTime}
                  onChange={(e) => setManualStartTime(e.target.value)}
                  className="w-full text-xs p-2 rounded-lg border border-[#D9E3EF] bg-white text-[#172B42]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#53657A] mb-1">
                  Jam Selesai
                </label>
                <input
                  type="time"
                  value={manualEndTime}
                  onChange={(e) => setManualEndTime(e.target.value)}
                  className="w-full text-xs p-2 rounded-lg border border-[#D9E3EF] bg-white text-[#172B42]"
                />
              </div>
            </div>
          </div>
        )}

        {/* Validation Error Message */}
        {validationError && (
          <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-[#C43D4B] flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{validationError}</span>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#D9E3EF]">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-xs font-medium text-[#53657A] hover:bg-slate-100 rounded-xl transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl shadow-xs transition-colors disabled:opacity-50"
          >
            {isSubmitting ? (
              <span>Menjadwalkan...</span>
            ) : (
              <>
                <RotateCw size={13} />
                <span>Konfirmasi & Jadwalkan Ulang</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
