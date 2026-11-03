import {
  TaskSplitConfig,
  SplitValidationResult,
  SplitConflictType,
} from '../types';

export interface ValidateSplitParams {
  estimatedDurationMinutes: number;
  hasExplicitTotalDuration?: boolean;
  splitConfig?: TaskSplitConfig;
  minimumSessionMinutes?: number;
}

/**
 * Validasi terpusat untuk konfigurasi pembagian sesi.
 * Digunakan secara konsisten oleh temporal parser, backend, frontend, dan deterministic scheduler.
 */
export function validateSplitConfiguration(params: ValidateSplitParams): SplitValidationResult {
  const {
    estimatedDurationMinutes,
    hasExplicitTotalDuration = false,
    splitConfig,
    minimumSessionMinutes = 30,
  } = params;

  // Jika tidak ada konfigurasi split atau mode single, konfigurasi valid
  if (!splitConfig || splitConfig.forcedMode !== 'split') {
    return {
      isValid: true,
      totalTaskDuration: estimatedDurationMinutes,
      totalSessionsDuration: estimatedDurationMinutes,
    };
  }

  // 1. estimatedDurationMinutes harus berupa angka positif valid
  if (
    typeof estimatedDurationMinutes !== 'number' ||
    !Number.isFinite(estimatedDurationMinutes) ||
    Number.isNaN(estimatedDurationMinutes) ||
    estimatedDurationMinutes <= 0
  ) {
    return {
      isValid: false,
      errorCode: 'INVALID_DURATION_VALUE',
      errorMessage: `Total durasi tugas tidak valid (${estimatedDurationMinutes}). Durasi harus berupa angka positif.`,
    };
  }

  // 2. targetSessionCount harus integer positif >= 1
  const targetCount = splitConfig.targetSessionCount;
  if (
    typeof targetCount !== 'number' ||
    !Number.isInteger(targetCount) ||
    targetCount < 1
  ) {
    return {
      isValid: false,
      errorCode: 'SESSION_COUNT_MISMATCH',
      errorMessage: `Jumlah sesi tidak valid (${targetCount}). Jumlah sesi harus berupa bilangan bulat minimal 1.`,
    };
  }

  // 3. sessionDurations validation
  const sessionDurations = splitConfig.sessionDurations;
  if (sessionDurations) {
    if (!Array.isArray(sessionDurations)) {
      return {
        isValid: false,
        errorCode: 'INVALID_DURATION_VALUE',
        errorMessage: 'Format daftar durasi sesi harus berupa array angka.',
      };
    }

    if (sessionDurations.length !== targetCount) {
      return {
        isValid: false,
        errorCode: 'SESSION_COUNT_MISMATCH',
        errorMessage: `Jumlah sesi yang diminta (${targetCount}) tidak sesuai dengan rincian durasi yang diberikan (${sessionDurations.length} sesi).`,
      };
    }

    for (let i = 0; i < sessionDurations.length; i++) {
      const dur = sessionDurations[i];
      if (
        typeof dur !== 'number' ||
        !Number.isFinite(dur) ||
        Number.isNaN(dur) ||
        dur <= 0
      ) {
        return {
          isValid: false,
          errorCode: 'INVALID_DURATION_VALUE',
          errorMessage: `Durasi sesi ke-${i + 1} (${dur}) tidak valid. Setiap sesi harus berupa angka positif.`,
        };
      }

      if (dur < minimumSessionMinutes) {
        return {
          isValid: false,
          errorCode: 'BELOW_MINIMUM_DURATION',
          errorMessage: `Durasi sesi ke-${i + 1} (${dur} menit) di bawah batas minimal ${minimumSessionMinutes} menit.`,
        };
      }
    }

    // 4. Periksa total seluruh sessionDurations terhadap total durasi tugas
    const sumDurations = sessionDurations.reduce((sum, d) => sum + d, 0);

    // Jika pengguna menyebutkan total durasi secara eksplisit dan jumlah sesi tidak sama persis
    if (hasExplicitTotalDuration && sumDurations !== estimatedDurationMinutes) {
      return {
        isValid: false,
        errorCode: 'DURATION_MISMATCH',
        errorMessage: `Total durasi tugas adalah ${estimatedDurationMinutes} menit, tetapi pembagian sesi hanya berjumlah ${sumDurations} menit (${sessionDurations.join(' + ')}). Silakan sesuaikan durasi sesi agar totalnya tepat ${estimatedDurationMinutes} menit.`,
        totalTaskDuration: estimatedDurationMinutes,
        totalSessionsDuration: sumDurations,
      };
    }

    return {
      isValid: true,
      totalTaskDuration: estimatedDurationMinutes,
      totalSessionsDuration: sumDurations,
    };
  }

  // 5. sessionDurationMinutes check jika sessionDurations belum ada
  if (
    typeof splitConfig.sessionDurationMinutes === 'number' &&
    (Number.isNaN(splitConfig.sessionDurationMinutes) ||
      !Number.isFinite(splitConfig.sessionDurationMinutes) ||
      splitConfig.sessionDurationMinutes <= 0)
  ) {
    return {
      isValid: false,
      errorCode: 'INVALID_DURATION_VALUE',
      errorMessage: `Durasi per sesi (${splitConfig.sessionDurationMinutes}) tidak valid.`,
    };
  }

  return {
    isValid: true,
    totalTaskDuration: estimatedDurationMinutes,
    totalSessionsDuration: estimatedDurationMinutes,
  };
}

