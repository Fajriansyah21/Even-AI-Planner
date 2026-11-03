import React, { useState, useRef, useEffect, useMemo } from 'react';
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
  XCircle,
  CircleDot,
  CheckCircle,
} from 'lucide-react';
import {
  Task,
  CalendarEvent,
  UserPreferences,
  AIPlanDraft,
  ScheduleCalculationResult,
  TaskSplitConfig,
  SessionDistributionStrategy,
} from '../types';
import {
  scheduleTaskDeterministically,
  DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES,
} from '../lib/scheduler';
import { formatUserErrorMessage } from '../lib/geminiErrorHandling';
import { formatInUserTimezone, getZonedDateTimeParts, createIsoInTimezone } from '../lib/timezone';
import { parseIndonesianTemporalRules } from '../lib/temporalParser';

export interface SplitOption {
  sessionCount: number;
  durationPerSession: number;
  sessionDurations: number[];
  totalDuration: number;
  label: string;
}

/**
 * Menghasilkan opsi pembagian sesi yang valid dan proporsional
 * berdasarkan durasi total dan batas minimum durasi sesi.
 * Menjamin jumlah total menit seluruh sesi selalu sama persis dengan totalMinutes (tidak ada menit hilang).
 */
export function getAvailableSplitOptions(
  totalMinutes: number,
  minimumSessionMinutes: number = 30
): SplitOption[] {
  const options: SplitOption[] = [];
  if (totalMinutes < minimumSessionMinutes * 2) return options;

  for (let count = 2; count <= 6; count++) {
    const base = Math.floor(totalMinutes / count);
    if (base < minimumSessionMinutes) continue;

    const remainder = totalMinutes % count;
    // Sisa menit didistribusikan ke sesi-sesi awal agar total durasi selalu persis sama
    const durations = Array.from({ length: count }, (_, i) =>
      i < remainder ? base + 1 : base
    );

    const sum = durations.reduce((acc, d) => acc + d, 0);

    let label = '';
    if (remainder === 0) {
      label = `${count} sesi × ${base} menit`;
    } else {
      label = `${count} sesi (${durations[0]}m & ${durations[durations.length - 1]}m)`;
    }

    options.push({
      sessionCount: count,
      durationPerSession: base,
      sessionDurations: durations,
      totalDuration: sum,
      label,
    });
  }

  return options;
}

/**
 * Format tampilan Target / Waktu tanpa pernah menampilkan 'undefined hari' atau menebak tenggat.
 */
