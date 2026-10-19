import React, { useState } from 'react';
import {
  Sparkles,
  Send,
  Calendar,
  Clock,
  Layers,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Check,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { Task, CalendarEvent, UserPreferences, AIPlanDraft, ScheduleCalculationResult } from '../types';
import { scheduleTaskDeterministically } from '../lib/scheduler';

interface AIAssistantViewProps {
  tasks: Task[];
  events: CalendarEvent[];
  preferences: UserPreferences;
  onApplyAIPlan: (plan: AIPlanDraft, scheduleResult: ScheduleCalculationResult) => void;
  onNavigateToCalendar: () => void;
}

export const AIAssistantView: React.FC<AIAssistantViewProps> = ({
  tasks,
  events,
  preferences,
  onApplyAIPlan,
  onNavigateToCalendar,
}) => {
  const [promptInput, setPromptInput] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [proposedPlan, setProposedPlan] = useState<AIPlanDraft | null>(null);
  const [scheduleTestResult, setScheduleTestResult] = useState<ScheduleCalculationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [appliedSuccess, setAppliedSuccess] = useState(false);

  const samplePrompts = [
    'Tolong jadwalkan persiapan materi sprint durasi 90 menit sebelum besok sore, bagi 2 sesi jika padat.',
    'Saya perlu membaca ringkasan kontrak hukum 45 menit besok pagi sebelum jam makan siang.',
    'Jadwalkan riset benchmark kompetitor 120 menit dengan prioritas tinggi sebelum lusa.',
  ];

  const handlePlanSubmit = async (text: string) => {
    if (!text.trim()) return;

    setIsAnalyzing(true);
    setErrorMessage('');
    setProposedPlan(null);
    setScheduleTestResult(null);
    setAppliedSuccess(false);

    try {
      const response = await fetch('/api/gemini/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPrompt: text,
          currentDateTime: new Date().toISOString(),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Gagal memproses permintaan dengan AI.');
      }

      const plan: AIPlanDraft = data.plan;
      setProposedPlan(plan);

      // Immediately run deterministic scheduler as pre-flight check!
      const deadlineDate = new Date();
      deadlineDate.setDate(deadlineDate.getDate() + (plan.deadlineDaysFromNow || 1));
      deadlineDate.setHours(17, 0, 0, 0);

      const pseudoTask: Task = {
        id: `ai-draft-${Date.now()}`,
        userId: 'user-default',
        title: plan.title,
        description: plan.description,
        estimatedDurationMinutes: plan.estimatedDurationMinutes,
        deadlineAt: deadlineDate.toISOString(),
        priority: plan.priority,
        status: 'UNSCHEDULED',
        allowSplit: plan.allowSplit,
        minimumSessionMinutes: plan.minimumSessionMinutes || 30,
        preferredTimeOfDay: plan.preferredTimeOfDay,
        createdAt: new Date().toISOString(),
      };

      const schedRes = scheduleTaskDeterministically(pseudoTask, events, tasks, preferences);
      setScheduleTestResult(schedRes);
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan saat berkomunikasi dengan server.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleConfirmAndApply = () => {
    if (!proposedPlan || !scheduleTestResult) return;
    onApplyAIPlan(proposedPlan, scheduleTestResult);
    setAppliedSuccess(true);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-y-auto p-4 sm:p-6">
      <div className="max-w-3xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="text-center sm:text-left space-y-1">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EAF3FC] text-[#2457A7] text-xs font-semibold mb-2">
            <Sparkles size={14} /> Asisten Perencanaan EVEN
          </div>
          <h2 className="text-2xl font-bold font-editorial text-[#172B42] tracking-tight">
            Ubah Niat Kerja Menjadi Jadwal Nyata
          </h2>
          <p className="text-xs text-[#53657A] leading-relaxed max-w-xl">
            Tuliskan apa yang ingin Anda kerjakan dengan bahasa sehari-hari. AI menafsirkan waktu dan tenggat, lalu scheduler deterministik memeriksa ketersediaan slot bebas konflik di Google Calendar.
          </p>
        </div>

        {/* Input Card */}
        <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-4">
          <label className="block text-xs font-semibold text-[#172B42]">
            Apa yang ingin Anda selesaikan?
          </label>
          <div className="relative">
            <textarea
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              placeholder="Contoh: Jadwalkan riset kompetitor 90 menit sebelum lusa sore, boleh dibagi 2 sesi..."
              rows={3}
              className="w-full p-3.5 pr-12 rounded-xl border border-[#D9E3EF] bg-[#F8FAFC] focus:bg-white text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7] resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handlePlanSubmit(promptInput);
                }
              }}
            />
            <button
              onClick={() => handlePlanSubmit(promptInput)}
              disabled={isAnalyzing || !promptInput.trim()}
              className="absolute right-3 bottom-3 p-2 rounded-xl bg-[#2457A7] hover:bg-[#1E4889] text-white disabled:opacity-40 transition-colors"
              title="Kirim permintaan perencanaan"
            >
              <Send size={15} />
            </button>
          </div>

          {/* Prompt chips */}
          <div className="space-y-1.5 pt-1">
            <span className="text-[11px] text-[#53657A] font-medium block">
              Contoh permintaan yang dapat dicoba:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {samplePrompts.map((s, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setPromptInput(s);
                    handlePlanSubmit(s);
                  }}
                  className="text-left text-[11px] px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-[#EAF3FC] border border-[#D9E3EF] text-[#53657A] hover:text-[#2457A7] transition-colors"
                >
                  {`"${s}"`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Loading indicator */}
        {isAnalyzing && (
          <div className="p-8 bg-white border border-[#D9E3EF] rounded-2xl shadow-xs text-center space-y-3 animate-pulse">
            <Sparkles className="w-8 h-8 text-[#2457A7] mx-auto animate-spin" />
            <h4 className="text-sm font-bold text-[#172B42]">
              Sedang menganalisis niat dan komitmen kalender...
            </h4>
            <p className="text-xs text-[#53657A]">
              AI menafsirkan durasi dan kendala, kemudian mesin scheduler memvalidasi jam kerja dan rapat.
            </p>
          </div>
        )}

        {/* Error Feedback */}
        {errorMessage && (
          <div className="p-4 bg-red-50 border border-[#C43D4B]/30 rounded-2xl flex items-start gap-3 text-xs text-[#C43D4B]">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold block">Gagal Merencanakan:</span>
              <p className="mt-0.5 leading-relaxed">{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Results Card */}
        {proposedPlan && scheduleTestResult && !isAnalyzing && (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-6 shadow-xs space-y-5">
            {/* Header info */}
            <div className="flex items-start justify-between border-b border-[#D9E3EF] pb-4">
              <div>
                <span className="text-[10px] font-semibold bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-full">
                  Usulan Rencana Terverifikasi
                </span>
                <h3 className="text-lg font-bold text-[#172B42] mt-1.5">
                  {proposedPlan.title}
                </h3>
                {proposedPlan.description && (
                  <p className="text-xs text-[#53657A] mt-1">{proposedPlan.description}</p>
                )}
              </div>

              <div className="text-right">
                <span className="text-xs font-mono font-bold text-[#2457A7]">
                  {proposedPlan.estimatedDurationMinutes} menit
                </span>
                <span className="block text-[10px] text-[#53657A]">
                  Prioritas {proposedPlan.priority}
                </span>
              </div>
            </div>

            {/* AI Reasoning explanation */}
            <div className="p-3.5 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl text-xs space-y-1">
              <span className="font-semibold text-[#172B42] flex items-center gap-1.5">
                <Sparkles size={14} className="text-[#2457A7]" />
                Penjelasan AI:
              </span>
              <p className="text-[#53657A] leading-relaxed">
                {proposedPlan.reasoning}
              </p>
            </div>

            {/* Deterministic Scheduler Result Section */}
            <div className="p-4 rounded-xl border space-y-2.5">
              {scheduleTestResult.success ? (
                <>
                  <div className="flex items-center gap-2 text-xs font-bold text-[#16856B]">
                    <CheckCircle2 size={16} />
                    <span>Slot Kalender Berhasil Ditemukan Tanpa Bentrok!</span>
                  </div>
                  <p className="text-xs text-[#53657A] leading-relaxed">
                    {scheduleTestResult.explanation}
                  </p>

                  <div className="pt-2 space-y-1.5">
                    <span className="text-[11px] font-semibold text-[#172B42] block">
                      Rencana Penempatan Sesi:
                    </span>
                    {scheduleTestResult.proposedSessions.map((sess, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 bg-[#EAF3FC]/60 border border-[#8DBCEB]/50 rounded-xl flex items-center justify-between text-xs text-[#172B42]"
                      >
                        <span className="font-medium">
                          {new Date(sess.startAt).toLocaleDateString('id-ID', {
                            weekday: 'long',
                            day: 'numeric',
                            month: 'short',
                          })}{' '}
                          • Pukul{' '}
                          {new Date(sess.startAt).toLocaleTimeString('id-ID', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}{' '}
                          —{' '}
                          {new Date(sess.endAt).toLocaleTimeString('id-ID', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <span className="font-mono text-[11px] text-[#2457A7] font-semibold">
                          {sess.durationMinutes} menit
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-xs font-bold text-[#B86B12]">
                    <ShieldAlert size={16} />
                    <span>Jadwal Tidak Muat Sebelum Tenggat</span>
                  </div>
                  <p className="text-xs text-[#53657A] leading-relaxed">
                    {scheduleTestResult.explanation}
                  </p>
                  {scheduleTestResult.warning && (
                    <p className="text-xs text-[#B86B12] bg-amber-50 p-2.5 rounded-lg border border-amber-200">
                      {scheduleTestResult.warning}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Action Buttons */}
            {appliedSuccess ? (
              <div className="p-3 bg-emerald-50 border border-[#16856B]/30 rounded-xl flex items-center justify-between text-xs text-[#16856B]">
                <div className="flex items-center gap-2 font-medium">
                  <Check size={16} />
                  <span>Jadwal berhasil ditambahkan ke kalender kerja Anda!</span>
                </div>
                <button
                  onClick={onNavigateToCalendar}
                  className="font-semibold underline flex items-center gap-1"
                >
                  Lihat Kalender <ArrowRight size={12} />
                </button>
              </div>
            ) : (
              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  onClick={() => {
                    setProposedPlan(null);
                    setScheduleTestResult(null);
                  }}
                  className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42]"
                >
                  Batal
                </button>

                {scheduleTestResult.success && (
                  <button
                    onClick={handleConfirmAndApply}
                    className="flex items-center gap-1.5 px-5 py-2.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs"
                  >
                    <Check size={14} />
                    <span>Terapkan ke Jadwal & Kalender</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
