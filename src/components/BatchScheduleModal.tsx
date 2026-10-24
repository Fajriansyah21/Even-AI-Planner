import React from 'react';
import { X, CheckCircle2, AlertTriangle, Calendar, Check, Zap } from 'lucide-react';
import { ScheduleCalculationResult } from '../types';

interface BatchScheduleModalProps {
  isOpen: boolean;
  results: ScheduleCalculationResult[];
  onClose: () => void;
  onApplyBatch: () => void;
}

export const BatchScheduleModal: React.FC<BatchScheduleModalProps> = ({
  isOpen,
  results,
  onClose,
  onApplyBatch,
}) => {
  if (!isOpen || results.length === 0) return null;

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div 
        className="w-full max-w-xl bg-white rounded-2xl shadow-xl border border-[#D9E3EF] overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        <div className="px-6 py-4 flex items-center justify-between border-b border-[#D9E3EF]">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-[#2457A7]" />
            <h3 className="text-base font-bold text-[#172B42]">
              Hasil Penjadwalan Otomatis ({results.length} Tugas)
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-[#53657A] hover:text-[#172B42] p-1 rounded-lg"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Summary Banner */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="p-3 bg-emerald-50 border border-[#16856B]/30 rounded-xl text-[#16856B] flex items-center gap-2 font-medium">
              <CheckCircle2 size={16} />
              <span>{successCount} tugas berhasil dijadwalkan</span>
            </div>
            {failCount > 0 ? (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[#B86B12] flex items-center gap-2 font-medium">
                <AlertTriangle size={16} />
                <span>{failCount} tugas memerlukan penyesuaian</span>
              </div>
            ) : (
              <div className="p-3 bg-[#EAF3FC] border border-[#8DBCEB]/50 rounded-xl text-[#2457A7] flex items-center gap-2 font-medium">
                <CheckCircle2 size={16} />
                <span>Semua slot tervalidasi</span>
              </div>
            )}
          </div>

          {/* List of results */}
          <div className="space-y-2.5">
            {results.map((res, i) => (
              <div
                key={i}
                className={`p-3 rounded-xl border text-xs space-y-1 ${
                  res.success
                    ? 'bg-[#F8FAFC] border-[#D9E3EF]'
                    : 'bg-amber-50/50 border-amber-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[#172B42]">{res.taskTitle}</span>
                  {res.success ? (
                    <span className="text-[10px] bg-emerald-100 text-[#16856B] px-2 py-0.5 rounded-full font-semibold">
                      Tersedia
                    </span>
                  ) : (
                    <span className="text-[10px] bg-amber-100 text-[#B86B12] px-2 py-0.5 rounded-full font-semibold">
                      Bentrok / Penuh
                    </span>
                  )}
                </div>
                <p className="text-[#53657A] leading-relaxed">{res.explanation}</p>
                {res.warning && (
                  <p className="text-[11px] text-[#B86B12] italic">{res.warning}</p>
                )}
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-[#D9E3EF] flex items-center justify-end gap-2.5">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42]"
            >
              Batal
            </button>
            <button
              onClick={() => {
                onApplyBatch();
                onClose();
              }}
              className="flex items-center gap-1.5 px-5 py-2.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs"
            >
              <Check size={14} />
              <span>Terapkan Semua ke Kalender</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