export function formatPlanTargetDisplay(
  plan: AIPlanDraft,
  userTimezone: string = 'Asia/Jakarta'
): string {
  // 1. Multiple occurrences / fixed events dengan rentang jam eksplisit
  if (plan.targetOccurrences && plan.targetOccurrences.length > 1) {
    return plan.targetOccurrences.map((o) => o.dayName).join(' & ');
  }
  if (plan.requestedStartAt) {
    const startD = new Date(plan.requestedStartAt);
    const startStr = formatInUserTimezone(startD, userTimezone, {
      hour: '2-digit',
      minute: '2-digit',
    });
    if (plan.requestedEndAt) {
      const endD = new Date(plan.requestedEndAt);
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
  }

  // 2. Tanggal target kalender atau offset relatif
  if (plan.targetDate || typeof plan.targetDayOffset === 'number') {
    let baseLabel = '';
    if (typeof plan.targetDayOffset === 'number') {
      if (plan.targetDayOffset === 0) baseLabel = 'Hari ini';
      else if (plan.targetDayOffset === 1) baseLabel = 'Besok';
      else if (plan.targetDayOffset === 2) baseLabel = 'Lusa';
      else if (plan.targetDayOffset > 2) baseLabel = `${plan.targetDayOffset} hari ke depan`;
    }

    let dateFormatted = '';
    if (plan.targetDate) {
      const parts = plan.targetDate.split('-').map(Number);
      if (parts.length === 3) {
        const d = new Date(createIsoInTimezone(parts[0], parts[1], parts[2], 12, 0, 0, userTimezone));
        dateFormatted = formatInUserTimezone(d, userTimezone, {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
        });
      }
    }

    const windowLabel =
      plan.preferredWindow?.label ||
      (plan.preferredTimeOfDay === 'MORNING'
        ? 'Pagi'
        : plan.preferredTimeOfDay === 'AFTERNOON'
        ? 'Siang/Sore'
        : plan.preferredTimeOfDay === 'EVENING'
        ? 'Malam'
        : '');

    let combined = baseLabel;
    if (baseLabel && dateFormatted) {
      combined = `${baseLabel} (${dateFormatted})`;
    } else if (dateFormatted) {
      combined = dateFormatted;
    }

    if (windowLabel) {
      combined = combined ? `${combined} • ${windowLabel}` : windowLabel;
    }

    return combined || 'Fleksibel';
  }

  // 3. Jika hanya ada jendela waktu (misal: "Malam ini" atau "Pagi hari" tanpa tanggal tertentu)
  if (plan.preferredWindow?.label) {
    return plan.preferredWindow.label;
  }
  if (plan.preferredTimeOfDay && plan.preferredTimeOfDay !== 'ANY') {
    return plan.preferredTimeOfDay === 'MORNING'
      ? 'Pagi Hari'
      : plan.preferredTimeOfDay === 'AFTERNOON'
      ? 'Siang/Sore'
      : 'Malam Hari';
  }

  // 4. Default aman jika tidak ada target tertentu: Fleksibel
  return 'Fleksibel';
}

interface AIAssistantViewProps {
  tasks: Task[];
  events: CalendarEvent[];
  preferences: UserPreferences;
  onApplyAIPlan: (plan: AIPlanDraft, scheduleResult: ScheduleCalculationResult) => Promise<boolean | void> | void;
  onNavigateToCalendar: () => void;
}

export enum LoadingPhase {
  IDLE = 'IDLE',
  VALIDATING = 'Validating',
  ANALYZING = 'Analyzing',
  PLANNING = 'Planning',
  CHECKING_CONFLICTS = 'Checking Conflicts',
  SAVING_CALENDAR = 'Saving Calendar',
}

export interface LoadingStepConfig {
  phase: LoadingPhase;
  stepNumber: number;
  stageName: 'Validating' | 'Analyzing' | 'Planning' | 'Checking Conflicts';
  label: string;
  detail: string;
}

export const LOADING_STEPS: LoadingStepConfig[] = [
  {
    phase: LoadingPhase.VALIDATING,
    stageName: 'Validating',
    stepNumber: 1,
    label: 'Validating',
    detail: 'Memvalidasi kelengkapan teks dan format instruksi Anda...',
  },
  {
    phase: LoadingPhase.ANALYZING,
    stageName: 'Analyzing',
    stepNumber: 2,
    label: 'Analyzing',
    detail: 'Menafsirkan durasi, jam kegiatan, dan konteks waktu Asia/Jakarta...',
  },
  {
    phase: LoadingPhase.PLANNING,
    stageName: 'Planning',
    stepNumber: 3,
    label: 'Planning',
    detail: 'Menyusun draf usulan rencana terstruktur melalui AI Gemini...',
  },
  {
    phase: LoadingPhase.CHECKING_CONFLICTS,
    stageName: 'Checking Conflicts',
    stepNumber: 4,
    label: 'Checking Conflicts',
    detail: 'Menguji ketersediaan slot kalender bebas benturan via deterministic scheduler...',
  },
];

export const AIAssistantView: React.FC<AIAssistantViewProps> = ({
  tasks,
  events,
  preferences,
  onApplyAIPlan,
  onNavigateToCalendar,
}) => {
  const [promptInput, setPromptInput] = useState('');
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState('');
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>(LoadingPhase.IDLE);
  const [proposedPlan, setProposedPlan] = useState<AIPlanDraft | null>(null);
  const [scheduleTestResult, setScheduleTestResult] = useState<ScheduleCalculationResult | null>(null);
  const [selectedSplitMode, setSelectedSplitMode] = useState<'single' | 'split'>('single');
  const [selectedSplitOption, setSelectedSplitOption] = useState<SplitOption | null>(null);
  const [selectedDistributionStrategy, setSelectedDistributionStrategy] = useState<SessionDistributionStrategy>('flexible');

  const availableSplitOptions = useMemo(() => {
    if (!proposedPlan) return [];
    if (proposedPlan.timeConstraintType === 'fixed_event') return [];
    return getAvailableSplitOptions(
      proposedPlan.estimatedDurationMinutes,
      proposedPlan.minimumSessionMinutes || 30
    );
  }, [proposedPlan]);

  const [errorMessage, setErrorMessage] = useState('');
  const [warningMessage, setWarningMessage] = useState('');
  const [planSource, setPlanSource] = useState<'gemini' | 'rule_fallback_on_error' | 'rule_fallback'>('gemini');
  const [appliedSuccess, setAppliedSuccess] = useState(false);

  // Active cancellation, race condition guard, and timer references
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRequestIdRef = useRef<number>(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (timeoutTimerRef.current) {
        clearTimeout(timeoutTimerRef.current);
        timeoutTimerRef.current = null;
      }
    };
  }, []);

  const isAnalyzing =
    loadingPhase === LoadingPhase.VALIDATING ||
    loadingPhase === LoadingPhase.ANALYZING ||
    loadingPhase === LoadingPhase.PLANNING ||
    loadingPhase === LoadingPhase.CHECKING_CONFLICTS;
  const isSaving = loadingPhase === LoadingPhase.SAVING_CALENDAR;

  const userTimezone = preferences.timezone
    ? preferences.timezone.split(' ')[0]
    : 'Asia/Jakarta';

  const samplePrompts = [
    'Kelas dari jam 7 malam sampai jam 10 malam',
    'Malam ini jam 9 belajar materi React 45 menit',
    'Jadwalkan persiapan materi sprint durasi 90 menit sebelum besok sore, bagi 2 sesi jika padat.',
    'Membaca ringkasan kontrak hukum 45 menit besok pagi sebelum makan siang.',
  ];

  const handleCancelAnalysis = () => {
    activeRequestIdRef.current++;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
    setLoadingPhase(LoadingPhase.IDLE);
    setErrorMessage('Proses analisis dibatalkan oleh pengguna.');
  };

  const handlePlanSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isAnalyzing || isSaving) return;

    // Track active request ID to completely eliminate race conditions
    const currentReqId = ++activeRequestIdRef.current;

    // Preserve text in input field and record as last submitted prompt
    setPromptInput(text);
    setLastSubmittedPrompt(trimmed);

    // Abort previous running request if any
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }

    // Stage 1: Validating (Validasi format teks dan kelengkapan)
    setLoadingPhase(LoadingPhase.VALIDATING);
    setErrorMessage('');
    setWarningMessage('');
    setProposedPlan(null);
    setScheduleTestResult(null);
    setSelectedSplitMode('single');
    setSelectedSplitOption(null);
    setSelectedDistributionStrategy('flexible');
    setAppliedSuccess(false);

    // Stage 2: Analyzing (Menganalisis konteks waktu lokal & preferensi)
    setLoadingPhase(LoadingPhase.ANALYZING);
    const now = new Date();
    const effectiveTimezone = preferences.timezone
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

    // Stage 3: Planning (Menyusun usulan rencana terstruktur)
    setLoadingPhase(LoadingPhase.PLANNING);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    let didTimeout = false;

    // Timeout disinkronkan tepat 30 detik (30000ms)
    timeoutTimerRef.current = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, 30000);

    try {
      const response = await fetch('/api/gemini/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          userPrompt: trimmed,
          currentDateTime: now.toISOString(),
          userLocalTimeStr,
          userTimezone: effectiveTimezone,
          workHours: {
            workStartHour: preferences.workStartHour,
            workEndHour: preferences.workEndHour,
          },
        }),
      });

      if (timeoutTimerRef.current) {
        clearTimeout(timeoutTimerRef.current);
        timeoutTimerRef.current = null;
      }

      // Check if this request is still the active one
      if (activeRequestIdRef.current !== currentReqId) return;

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
      const resolvedSource = data.source || (data.isAiGenerated ? 'gemini' : 'rule_fallback_on_error');
      setPlanSource(resolvedSource);

      // Stage 4: Checking Conflicts (Pemeriksaan konflik ketersediaan slot)
      setLoadingPhase(LoadingPhase.CHECKING_CONFLICTS);

      if (plan.isOperational) {
        setProposedPlan(plan);
        setScheduleTestResult(null);
        return;
      }

      // Calculate initial split options
      const splitOpts = getAvailableSplitOptions(plan.estimatedDurationMinutes, plan.minimumSessionMinutes || 30);
      if (splitOpts.length > 0) {
        setSelectedSplitOption(splitOpts[0]);
      } else {
        setSelectedSplitOption(null);
      }
      setSelectedSplitMode('single');

      // Pisahkan secara tegas antara batas tenggat eksplisit dan tanggal target:
      // JANGAN PERNAH menyintesis tenggat buatan jam 18.00/23.00 jika pengguna tidak meminta tenggat!
      const calculatedDeadlineAt: string | null = plan.deadlineAt || null;

      // Pre-flight check via deterministic scheduler (default: single session)
      const pseudoTask: Task = {
        id: `ai-draft-${Date.now()}`,
        userId: 'user-default',
        title: plan.title,
        description: plan.description,
        estimatedDurationMinutes: plan.estimatedDurationMinutes,
        deadlineAt: calculatedDeadlineAt,
        hasExplicitDeadline: Boolean(plan.hasExplicitDeadline || plan.deadlineAt),
        targetDate: plan.targetDate,
        targetDayOffset: plan.targetDayOffset,
        priority: plan.priority,
        status: 'UNSCHEDULED',
        allowSplit: plan.allowSplit,
        minimumSessionMinutes: plan.minimumSessionMinutes || 30,
        splitConfig: plan.allowSplit ? { forcedMode: 'single' } : undefined,
        preferredTimeOfDay: plan.preferredTimeOfDay,
        timeConstraintType: plan.timeConstraintType,
        requestedStartAt: plan.requestedStartAt,
        requestedEndAt: plan.requestedEndAt,
        targetDays: plan.targetDays,
        targetOccurrences: plan.targetOccurrences,
        preferredWindow: plan.preferredWindow,
        timezone: plan.timezone || effectiveTimezone,
        createdAt: new Date().toISOString(),
      };

      const schedRes = scheduleTaskDeterministically(pseudoTask, events, tasks, preferences);

      if (activeRequestIdRef.current !== currentReqId) return;

      // Selesai: Tampilkan hasil secara lengkap setelah uji slot selesai
      setProposedPlan(plan);
      setScheduleTestResult(schedRes);
    } catch (err: any) {
      if (activeRequestIdRef.current !== currentReqId) return;

      if (err.name === 'AbortError' && !didTimeout) {
        // Pembatalan manual oleh pengguna: JANGAN jalankan fallback
        setErrorMessage('Proses analisis dibatalkan oleh pengguna.');
        return;
      }

      // Timeout otomatis 30 detik (didTimeout === true) ATAU error jaringan/Gemini/server:
      // Jalankan fallback ke deterministic rule-based scheduler lokal jika permintaan masih aktif
      try {
        setLoadingPhase(LoadingPhase.CHECKING_CONFLICTS);
        const fallbackParsed = parseIndonesianTemporalRules({
          userPrompt: trimmed,
          currentDateTime: now.toISOString(),
          userLocalTimeStr,
          userTimezone: effectiveTimezone,
          workHours: {
            workStartHour: preferences.workStartHour,
            workEndHour: preferences.workEndHour,
          },
        });

        if (!fallbackParsed.title || !fallbackParsed.estimatedDurationMinutes) {
          throw new Error('Instruksi tidak dapat dipahami untuk penjadwalan otomatis.');
        }

        const splitOpts = getAvailableSplitOptions(
          fallbackParsed.estimatedDurationMinutes,
          fallbackParsed.minimumSessionMinutes || 30
        );
        if (splitOpts.length > 0) {
          setSelectedSplitOption(splitOpts[0]);
        } else {
          setSelectedSplitOption(null);
        }
        setSelectedSplitMode('single');

        const calculatedDeadlineAt: string | null = fallbackParsed.deadlineAt || null;

        const fallbackTask: Task = {
          id: `ai-draft-${Date.now()}`,
          userId: 'user-default',
          title: fallbackParsed.title,
          description: fallbackParsed.description,
          estimatedDurationMinutes: fallbackParsed.estimatedDurationMinutes,
          deadlineAt: calculatedDeadlineAt,
          hasExplicitDeadline: Boolean(fallbackParsed.hasExplicitDeadline || fallbackParsed.deadlineAt),
          targetDate: fallbackParsed.targetDate,
          targetDayOffset: fallbackParsed.targetDayOffset,
          priority: fallbackParsed.priority,
          status: 'UNSCHEDULED',
          allowSplit: fallbackParsed.allowSplit,
          minimumSessionMinutes: fallbackParsed.minimumSessionMinutes || 30,
          splitConfig: fallbackParsed.allowSplit ? { forcedMode: 'single' } : undefined,
          preferredTimeOfDay: fallbackParsed.preferredTimeOfDay,
          timeConstraintType: fallbackParsed.timeConstraintType,
          requestedStartAt: fallbackParsed.requestedStartAt,
          requestedEndAt: fallbackParsed.requestedEndAt,
          targetDays: fallbackParsed.targetDays,
          targetOccurrences: fallbackParsed.targetOccurrences,
          preferredWindow: fallbackParsed.preferredWindow,
          timezone: fallbackParsed.timezone || effectiveTimezone,
          createdAt: new Date().toISOString(),
        };

        const schedRes = scheduleTaskDeterministically(fallbackTask, events, tasks, preferences);

        if (activeRequestIdRef.current !== currentReqId) return;

        setPlanSource('rule_fallback_on_error');
        setProposedPlan(fallbackParsed);
        setScheduleTestResult(schedRes);

        const noticeMsg = didTimeout
          ? 'Permintaan AI melampaui batas waktu respons (30 detik). Jadwal berhasil dialihkan dan disusun menggunakan mesin aturan lokal deterministik (Local Rule-based Engine) EVEN.'
          : 'Pemrosesan AI tidak tersedia saat ini. Jadwal berhasil dialihkan dan disusun menggunakan mesin aturan lokal deterministik (Local Rule-based Engine) EVEN.';
        setWarningMessage(noticeMsg);
      } catch (fallbackErr: any) {
        if (activeRequestIdRef.current !== currentReqId) return;
        const safeMessage = formatUserErrorMessage(undefined, undefined, err?.message || fallbackErr?.message);
        setErrorMessage(safeMessage);
      }
    } finally {
      if (timeoutTimerRef.current) {
        clearTimeout(timeoutTimerRef.current);
        timeoutTimerRef.current = null;
      }
      abortControllerRef.current = null;
      if (activeRequestIdRef.current === currentReqId) {
        setLoadingPhase(LoadingPhase.IDLE);
      }
    }
  };

  const handleSelectSplitMode = (mode: 'single' | 'split') => {
    if (!proposedPlan) return;
    setSelectedSplitMode(mode);

    const splitOpts = getAvailableSplitOptions(
      proposedPlan.estimatedDurationMinutes,
      proposedPlan.minimumSessionMinutes || 30
    );
    const chosenOption = selectedSplitOption || splitOpts[0] || null;
    if (mode === 'split' && !selectedSplitOption && splitOpts[0]) {
      setSelectedSplitOption(splitOpts[0]);
    }

    const splitConfig: TaskSplitConfig =
      mode === 'split' && chosenOption
        ? {
            forcedMode: 'split',
            targetSessionCount: chosenOption.sessionCount,
            sessionDurationMinutes: chosenOption.durationPerSession,
            sessionDurations: chosenOption.sessionDurations,
            minGapMinutes: DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES,
            distributionStrategy: selectedDistributionStrategy,
          }
        : {
            forcedMode: 'single',
          };

    const updatedPlan: AIPlanDraft = {
      ...proposedPlan,
      allowSplit: mode === 'split',
      splitConfig,
    };
    setProposedPlan(updatedPlan);

    const pseudoTask: Task = {
      id: `ai-draft-${Date.now()}`,
      userId: 'user-default',
      title: updatedPlan.title,
      description: updatedPlan.description,
      estimatedDurationMinutes: updatedPlan.estimatedDurationMinutes,
      deadlineAt: updatedPlan.deadlineAt || null,
      hasExplicitDeadline: Boolean(updatedPlan.hasExplicitDeadline || updatedPlan.deadlineAt),
      targetDate: updatedPlan.targetDate,
      targetDayOffset: updatedPlan.targetDayOffset,
      priority: updatedPlan.priority,
      status: 'UNSCHEDULED',
      allowSplit: mode === 'split',
      minimumSessionMinutes: updatedPlan.minimumSessionMinutes || 30,
      splitConfig,
      preferredTimeOfDay: updatedPlan.preferredTimeOfDay,
      timeConstraintType: updatedPlan.timeConstraintType,
      requestedStartAt: updatedPlan.requestedStartAt,
      requestedEndAt: updatedPlan.requestedEndAt,
      targetDays: updatedPlan.targetDays,
      targetOccurrences: updatedPlan.targetOccurrences,
      preferredWindow: updatedPlan.preferredWindow,
      timezone: updatedPlan.timezone || userTimezone,
      createdAt: new Date().toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(pseudoTask, events, tasks, preferences);
    setScheduleTestResult(schedRes);
  };

  const handleSelectSplitOption = (opt: SplitOption) => {
    if (!proposedPlan) return;
    setSelectedSplitOption(opt);
    setSelectedSplitMode('split');

    const splitConfig: TaskSplitConfig = {
      forcedMode: 'split',
      targetSessionCount: opt.sessionCount,
      sessionDurationMinutes: opt.durationPerSession,
      sessionDurations: opt.sessionDurations,
      minGapMinutes: DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES,
      distributionStrategy: selectedDistributionStrategy,
    };

    const updatedPlan: AIPlanDraft = {
      ...proposedPlan,
      allowSplit: true,
      splitConfig,
    };
    setProposedPlan(updatedPlan);

    const pseudoTask: Task = {
      id: `ai-draft-${Date.now()}`,
      userId: 'user-default',
      title: updatedPlan.title,
      description: updatedPlan.description,
      estimatedDurationMinutes: updatedPlan.estimatedDurationMinutes,
      deadlineAt: updatedPlan.deadlineAt || null,
      hasExplicitDeadline: Boolean(updatedPlan.hasExplicitDeadline || updatedPlan.deadlineAt),
      targetDate: updatedPlan.targetDate,
      targetDayOffset: updatedPlan.targetDayOffset,
      priority: updatedPlan.priority,
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: updatedPlan.minimumSessionMinutes || 30,
      splitConfig,
      preferredTimeOfDay: updatedPlan.preferredTimeOfDay,
      timeConstraintType: updatedPlan.timeConstraintType,
      requestedStartAt: updatedPlan.requestedStartAt,
      requestedEndAt: updatedPlan.requestedEndAt,
      targetDays: updatedPlan.targetDays,
      targetOccurrences: updatedPlan.targetOccurrences,
      preferredWindow: updatedPlan.preferredWindow,
      timezone: updatedPlan.timezone || userTimezone,
      createdAt: new Date().toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(pseudoTask, events, tasks, preferences);
    setScheduleTestResult(schedRes);
  };

  const handleSelectDistributionStrategy = (strategy: SessionDistributionStrategy) => {
    if (!proposedPlan) return;
    setSelectedDistributionStrategy(strategy);
    setSelectedSplitMode('split');

    const splitOpts = getAvailableSplitOptions(
      proposedPlan.estimatedDurationMinutes,
      proposedPlan.minimumSessionMinutes || 30
    );
    const chosenOption = selectedSplitOption || splitOpts[0] || null;

    const splitConfig: TaskSplitConfig = {
      forcedMode: 'split',
      targetSessionCount: chosenOption?.sessionCount || 2,
      sessionDurationMinutes: chosenOption?.durationPerSession || 30,
      sessionDurations: chosenOption?.sessionDurations,
      minGapMinutes: DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES,
      distributionStrategy: strategy,
    };

    const updatedPlan: AIPlanDraft = {
      ...proposedPlan,
      allowSplit: true,
      splitConfig,
    };
    setProposedPlan(updatedPlan);

    const pseudoTask: Task = {
      id: `ai-draft-${Date.now()}`,
      userId: 'user-default',
      title: updatedPlan.title,
      description: updatedPlan.description,
      estimatedDurationMinutes: updatedPlan.estimatedDurationMinutes,
      deadlineAt: updatedPlan.deadlineAt || null,
      hasExplicitDeadline: Boolean(updatedPlan.hasExplicitDeadline || updatedPlan.deadlineAt),
      targetDate: updatedPlan.targetDate,
      targetDayOffset: updatedPlan.targetDayOffset,
      priority: updatedPlan.priority,
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: updatedPlan.minimumSessionMinutes || 30,
      splitConfig,
      preferredTimeOfDay: updatedPlan.preferredTimeOfDay,
      timeConstraintType: updatedPlan.timeConstraintType,
      requestedStartAt: updatedPlan.requestedStartAt,
      requestedEndAt: updatedPlan.requestedEndAt,
      targetDays: updatedPlan.targetDays,
      targetOccurrences: updatedPlan.targetOccurrences,
      preferredWindow: updatedPlan.preferredWindow,
      timezone: updatedPlan.timezone || userTimezone,
      createdAt: new Date().toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(pseudoTask, events, tasks, preferences);
    setScheduleTestResult(schedRes);
  };

  const handleResolveDurationAmbiguity = (mode: 'split' | 'per_day') => {
    if (!proposedPlan) return;
    const totalMins = proposedPlan.totalDurationMinutes || proposedPlan.estimatedDurationMinutes || 180;
    const daysCount = proposedPlan.targetDays?.length || 2;
    const splitMins = Math.round(totalMins / daysCount);

    const updatedPlan: AIPlanDraft = {
      ...proposedPlan,
      isDurationAmbiguous: false,
      allowSplit: mode === 'split',
      estimatedDurationMinutes: mode === 'split' ? splitMins : totalMins,
      reasoning:
        mode === 'split'
          ? `Total waktu ${totalMins} menit dibagi rata menjadi ${splitMins} menit per hari pada ${proposedPlan.targetOccurrences?.map((o) => o.dayName).join(' dan ') || 'hari yang dipilih'}.`
          : `Waktu pengerjaan ditetapkan ${totalMins} menit penuh di setiap hari yang diminta.`,
    };

    setProposedPlan(updatedPlan);

    const pseudoTask: Task = {
      id: `ai-draft-${Date.now()}`,
      userId: 'user-default',
      title: updatedPlan.title,
      description: updatedPlan.description,
      estimatedDurationMinutes: updatedPlan.estimatedDurationMinutes,
      deadlineAt: updatedPlan.deadlineAt,
      hasExplicitDeadline: Boolean(updatedPlan.hasExplicitDeadline || updatedPlan.deadlineAt),
      targetDate: updatedPlan.targetDate,
      targetDayOffset: updatedPlan.targetDayOffset,
      priority: updatedPlan.priority,
      status: 'UNSCHEDULED',
      allowSplit: updatedPlan.allowSplit,
      minimumSessionMinutes: updatedPlan.minimumSessionMinutes || 30,
      preferredTimeOfDay: updatedPlan.preferredTimeOfDay,
      timeConstraintType: updatedPlan.timeConstraintType,
      requestedStartAt: updatedPlan.requestedStartAt,
      requestedEndAt: updatedPlan.requestedEndAt,
      targetDays: updatedPlan.targetDays,
      targetOccurrences: updatedPlan.targetOccurrences,
      preferredWindow: updatedPlan.preferredWindow,
      timezone: updatedPlan.timezone || userTimezone,
      createdAt: new Date().toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(pseudoTask, events, tasks, preferences);
    setScheduleTestResult(schedRes);
  };

  const handleConfirmAndApply = async () => {
    if (!proposedPlan || !scheduleTestResult || isSaving) return;

    setLoadingPhase(LoadingPhase.SAVING_CALENDAR);
    try {
      await onApplyAIPlan(proposedPlan, scheduleTestResult);
      setAppliedSuccess(true);
    } catch (err: any) {
      setErrorMessage(`Gagal menyimpan: ${err.message}`);
    } finally {
      setLoadingPhase(LoadingPhase.IDLE);
    }
  };

  const getStepIndex = (phase: LoadingPhase): number => {
    switch (phase) {
      case LoadingPhase.VALIDATING:
        return 1;
      case LoadingPhase.ANALYZING:
        return 2;
      case LoadingPhase.PLANNING:
        return 3;
      case LoadingPhase.CHECKING_CONFLICTS:
        return 4;
      default:
        return 0;
    }
  };

  const currentStepNumber = getStepIndex(loadingPhase);

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

          {/* Stepper Progres Analisis Multi-Tahap (Jujur & Transparan) */}
          {isAnalyzing && (
            <div
              role="status"
              aria-live="polite"
              className="p-4 bg-[#F8FAFC] border border-[#2457A7]/25 rounded-2xl space-y-4 animate-in fade-in"
            >
              <div className="flex items-center justify-between border-b border-[#D9E3EF] pb-3">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-[#EAF3FC] text-[#2457A7]">
                    <Sparkles size={16} className="animate-pulse" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-[#172B42]">
                      Memproses Penjadwalan
                    </h3>
                    <p className="text-[11px] text-[#53657A]">
                      Tahap {currentStepNumber} dari 4: {LOADING_STEPS.find((s) => s.stepNumber === currentStepNumber)?.label}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelAnalysis}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#53657A] hover:text-[#C43D4B] hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-[#C43D4B]/30"
                  title="Batalkan proses analisis saat ini"
                >
                  <XCircle size={14} />
                  <span>Batalkan</span>
                </button>
              </div>

              {/* Step indicator items */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                {LOADING_STEPS.map((step) => {
                  const isDone = currentStepNumber > step.stepNumber;
                  const isCurrent = currentStepNumber === step.stepNumber;

                  return (
                    <div
                      key={step.phase}
                      className={`p-2.5 rounded-xl border text-left transition-all ${
                        isCurrent
                          ? 'bg-white border-[#2457A7] shadow-xs ring-1 ring-[#2457A7]/20'
                          : isDone
                          ? 'bg-[#EAF3FC]/40 border-[#16856B]/30'
                          : 'bg-white/50 border-[#D9E3EF]/70 opacity-60'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {isDone ? (
                          <CheckCircle2 size={15} className="text-[#16856B] shrink-0" />
                        ) : isCurrent ? (
                          <Loader2 size={15} className="text-[#2457A7] animate-spin shrink-0" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-[#53657A]/40 flex items-center justify-center text-[10px] font-bold text-[#53657A] shrink-0">
                            {step.stepNumber}
                          </div>
                        )}
                        <span
                          className={`text-xs font-bold ${
                            isCurrent
                              ? 'text-[#2457A7]'
                              : isDone
                              ? 'text-[#16856B]'
                              : 'text-[#53657A]'
                          }`}
                        >
                          {step.label}
                        </span>
                      </div>
                      <p className="text-[10px] text-[#53657A] leading-tight mt-1 pl-6">
                        {step.detail}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Saving phase indicator */}
          {isSaving && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 px-3 py-2 bg-[#EAF3FC] text-[#2457A7] text-xs font-medium rounded-xl animate-in fade-in"
            >
              <Loader2 size={14} className="animate-spin" />
              <span>Menyimpan jadwal ke Google Calendar...</span>
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

        {/* Operational Intent Response (Bukan Pembuatan Tugas Baru) */}
        {proposedPlan && proposedPlan.isOperational && (
          <div className="bg-white border border-[#2457A7]/30 rounded-2xl p-5 shadow-xs space-y-4 animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2457A7] bg-[#EAF3FC] px-3 py-1 rounded-full w-fit">
              <Sparkles size={14} /> Permintaan Operasional
            </div>
            <div>
              <h3 className="text-base font-bold text-[#172B42]">
                {proposedPlan.operationalAction === 'find_free_slot'
                  ? 'Pencarian Slot Waktu Kosong'
                  : proposedPlan.operationalAction === 'resolve_conflicts'
                  ? 'Resolusi Jadwal Bertabrakan'
                  : 'Tinjauan Jadwal'}
              </h3>
              <p className="text-xs text-[#53657A] leading-relaxed mt-1.5">
                {proposedPlan.operationalMessage || proposedPlan.reasoning}
              </p>
            </div>
            <div className="pt-2 flex items-center gap-3">
              <button
                onClick={onNavigateToCalendar}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs"
              >
                <span>Buka Kalender</span>
                <ArrowRight size={13} />
              </button>
              <button
                onClick={() => {
                  setProposedPlan(null);
                  setScheduleTestResult(null);
                }}
                className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42]"
              >
                Tutup
              </button>
            </div>
          </div>
        )}

        {/* AI Proposal & Deterministic Validation Result */}
        {proposedPlan && !proposedPlan.isOperational && scheduleTestResult && (
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
                  {proposedPlan.hasExplicitDeadline && proposedPlan.deadlineAt && (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md">
                      <Calendar size={11} /> Tenggat: {formatInUserTimezone(new Date(proposedPlan.deadlineAt), userTimezone, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} WIB
                    </span>
                  )}
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

            {/* Fallback Transparency Banner */}
            {planSource !== 'gemini' && (
              <div className="p-3.5 bg-amber-50/90 border border-amber-300/80 rounded-xl flex items-start gap-2.5 text-xs text-amber-900 animate-in fade-in">
                <AlertCircle size={16} className="shrink-0 mt-0.5 text-amber-700" />
                <div className="space-y-1">
                  <span className="font-bold text-amber-950 block">
                    Pemberitahuan: Pemrosesan AI Tidak Tersedia
                  </span>
                  <p className="leading-relaxed text-amber-800 text-[11px]">
                    Layanan pemrosesan AI sedang tidak tersedia atau mengalami pembatasan. Jadwal ini berhasil dialihkan dan dihasilkan menggunakan <strong>Mesin Aturan Lokal Deterministik (Local Rule-Based Engine)</strong> EVEN, dengan seluruh durasi, waktu, dan benturan kalender telah diverifikasi secara akurat oleh scheduler.
                  </p>
                </div>
              </div>
            )}

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
                  {formatPlanTargetDisplay(proposedPlan, userTimezone)}
                </span>
              </div>
              <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]/60 space-y-1">
                <span className="text-[11px] text-[#53657A] flex items-center gap-1">
                  <Layers size={12} /> Pembagian Sesi
                </span>
                <span className="text-xs font-bold text-[#172B42]">
                  {proposedPlan.allowSplit
                    ? (selectedSplitMode === 'split' && selectedSplitOption
                        ? `${selectedSplitOption.sessionCount} sesi × ${selectedSplitOption.durationPerSession}m`
                        : `Boleh (${proposedPlan.minimumSessionMinutes || 30}m min)`)
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

            {/* Split Session Interactive Selection (Tersedia untuk semua tugas fleksibel yang durasinya memenuhi syarat) */}
            {proposedPlan.timeConstraintType !== 'fixed_event' && availableSplitOptions.length > 0 && (
              <div className="p-4 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <span className="text-xs font-bold text-[#172B42] flex items-center gap-1.5">
                    <Layers size={14} className="text-[#2457A7]" />
                    Pilihan Pembagian Sesi Kegiatan
                  </span>
                  <span className="text-[11px] text-[#53657A]">
                    Total Durasi: {proposedPlan.estimatedDurationMinutes} menit (Batas minimum {proposedPlan.minimumSessionMinutes || 30}m/sesi)
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleSelectSplitMode('single')}
                    className={`px-3.5 py-2.5 text-xs rounded-xl border transition-all text-left flex flex-col justify-between ${
                      selectedSplitMode === 'single'
                        ? 'bg-[#EAF3FC] border-[#2457A7] text-[#2457A7] ring-1 ring-[#2457A7] shadow-2xs font-semibold'
                        : 'bg-white text-[#172B42] border-[#D9E3EF] hover:border-[#8DBCEB]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold">Satu Sesi Utuh</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-[#53657A]">1 sesi</span>
                    </div>
                    <p className="text-[11px] text-[#53657A] mt-1">
                      Dikerjakan sekaligus selama {proposedPlan.estimatedDurationMinutes} menit tanpa jeda.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSelectSplitMode('split')}
                    className={`px-3.5 py-2.5 text-xs rounded-xl border transition-all text-left flex flex-col justify-between ${
                      selectedSplitMode === 'split'
                        ? 'bg-[#EAF3FC] border-[#2457A7] text-[#2457A7] ring-1 ring-[#2457A7] shadow-2xs font-semibold'
                        : 'bg-white text-[#172B42] border-[#D9E3EF] hover:border-[#8DBCEB]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold">Bagi Menjadi Beberapa Sesi</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#EAF3FC] text-[#2457A7]">Terjadwal parsial</span>
                    </div>
                    <p className="text-[11px] text-[#53657A] mt-1">
                      Pecah pengerjaan ke dalam slot waktu terpisah yang lebih fleksibel.
                    </p>
                  </button>
                </div>

                {selectedSplitMode === 'split' && (
                  <div className="pt-2.5 border-t border-[#D9E3EF] space-y-2">
                    <span className="text-[11px] font-semibold text-[#53657A] block">
                      Pilih konfigurasi jumlah dan durasi sesi:
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {availableSplitOptions.map((opt, idx) => {
                        const isSelected =
                          selectedSplitOption?.sessionCount === opt.sessionCount &&
                          selectedSplitOption?.durationPerSession === opt.durationPerSession;
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => handleSelectSplitOption(opt)}
                            className={`p-2.5 rounded-lg border text-left transition-all ${
                              isSelected
                                ? 'bg-white border-[#2457A7] text-[#2457A7] shadow-2xs ring-1 ring-[#2457A7]'
                                : 'bg-white border-[#D9E3EF] text-[#172B42] hover:border-[#8DBCEB]'
                            }`}
                          >
                            <div className="flex items-center justify-between text-xs font-bold">
                              <span>{opt.label}</span>
                              <span className="text-[11px] font-semibold text-[#53657A]">
                                Total {opt.totalDuration} menit
                              </span>
                            </div>
                            <p className="text-[11px] text-[#53657A] mt-0.5">
                              {opt.sessionCount} kali pengerjaan, masing-masing {opt.durationPerSession} menit
                            </p>
                          </button>
                        );
                      })}
                    </div>

                    {/* Strategi Distribusi Sesi */}
                    <div className="pt-3 border-t border-[#D9E3EF] space-y-2">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                        <span className="text-[11px] font-semibold text-[#53657A]">
                          Strategi Distribusi Sesi:
                        </span>
                        <span className="text-[10px] text-[#2457A7] font-medium bg-[#EAF3FC] px-2 py-0.5 rounded inline-block self-start sm:self-auto">
                          Jeda minimal 60 menit antar sesi di hari yang sama
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => handleSelectDistributionStrategy('flexible')}
                          className={`p-2.5 rounded-lg border text-left transition-all ${
                            selectedDistributionStrategy === 'flexible'
                              ? 'bg-white border-[#2457A7] text-[#2457A7] shadow-2xs ring-1 ring-[#2457A7]'
                              : 'bg-white border-[#D9E3EF] text-[#172B42] hover:border-[#8DBCEB]'
                          }`}
                        >
                          <span className="text-xs font-bold block">Fleksibel (Otomatis)</span>
                          <p className="text-[10px] text-[#53657A] mt-0.5 leading-snug">
                            Optimalkan hari sama jika muat, lanjut lintas hari jika padat.
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSelectDistributionStrategy('same_day')}
                          className={`p-2.5 rounded-lg border text-left transition-all ${
                            selectedDistributionStrategy === 'same_day'
                              ? 'bg-white border-[#2457A7] text-[#2457A7] shadow-2xs ring-1 ring-[#2457A7]'
                              : 'bg-white border-[#D9E3EF] text-[#172B42] hover:border-[#8DBCEB]'
                          }`}
                        >
                          <span className="text-xs font-bold block">Hari yang Sama</span>
                          <p className="text-[10px] text-[#53657A] mt-0.5 leading-snug">
                            Semua sesi dikerjakan di 1 hari dengan jeda minimal 60m.
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSelectDistributionStrategy('across_days')}
                          className={`p-2.5 rounded-lg border text-left transition-all ${
                            selectedDistributionStrategy === 'across_days'
                              ? 'bg-white border-[#2457A7] text-[#2457A7] shadow-2xs ring-1 ring-[#2457A7]'
                              : 'bg-white border-[#D9E3EF] text-[#172B42] hover:border-[#8DBCEB]'
                          }`}
                        >
                          <span className="text-xs font-bold block">Lintas Hari</span>
                          <p className="text-[10px] text-[#53657A] mt-0.5 leading-snug">
                            Prioritaskan 1 sesi per hari pada hari-hari berbeda.
                          </p>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Multi-day Duration Ambiguity Clarification Banner */}
            {proposedPlan.isDurationAmbiguous && (
              <div className="p-4 bg-amber-50/95 border border-amber-300 rounded-xl space-y-3 animate-in fade-in">
                <div className="flex items-start gap-2.5">
                  <Info size={16} className="shrink-0 mt-0.5 text-amber-700" />
                  <div className="space-y-1">
                    <span className="text-xs font-bold text-amber-900">
                      Konfirmasi Alokasi Durasi Diperlukan
                    </span>
                    <p className="text-xs text-amber-800 leading-relaxed">
                      {proposedPlan.clarificationPrompt ||
                        'Apakah durasi ini merupakan total waktu yang dibagi rata untuk semua hari, atau durasi penuh di setiap hari?'}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => handleResolveDurationAmbiguity('split')}
                    className="px-3.5 py-2 bg-white border border-amber-300 hover:border-amber-500 text-amber-900 rounded-lg text-xs font-semibold shadow-2xs hover:bg-amber-100/60 transition-colors"
                  >
                    Total {Math.round((proposedPlan.totalDurationMinutes || proposedPlan.estimatedDurationMinutes) / 60)} Jam (Dibagi Rata {Math.round((proposedPlan.totalDurationMinutes || proposedPlan.estimatedDurationMinutes) / (proposedPlan.targetDays?.length || 2))} Menit/Hari)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResolveDurationAmbiguity('per_day')}
                    className="px-3.5 py-2 bg-white border border-amber-300 hover:border-amber-500 text-amber-900 rounded-lg text-xs font-semibold shadow-2xs hover:bg-amber-100/60 transition-colors"
                  >
                    {Math.round((proposedPlan.totalDurationMinutes || proposedPlan.estimatedDurationMinutes) / 60)} Jam Penuh Setiap Hari ({proposedPlan.totalDurationMinutes || proposedPlan.estimatedDurationMinutes} Menit/Hari)
                  </button>
                </div>
              </div>
            )}

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
                  {(() => {
                    const getFailureBadgeInfo = (code?: ScheduleCalculationResult['failureCode']) => {
                      switch (code) {
                        case 'INSUFFICIENT_SPLIT_SLOTS':
                          return {
                            badge: 'INSUFFICIENT_SPLIT_SLOTS',
                            title: 'Slot Multi-Sesi Tidak Mencukupi (Jeda Terpotong)',
                            color: 'text-amber-800 bg-amber-100 border-amber-300',
                          };
                        case 'NO_CONTIGUOUS_SLOT':
                          return {
                            badge: 'NO_CONTIGUOUS_SLOT',
                            title: 'Tidak Ada Slot Kontigu Tanpa Putus',
                            color: 'text-amber-800 bg-amber-100 border-amber-300',
                          };
                        case 'TIME_CONFLICT':
                          return {
                            badge: 'TIME_CONFLICT',
                            title: 'Bentrok dengan Agenda Kalender Lain',
                            color: 'text-rose-800 bg-rose-100 border-rose-300',
                          };
                        case 'NO_SLOT_BEFORE_DEADLINE':
                          return {
                            badge: 'NO_SLOT_BEFORE_DEADLINE',
                            title: 'Tidak Ada Slot Sebelum Tenggat Waktu',
                            color: 'text-rose-800 bg-rose-100 border-rose-300',
                          };
                        case 'DEADLINE_PASSED':
                          return {
                            badge: 'DEADLINE_PASSED',
                            title: 'Tenggat Waktu Sudah Terlewat',
                            color: 'text-rose-800 bg-rose-100 border-rose-300',
                          };
                        case 'DEADLINE_INSUFFICIENT_TIME':
                          return {
                            badge: 'DEADLINE_INSUFFICIENT_TIME',
                            title: 'Waktu Menuju Tenggat Kurang dari Durasi',
                            color: 'text-amber-800 bg-amber-100 border-amber-300',
                          };
                        default:
                          return {
                            badge: 'SLOT_UNAVAILABLE',
                            title: 'Tidak Dapat Menempatkan Jadwal',
                            color: 'text-amber-800 bg-amber-100 border-amber-300',
                          };
                      }
                    };

                    const failInfo = getFailureBadgeInfo(scheduleTestResult.failureCode);
                    return (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${failInfo.color}`}
                          >
                            {failInfo.badge}
                          </span>
                          <div className="flex items-center gap-1.5 text-xs font-bold text-[#B86B12]">
                            <ShieldAlert size={16} />
                            <span>{failInfo.title}</span>
                          </div>
                        </div>
                        <p className="text-xs text-[#53657A] leading-relaxed">
                          {scheduleTestResult.explanation}
                        </p>
                        {scheduleTestResult.warning && (
                          <p className="text-xs text-[#B86B12] bg-amber-50 p-2.5 rounded-lg border border-amber-200">
                            {scheduleTestResult.warning}
                          </p>
                        )}
                      </div>
                    );
                  })()}
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

                <button
                  onClick={handleConfirmAndApply}
                  disabled={
                    !scheduleTestResult.success ||
                    isSaving ||
                    Boolean(proposedPlan.isDurationAmbiguous)
                  }
                  title={
                    !scheduleTestResult.success
                      ? 'Slot kalender tidak mencukupi atau bentrok dengan agenda lain'
                      : proposedPlan.isDurationAmbiguous
                      ? 'Harap konfirmasi pilihan alokasi durasi di atas terlebih dahulu'
                      : 'Terapkan ke Jadwal & Kalender'
                  }
                  className="flex items-center gap-1.5 px-5 py-2.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSaving ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Menyimpan ke Google Calendar...</span>
                    </>
                  ) : (
                    <>
                      <Check size={14} />
                      <span>
                        {!scheduleTestResult.success
                          ? 'Slot Tidak Mencukupi'
                          : proposedPlan.isDurationAmbiguous
                          ? 'Pilih Alokasi Durasi Terlebih Dahulu'
                          : 'Terapkan ke Jadwal & Kalender'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
