import React, { useState } from 'react';
import {
  Sparkles,
  Send,
  Calendar,
  Clock,
  Layers,
  CheckCircle2,
  AlertCircle,
  Check,
  ArrowRight,
  ShieldAlert,
  Lock,
  Loader2,
  Info,
  RotateCcw,
} from 'lucide-react';
import { Task, CalendarEvent, UserPreferences, AIPlanDraft, ScheduleCalculationResult } from '../types';
import { scheduleTaskDeterministically } from '../lib/scheduler';
import { formatUserErrorMessage } from '../lib/geminiErrorHandling';
import { formatInUserTimezone, getZonedDateTimeParts } from '../lib/timezone';

interface AIAssistantViewProps {
  tasks: Task[];
  events: CalendarEvent[];
  preferences: UserPreferences;
  onApplyAIPlan: (plan: AIPlanDraft, scheduleResult: ScheduleCalculationResult) => Promise<boolean | void> | void;
  onNavigateToCalendar: () => void;
}

type LoadingPhase = 'idle' | 'interpreting' | 'checking_slots' | 'saving_calendar';

export const AIAssistantView: React.FC<AIAssistantViewProps> = ({
  tasks,
  events,
  preferences,
  onApplyAIPlan,
  onNavigateToCalendar,
}) => {
  const [promptInput, setPromptInput] = useState('');
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState('');
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>('idle');
  const [proposedPlan, setProposedPlan] = useState<AIPlanDraft | null>(null);
  const [scheduleTestResult, setScheduleTestResult] = useState<ScheduleCalculationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [warningMessage, setWarningMessage] = useState('');
  const [planSource, setPlanSource] = useState<'gemini' | 'rule_fallback_on_error' | 'rule_fallback'>('gemini');
  const [appliedSuccess, setAppliedSuccess] = useState(false);

  const isAnalyzing = loadingPhase === 'interpreting' || loadingPhase === 'checking_slots';
  const isSaving = loadingPhase === 'saving_calendar';

  const userTimezone = preferences.timezone
    ? preferences.timezone.split(' ')[0]
    : 'Asia/Jakarta';

  const samplePrompts = [
    'Kelas dari jam 7 malam sampai jam 10 malam',
    'Malam ini jam 9 belajar materi React 45 menit',
    'Jadwalkan persiapan materi sprint durasi 90 menit sebelum besok sore, bagi 2 sesi jika padat.',
    'Membaca ringkasan kontrak hukum 45 menit besok pagi sebelum makan siang.',
  ];

  const handlePlanSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isAnalyzing || isSaving) return;

    // Preserve text in input field and record as last submitted prompt
    setPromptInput(text);
    setLastSubmittedPrompt(trimmed);

    setLoadingPhase('interpreting');
    setErrorMessage('');
    setWarningMessage('');
    setProposedPlan(null);
    setScheduleTestResult(null);
    setAppliedSuccess(false);

    const abortController = new AbortController();
    const clientTimeoutId = setTimeout(() => {
      abortController.abort();
    }, 35000); // 35-second client timeout

    try {
      const now = new Date();
      const userTimezone = preferences.timezone
        ? preferences.timezone.split(' ')[0]
        : 'Asia/Jakarta';

      const userLocalTimeStr = now.toLocaleDateString('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const response = await fetch('/api/gemini/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          userPrompt: trimmed,
          currentDateTime: now.toISOString(),
          userLocalTimeStr,
          userTimezone,
          workHours: {
            workStartHour: preferences.workStartHour,
            workEndHour: preferences.workEndHour,
          },
        }),
      });

      clearTimeout(clientTimeoutId);

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        throw new Error('Gagal mengurai respons dari server.');
      }

      if (!response.ok || !data?.success) {
        const friendlyMessage = formatUserErrorMessage(data?.errorCode, response.status, data?.error);
        throw new Error(friendlyMessage);
      }

      if (data.warning) {
        setWarningMessage(data.warning);
      }

      const plan: AIPlanDraft = data.plan;
      setPlanSource(data.source || (data.isAiGenerated ? 'gemini' : 'rule_fallback_on_error'));
      setProposedPlan(plan);

      // Phase 2: Memeriksa waktu kosong via scheduler
      setLoadingPhase('checking_slots');

      // Construct deadline date
      let deadlineDate = new Date();
      if (plan.deadlineAt) {
        deadlineDate = new Date(plan.deadlineAt);
      } else {
        deadlineDate.setDate(deadlineDate.getDate() + (plan.deadlineDaysFromNow || 1));
        deadlineDate.setHours(plan.preferredTimeOfDay === 'EVENING' ? 23 : 18, 0, 0, 0);
      }

      // Pre-flight check via deterministic scheduler
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
        timeConstraintType: plan.timeConstraintType,
        requestedStartAt: plan.requestedStartAt,
        requestedEndAt: plan.requestedEndAt,
        preferredWindow: plan.preferredWindow,
        timezone: plan.timezone || userTimezone,
        createdAt: new Date().toISOString(),
      };

      const schedRes = scheduleTaskDeterministically(pseudoTask, events, tasks, preferences);
      setScheduleTestResult(schedRes);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setErrorMessage('Permintaan dibatalkan karena melebihi batas waktu (timeout 20 detik). Silakan coba lagi.');
      } else {
        const safeMessage = formatUserErrorMessage(undefined, undefined, err?.message);
        setErrorMessage(safeMessage);
      }
    } finally {
      clearTimeout(clientTimeoutId);
      setLoadingPhase('idle');
    }
  };

  const handleConfirmAndApply = async () => {
    if (!proposedPlan || !scheduleTestResult || isSaving) return;

    setLoadingPhase('saving_calendar');
    try {
      await onApplyAIPlan(proposedPlan, scheduleTestResult);
      setAppliedSuccess(true);
    } catch (err: any) {
      setErrorMessage(`Gagal menyimpan: ${err.message}`);
    } finally {
      setLoadingPhase('idle');
    }
  };

  const getPhaseText = (): string => {
    switch (loadingPhase) {
      case 'interpreting':
        return 'Menafsirkan permintaan...';
      case 'checking_slots':
        return 'Memeriksa waktu kosong...';
      case 'saving_calendar':
        return 'Menyimpan ke Google Calendar...';
      default:
        return '';
    }
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
            Tuliskan apa yang ingin Anda kerjakan dengan bahasa sehari-hari. AI menafsirkan waktu, jenis komitmen (tetap atau fleksibel), lalu scheduler deterministik menguji slot bebas konflik di kalender Anda.
          </p>
        </div>

        {/* Input Card */}
        <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-4">
          <label className="block text-xs font-semibold text-[#172B42]">
            Apa yang ingin Anda jadwalkan?
          </label>
          <div className="relative">
            <textarea
              rows={3}
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              placeholder="Contoh: Kelas dari jam 7 malam sampai jam 10 malam, atau: Tolong jadwalkan pengerjaan tugas 60 menit besok malam..."
              disabled={isAnalyzing || isSaving}
              className="w-full p-3.5 pr-12 text-sm rounded-xl border border-[#D9E3EF] text-[#172B42] placeholder:text-[#53657A]/60 focus:ring-2 focus:ring-[#2457A7] focus:outline-hidden resize-none transition-all disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handlePlanSubmit(promptInput);
                }
              }}
            />
            <button
              onClick={() => handlePlanSubmit(promptInput)}
              disabled={!promptInput.trim() || isAnalyzing || isSaving}
              className="absolute right-3 bottom-3.5 p-2 rounded-lg bg-[#2457A7] text-white hover:bg-[#1E4889] disabled:opacity-40 disabled:hover:bg-[#2457A7] transition-colors"
              title="Kirim Instruksi"
            >
              {isAnalyzing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}
            </button>
          </div>

          {/* Phase loading indicator */}
          {loadingPhase !== 'idle' && (
            <div className="flex items-center gap-2 px-3 py-2 bg-[#EAF3FC] text-[#2457A7] text-xs font-medium rounded-xl animate-in fade-in">
              <Loader2 size={14} className="animate-spin" />
              <span>{getPhaseText()}</span>
            </div>
          )}

          {/* Sample Prompts */}
          <div className="space-y-2">
            <span className="text-[11px] font-semibold text-[#53657A] uppercase tracking-wider">
              Contoh Permintaan Waktu Nyata:
            </span>
            <div className="flex flex-wrap gap-2">
              {samplePrompts.map((sample, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setPromptInput(sample);
                    handlePlanSubmit(sample);
                  }}
                  disabled={isAnalyzing || isSaving}
                  className="text-left text-xs px-3 py-1.5 rounded-lg bg-[#F8FAFC] border border-[#D9E3EF] text-[#172B42] hover:border-[#2457A7] hover:bg-white transition-all disabled:opacity-50"
                >
                  &ldquo;{sample}&rdquo;
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Error Notification */}
        {errorMessage && (
          <div className="p-4 bg-red-50 border border-[#C43D4B]/30 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-[#C43D4B] animate-in fade-in">
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <span className="font-bold">Gagal Memproses Permintaan</span>
                <p className="leading-relaxed text-[#172B42]">{errorMessage}</p>
              </div>
            </div>
            {lastSubmittedPrompt && (
              <button
                type="button"
                onClick={() => handlePlanSubmit(lastSubmittedPrompt)}
                disabled={isAnalyzing || isSaving}
                className="shrink-0 self-start sm:self-center flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#C43D4B]/40 hover:border-[#C43D4B] text-[#C43D4B] font-semibold rounded-xl text-xs hover:bg-red-50 transition-colors shadow-2xs disabled:opacity-40"
              >
                <RotateCcw size={13} />
                <span>Coba Lagi</span>
              </button>
            )}
          </div>
        )}

        {/* Warning Notification (e.g. Rule engine fallback) */}
        {warningMessage && (
          <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-800">
            <Info size={16} className="shrink-0 mt-0.5 text-amber-600" />
            <p className="leading-relaxed">{warningMessage}</p>
          </div>
        )}

        {/* AI Proposal & Deterministic Validation Result */}
        {proposedPlan && scheduleTestResult && (
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-5 animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-start justify-between border-b border-[#D9E3EF] pb-4">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full ${
                      planSource === 'gemini'
                        ? 'text-[#2457A7] bg-[#EAF3FC]'
                        : 'text-amber-800 bg-amber-100 border border-amber-300'
                    }`}
                  >
                    {planSource === 'gemini' ? 'Hasil Analisis AI' : 'Mesin Aturan Deterministik (Fallback)'}
                  </span>
                  {proposedPlan.timeConstraintType === 'fixed_event' ? (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md">
                      <Lock size={11} /> Komitmen Waktu Tetap (Fixed Event)
                    </span>
                  ) : proposedPlan.timeConstraintType === 'preferred_window' ? (
                    <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">
                      Jendela Waktu Preferensi
                    </span>
                  ) : (
                    <span className="text-[11px] font-semibold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">
                      Fleksibel (Hanya Tenggat)
                    </span>
                  )}
                </div>
                <div className="mt-2">
                  <span className="text-[11px] font-semibold text-[#53657A] block">Judul Kegiatan:</span>
                  <h3 className="text-base font-bold text-[#172B42] mt-0.5">
                    {proposedPlan.title}
                  </h3>
                </div>
              </div>
              <span
                className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                  proposedPlan.priority === 'URGENT'
                    ? 'bg-rose-100 text-rose-700'
                    : proposedPlan.priority === 'HIGH'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-slate-100 text-[#53657A]'
                }`}
              >
                {proposedPlan.priority}
              </span>
            </div>

            {/* Plan Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]/60 space-y-1">
                <span className="text-[11px] text-[#53657A] flex items-center gap-1">
                  <Clock size={12} /> Durasi
                </span>
                <span className="text-xs font-bold text-[#172B42]">
                  {proposedPlan.estimatedDurationMinutes} Menit
                </span>
              </div>
              <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]/60 space-y-1">
                <span className="text-[11px] text-[#53657A] flex items-center gap-1">
                  <Calendar size={12} /> Target / Waktu
                </span>
                <span className="text-xs font-bold text-[#172B42]">
                  {proposedPlan.requestedStartAt
                    ? (() => {
                        const startD = new Date(proposedPlan.requestedStartAt);
                        const startStr = formatInUserTimezone(startD, userTimezone, {
                          hour: '2-digit',
                          minute: '2-digit',
                        });
                        if (proposedPlan.requestedEndAt) {
                          const endD = new Date(proposedPlan.requestedEndAt);
                          const endStr = formatInUserTimezone(endD, userTimezone, {
                            hour: '2-digit',
                            minute: '2-digit',
                          });
                          const isNextDay =
                            getZonedDateTimeParts(endD, userTimezone).day !==
                            getZonedDateTimeParts(startD, userTimezone).day;
                          return `${startStr} - ${endStr}${isNextDay ? ' (+1 hr)' : ''}`;
                        }
                        return startStr;
                      })()
                    : proposedPlan.deadlineDaysFromNow === 0
                    ? 'Hari ini'
                    : proposedPlan.deadlineDaysFromNow === 1
                    ? 'Besok'
                    : `${proposedPlan.deadlineDaysFromNow} hari`}
                </span>
              </div>
              <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]/60 space-y-1">
                <span className="text-[11px] text-[#53657A] flex items-center gap-1">
                  <Layers size={12} /> Pembagian Sesi
                </span>
                <span className="text-xs font-bold text-[#172B42]">
                  {proposedPlan.allowSplit
                    ? `Boleh (${proposedPlan.minimumSessionMinutes}m min)`
                    : 'Satu sesi utuh'}
                </span>
              </div>
              <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]/60 space-y-1">
                <span className="text-[11px] text-[#53657A] flex items-center gap-1">
                  <Sparkles size={12} /> Waktu Pilihan
                </span>
                <span className="text-xs font-bold text-[#172B42]">
                  {proposedPlan.preferredTimeOfDay === 'MORNING'
                    ? 'Pagi Hari'
                    : proposedPlan.preferredTimeOfDay === 'AFTERNOON'
                    ? 'Siang/Sore'
                    : proposedPlan.preferredTimeOfDay === 'EVENING'
                    ? 'Malam Hari'
                    : 'Kapan saja'}
                </span>
              </div>
            </div>

            {/* AI or Rule Reasoning */}
            <div className="p-3.5 bg-[#EAF3FC]/50 border border-[#8DBCEB]/30 rounded-xl space-y-1">
              <span className="text-[11px] font-bold text-[#2457A7] uppercase tracking-wider">
                {planSource === 'gemini' ? 'Pertimbangan Logis AI:' : 'Pertimbangan Aturan Deterministik:'}
              </span>
              <p className="text-xs text-[#172B42] leading-relaxed">
                {proposedPlan.reasoning}
              </p>
            </div>

            {/* Deterministic Pre-Flight Result */}
            <div
              className={`p-4 rounded-xl border space-y-3 ${
                scheduleTestResult.success
                  ? 'bg-emerald-50/60 border-[#16856B]/30'
                  : 'bg-amber-50/60 border-[#B86B12]/30'
              }`}
            >
              {scheduleTestResult.success ? (
                <>
                  <div className="flex items-center gap-2 text-xs font-bold text-[#16856B]">
                    <CheckCircle2 size={16} />
                    <span>Slot Kalender Ditemukan & Bebas Konflik</span>
                  </div>
                  <p className="text-xs text-[#53657A] leading-relaxed">
                    {scheduleTestResult.explanation}
                  </p>
                  <div className="space-y-1.5 pt-1">
                    {scheduleTestResult.proposedSessions.map((sess, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between text-xs bg-white px-3 py-2 rounded-lg border border-[#D9E3EF]"
                      >
                        <span className="font-medium text-[#172B42]">
                          Sesi {sess.sessionIndex} ({sess.durationMinutes} menit)
                        </span>
                        <span className="font-semibold text-[#2457A7]">
                          {new Date(sess.startAt).toLocaleDateString('id-ID', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                          })}{' '}
                          •{' '}
                          {new Date(sess.startAt).toLocaleTimeString('id-ID', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}{' '}
                          -{' '}
                          {new Date(sess.endAt).toLocaleTimeString('id-ID', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-xs font-bold text-[#B86B12]">
                    <ShieldAlert size={16} />
                    <span>Tidak Dapat Menempatkan Jadwal</span>
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
                  disabled={isSaving}
                  className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42] disabled:opacity-50"
                >
                  Batal
                </button>

                {scheduleTestResult.success && (
                  <button
                    onClick={handleConfirmAndApply}
                    disabled={isSaving}
                    className="flex items-center gap-1.5 px-5 py-2.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs disabled:opacity-60"
                  >
                    {isSaving ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        <span>Menyimpan ke Google Calendar...</span>
                      </>
                    ) : (
                      <>
                        <Check size={14} />
                        <span>Terapkan ke Jadwal & Kalender</span>
                      </>
                    )}
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
