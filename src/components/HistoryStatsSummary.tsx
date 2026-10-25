import React from 'react';
import { CheckCircle2, AlertCircle, TrendingUp, Clock, RotateCw, CheckCheck, HelpCircle } from 'lucide-react';
import { Task } from '../types';

interface HistoryStatsSummaryProps {
  historyTasks: Task[];
}

export const HistoryStatsSummary: React.FC<HistoryStatsSummaryProps> = ({ historyTasks }) => {
  const completedCount = historyTasks.filter(
    (t) => t.status === 'completed_manual' || t.status === 'COMPLETED'
  ).length;

  const missedCount = historyTasks.filter((t) => t.status === 'missed_auto').length;
  const totalEvaluated = completedCount + missedCount;

  const completionRate = totalEvaluated > 0 ? Math.round((completedCount / totalEvaluated) * 100) : 0;
  const missedRate = totalEvaluated > 0 ? Math.round((missedCount / totalEvaluated) * 100) : 0;

  // Breakdown of missed actions
  const rescheduledCount = historyTasks.filter(
    (t) => t.status === 'missed_auto' && t.rescheduleDecision === 'rescheduled'
  ).length;

  const dismissedCount = historyTasks.filter(
    (t) => t.status === 'missed_auto' && t.rescheduleDecision === 'dismissed'
  ).length;

  const pendingActionCount = historyTasks.filter(
    (t) => t.status === 'missed_auto' && (!t.rescheduleDecision || t.rescheduleDecision === 'pending')
  ).length;

  // Total completed focus duration
  const totalCompletedMinutes = historyTasks
    .filter((t) => t.status === 'completed_manual' || t.status === 'COMPLETED')
    .reduce((sum, t) => sum + (t.estimatedDurationMinutes || 0), 0);

  const completedHours = Math.floor(totalCompletedMinutes / 60);
  const completedRemainingMins = totalCompletedMinutes % 60;

  const getPerformanceFeedback = () => {
    if (totalEvaluated === 0) {
      return {
        text: 'Belum ada data kegiatan untuk dievaluasi.',
        color: 'text-[#53657A]',
        bg: 'bg-slate-100',
      };
    }
    if (completionRate >= 80) {
      return {
        text: 'Efektivitas sangat tinggi — jadwal dipenuhi dengan konsisten.',
        color: 'text-[#16856B]',
        bg: 'bg-emerald-50',
      };
    }
    if (completionRate >= 50) {
      return {
        text: 'Produktivitas stabil — periksa kegiatan terlewat untuk dijadwalkan ulang.',
        color: 'text-[#2457A7]',
        bg: 'bg-[#EAF3FC]',
      };
    }
    return {
      text: 'Banyak kegiatan terlewat — pertimbangkan estimasi durasi yang lebih realistis.',
      color: 'text-[#B86B12]',
      bg: 'bg-amber-50',
    };
  };

  const feedback = getPerformanceFeedback();

  return (
    <div className="bg-white border border-[#D9E3EF] rounded-2xl p-4 sm:p-5 shadow-2xs space-y-4">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#D9E3EF]/70 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#EAF3FC] text-[#2457A7] flex items-center justify-center shrink-0">
            <TrendingUp size={16} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-[#172B42] font-editorial tracking-tight">
              Ringkasan Kinerja & Statistik Riwayat
            </h3>
            <p className="text-[11px] text-[#53657A]">
              Rasio perbandingan kegiatan yang berhasil diselesaikan vs terlewat waktu
            </p>
          </div>
        </div>

        <div className={`px-2.5 py-1 rounded-lg text-[11px] font-medium self-start sm:self-auto ${feedback.bg} ${feedback.color}`}>
          {feedback.text}
        </div>
      </div>

      {/* Main Grid: Percentage Metric, Ratio Bar, and Detail Columns */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
        {/* Metric Highlight (Left - 4 cols) */}
        <div className="md:col-span-4 flex items-center gap-4 bg-[#F8FAFC] p-3.5 rounded-xl border border-[#D9E3EF]">
          <div className="relative flex items-center justify-center">
            {/* SVG Circular Progress Ring */}
            <svg className="w-16 h-16 transform -rotate-90" viewBox="0 0 36 36">
              <path
                className="text-slate-200"
                strokeWidth="3.5"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              <path
                className="text-[#16856B] transition-all duration-500 ease-out"
                strokeDasharray={`${completionRate}, 100`}
                strokeWidth="3.5"
                strokeLinecap="round"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
            </svg>
            <div className="absolute text-center">
              <span className="text-sm font-bold text-[#172B42]">{completionRate}%</span>
            </div>
          </div>

          <div className="space-y-0.5">
            <span className="text-[11px] font-semibold text-[#53657A] uppercase tracking-wider">
              Tingkat Selesai
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold text-[#16856B] font-editorial">
                {completedCount}
              </span>
              <span className="text-xs text-[#53657A]">dari {totalEvaluated} kegiatan</span>
            </div>
            <p className="text-[11px] text-[#53657A] leading-tight">
              {totalEvaluated > 0
                ? `${missedCount} kegiatan (${missedRate}%) terlewat waktu`
                : 'Belum ada kegiatan yang berakhir'}
            </p>
          </div>
        </div>

        {/* Visual Ratio Progress Bar (Middle - 5 cols) */}
        <div className="md:col-span-5 space-y-2 bg-[#F8FAFC] p-3.5 rounded-xl border border-[#D9E3EF]">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-[#172B42]">Proporsi Status Akhir</span>
            <span className="text-[#53657A] text-[11px]">
              {totalEvaluated > 0 ? `${totalEvaluated} total catatan` : '0 catatan'}
            </span>
          </div>

          {/* Dual Segmented Bar */}
          <div className="w-full h-3 rounded-full bg-slate-200 overflow-hidden flex shadow-inner">
            {totalEvaluated > 0 ? (
              <>
                <div
                  style={{ width: `${completionRate}%` }}
                  className="bg-[#16856B] h-full transition-all duration-300"
                  title={`Selesai Manual: ${completedCount} (${completionRate}%)`}
                />
                <div
                  style={{ width: `${missedRate}%` }}
                  className="bg-[#E2933A] h-full transition-all duration-300"
                  title={`Terlewat Otomatis: ${missedCount} (${missedRate}%)`}
                />
              </>
            ) : (
              <div className="w-full h-full bg-slate-200" />
            )}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-between text-[11px] pt-0.5">
            <div className="flex items-center gap-1.5 text-[#16856B]">
              <span className="w-2 h-2 rounded-full bg-[#16856B]" />
              <span className="font-semibold">{completionRate}% Selesai Manual</span>
              <span className="text-[#53657A]">({completedCount})</span>
            </div>
            <div className="flex items-center gap-1.5 text-[#B86B12]">
              <span className="w-2 h-2 rounded-full bg-[#E2933A]" />
              <span className="font-semibold">{missedRate}% Terlewat</span>
              <span className="text-[#53657A]">({missedCount})</span>
            </div>
          </div>
        </div>

        {/* Key Additional Insights (Right - 3 cols) */}
        <div className="md:col-span-3 flex flex-col justify-between h-full bg-[#F8FAFC] p-3.5 rounded-xl border border-[#D9E3EF] space-y-2">
          <div>
            <span className="text-[10px] font-semibold text-[#53657A] uppercase tracking-wider block mb-1">
              Waktu Fokus Selesai
            </span>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#172B42]">
              <Clock size={13} className="text-[#2457A7]" />
              <span>
                {completedHours > 0 || completedRemainingMins > 0
                  ? `${completedHours} jam ${completedRemainingMins > 0 ? `${completedRemainingMins} mnt` : ''}`
                  : '0 jam'}
              </span>
            </div>
          </div>

          <div className="pt-1.5 border-t border-[#D9E3EF]/60">
            <span className="text-[10px] font-semibold text-[#53657A] uppercase tracking-wider block mb-1">
              Pemulihan Terlewat
            </span>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#53657A]">Dijadwalkan Ulang:</span>
              <span className="font-semibold text-[#2457A7]">{rescheduledCount}</span>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#53657A]">Butuh Keputusan:</span>
              <span className={`font-semibold ${pendingActionCount > 0 ? 'text-[#B86B12]' : 'text-[#53657A]'}`}>
                {pendingActionCount}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
