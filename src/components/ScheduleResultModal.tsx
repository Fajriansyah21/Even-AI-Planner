import React from 'react';
import { X, CheckCircle2, AlertTriangle, Calendar, Clock, Check, ArrowRight, ShieldAlert } from 'lucide-react';
import { ScheduleCalculationResult } from '../types';

interface ScheduleResultModalProps {
  isOpen: boolean;
  result: ScheduleCalculationResult | null;
  onClose: () => void;
  onConfirmSchedule: (result: ScheduleCalculationResult) => void;
}

function getFailureCodeBadge(code?: string) {
  switch (code) {
    case 'TIME_CONFLICT':
      return { label: 'Konflik Waktu Tetap', color: 'bg-red-50 text-[#C43D4B] border-red-200' };
    case 'PREFERRED_WINDOW_FULL':
      return { label: 'Jendela Waktu Penuh', color: 'bg-amber-50 text-[#B86B12] border-amber-200' };
    case 'NO_SLOT_BEFORE_DEADLINE':
      return { label: 'Tidak Ada Slot Sebelum Tenggat', color: 'bg-amber-50 text-[#B86B12] border-amber-200' };
    case 'DEADLINE_PASSED':
      return { label: 'Tenggat Waktu Lewat', color: 'bg-red-50 text-[#C43D4B] border-red-200' };
    case 'INVALID_TIME_RANGE':
      return { label: 'Rentang Waktu Tidak Valid', color: 'bg-red-50 text-[#C43D4B] border-red-200' };
    default:
      return { label: 'Perlu Penyesuaian', color: 'bg-slate-50 text-[#53657A] border-slate-200' };
  }
}

export const ScheduleResultModal: React.FC<ScheduleResultModalProps> = ({
  isOpen,
  result,
  onClose,
  onConfirmSchedule,
}) => {
  if (!isOpen || !result) return null;

  const failureBadge = !result.success ? getFailureCodeBadge(result.failureCode) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div 
        className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-[#D9E3EF] overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        <div className="px-6 py-4 flex items-center justify-between border-b border-[#D9E3EF]">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-[#EAF3FC] text-[#2457A7]">
              Kalkulasi Deterministik
            </span>
            {failureBadge && (
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${failureBadge.color}`}>
                {failureBadge.label}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-[#53657A] hover:text-[#172B42] p-1 rounded-lg"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <h3 className="text-base font-bold text-[#172B42]">
              {result.taskTitle}
            </h3>
          </div>

          {result.success ? (
            <div className="space-y-4">
              <div className="p-3 bg-emerald-50 border border-[#16856B]/30 rounded-xl flex items-start gap-2.5 text-xs text-[#16856B]">
                <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">Slot Kalender Terkonfirmasi!</span>
                  <p className="mt-0.5 text-slate-700 leading-relaxed">
                    {result.explanation}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-xs font-semibold text-[#172B42] block">
                  Rincian Penempatan Sesi di Kalender:
                </span>
                {result.proposedSessions.map((s, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl flex items-center justify-between text-xs"
                  >
                    <div className="space-y-0.5">
                      <span className="font-semibold text-[#172B42] block">
                        {new Date(s.startAt).toLocaleDateString('id-ID', {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                      <span className="text-[#53657A]">
                        {new Date(s.startAt).toLocaleTimeString('id-ID', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        —{' '}
                        {new Date(s.endAt).toLocaleTimeString('id-ID', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>

                    <div className="text-right">
                      <span className="font-mono font-bold text-[#2457A7]">
                        {s.durationMinutes} mnt
                      </span>
                      {s.totalSessions > 1 && (
                        <span className="block text-[10px] text-[#53657A]">
                          Sesi {s.sessionIndex}/{s.totalSessions}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-[#B86B12]">
                <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">
                    {result.failureCode === 'TIME_CONFLICT'
                      ? 'Benturan Jadwal Terdeteksi'
                      : 'Slot Waktu Tidak Tersedia'}
                  </span>
                  <p className="mt-1 text-slate-700 leading-relaxed">
                    {result.explanation}
                  </p>
                </div>
              </div>

              {result.warning && (
                <div className="p-3 bg-slate-50 border border-[#D9E3EF] rounded-xl text-xs text-[#53657A]">
                  <strong className="text-[#172B42] block mb-0.5">Saran Tindakan:</strong>
                  {result.warning}
                </div>
              )}

              {result.diagnostics && result.diagnostics.freeTimeCalculatedMinutes !== undefined && (
                <div className="p-2.5 bg-[#F8FAFC] border border-[#D9E3EF] rounded-lg text-[11px] text-[#53657A] flex items-center justify-between">
                  <span>Waktu luang terdeteksi pada rentang ini:</span>
                  <span className="font-mono font-semibold text-[#172B42]">
                    {result.diagnostics.freeTimeCalculatedMinutes} menit
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="pt-3 border-t border-[#D9E3EF] flex items-center justify-end gap-2.5">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42]"
            >
              Tutup
            </button>

            {result.success && (
              <button
                onClick={() => {
                  onConfirmSchedule(result);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-5 py-2.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs"
              >
                <Check size={14} />
                <span>Simpan ke Jadwal Kalender</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
