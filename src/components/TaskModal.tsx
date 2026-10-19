import React, { useState, useEffect } from 'react';
import { X, Calendar, Clock, AlertCircle, Layers } from 'lucide-react';
import { Task, Priority } from '../types';

interface TaskModalProps {
  isOpen: boolean;
  taskToEdit?: Task | null;
  onClose: () => void;
  onSave: (taskData: Omit<Task, 'id' | 'createdAt' | 'status' | 'scheduledSessions'>) => void;
}

export const TaskModal: React.FC<TaskModalProps> = ({
  isOpen,
  taskToEdit,
  onClose,
  onSave,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [estimatedDurationMinutes, setEstimatedDurationMinutes] = useState(60);
  const [deadlineAt, setDeadlineAt] = useState('');
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [allowSplit, setAllowSplit] = useState(false);
  const [minimumSessionMinutes, setMinimumSessionMinutes] = useState(30);
  const [preferredTimeOfDay, setPreferredTimeOfDay] = useState<'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY'>('ANY');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (taskToEdit) {
      setTitle(taskToEdit.title);
      setDescription(taskToEdit.description || '');
      setEstimatedDurationMinutes(taskToEdit.estimatedDurationMinutes);
      // Format ISO string to local input format "YYYY-MM-DDTHH:mm"
      const d = new Date(taskToEdit.deadlineAt);
      const localFormatted = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      setDeadlineAt(localFormatted);
      setPriority(taskToEdit.priority);
      setAllowSplit(taskToEdit.allowSplit);
      setMinimumSessionMinutes(taskToEdit.minimumSessionMinutes || 30);
      setPreferredTimeOfDay(taskToEdit.preferredTimeOfDay || 'ANY');
    } else {
      // Default: tomorrow at 17:00
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(17, 0, 0, 0);
      const localFormatted = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

      setTitle('');
      setDescription('');
      setEstimatedDurationMinutes(60);
      setDeadlineAt(localFormatted);
      setPriority('MEDIUM');
      setAllowSplit(false);
      setMinimumSessionMinutes(30);
      setPreferredTimeOfDay('ANY');
    }
    setErrorMsg('');
  }, [taskToEdit, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErrorMsg('Judul tugas wajib diisi.');
      return;
    }
    if (estimatedDurationMinutes <= 0) {
      setErrorMsg('Durasi estimasi harus lebih dari 0 menit.');
      return;
    }
    if (!deadlineAt) {
      setErrorMsg('Tenggat waktu (deadline) wajib ditentukan.');
      return;
    }

    const deadlineDate = new Date(deadlineAt);
    if (isNaN(deadlineDate.getTime())) {
      setErrorMsg('Format tanggal tenggat tidak valid.');
      return;
    }

    if (allowSplit && minimumSessionMinutes > estimatedDurationMinutes) {
      setErrorMsg('Durasi minimal per sesi tidak boleh lebih besar dari total durasi tugas.');
      return;
    }

    onSave({
      userId: 'user-default',
      title: title.trim(),
      description: description.trim() || undefined,
      estimatedDurationMinutes: Number(estimatedDurationMinutes),
      deadlineAt: deadlineDate.toISOString(),
      priority,
      allowSplit,
      minimumSessionMinutes: allowSplit ? Number(minimumSessionMinutes) : undefined,
      preferredTimeOfDay,
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
            {taskToEdit ? 'Ubah Rincian Tugas' : 'Tambah Tugas Baru'}
          </h2>
          <button
            onClick={onClose}
            className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-red-50 border border-[#C43D4B]/30 rounded-xl flex items-center gap-2 text-xs text-[#C43D4B]">
              <AlertCircle size={16} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-[#172B42] mb-1">
              Judul Tugas <span className="text-[#C43D4B]">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Contoh: Menyiapkan laporan sprint mingguan"
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
              placeholder="Catatan tambahan, link referensi, atau instruksi pengerjaan..."
              rows={2}
              className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7] resize-none"
            />
          </div>

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
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-[#172B42] mb-1">
                Tenggat Waktu (Deadline) <span className="text-[#C43D4B]">*</span>
              </label>
              <input
                type="datetime-local"
                value={deadlineAt}
                onChange={(e) => setDeadlineAt(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
              />
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
                <option value="MORNING">Pagi hari (sebelum siang)</option>
                <option value="AFTERNOON">Sore hari (setelah siang)</option>
              </select>
            </div>
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
              {taskToEdit ? 'Simpan Perubahan' : 'Buat Tugas'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
