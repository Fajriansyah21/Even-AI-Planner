import React, { useState } from 'react';
import { X, Calendar, Clock, AlertCircle, Layers, Sparkles, UserCheck } from 'lucide-react';
import { Task, Priority } from '../types';
import {
  normalizeTimezone,
  createIsoFromLocalZoned,
  getZonedDateTimeParts,
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
  const nowParts = getZonedDateTimeParts(new Date(), tz);
  const todayStr = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`;

  if (taskToEdit) {
    const isFixed = taskToEdit.timeConstraintType === 'fixed_event' && Boolean(taskToEdit.requestedStartAt) && Boolean(taskToEdit.requestedEndAt);
    let mDate = todayStr;
    let mStart = '19:00';
    let mEnd = '22:00';
    let dLine = '';

    if (isFixed && taskToEdit.requestedStartAt && taskToEdit.requestedEndAt) {
      const sParts = getZonedDateTimeParts(new Date(taskToEdit.requestedStartAt), tz);
      const eParts = getZonedDateTimeParts(new Date(taskToEdit.requestedEndAt), tz);
      mDate = `${sParts.year}-${String(sParts.month).padStart(2, '0')}-${String(sParts.day).padStart(2, '0')}`;
      mStart = `${String(sParts.hour).padStart(2, '0')}:${String(sParts.minute).padStart(2, '0')}`;
      mEnd = `${String(eParts.hour).padStart(2, '0')}:${String(eParts.minute).padStart(2, '0')}`;
    } else if (taskToEdit.deadlineAt) {
      const dParts = getZonedDateTimeParts(new Date(taskToEdit.deadlineAt), tz);
      dLine = `${dParts.year}-${String(dParts.month).padStart(2, '0')}-${String(dParts.day).padStart(2, '0')}T${String(dParts.hour).padStart(2, '0')}:${String(dParts.minute).padStart(2, '0')}`;
    }

    return {
      scheduleMode: isFixed ? ('manual' as const) : ('ai' as const),
      title: taskToEdit.title || '',
      description: taskToEdit.description || '',
      priority: taskToEdit.priority || ('MEDIUM' as Priority),
      manualDate: mDate,
      manualStartTime: mStart,
      manualEndTime: mEnd,
      estimatedDurationMinutes: taskToEdit.estimatedDurationMinutes || 60,
      deadlineAt: dLine,
      preferredTimeOfDay: taskToEdit.preferredTimeOfDay || ('ANY' as const),
      allowSplit: Boolean(taskToEdit.allowSplit),
      minimumSessionMinutes: taskToEdit.minimumSessionMinutes || 30,
    };
  }

  const tomorrowParts = getZonedDateTimeParts(new Date(Date.now() + 86400000), tz);
  const defaultDeadline = `${tomorrowParts.year}-${String(tomorrowParts.month).padStart(2, '0')}-${String(tomorrowParts.day).padStart(2, '0')}T17:00`;

  return {
    scheduleMode: 'ai' as const,
    title: '',
    description: '',
    priority: 'MEDIUM' as Priority,
    manualDate: todayStr,
    manualStartTime: '19:00',
    manualEndTime: '22:00',
    estimatedDurationMinutes: 60,
    deadlineAt: defaultDeadline,
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

  // Tab mode: 'manual' (Tentukan waktu sendiri) vs 'ai' (Bantu pilih waktu dengan AI)
  const [scheduleMode, setScheduleMode] = useState<'manual' | 'ai'>(initial.scheduleMode);

  // Shared fields
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [priority, setPriority] = useState<Priority>(initial.priority);

  // Manual mode fields
  const [manualDate, setManualDate] = useState(initial.manualDate);
  const [manualStartTime, setManualStartTime] = useState(initial.manualStartTime);
  const [manualEndTime, setManualEndTime] = useState(initial.manualEndTime);

  // AI mode fields
  const [estimatedDurationMinutes, setEstimatedDurationMinutes] = useState(initial.estimatedDurationMinutes);
  const [deadlineAt, setDeadlineAt] = useState(initial.deadlineAt);
  const [preferredTimeOfDay, setPreferredTimeOfDay] = useState<'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY'>(initial.preferredTimeOfDay);
  const [allowSplit, setAllowSplit] = useState(initial.allowSplit);
  const [minimumSessionMinutes, setMinimumSessionMinutes] = useState(initial.minimumSessionMinutes);

  const [errorMsg, setErrorMsg] = useState('');

  // Auto-calculated manual timestamps & duration
  const getManualTimeMeta = () => {
    if (!manualDate || !manualStartTime || !manualEndTime) {
      return { durationMinutes: 0, isNextDay: false, startIso: '', endIso: '', error: null, formattedEnd: '' };
    }
    const [sH, sM] = manualStartTime.split(':').map((x) => parseInt(x, 10));
    const [eH, eM] = manualEndTime.split(':').map((x) => parseInt(x, 10));
    const startM = sH * 60 + sM;
    const endM = eH * 60 + eM;

    if (startM === endM) {
      return {
        durationMinutes: 0,
        isNextDay: false,
        startIso: '',
        endIso: '',
        error: 'Jam mulai dan jam selesai tidak boleh sama. Tentukan durasi kegiatan yang valid.',
        formattedEnd: '',
      };
    }

    const [y, m, d] = manualDate.split('-').map((v) => parseInt(v, 10));
    const startIso = createIsoFromLocalZoned(y, m, d, sH, sM, 0, tz);

    let endIso = '';
    let isNextDay = false;
    let endDayStr = '';

    if (endM < startM) {
      // Cross-midnight: ends on the next calendar day
      isNextDay = true;
      const nextDate = new Date(Date.UTC(y, m - 1, d + 1));
      const nY = nextDate.getUTCFullYear();
      const nM = nextDate.getUTCMonth() + 1;
      const nD = nextDate.getUTCDate();
      endIso = createIsoFromLocalZoned(nY, nM, nD, eH, eM, 0, tz);
      endDayStr = `${nD}/${nM}/${nY}`;
    } else {
      endIso = createIsoFromLocalZoned(y, m, d, eH, eM, 0, tz);
      endDayStr = `${d}/${m}/${y}`;
    }

    const durationMinutes = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);

    return {
      durationMinutes,
      isNextDay,
      startIso,
      endIso,
      error: null,
      formattedEnd: `${endDayStr} pukul ${manualEndTime}`,
    };
  };

  const manualMeta = getManualTimeMeta();
  const manualDurationMinutes = manualMeta.durationMinutes;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!title.trim()) {
      setErrorMsg('Judul kegiatan wajib diisi.');
      return;
    }

    if (scheduleMode === 'manual') {
      if (!manualDate) {
        setErrorMsg('Tanggal pelaksanaan wajib ditentukan.');
        return;
      }
      if (!manualStartTime || !manualEndTime) {
        setErrorMsg('Jam mulai dan jam selesai wajib ditentukan.');
        return;
      }
      if (manualMeta.error) {
        setErrorMsg(manualMeta.error);
        return;
      }
      if (manualDurationMinutes <= 0) {
        setErrorMsg('Rentang waktu tidak valid. Tentukan durasi kegiatan yang valid.');
        return;
      }

      const [sH] = manualStartTime.split(':').map((v) => parseInt(v, 10));

      onSave({
        userId: userId || 'user-default',
        title: title.trim(),
        description: description.trim() || '',
        estimatedDurationMinutes: manualDurationMinutes,
        deadlineAt: manualMeta.endIso, // in manual mode, deadline equals end time
        priority,
        allowSplit: false, // fixed manual events cannot be split
        preferredTimeOfDay: sH >= 18 ? 'EVENING' : sH >= 12 ? 'AFTERNOON' : 'MORNING',
        timeConstraintType: 'fixed_event',
        requestedStartAt: manualMeta.startIso,
        requestedEndAt: manualMeta.endIso,
        timezone: tz,
      });

      onClose();
      return;
    }

    // AI Mode validation
    if (estimatedDurationMinutes <= 0) {
      setErrorMsg('Durasi estimasi harus lebih dari 0 menit.');
      return;
    }

    let deadlineIso = '';
    if (deadlineAt) {
      const dParts = deadlineAt.split('T');
      if (dParts.length === 2) {
        const [y, m, d] = dParts[0].split('-').map((v) => parseInt(v, 10));
        const [h, min] = dParts[1].split(':').map((v) => parseInt(v, 10));
        deadlineIso = createIsoFromLocalZoned(y, m, d, h, min, 0, tz);
      } else {
        const parsedD = new Date(deadlineAt);
        if (isNaN(parsedD.getTime())) {
          setErrorMsg('Format tanggal tenggat tidak valid.');
          return;
        }
        deadlineIso = parsedD.toISOString();
      }
    } else {
      // Optional deadline: 7 days default
      const defaultD = new Date(Date.now() + 7 * 86400000);
      const defParts = getZonedDateTimeParts(defaultD, tz);
      deadlineIso = createIsoFromLocalZoned(defParts.year, defParts.month, defParts.day, 23, 59, 59, tz);
    }

    if (allowSplit && minimumSessionMinutes > estimatedDurationMinutes) {
      setErrorMsg('Durasi minimal per sesi tidak boleh lebih besar dari total durasi tugas.');
      return;
    }

    onSave({
      userId: userId || 'user-default',
      title: title.trim(),
      description: description.trim() || '',
      estimatedDurationMinutes: Number(estimatedDurationMinutes),
      deadlineAt: deadlineIso,
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
        <div className="px-6 py-4 flex items-center justify-between border-b border-[#D9E3EF]">
          <h2 className="text-base font-bold text-[#172B42]">
            {taskToEdit && taskToEdit.id ? 'Ubah Rincian Tugas' : 'Tambah Tugas Baru'}
          </h2>
          <button
            onClick={onClose}
            className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Mode Selector Tabs */}
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
              <span>Tentukan Waktu Sendiri (Manual)</span>
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
              <span>Bantu Pilih Waktu dengan AI</span>
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
              Judul Kegiatan <span className="text-[#C43D4B]">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={scheduleMode === 'manual' ? 'Contoh: Kelas React Lanjutan' : 'Contoh: Menyiapkan laporan sprint mingguan'}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#172B42] mb-1">
              Catatan / Deskripsi (Opsional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Catatan tambahan, link referensi, atau instruksi..."
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

          {/* MANUAL MODE FIELDS */}
          {scheduleMode === 'manual' && (
            <div className="p-4 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#2457A7]">
                <Clock size={14} />
                <span>Penjadwalan Waktu Tetap (Eksplisit)</span>
              </div>
              <p className="text-[11px] text-[#53657A]">
                Waktu yang Anda tentukan di sini akan dikunci tepat pada kalender tanpa digeser oleh perencana AI.
              </p>

              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Tanggal Pelaksanaan <span className="text-[#C43D4B]">*</span>
                </label>
                <input
                  type="date"
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Jam Mulai <span className="text-[#C43D4B]">*</span>
                  </label>
                  <input
                    type="time"
                    value={manualStartTime}
                    onChange={(e) => setManualStartTime(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Jam Selesai <span className="text-[#C43D4B]">*</span>
                  </label>
                  <input
                    type="time"
                    value={manualEndTime}
                    onChange={(e) => setManualEndTime(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                  />
                </div>
              </div>

              {manualMeta.isNextDay && (
                <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center gap-2 text-xs text-indigo-800 animate-in fade-in">
                  <Clock size={14} className="text-indigo-600 shrink-0" />
                  <span>
                    Kegiatan berlanjut lintas tengah malam dan berakhir pada <strong>{manualMeta.formattedEnd}</strong> (+1 hari).
                  </span>
                </div>
              )}

              <div className="pt-2 border-t border-[#D9E3EF] flex items-center justify-between text-xs">
                <span className="text-[#53657A]">Durasi Terhitung Otomatis:</span>
                <span className={`font-mono font-bold ${manualDurationMinutes > 0 ? 'text-[#2457A7]' : 'text-[#C43D4B]'}`}>
                  {manualDurationMinutes > 0 ? `${manualDurationMinutes} menit (${(manualDurationMinutes / 60).toFixed(1)} jam)` : (manualMeta.error || 'Waktu tidak valid')}
                </span>
              </div>
            </div>
          )}

          {/* AI MODE FIELDS */}
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
                    Preferensi Waktu Hari
                  </label>
                  <select
                    value={preferredTimeOfDay}
                    onChange={(e) => setPreferredTimeOfDay(e.target.value as any)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                  >
                    <option value="ANY">Kapan saja dalam jam kerja</option>
                    <option value="MORNING">Pagi hari (08:00 - 12:00)</option>
                    <option value="AFTERNOON">Sore hari (13:00 - 18:00)</option>
                    <option value="EVENING">Malam hari (19:00 - 23:00)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Tenggat Waktu (Deadline) <span className="text-[#53657A] font-normal">(Opsional)</span>
                </label>
                <input
                  type="datetime-local"
                  value={deadlineAt}
                  onChange={(e) => setDeadlineAt(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                />
                <span className="text-[11px] text-[#53657A] mt-1 block">
                  Bila dikosongkan, AI akan mencari slot luang terdekat dalam 7 hari ke depan.
                </span>
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
                  Jika waktu luang sebelum tenggat tidak mencukupi untuk satu blok penuh, EVEN akan membagi tugas menjadi beberapa sesi aman.
                </p>
              </div>
            </div>
          )}

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
              {taskToEdit && taskToEdit.id ? 'Simpan Perubahan' : scheduleMode === 'manual' ? 'Simpan Jadwal Waktu Tetap' : 'Buat Tugas AI'}
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