export interface SplitContradictionCheckParams {
  prompt: string;
  isAcrossDays: boolean;
  isSameDay: boolean;
  targetSessionCount?: number;
  sessionDurations?: number[];
  estimatedDurationMinutes?: number;
  hasExplicitTotal?: boolean;
  deadlineIso?: string;
  referenceDate?: Date;
  timezone?: string;
}

export interface SplitContradictionResult {
  hasConflict: boolean;
  conflictType?: SplitConflictType;
  conflictReason?: string;
  conflictingInstructions?: string[];
  requiresClarification?: boolean;
  clarificationPrompt?: string;
  clarificationOptions?: { label: string; actionValue: string }[];
}

/**
 * Mendeteksi instruksi pembagian sesi yang saling bertentangan secara logis.
 */
export function detectSplitContradictions(params: SplitContradictionCheckParams): SplitContradictionResult {
  const {
    prompt,
    isAcrossDays,
    isSameDay,
    targetSessionCount = 2,
    sessionDurations,
    estimatedDurationMinutes,
    hasExplicitTotal = false,
    deadlineIso,
    referenceDate = new Date(),
    timezone = 'Asia/Jakarta',
  } = params;

  const p = prompt.toLowerCase();

  // 1. Konflik Strategi: Lintas Hari vs Hari yang Sama / Selesai Hari Ini
  // Contoh: "Bagi menjadi 3 sesi pada hari yang berbeda, tetapi selesaikan semuanya hari ini."
  // Contoh: "Bagi menjadi 2 sesi, satu sesi pagi dan satu sesi malam pada hari yang sama. Jadwalkan pada hari berbeda."
  const mentionsSameDayConstraint =
    isSameDay ||
    /\b(?:selesaikan|harus\s+selesai|semuanya|semua\s+sesi)\s+(?:semuanya\s+)?hari\s+ini\b/i.test(p) ||
    /\bdalam\s+satu\s+hari\b/i.test(p);

  if (isAcrossDays && mentionsSameDayConstraint) {
    return {
      hasConflict: true,
      conflictType: 'STRATEGY_MISMATCH',
      conflictReason:
        'Instruksi Anda meminta sesi dijadwalkan pada hari berbeda, tetapi juga meminta seluruh sesi selesai pada hari yang sama / hari ini. Kedua instruksi ini bertentangan secara logis.',
      conflictingInstructions: [
        'Jadwalkan pada hari yang berbeda (lintas hari)',
        'Selesaikan seluruh sesi pada hari yang sama / hari ini',
      ],
      requiresClarification: true,
      clarificationPrompt:
        'Instruksi Anda meminta sesi dijadwalkan pada hari berbeda, tetapi juga meminta seluruh sesi selesai hari ini. Mana yang ingin diprioritaskan?',
      clarificationOptions: [
        { label: 'Jadwalkan Lintas Hari (Hari Berbeda)', actionValue: 'across_days' },
        { label: 'Selesaikan Hari Ini (Hari yang Sama)', actionValue: 'same_day' },
      ],
    };
  }

  // 2. Konflik Tenggat vs Lintas Hari: Meminta lintas hari tapi tenggat waktu hari ini
  // Contoh: "Bagi menjadi 3 sesi pada hari berbeda, tetapi semua sesi harus selesai sebelum pukul 12.00 hari ini."
  if (isAcrossDays && deadlineIso) {
    try {
      const dDate = new Date(deadlineIso);
      const rDate = new Date(referenceDate);

      // Hitung perbedaan hari kalender antara reference date dan deadline dalam timezone
      const refDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(rDate);
      const dlDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(dDate);

      if (refDayKey === dlDayKey && targetSessionCount > 1) {
        const timeStrMatch = p.match(/(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?/i);
        const timeLabel = timeStrMatch ? `pukul ${timeStrMatch[1]}.${timeStrMatch[2] || '00'} WIB` : 'hari ini';
        return {
          hasConflict: true,
          conflictType: 'DEADLINE_IMPOSSIBLE',
          conflictReason: `Instruksi Anda meminta pembagian menjadi ${targetSessionCount} sesi pada hari berbeda, namun batas tenggat waktu jatuh pada ${timeLabel} (hari yang sama). Tidak mungkin mendistribusikan ${targetSessionCount} sesi pada hari-hari berbeda sebelum tenggat hari ini.`,
          conflictingInstructions: [
            `${targetSessionCount} sesi pada hari berbeda`,
            `Tenggat waktu selesai ${timeLabel}`,
          ],
          requiresClarification: true,
          clarificationPrompt: `Tenggat waktu ${timeLabel} tidak memungkinkan pembagian sesi lintas hari. Apakah Anda ingin menyelesaikan seluruh sesi hari ini, atau memperpanjang tenggat waktu?`,
          clarificationOptions: [
            { label: 'Selesaikan Semua Sesi Hari Ini', actionValue: 'same_day' },
            { label: 'Perpanjang Tenggat (Tetap Lintas Hari)', actionValue: 'extend_deadline' },
          ],
        };
      }
    } catch {
      // Abaikan jika parsing tanggal gagal
    }
  }

  // 3. Konflik Total Durasi vs Jumlah Sesi Eksplisit
  if (
    hasExplicitTotal &&
    typeof estimatedDurationMinutes === 'number' &&
    sessionDurations &&
    sessionDurations.length > 0
  ) {
    const sumDur = sessionDurations.reduce((sum, d) => sum + d, 0);
    if (sumDur !== estimatedDurationMinutes) {
      return {
        hasConflict: true,
        conflictType: 'DURATION_MISMATCH',
        conflictReason: `Total durasi tugas adalah ${estimatedDurationMinutes} menit, tetapi pembagian sesi hanya berjumlah ${sumDur} menit (${sessionDurations.join(' + ')}). Silakan sesuaikan durasi sesi agar totalnya tepat ${estimatedDurationMinutes} menit.`,
        conflictingInstructions: [
          `Total durasi kegiatan: ${estimatedDurationMinutes} menit`,
          `Rincian sesi: ${sessionDurations.join('m + ')}m = ${sumDur} menit`,
        ],
        requiresClarification: true,
        clarificationPrompt: `Total durasi tugas (${estimatedDurationMinutes}m) berbeda dengan total rincian sesi (${sumDur}m). Mana durasi yang ingin Anda gunakan?`,
        clarificationOptions: [
          { label: `Gunakan Total ${estimatedDurationMinutes} Menit`, actionValue: 'keep_total' },
          { label: `Gunakan Rincian ${sumDur} Menit`, actionValue: 'use_session_sum' },
        ],
      };
    }
  }

  return { hasConflict: false };
}
