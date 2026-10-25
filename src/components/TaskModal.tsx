import React, { useState } from 'react';
import { X, Calendar, Clock, AlertCircle, Layers, Sparkles, Check } from 'lucide-react';
import { Task, Priority } from '../types';
import {
  normalizeTimezone,
  createIsoFromLocalZoned,
  getZonedDateTimeParts,
  formatDateOnlyInTimezone,
} from '../lib/timezone';

interface TaskModalProps {
  isOpen: boolean;
  taskToEdit?: Task | null;
  onClose: () => void;
  onSave: (taskData: Omit<Task, 'id' | 'createdAt' | 'status' | 'scheduledSessions'>) => void;
  userId?: string | null;
  userTimezone?: string;
}

function getInitialFormState(taskToEdit: Task | null | undefined, tz: string) {
  const now = new Date();
  const nowParts = getZonedDateTimeParts(now, tz);
  const todayStr = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`;

  if (taskToEdit) {
    const isFixed =
      taskToEdit.timeConstraintType === 'fixed_event' &&
      Boolean(taskToEdit.requestedStartAt) &&
      Boolean(taskToEdit.requestedEndAt);

    let mStartDate = todayStr;
    let mStartTime = '22:00';
    let mEndDate = todayStr;
    let mEndTime = '23:00';
    let dLine = '';
    const hasDeadline = Boolean(taskToEdit.deadlineAt && taskToEdit.deadlineAt.trim().length > 0);

    if (isFixed && taskToEdit.requestedStartAt && taskToEdit.requestedEndAt) {
      const sParts = getZonedDateTimeParts(new Date(taskToEdit.requestedStartAt), tz);
      const eParts = getZonedDateTimeParts(new Date(taskToEdit.requestedEndAt), tz);
      mStartDate = `${sParts.year}-${String(sParts.month).padStart(2, '0')}-${String(sParts.day).padStart(2, '0')}`;
      mStartTime = `${String(sParts.hour).padStart(2, '0')}:${String(sParts.minute).padStart(2, '0')}`;
      mEndDate = `${eParts.year}-${String(eParts.month).padStart(2, '0')}-${String(eParts.day).padStart(2, '0')}`;
      mEndTime = `${String(eParts.hour).padStart(2, '0')}:${String(eParts.minute).padStart(2, '0')}`;
    }

    if (hasDeadline && taskToEdit.deadlineAt) {
      const dParts = getZonedDateTimeParts(new Date(taskToEdit.deadlineAt), tz);
      dLine = `${dParts.year}-${String(dParts.month).padStart(2, '0')}-${String(dParts.day).padStart(2, '0')}T${String(dParts.hour).padStart(2, '0')}:${String(dParts.minute).padStart(2, '0')}`;
    }

    return {
      scheduleMode: isFixed ? ('manual' as const) : ('ai' as const),
      title: taskToEdit.title || '',
      description: taskToEdit.description || '',
      priority: taskToEdit.priority || ('MEDIUM' as Priority),
      manualStartDate: mStartDate,
      manualStartTime: mStartTime,
      manualEndDate: mEndDate,
      manualEndTime: mEndTime,
      isAllDay: Boolean(taskToEdit.isAllDay),
      estimatedDurationMinutes: taskToEdit.estimatedDurationMinutes || 60,
      hasDeadline,
      deadlineAt: dLine,
      preferredTimeOfDay: taskToEdit.preferredTimeOfDay || ('ANY' as const),
      allowSplit: Boolean(taskToEdit.allowSplit),
      minimumSessionMinutes: taskToEdit.minimumSessionMinutes || 30,
    };
  }

  // New task default
  return {
    scheduleMode: 'manual' as const,
    title: '',
    description: '',
    priority: 'MEDIUM' as Priority,
    manualStartDate: todayStr,
    manualStartTime: '19:00',
    manualEndDate: todayStr,
    manualEndTime: '21:00',
    isAllDay: false,
    estimatedDurationMinutes: 60,
    hasDeadline: false,
    deadlineAt: '',
    preferredTimeOfDay: 'ANY' as const,
    allowSplit: false,
    minimumSessionMinutes: 30,
  };
}

const TaskModalInner: React.FC<TaskModalProps> = ({
  taskToEdit,
  onClose,
  onSave,
  userId,
  userTimezone = 'Asia/Jakarta',
}) => {
  const tz = normalizeTimezone(userTimezone);
  const initial = getInitialFormState(taskToEdit, tz);

  // Tabs: 'manual' vs 'ai'
  const [scheduleMode, setScheduleMode] = useState<'manual' | 'ai'>(initial.scheduleMode);

  // Shared fields
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [priority, setPriority] = useState<Priority>(initial.priority);

  // Manual mode fields
  const [manualStartDate, setManualStartDate] = useState(initial.manualStartDate);
  const [manualStartTime, setManualStartTime] = useState(initial.manualStartTime);
  const [manualEndDate, setManualEndDate] = useState(initial.manualEndDate);
  const [manualEndTime, setManualEndTime] = useState(initial.manualEndTime);
  const [isAllDay, setIsAllDay] = useState(initial.isAllDay);

  // AI mode fields
  const [estimatedDurationMinutes, setEstimatedDurationMinutes] = useState(initial.estimatedDurationMinutes);
  const [hasDeadline, setHasDeadline] = useState(initial.hasDeadline);
  const [deadlineAt, setDeadlineAt] = useState(initial.deadlineAt);
  const [preferredTimeOfDay, setPreferredTimeOfDay] = useState<'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY'>(initial.preferredTimeOfDay);
  const [allowSplit, setAllowSplit] = useState(initial.allowSplit);
  const [minimumSessionMinutes, setMinimumSessionMinutes] = useState(initial.minimumSessionMinutes);

  const [errorMsg, setErrorMsg] = useState('');

  // Calculate real timestamps and duration for manual mode
  const getManualTimeMeta = () => {
    if (!manualStartDate || !manualEndDate) {
      return { durationMinutes: 0, isMultiDay: false, startIso: '', endIso: '', error: 'Tanggal belum lengkap' };
    }

    if (isAllDay) {
      const [sy, sm, sd] = manualStartDate.split('-').map((v) => parseInt(v, 10));
      const [ey, em, ed] = manualEndDate.split('-').map((v) => parseInt(v, 10));
      const startIso = createIsoFromLocalZoned(manualStartDate, '00:00', tz);
      // All day ends at 24:00 (next day 00:00) of manualEndDate
      const nextEndDate = new Date(Date.UTC(ey, em - 1, ed + 1));
      const nY = nextEndDate.getUTCFullYear();
      const nM = String(nextEndDate.getUTCMonth() + 1).padStart(2, '0');
      const nD = String(nextEndDate.getUTCDate()).padStart(2, '0');
      const endIso = createIsoFromLocalZoned(`${nY}-${nM}-${nD}`, '00:00', tz);

      const sMs = new Date(startIso).getTime();
      const eMs = new Date(endIso).getTime();

      if (eMs <= sMs) {
        return {
          durationMinutes: 0,
          isMultiDay: false,
          startIso: '',
          endIso: '',
          error: 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.',
        };
      }

      const durationMinutes = Math.round((eMs - sMs) / 60000);
      const days = Math.round(durationMinutes / 1440);
      return {
        durationMinutes,
        isMultiDay: days > 1,
        startIso,
        endIso,
        error: null,
        formattedInfo: `Sepanjang hari (${days} hari)`,
      };
    }

    if (!manualStartTime || !manualEndTime) {
      return { durationMinutes: 0, isMultiDay: false, startIso: '', endIso: '', error: 'Waktu belum lengkap' };
    }

    const startIso = createIsoFromLocalZoned(manualStartDate, manualStartTime, tz);
    const endIso = createIsoFromLocalZoned(manualEndDate, manualEndTime, tz);

    const sMs = new Date(startIso).getTime();
    const eMs = new Date(endIso).getTime();

    if (isNaN(sMs) || isNaN(eMs)) {
      return { durationMinutes: 0, isMultiDay: false, startIso: '', endIso: '', error: 'Format tanggal atau jam tidak valid' };
    }

    if (eMs <= sMs) {
      return {
        durationMinutes: 0,
        isMultiDay: false,
        startIso: '',
        endIso: '',
        error: 'Tanggal dan waktu selesai harus lebih akhir dari waktu mulai. Tolak rentang waktu nol atau negatif.',
      };
    }

    const durationMinutes = Math.round((eMs - sMs) / 60000);
    const isMultiDay = manualEndDate !== manualStartDate;
    const hours = (durationMinutes / 60).toFixed(1);

    return {
      durationMinutes,
      isMultiDay,
      startIso,
      endIso,
      error: null,
      formattedInfo: isMultiDay
        ? `${durationMinutes} menit (${hours} jam) — Lintas tengah malam`
        : `${durationMinutes} menit (${hours} jam)`,
    };
  };

  const manualMeta = getManualTimeMeta();

  const handleStartDateChange = (newStartDate: string) => {
    setManualStartDate(newStartDate);
    // Auto-advance end date if end date was before new start date
    if (manualEndDate < newStartDate) {
      setManualEndDate(newStartDate);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!title.trim()) {
      setErrorMsg('Nama kegiatan wajib diisi.');
      return;
    }

    if (scheduleMode === 'manual') {
      if (manualMeta.error) {
        setErrorMsg(manualMeta.error);
        return;
      }
      if (manualMeta.durationMinutes <= 0) {
        setErrorMsg('Rentang waktu kegiatan tidak valid.');
        return;
      }

      onSave({
        userId: userId || 'user-default',
        title: title.trim(),
        description: description.trim() || '',
        estimatedDurationMinutes: manualMeta.durationMinutes,
        deadlineAt: null, // manual events have fixed exact schedules, not a flexible deadline
        priority,
        allowSplit: false, // fixed manual events cannot be split
        preferredTimeOfDay: 'ANY',
        timeConstraintType: 'fixed_event',
        requestedStartAt: manualMeta.startIso,
        requestedEndAt: manualMeta.endIso,
        isAllDay,
        timezone: tz,
      });

      onClose();
      return;
    }

    // AI Mode validation
    if (estimatedDurationMinutes <= 0) {
      setErrorMsg('Estimasi durasi kegiatan harus lebih dari 0 menit.');
      return;
    }

    let deadlineIso: string | null = null;
    if (hasDeadline) {
      if (!deadlineAt) {
        setErrorMsg('Tenggat waktu diaktifkan. Silakan tentukan tanggal dan jam tenggat, atau nonaktifkan tenggat waktu.');
        return;
      }
      const parsed = new Date(deadlineAt);
      if (isNaN(parsed.getTime())) {
        setErrorMsg('Format tanggal tenggat waktu tidak valid.');
        return;
      }
      deadlineIso = parsed.toISOString();
    }

    if (allowSplit && minimumSessionMinutes > estimatedDurationMinutes) {
      setErrorMsg('Durasi minimal per sesi tidak boleh lebih besar dari total durasi kegiatan.');
      return;
    }

    onSave({
      userId: userId || 'user-default',
      title: title.trim(),
      description: description.trim() || '',
      estimatedDurationMinutes: Number(estimatedDurationMinutes),
      deadlineAt: deadlineIso, // strictly null when hasDeadline is false
      priority,
      allowSplit,
      minimumSessionMinutes: allowSplit ? Number(minimumSessionMinutes) : undefined,
      preferredTimeOfDay,
      timeConstraintType: preferredTimeOfDay !== 'ANY' ? 'preferred_window' : 'deadline_only',
      timezone: tz,
    });

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div 
        className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-[#D9E3EF] overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* Modal Header */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-[#D9E3EF]">
          <h2 className="text-base sm:text-lg font-bold text-[#172B42] font-editorial">
            {taskToEdit && taskToEdit.id ? 'Ubah Rincian Kegiatan' : 'Tambah Kegiatan Baru'}
          </h2>
          <button
            onClick={onClose}
            className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Mode Selector Tabs: Manual vs Jadwalkan dengan AI */}
        <div className="px-6 pt-4 pb-2">
          <div className="grid grid-cols-2 p-1 bg-[#F1F5F9] rounded-xl border border-[#D9E3EF]">
            <button
              type="button"
              onClick={() => setScheduleMode('manual')}
              className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                scheduleMode === 'manual'
                  ? 'bg-white text-[#2457A7] shadow-xs'
                  : 'text-[#53657A] hover:text-[#172B42]'
              }`}
            >
              <Clock size={14} />
              <span>Manual</span>
            </button>
            <button
              type="button"
              onClick={() => setScheduleMode('ai')}
              className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                scheduleMode === 'ai'
                  ? 'bg-white text-[#2457A7] shadow-xs'
                  : 'text-[#53657A] hover:text-[#172B42]'
              }`}
            >
              <Sparkles size={14} />
              <span>Jadwalkan dengan AI</span>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 pt-2 space-y-4 max-h-[75vh] overflow-y-auto">
          {errorMsg && (
            <div className="p-3 bg-red-50 border border-[#C43D4B]/30 rounded-xl flex items-center gap-2 text-xs text-[#C43D4B]">
              <AlertCircle size={16} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-[#172B42] mb-1">
              Nama Kegiatan <span className="text-[#C43D4B]">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={scheduleMode === 'manual' ? 'Contoh: Rapat Kerja atau Tidur Malam' : 'Contoh: Menyelesaikan revisi materi presentasi'}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#172B42] mb-1">
              Deskripsi / Catatan (Opsional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tambahkan detail, instruksi, atau tautan..."
              rows={2}
              className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7] resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#172B42] mb-1">
              Prioritas
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
            >
              <option value="LOW">Rendah</option>
              <option value="MEDIUM">Sedang</option>
              <option value="HIGH">Tinggi</option>
              <option value="URGENT">Mendesak</option>
            </select>
          </div>

          {/* MODE MANUAL */}
          {scheduleMode === 'manual' && (
            <div className="p-4 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#2457A7]">
                  <Clock size={14} />
                  <span>Jadwal Tetap (Ditentukan Sendiri)</span>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-[#172B42] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isAllDay}
                    onChange={(e) => setIsAllDay(e.target.checked)}
                    className="w-4 h-4 text-[#2457A7] rounded-sm focus:ring-[#2457A7]"
                  />
                  <span>Sepanjang Hari</span>
                </label>
              </div>

              <p className="text-[11px] text-[#53657A]">
                Waktu yang ditentukan di sini diperlakukan sebagai jadwal tetap dan tidak akan dipindahkan oleh perencana AI.
              </p>

              {/* Start Date & Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Tanggal Mulai <span className="text-[#C43D4B]">*</span>
                  </label>
                  <input
                    type="date"
                    value={manualStartDate}
                    onChange={(e) => handleStartDateChange(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                  />
                </div>

                {!isAllDay && (
                  <div>
                    <label className="block text-xs font-semibold text-[#172B42] mb-1">
                      Waktu Mulai <span className="text-[#C43D4B]">*</span>
                    </label>
                    <input
                      type="time"
                      value={manualStartTime}
                      onChange={(e) => setManualStartTime(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                    />
                  </div>
                )}
              </div>

              {/* End Date & Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Tanggal Selesai <span className="text-[#C43D4B]">*</span>
                  </label>
                  <input
                    type="date"
                    value={manualEndDate}
                    onChange={(e) => setManualEndDate(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                  />
                </div>

                {!isAllDay && (
                  <div>
                    <label className="block text-xs font-semibold text-[#172B42] mb-1">
                      Waktu Selesai <span className="text-[#C43D4B]">*</span>
                    </label>
                    <input
                      type="time"
                      value={manualEndTime}
                      onChange={(e) => setManualEndTime(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                    />
                  </div>
                )}
              </div>

              {/* Duration & Cross-Midnight Banner */}
              <div className="pt-2 border-t border-[#D9E3EF] flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                <span className="text-[#53657A]">Durasi Terhitung:</span>
                <span className={`font-mono font-bold ${manualMeta.durationMinutes > 0 ? 'text-[#2457A7]' : 'text-[#C43D4B]'}`}>
                  {manualMeta.durationMinutes > 0 ? manualMeta.formattedInfo : (manualMeta.error || 'Waktu tidak valid')}
                </span>
              </div>
            </div>
          )}

          {/* MODE JADWALKAN DENGAN AI */}
          {scheduleMode === 'ai' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Estimasi Durasi (Menit) <span className="text-[#C43D4B]">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      min={15}
                      max={480}
                      step={15}
                      value={estimatedDurationMinutes}
                      onChange={(e) => setEstimatedDurationMinutes(Number(e.target.value))}
                      className="w-full pl-3.5 pr-8 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                    />
                    <span className="absolute right-3 top-2.5 text-xs text-[#53657A]">mnt</span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Preferensi Waktu
                  </label>
                  <select
                    value={preferredTimeOfDay}
                    onChange={(e) => setPreferredTimeOfDay(e.target.value as any)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                  >
                    <option value="ANY">Kapan saja dalam jam kerja</option>
                    <option value="MORNING">Pagi hari (08:00 - 12:00)</option>
                    <option value="AFTERNOON">Siang / Sore (13:00 - 18:00)</option>
                    <option value="EVENING">Malam hari (19:00 - 23:00)</option>
                  </select>
                </div>
              </div>

              {/* STRICTLY OPTIONAL DEADLINE */}
              <div className="p-3.5 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-2.5">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-semibold text-[#172B42] flex items-center gap-1.5">
                    <Calendar size={14} className="text-[#2457A7]" />
                    Tetapkan Batas Tenggat Waktu (Opsional)
                  </span>
                  <input
                    type="checkbox"
                    checked={hasDeadline}
                    onChange={(e) => setHasDeadline(e.target.checked)}
                    className="w-4 h-4 text-[#2457A7] rounded-sm focus:ring-[#2457A7]"
                  />
                </label>

                {hasDeadline ? (
                  <div className="pt-2 border-t border-[#D9E3EF]/70 space-y-1">
                    <label className="block text-[11px] font-medium text-[#53657A]">
                      Pilih Tanggal & Jam Batas Akhir Selesai:
                    </label>
                    <input
                      type="datetime-local"
                      value={deadlineAt}
                      onChange={(e) => setDeadlineAt(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-xs bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                    />
                    <span className="text-[11px] text-[#53657A] block">
                      Scheduler akan memastikan seluruh kegiatan selesai sebelum atau pada batas tenggat ini.
                    </span>
                  </div>
                ) : (
                  <p className="text-[11px] text-[#53657A] pt-1">
                    Tenggat dinonaktifkan. AI akan mencari slot waktu luang terbaik sesuai preferensi dan jam kerja Anda tanpa batasan tanggal kaku.
                  </p>
                )}
              </div>

              {/* Split Session Preferences */}
              <div className="p-3.5 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-2.5">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-semibold text-[#172B42] flex items-center gap-1.5">
                    <Layers size={14} className="text-[#2457A7]" />
                    Boleh dipecah menjadi beberapa sesi (Split)
                  </span>
                  <input
                    type="checkbox"
                    checked={allowSplit}
                    onChange={(e) => setAllowSplit(e.target.checked)}
                    className="w-4 h-4 text-[#2457A7] rounded-sm focus:ring-[#2457A7]"
                  />
                </label>

                {allowSplit && (
                  <div className="pt-2 border-t border-[#D9E3EF]/70 flex items-center justify-between">
                    <span className="text-xs text-[#53657A]">Durasi sesi minimum:</span>
                    <select
                      value={minimumSessionMinutes}
                      onChange={(e) => setMinimumSessionMinutes(Number(e.target.value))}
                      className="px-2.5 py-1 rounded-lg border border-[#D9E3EF] text-xs bg-white text-[#172B42]"
                    >
                      <option value={15}>15 menit</option>
                      <option value={30}>30 menit</option>
                      <option value={45}>45 menit</option>
                      <option value={60}>60 menit</option>
                    </select>
                  </div>
                )}
                <p className="text-[11px] text-[#53657A]">
                  Bila waktu luang tidak mencukupi untuk satu blok penuh, EVEN akan membagi kegiatan menjadi beberapa sesi realistis.
                </p>
              </div>
            </div>
          )}

          {/* Form Actions */}
          <div className="pt-3 border-t border-[#D9E3EF] flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42] rounded-xl"
            >
              Batal
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] rounded-xl transition-colors shadow-xs"
            >
              {taskToEdit && taskToEdit.id ? 'Simpan Perubahan' : scheduleMode === 'manual' ? 'Simpan Jadwal Kegiatan' : 'Simpan Kegiatan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export const TaskModal: React.FC<TaskModalProps> = (props) => {
  if (!props.isOpen) return null;
  return <TaskModalInner key={props.taskToEdit?.id || 'new-task'} {...props} />;
};
