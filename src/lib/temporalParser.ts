import {
  parseTimezoneString,
  getPartsInTimezone,
  createIsoInTimezone,
  addDaysInTimezone,
} from './timezone';
import { TaskOccurrence } from '../types';

export interface ParseContext {
  userPrompt: string;
  currentDateTime?: string;
  userLocalTimeStr?: string;
  userTimezone?: string;
  workHours?: {
    workStartHour: number;
    workEndHour: number;
  };
}

export const INDONESIAN_WEEKDAYS: { name: string; dayIndex: number }[] = [
  { name: 'minggu', dayIndex: 0 },
  { name: 'ahad', dayIndex: 0 },
  { name: 'senin', dayIndex: 1 },
  { name: 'selasa', dayIndex: 2 },
  { name: 'rabu', dayIndex: 3 },
  { name: 'kamis', dayIndex: 4 },
  { name: 'jumat', dayIndex: 5 },
  { name: "jum'at", dayIndex: 5 },
  { name: 'sabtu', dayIndex: 6 },
];

export const DAY_NAMES_ID: Record<number, string> = {
  0: 'Minggu',
  1: 'Senin',
  2: 'Selasa',
  3: 'Rabu',
  4: 'Kamis',
  5: 'Jumat',
  6: 'Sabtu',
};

export interface ParsedDayInfo {
  dayIndex: number; // 0 = Minggu ... 6 = Sabtu
  dayName: string;  // 'Minggu', 'Senin', dst.
  rawKeyword: string;
}

/**
 * Normalisasi huruf kapital (Title Case) dengan mempertahankan akronim teknis.
 */
export function toTitleCase(str: string): string {
  const acronyms = new Set([
    'UTS', 'UAS', 'PR', 'UI', 'UX', 'UI/UX', 'API', 'AI', 'HTML', 'CSS', 'SQL',
    'WIB', 'WITA', 'WIT', 'GBK', 'IT', 'QA', 'CRUD', 'MVP', 'SDK'
  ]);
  return str
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (acronyms.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Membentuk judul kegiatan ringkas dan bermakna dari inti pekerjaan/subjek,
 * bukan menyalin seluruh prompt mentah.
 * Contoh:
 * - "Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming" -> "UTS Web Programming"
 * - "Kamis aku mau lanjut ngerjain design kalo belum selesai, selama tiga jam" -> "Melanjutkan Desain"
 * - "Aku ada UTS Design deadline-nya hari Jumat" -> "Persiapan UTS Design"
 */
export interface OperationalIntentResult {
  isOperational: boolean;
  operationalAction?: 'find_free_slot' | 'resolve_conflicts' | 'view_schedule' | 'other';
  operationalMessage?: string;
}

/**
 * Mendeteksi apakah input pengguna merupakan perintah/tindakan operasional
 * (seperti mencari slot kosong atau memindahkan jadwal bentrok) dan BUKAN pembuatan tugas baru.
 */
export function detectOperationalIntent(prompt: string): OperationalIntentResult {
  const p = prompt.trim().toLowerCase();

  // 1. Perintah mencari slot kosong / waktu terdekat luang
  const isFindSlot =
    /\b(?:cari(?:kan)?|tunjuk(?:kan)?|lihat|cek)\s*(?:kan)?\s*(?:waktu|slot)?\s*(?:terdekat\s+yang\s+kosong|slot\s+kosong|waktu\s+luang|waktu\s+kosong|jadwal\s+kosong)\b/i.test(p) ||
    /\b(?:kapan\s+(?:saya\s+)?(?:ada\s+)?(?:waktu\s+luang|slot\s+kosong|free\s+time))\b/i.test(p) ||
    /^(?:tunjukkan|cari)\s+slot\s+kosong/i.test(p);

  if (isFindSlot) {
    return {
      isOperational: true,
      operationalAction: 'find_free_slot',
      operationalMessage:
        'Instruksi Anda adalah untuk mencari atau menampilkan slot waktu kosong pada jadwal Anda, bukan untuk membuat agenda kegiatan baru. Silakan periksa tampilan Kalender atau gunakan fitur saran slot optimal untuk memilih waktu pengerjaan yang tersedia.',
    };
  }

  // 2. Perintah memindahkan / merelokasi jadwal yang bentrok
  const isResolveConflict =
    /\b(?:pindah(?:kan)?|geser|jadwalkan\s+ulang|atur\s+ulang|selesaikan|atasi)\s*(?:semua|seluruh)?\s*(?:jadwal|rapat|kegiatan|agenda)?\s*(?:yang\s+)?(?:bentrok|bertabrakan|konflik)\b/i.test(p);

  if (isResolveConflict) {
    return {
      isOperational: true,
      operationalAction: 'resolve_conflicts',
      operationalMessage:
        'Instruksi Anda adalah tindakan pemindahan atau penyelesaian jadwal yang saling bertabrakan (bentrok), bukan untuk menambahkan kegiatan baru. Sistem EVEN menjaga komitmen waktu tetap agar tidak digeser sepihak tanpa konfirmasi. Silakan buka tampilan Kalender atau Riwayat untuk meninjau dan menjadwalkan ulang kegiatan terkait secara terarah.',
    };
  }

  // 3. Perintah melihat kalender / jadwal saja tanpa aktivitas
  const isViewSchedule =
    /^(?:tampil(?:kan)?|lihat|buka)\s+(?:jadwal|kalender|agenda)\s*(?:saya|hari\s+ini|besok|minggu\s+ini)?$/i.test(p);

  if (isViewSchedule) {
    return {
      isOperational: true,
      operationalAction: 'view_schedule',
      operationalMessage:
        'Instruksi Anda adalah untuk meninjau jadwal kegiatan yang sudah ada. Anda dapat langsung membuka tab Kalender atau Daftar Kegiatan.',
    };
  }

  return { isOperational: false };
}

/**
 * Membentuk judul kegiatan ringkas dan bermakna dari inti pekerjaan/subjek,
 * bukan menyalin seluruh prompt mentah.
 * Contoh:
 * - "Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming" -> "UTS Web Programming"
 * - "Kamis aku mau lanjut ngerjain design kalo belum selesai, selama tiga jam" -> "Melanjutkan Desain"
 * - "Aku ada UTS Design deadline-nya hari Jumat" -> "Persiapan UTS Design"
 * - "Setiap Senin dan Rabu jam 19.00 belajar React" -> "Belajar React"
 */
export function extractCleanActivityTitle(prompt: string, aiTitle?: string): string {
  if (aiTitle && typeof aiTitle === 'string') {
    const trimmedAi = aiTitle.trim();
    const promptTrimmed = prompt.trim();
    if (
      trimmedAi.length >= 3 &&
      trimmedAi.length <= 60 &&
      trimmedAi.toLowerCase() !== promptTrimmed.toLowerCase() &&
      !/^(?:tolong\s+)?(?:jadwalkan|masukkan|buatkan|bikin\s+jadwal)\b/i.test(trimmedAi) &&
      !/\b(setiap\s+belajar|setiap\s+senin|setiap\s+hari)\b/i.test(trimmedAi)
    ) {
      return trimmedAi;
    }
  }

  const raw = prompt.trim();

  // Pola 1: Persiapan Ujian / Tugas dengan deadline
  // Contoh: "Aku ada UTS Design deadline-nya hari Jumat" -> "Persiapan UTS Design"
  const examDeadlineMatch = raw.match(
    /\b(?:ada\s+)?(UTS|UAS|ujian|tugas|kuis|quiz)\s+([A-Za-z0-9\s/]+?)(?:\s+(?:deadline[-a-zA-Z0-9]*|tenggat|paling lambat).*|$)/i
  );
  if (examDeadlineMatch && /\b(deadline|tenggat|paling lambat)\b/i.test(raw)) {
    const examType = examDeadlineMatch[1].toUpperCase();
    let subject = examDeadlineMatch[2].trim();
    if (subject.toLowerCase() === 'design') subject = 'Design';
    return `Persiapan ${examType} ${toTitleCase(subject)}`;
  }

  // Pola 2: "lanjut ngerjain / mengerjakan / bikin [subjek]"
  // Contoh: "Kamis aku mau lanjut ngerjain design kalo belum selesai, selama tiga jam" -> "Melanjutkan Desain"
  const continueMatch = raw.match(
    /\b(?:lanjut|melanjutkan)\s+(?:ngerjain|mengerjakan|bikin|buat|kerja(?:kan)?|belajar)?\s*([A-Za-z0-9\s/]+?)(?:\s+(?:kalo|kalau|jika|bila)\s+belum\s+selesai|\s+selama|\s+jam|\s+pukul|$)/i
  );
  if (continueMatch) {
    let subject = continueMatch[1].trim();
    if (subject.toLowerCase() === 'design' || subject.toLowerCase() === 'desain') {
      subject = 'Desain';
    } else {
      subject = toTitleCase(subject);
    }
    return `Melanjutkan ${subject}`;
  }

  let text = raw;

  // Hapus kata perulangan / frekuensi temporal
  text = text.replace(/\b(?:setiap|tiap(?:\s+tiap)?|rutin|selalu|per\s+minggu)\b/gi, '');

  // Hapus awalan perintah/keinginan percakapan
  text = text.replace(
    /^(?:tolong\s+)?(?:jadwalkan|masukkan|buatkan|bikin)?\s*(?:jadwal\s+)?(?:aku\s+|saya\s+|kami\s+)?(?:mau\s+|ingin\s+|pengen\s+|rencananya\s+)?(?:akan\s+ada\s+|ada\s+)?/i,
    ''
  );

  // Hapus frasa hari dan rentang hari
  text = text.replace(
    /\b(?:pada\s+hari|hari\s+)?(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)(?:\s+(?:dan|sampai|hingga|s\/d|-|–)\s+(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad))*\b/gi,
    ''
  );
  text = text.replace(/\b(?:besok\s+lusa|besok|lusa|kemarin|minggu\s+depan|minggu\s+ini|minggu\s+lalu|hari\s+ini|nanti)\b/gi, '');

  // Hapus rentang waktu jam
  text = text.replace(
    /(?:dari\s+)?(?:jam|pukul)?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|siang|sore|malam)?\s*(?:sampai|hingga|s\/d|-|–)\s*(?:jam|pukul)?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|siang|sore|malam)?/gi,
    ''
  );
  text = text.replace(/(?:pada\s+)?(?:jam|pukul)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|siang|sore|malam)?/gi, '');
  text = text.replace(/\b(?:malam\s+ini|pagi\s+ini|siang\s+ini|sore\s+ini)\b/gi, '');
  text = text.replace(/\b(?:malam|pagi|siang|sore)\b/gi, '');

  // Hapus durasi waktu
  text = text.replace(
    /\b(?:selama\s+)?(?:\d+|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|setengah)\s*(?:setengah)?\s*(?:jam|menit|mnt)\b/gi,
    ''
  );

  // Hapus frasa deadline
  text = text.replace(/\b(?:deadline[-a-zA-Z0-9]*|tenggat(?:\s+waktu)?|paling\s+lambat)\s*(?:hari\s+\w+|\w+)?\b/gi, '');

  // Hapus kondisi pelengkap
  text = text.replace(/\b(?:kalo|kalau|jika|bila)\s+belum\s+selesai\b/gi, '');

  // Hapus kata penghubung/filler sisa
  text = text.replace(/\b(?:akan\s+ada|ada|mau|selama|dan|atau|serta|yang|untuk|ini|itu|pada|di|ke)\b/gi, '');

  // Bersihkan tanda baca dan spasi berlebih
  text = text.replace(/[,;:.–—-]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Daftar stop words atau kata sisa yang tidak boleh berdiri sendiri sebagai judul
  const invalidSingleWords = new Set([
    'setiap', 'tiap', 'dan', 'atau', 'ini', 'itu', 'jadwal', 'kegiatan', 'agenda',
    'yang', 'untuk', 'akan', 'ada', 'mau', 'selama'
  ]);

  if (!text || text.length < 2 || invalidSingleWords.has(text.toLowerCase())) {
    return 'Kegiatan Terjadwal';
  }

  return toTitleCase(text);
}

/**
 * Memetakan nama hari (0 = Minggu s/d 6 = Sabtu) ke tanggal kalender berikutnya yang valid
 * berdasarkan zona waktu pengguna saat ini (Asia/Jakarta, WITA, WIT, dll).
 * Jika hari target adalah hari ini:
 * - Bila targetHour ditentukan dan jam tersebut sudah lewat hari ini, diarahkan ke minggu berikutnya (+7 hari).
 * - Bila opsi forceNextWeek aktif atau prompt menyebut "depan", diarahkan ke minggu berikutnya (+7 hari).
 * - Selain itu, diarahkan ke hari ini (+0 hari).
 */
export function getNextValidDateForDayOfWeek(
  targetDayOfWeek: number,
  referenceDate: Date = new Date(),
  timezone: string = 'Asia/Jakarta',
  options?: {
    targetHour?: number;
    targetMinute?: number;
    forceNextWeek?: boolean;
    weekOffset?: number;
  }
): {
  date: Date;
  dateStr: string; // YYYY-MM-DD
  dayOffset: number;
  year: number;
  month: number;
  day: number;
} {
  const tz = parseTimezoneString(timezone);
  const baseParts = getPartsInTimezone(referenceDate, tz);
  const currentDayOfWeek = baseParts.dayOfWeek;

  let dayOffset = (targetDayOfWeek - currentDayOfWeek + 7) % 7;
  if (dayOffset === 0) {
    if (options?.forceNextWeek) {
      dayOffset = 7;
    } else if (options?.targetHour !== undefined) {
      const currentMinutes = baseParts.hour * 60 + baseParts.minute;
      const targetMinutes = options.targetHour * 60 + (options.targetMinute || 0);
      if (targetMinutes <= currentMinutes) {
        dayOffset = 7;
      }
    }
  }

  if (options?.weekOffset && options.weekOffset > 0) {
    dayOffset += options.weekOffset * 7;
  }

  const targetDateObj = addDaysInTimezone(referenceDate, dayOffset, tz);
  const targetParts = getPartsInTimezone(targetDateObj, tz);
  const dateStr = `${targetParts.year}-${String(targetParts.month).padStart(2, '0')}-${String(targetParts.day).padStart(2, '0')}`;

  const iso = createIsoInTimezone(
    targetParts.year,
    targetParts.month,
    targetParts.day,
    options?.targetHour ?? 0,
    options?.targetMinute ?? 0,
    0,
    tz
  );

  return {
    date: new Date(iso),
    dateStr,
    dayOffset,
    year: targetParts.year,
    month: targetParts.month,
    day: targetParts.day,
  };
}

/**
 * Parser nama hari Indonesia (Senin-Minggu) dengan deteksi pola perulangan (recurring).
 */
export function parseIndonesianDayNames(prompt: string): {
  days: ParsedDayInfo[];
  isRecurring: boolean;
  deadlineDay?: ParsedDayInfo;
} {
  const p = prompt.toLowerCase();
  const days: ParsedDayInfo[] = [];

  const isRecurring = /\b(setiap|tiap|rutin|berulang|mingguan|per minggu|tiap-tiap|selalu)\b/i.test(prompt);

  // 1. Detect explicit deadline day clause first to avoid treating the deadline day as a work day!
  // e.g. "deadline-nya hari jumat", "deadline hari jumat", "tenggat hari jumat", "sebelum hari jumat", "paling lambat jumat"
  const deadlineClauseRegex = /(?:deadline(?:-nya)?|tenggat(?:\s+waktu)?|paling\s+lambat|sebelum|due(?:\s+date)?)\s*(?:hari\s+)?(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|ahad|minggu)/i;
  const deadlineMatch = p.match(deadlineClauseRegex);
  let deadlineDay: ParsedDayInfo | undefined = undefined;
  let promptForWorkDays = p;

  if (deadlineMatch) {
    const rawWord = deadlineMatch[1].toLowerCase();
    const entry = INDONESIAN_WEEKDAYS.find((w) => w.name === rawWord);
    const matchIndex = deadlineMatch.index || 0;
    const matchFull = deadlineMatch[0].toLowerCase();
    const afterMatch = p.slice(matchIndex + matchFull.length).trim();

    // Periksa apakah ini frasa pekan seperti "deadline minggu depan", "deadline minggu ini"
    const isWeekUnitPhrase =
      rawWord === 'minggu' &&
      !matchFull.includes('hari minggu') &&
      /^(?:depan|ini|lalu|kemarin|berikutnya|lagi)\b/i.test(afterMatch);

    if (!isWeekUnitPhrase) {
      if (entry && entry.name !== 'minggu') {
        deadlineDay = {
          dayIndex: entry.dayIndex,
          dayName: DAY_NAMES_ID[entry.dayIndex],
          rawKeyword: rawWord,
        };
      } else if (rawWord === 'minggu') {
        deadlineDay = {
          dayIndex: 0,
          dayName: 'Minggu',
          rawKeyword: 'minggu',
        };
      }
      // Remove the deadline clause so the deadline day is not added to target work days
      promptForWorkDays = p.replace(deadlineMatch[0], ' ');
    }
  }

  const weekdayRegex = /\b(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|ahad)\b/gi;
  let match;
  while ((match = weekdayRegex.exec(promptForWorkDays)) !== null) {
    const word = match[1].toLowerCase();
    const entry = INDONESIAN_WEEKDAYS.find((w) => w.name === word);
    if (entry && !days.some((d) => d.dayIndex === entry.dayIndex)) {
      days.push({
        dayIndex: entry.dayIndex,
        dayName: DAY_NAMES_ID[entry.dayIndex],
        rawKeyword: word,
      });
    }
  }

  // Check for Sunday ("minggu") in work days
  // PENTING: "minggu ini", "minggu depan", "minggu lalu", "minggu kemarin", "dua minggu lagi"
  // BUKAN hari Minggu (dayIndex 0)!
  // Tetapi "hari Minggu", "Minggu malam", "Minggu jam 19.00", "Senin sampai Minggu" ADALAH hari Minggu.
  const isSundayExplicit =
    /\b(?:hari\s+minggu|minggu\s+(?:pagi|siang|sore|malam|subuh|jam|pukul|\d{1,2}[:.]\d{2})|(?:dan|sampai|hingga|s\/d|-|–)\s*minggu\b|\bminggu\s*(?:dan|sampai|hingga|s\/d|-|–)\s*(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|ahad))\b/i.test(
      promptForWorkDays
    );

  const isSundayStandalone =
    /\bminggu\b/i.test(promptForWorkDays) &&
    !/\b(?:setiap|tiap|per|akhir|awal|tengah|sepanjang|dalam|\d+|satu|dua|tiga|empat|beberapa)\s+minggu\b/i.test(
      promptForWorkDays
    ) &&
    !/\bminggu\s+(?:ini|depan|lalu|kemarin|berikutnya|lagi)\b/i.test(promptForWorkDays);

  if ((isSundayExplicit || isSundayStandalone) && !days.some((d) => d.dayIndex === 0)) {
    days.push({
      dayIndex: 0,
      dayName: 'Minggu',
      rawKeyword: 'minggu',
    });
  }

  return { days, isRecurring, deadlineDay };
}

/**
 * Intelligent deterministic Indonesian temporal rule parser.
 * Serves as the anchor of truth and post-validator for LLM outputs.
 */
export function parseIndonesianTemporalRules(ctx: ParseContext) {
  const prompt = ctx.userPrompt.trim().toLowerCase();
  const tz = parseTimezoneString(ctx.userTimezone || 'Asia/Jakarta');

  // 0. Deteksi Intent Operasional (Cari slot kosong, pindahkan jadwal bentrok, dll.)
  const operationalResult = detectOperationalIntent(ctx.userPrompt);
  if (operationalResult.isOperational) {
    return {
      title: 'Permintaan Operasional',
      description: operationalResult.operationalMessage || ctx.userPrompt,
      estimatedDurationMinutes: 0,
      timeConstraintType: 'deadline_only' as const,
      isOperational: true,
      operationalAction: operationalResult.operationalAction,
      operationalMessage: operationalResult.operationalMessage,
      reasoning: operationalResult.operationalMessage || '',
      priority: 'LOW' as const,
      allowSplit: false,
      minimumSessionMinutes: 0,
      timezone: tz,
    };
  }

  // Base reference date parsed into target timezone
  const baseDate = ctx.currentDateTime ? new Date(ctx.currentDateTime) : new Date();
  const baseParts = getPartsInTimezone(baseDate, tz);

  // 1. Detect explicit Indonesian weekdays & recurring intent & deadline day:
  const { days: detectedWeekdays, isRecurring: promptIsRecurring, deadlineDay: detectedDeadlineDay } = parseIndonesianDayNames(prompt);

  // If multiple work days detected (e.g. "Kamis dan Selasa"), sort them chronologically from baseDate
  if (detectedWeekdays.length > 1) {
    detectedWeekdays.sort((a, b) => {
      const offsetA = (a.dayIndex - baseParts.dayOfWeek + 7) % 7;
      const offsetB = (b.dayIndex - baseParts.dayOfWeek + 7) % 7;
      return offsetA - offsetB;
    });
  }

  let hasExplicitDayTarget = false;
  let dayOffset = 0;

  if (detectedWeekdays.length > 0) {
    hasExplicitDayTarget = true;
    const firstDay = detectedWeekdays[0].dayIndex;
    const nextDate = getNextValidDateForDayOfWeek(firstDay, baseDate, tz, {
      forceNextWeek: prompt.includes('depan'),
    });
    dayOffset = nextDate.dayOffset;
  } else if (prompt.includes('besok lusa')) {
    dayOffset = 2;
    hasExplicitDayTarget = true;
  } else if (prompt.includes('lusa')) {
    dayOffset = 2;
    hasExplicitDayTarget = true;
  } else if (prompt.includes('besok')) {
    dayOffset = 1;
    hasExplicitDayTarget = true;
  } else if (prompt.includes('3 hari lagi')) {
    dayOffset = 3;
    hasExplicitDayTarget = true;
  } else if (prompt.includes('minggu depan')) {
    dayOffset = 7;
    hasExplicitDayTarget = false; // Horizon fleksibel pekan depan, bukan hari tertentu
  } else if (prompt.includes('minggu ini')) {
    dayOffset = 0;
    hasExplicitDayTarget = false; // Horizon fleksibel pekan berjalan
  } else if (
    prompt.includes('hari ini') ||
    prompt.includes('malam ini') ||
    prompt.includes('pagi ini') ||
    prompt.includes('siang ini') ||
    prompt.includes('sore ini')
  ) {
    dayOffset = 0;
    hasExplicitDayTarget = true;
  }

  // Calculate target date parts in the given timezone
  const targetDateObj = addDaysInTimezone(baseDate, dayOffset, tz);
  const targetParts = getPartsInTimezone(targetDateObj, tz);

  // 2. Identify fixed commitment keywords vs flexible tasks:
  // e.g. "kelas", "kuliah", "webinar", "rapat", "meeting", "janji", "jadwal", "workshop", "seminar"
  const isCommitmentKeyword = /\b(kelas|kuliah|webinar|rapat|meeting|janji|jadwal|workshop|seminar|konsultasi|kursus)\b/i.test(prompt);

  // 3. Detect start-end range:
  // e.g. "jam 7 malam sampai jam 10 malam", "jam 7 sampai 10 malam", "19.00 - 22.00", "pukul 20.00 sampai 21.00"
  let fixedStartHour: number | null = null;
  let fixedStartMin: number = 0;
  let fixedEndHour: number | null = null;
  let fixedEndMin: number = 0;
  let hasExplicitRange = false;

  // Pattern: "19.00 - 22.00" or "pukul 20.00 sampai 21.00" or "jam 08.30 - 10.00"
  const colonRangeMatch = prompt.match(/(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})\s*(?:-|–|sampai|s\/d|hingga)\s*(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})/i);
  if (colonRangeMatch) {
    fixedStartHour = parseInt(colonRangeMatch[1], 10);
    fixedStartMin = parseInt(colonRangeMatch[2], 10);
    fixedEndHour = parseInt(colonRangeMatch[3], 10);
    fixedEndMin = parseInt(colonRangeMatch[4], 10);
    hasExplicitRange = true;
  }

  // Pattern: "jam 7 malam sampai (jam) 10 malam", "jam 7 sampai 10 malam"
  if (fixedStartHour === null) {
    const wordRangeMatch = prompt.match(/(?:dari\s+)?(?:jam|pukul)\s*(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam)?\s*(?:sampai|hingga|s\/d|-|–)\s*(?:jam|pukul)?\s*(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (wordRangeMatch) {
      let sH = parseInt(wordRangeMatch[1], 10);
      const sM = wordRangeMatch[2] ? parseInt(wordRangeMatch[2], 10) : 0;
      const sPeriod = wordRangeMatch[3];
      let eH = parseInt(wordRangeMatch[4], 10);
      const eM = wordRangeMatch[5] ? parseInt(wordRangeMatch[5], 10) : 0;
      const ePeriod = wordRangeMatch[6] || sPeriod;

      const overallIsNight = ePeriod === 'malam' || sPeriod === 'malam' || prompt.includes('malam');
      const overallIsAfternoon = ePeriod === 'sore' || sPeriod === 'sore' || prompt.includes('sore');
      const overallIsNoon = ePeriod === 'siang' || sPeriod === 'siang' || prompt.includes('siang');

      if (overallIsNight) {
        if (sH < 12) sH += 12;
        if (eH < 12) eH += 12;
      } else if (overallIsAfternoon) {
        if (sH <= 6) sH += 12;
        if (eH <= 6) eH += 12;
      } else if (overallIsNoon) {
        if (sH >= 1 && sH <= 3) sH += 12;
        if (eH >= 1 && eH <= 3) eH += 12;
      }

      fixedStartHour = sH;
      fixedStartMin = sM;
      fixedEndHour = eH;
      fixedEndMin = eM;
      hasExplicitRange = true;
    }
  }

  // 4. Detect single specific time: e.g. "pukul 22.00", "jam 9 malam", "pukul 21.00", "tidur pukul 22.00"
  let hasExplicitExactTime = false;
  if (fixedStartHour === null) {
    const singleTimeMatch = prompt.match(/(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (singleTimeMatch) {
      let h = parseInt(singleTimeMatch[1], 10);
      const m = singleTimeMatch[2] ? parseInt(singleTimeMatch[2], 10) : 0;
      const period = singleTimeMatch[3];

      const isNight = period === 'malam' || prompt.includes('malam');
      const isAfternoon = period === 'sore' || prompt.includes('sore');
      const isNoon = period === 'siang' || prompt.includes('siang');

      if (isNight && h < 12) {
        h += 12; // 9 malam -> 21
      } else if (isAfternoon && h <= 6) {
        h += 12; // 3 sore -> 15
      } else if (isNoon && h >= 1 && h <= 3) {
        h += 12; // 1 siang -> 13
      }

      fixedStartHour = h;
      fixedStartMin = m;
      hasExplicitExactTime = true;
    } else {
      if (prompt.includes('sembilan malam') || prompt.includes('9 malam')) {
        fixedStartHour = 21;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes('tujuh malam') || prompt.includes('7 malam')) {
        fixedStartHour = 19;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes('delapan malam') || prompt.includes('8 malam')) {
        fixedStartHour = 20;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes('sepuluh malam') || prompt.includes('10 malam')) {
        fixedStartHour = 22;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      }
    }
  }

  // 5. Determine Duration:
  let duration = 60;
  const wordToNum: Record<string, number> = {
    se: 1,
    satu: 1,
    dua: 2,
    tiga: 3,
    empat: 4,
    lima: 5,
    enam: 6,
    tujuh: 7,
    delapan: 8,
  };
  const durMatch = prompt.match(/(\d+)\s*(menit|mnt|jam)/i);
  const wordDurMatch = prompt.match(/(?:selama\s+)?(se|satu|dua|tiga|empat|lima|enam|tujuh|delapan)\s*jam/i);
  const wordMinMatch = prompt.match(/(?:selama\s+)?(tiga puluh|empat puluh lima)\s*(?:menit|mnt)/i);

  if (durMatch) {
    const val = parseInt(durMatch[1], 10);
    const unit = durMatch[2].toLowerCase();
    if (unit === 'jam') {
      duration = val * 60;
    } else {
      duration = val;
    }
  } else if (wordDurMatch) {
    const word = wordDurMatch[1].toLowerCase();
    const multiplier = wordToNum[word] || 1;
    duration = multiplier * 60;
  } else if (wordMinMatch) {
    if (wordMinMatch[1].includes('tiga puluh')) duration = 30;
    else if (wordMinMatch[1].includes('empat puluh lima')) duration = 45;
  } else if (prompt.includes('sejam') || prompt.includes('1 jam')) {
    duration = 60;
  } else if (prompt.includes('setengah jam')) {
    duration = 30;
  } else if (fixedStartHour !== null && fixedEndHour !== null) {
    let startTotal = fixedStartHour * 60 + fixedStartMin;
    let endTotal = fixedEndHour * 60 + fixedEndMin;
    // Cross midnight range (e.g. 23:00 - 02:00)
    if (endTotal < startTotal) {
      endTotal += 24 * 60;
    }
    if (endTotal > startTotal) {
      duration = endTotal - startTotal;
    }
  } else if (prompt.includes('tidur') && !durMatch) {
    // Default sleep duration: 8 hours (480 minutes)
    duration = 480;
  }

  // 6. Calculate fixedEndHour / fixedEndMin if fixedStartHour is known
  if (fixedStartHour !== null && fixedEndHour === null) {
    const startTotal = fixedStartHour * 60 + fixedStartMin;
    const endTotal = startTotal + duration;
    fixedEndHour = Math.floor(endTotal / 60) % 24;
    fixedEndMin = endTotal % 60;
  }

  // 7. Determine timeConstraintType:
  // - 'fixed_event':
  //    * Explicit range specified ("jam 7 sampai 10 malam", "20.00-21.00")
  //    * Commitment keywords ("kelas", "rapat", "kuliah", "webinar")
  //    * Explicit exact time anchor like "tidur pukul 22.00", "rapat besok jam 20.00"
  // - 'preferred_window':
  //    * Mentions part of day without strict start-end ("tidur malam", "belajar malam", "olahraga pagi", "besok sore")
  //    * Flexible tasks like "malam ini jam 9 belajar" where user requested a time window
  // - 'deadline_only':
  //    * Pure deadline or flexible without window
  let timeConstraintType: 'fixed_event' | 'preferred_window' | 'deadline_only' = 'deadline_only';
  let requestedStartAt: string | undefined = undefined;
  let requestedEndAt: string | undefined = undefined;
  let preferredWindow: { startHour: number; startMinute?: number; endHour: number; endMinute?: number; label?: string } | undefined = undefined;
  let preferredTimeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY' = 'ANY';

  // Check if task is explicitly flexible learning/work vs fixed commitment
  const isFlexibleLearningOrTask = /\b(belajar|kerja|mengerjakan|ngerjain|tugas|baca|membaca|fokus|cicil|desain|design|ngoding|coding|nulis|menulis|bikin|membuat|lanjut)\b/i.test(prompt);

  // Prayer time anchors (Magrib, Isya, Subuh, Dzuhur, Ashar)
  const isAfterMagrib = /\b(habis\s+magrib|setelah\s+magrib|sehabis\s+magrib|ba'?da\s+magrib|magrib|habis\s+isya|setelah\s+isya|isya)\b/i.test(prompt);

  // Exact fixed event cases:
  // - Explicit range (e.g. "20.00 sampai 21.00", "jam 7 sampai 10 malam")
  // - Commitment keyword with specific time (e.g. "rapat jam 20.00", "kelas jam 19.00")
  // - Exact anchor without flexible keywords (e.g. "tidur pukul 22.00", "pukul 22.00")
  const isExactFixedEvent =
    fixedStartHour !== null &&
    (hasExplicitRange ||
      isCommitmentKeyword ||
      (!isFlexibleLearningOrTask && (prompt.includes('pukul') || prompt.includes('jam'))) ||
      prompt.includes('tidur pukul') ||
      prompt.includes('tidur jam'));

  let targetOccurrences: TaskOccurrence[] | undefined = undefined;
  let targetDays: number[] | undefined = detectedWeekdays.length > 0 ? detectedWeekdays.map((dw) => dw.dayIndex) : undefined;

  if (isExactFixedEvent && fixedStartHour !== null) {
    timeConstraintType = 'fixed_event';

    if (detectedWeekdays.length > 0) {
      targetOccurrences = detectedWeekdays.map((dw) => {
        const nextDate = getNextValidDateForDayOfWeek(dw.dayIndex, baseDate, tz, {
          targetHour: fixedStartHour!,
          targetMinute: fixedStartMin,
          forceNextWeek: prompt.includes('depan'),
          weekOffset: prompt.includes('minggu depan') ? 1 : 0,
        });

        const occStartIso = createIsoInTimezone(
          nextDate.year,
          nextDate.month,
          nextDate.day,
          fixedStartHour!,
          fixedStartMin,
          0,
          tz
        );
        const occStartDate = new Date(occStartIso);
        const occEndDate = new Date(occStartDate.getTime() + duration * 60000);
        return {
          dayName: dw.dayName,
          dayOfWeek: dw.dayIndex,
          requestedStartAt: occStartIso,
          requestedEndAt: occEndDate.toISOString(),
          label: `${dw.dayName} (${String(fixedStartHour).padStart(2, '0')}:${String(fixedStartMin).padStart(2, '0')})`,
        };
      });

      requestedStartAt = targetOccurrences[0].requestedStartAt;
      requestedEndAt = targetOccurrences[0].requestedEndAt;
    } else {
      // Construct start ISO in target timezone
      requestedStartAt = createIsoInTimezone(
        targetParts.year,
        targetParts.month,
        targetParts.day,
        fixedStartHour,
        fixedStartMin,
        0,
        tz
      );

      // Calculate end ISO, handling cross-midnight seamlessly
      const startDateObj = new Date(requestedStartAt);
      const endDateObj = new Date(startDateObj.getTime() + duration * 60000);
      requestedEndAt = endDateObj.toISOString();
    }

    preferredTimeOfDay = fixedStartHour >= 18 ? 'EVENING' : fixedStartHour >= 12 ? 'AFTERNOON' : 'MORNING';
  } else if (fixedStartHour !== null) {
    // Single time specified in flexible task: e.g. "malam ini jam 9 belajar materi React 45 menit"
    timeConstraintType = 'preferred_window';
    const windowEndHour = Math.min(23, fixedStartHour + Math.ceil(duration / 60) + 1);
    preferredWindow = {
      startHour: fixedStartHour,
      startMinute: fixedStartMin,
      endHour: windowEndHour,
      endMinute: 0,
      label: `Malam (${String(fixedStartHour).padStart(2, '0')}:${String(fixedStartMin).padStart(2, '0')} - ${String(windowEndHour).padStart(2, '0')}:00)`,
    };
    preferredTimeOfDay = fixedStartHour >= 18 ? 'EVENING' : fixedStartHour >= 12 ? 'AFTERNOON' : 'MORNING';

    // For compatibility with tests that check suggested start time on flexible tasks
    requestedStartAt = createIsoInTimezone(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      fixedStartHour,
      fixedStartMin,
      0,
      tz
    );
  } else if (isAfterMagrib) {
    // Habis magrib / isya evening task
    timeConstraintType = 'preferred_window';
    preferredWindow = {
      startHour: 18,
      startMinute: 30,
      endHour: 23,
      endMinute: 0,
      label: 'Habis Magrib / Malam (18:30 - 23:00)',
    };
    preferredTimeOfDay = 'EVENING';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  } else if (prompt.includes('malam')) {
    // Flexible evening task: e.g. "tidur malam", "belajar malam", "olahraga malam"
    // CRITICAL: requestedStartAt and requestedEndAt MUST BE UNDEFINED!
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 19, startMinute: 0, endHour: 23, endMinute: 0, label: 'Malam (19:00 - 23:00)' };
    preferredTimeOfDay = 'EVENING';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  } else if (prompt.includes('sore')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 15, startMinute: 0, endHour: 18, endMinute: 0, label: 'Sore (15:00 - 18:00)' };
    preferredTimeOfDay = 'AFTERNOON';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  } else if (prompt.includes('siang')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 13, startMinute: 0, endHour: 15, endMinute: 0, label: 'Siang (13:00 - 15:00)' };
    preferredTimeOfDay = 'AFTERNOON';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  } else if (prompt.includes('pagi')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 6, startMinute: 0, endHour: 12, endMinute: 0, label: 'Pagi (06:00 - 12:00)' };
    preferredTimeOfDay = 'MORNING';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  }

  // 8. Deadline calculation:
  let deadlineIso: string;
  let deadlineDaysFromNow: number;
  if (detectedDeadlineDay) {
    const nextDeadlineDate = getNextValidDateForDayOfWeek(detectedDeadlineDay.dayIndex, baseDate, tz, {
      targetHour: 23,
      targetMinute: 59,
      forceNextWeek: prompt.includes('depan'),
    });
    deadlineDaysFromNow = Math.max(1, nextDeadlineDate.dayOffset);
    deadlineIso = createIsoInTimezone(
      nextDeadlineDate.year,
      nextDeadlineDate.month,
      nextDeadlineDate.day,
      23,
      59,
      0,
      tz
    );
  } else if (prompt.includes('minggu ini')) {
    // Tenggat waktu akhir pekan berjalan (hari Minggu jam 23:59:00 WIB)
    const daysUntilEndOfWeek = (7 - baseParts.dayOfWeek) % 7;
    const endOfWeekObj = addDaysInTimezone(baseDate, daysUntilEndOfWeek, tz);
    const endOfWeekParts = getPartsInTimezone(endOfWeekObj, tz);
    deadlineDaysFromNow = Math.max(1, daysUntilEndOfWeek);
    deadlineIso = createIsoInTimezone(
      endOfWeekParts.year,
      endOfWeekParts.month,
      endOfWeekParts.day,
      23,
      59,
      0,
      tz
    );
  } else if (timeConstraintType === 'fixed_event' && requestedEndAt) {
    deadlineIso = requestedEndAt;
    deadlineDaysFromNow = Math.max(1, dayOffset);
  } else {
    // Target deadline at 23:00 for evening or 18:00 for standard daytime
    const deadlineHour = preferredTimeOfDay === 'EVENING' ? 23 : 18;
    deadlineIso = createIsoInTimezone(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      deadlineHour,
      0,
      0,
      tz
    );
    deadlineDaysFromNow = Math.max(1, dayOffset);
  }

  // 9. Multi-day duration ambiguity analysis:
  let isDurationAmbiguous = false;
  let totalDurationMinutes: number | undefined = undefined;
  let durationPerDayMinutes: number | undefined = undefined;
  let clarificationPrompt: string | undefined = undefined;

  const isMultiDay = detectedWeekdays.length > 1;
  const promptHasPerDayKeyword = /\b(per\s+hari|setiap\s+hari|tiap\s+hari|masing-masing|tiap\s+sesi|setiap\s+sesi)\b/i.test(prompt);
  const promptHasTotalSplitKeyword = /\b(total|dibagi|dibagi\s+rata|dipecah|dicicil)\b/i.test(prompt);

  if (isMultiDay && (durMatch || wordDurMatch)) {
    if (promptHasTotalSplitKeyword) {
      // Eksplisit total durasi dibagi rata
      isDurationAmbiguous = false;
      totalDurationMinutes = duration;
      durationPerDayMinutes = Math.round(duration / detectedWeekdays.length);
      duration = durationPerDayMinutes;
    } else if (promptHasPerDayKeyword) {
      // Eksplisit durasi per hari
      isDurationAmbiguous = false;
      durationPerDayMinutes = duration;
      totalDurationMinutes = duration * detectedWeekdays.length;
    } else {
      // Ambigu: misal "Belajar selama tiga jam pada Selasa dan Kamis"
      isDurationAmbiguous = true;
      totalDurationMinutes = duration;
      durationPerDayMinutes = duration;
      const hours = Math.round(duration / 60);
      const splitMinutes = Math.round(duration / detectedWeekdays.length);
      clarificationPrompt = `Apakah durasi ${hours} jam ini merupakan total yang dibagi rata untuk ${detectedWeekdays.length} hari (${splitMinutes} menit/hari), atau ${hours} jam penuh di setiap hari?`;
    }
  }

  // 10. Priority detection:
  let priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' = 'MEDIUM';
  if (prompt.includes('urgent') || prompt.includes('segera') || prompt.includes('penting sekali')) {
    priority = 'URGENT';
  } else if (prompt.includes('tinggi') || prompt.includes('prioritas') || isCommitmentKeyword) {
    priority = 'HIGH';
  } else if (prompt.includes('santai') || prompt.includes('low')) {
    priority = 'LOW';
  }

  // 11. Split policy:
  // Fixed events can NEVER be split!
  const allowSplit =
    timeConstraintType !== 'fixed_event' &&
    (promptHasTotalSplitKeyword || prompt.includes('bagi') || prompt.includes('sesi') || prompt.includes('cicil'));
  const minSession = 30;

  // 12. Title generation:
  const title = extractCleanActivityTitle(ctx.userPrompt);

  // 13. Explanation in Indonesian:
  let reasoning = '';
  if (timeConstraintType === 'fixed_event') {
    if (targetOccurrences && targetOccurrences.length > 1) {
      reasoning = `AI mendeteksi ${targetOccurrences.length} komitmen waktu tetap terpisah (${targetOccurrences.map((o) => o.dayName).join(' dan ')}) pukul ${fixedStartHour ? String(fixedStartHour).padStart(2, '0') : '00'}:${String(fixedStartMin).padStart(2, '0')} - ${fixedEndHour ? String(fixedEndHour).padStart(2, '0') : '00'}:${String(fixedEndMin).padStart(2, '0')} sehingga dijadwalkan per hari tanpa digeser.`;
    } else {
      reasoning = `AI mendeteksi komitmen waktu tetap (${fixedStartHour ? String(fixedStartHour).padStart(2, '0') : '00'}:${String(fixedStartMin).padStart(2, '0')} - ${fixedEndHour ? String(fixedEndHour).padStart(2, '0') : '00'}:${String(fixedEndMin).padStart(2, '0')}) sehingga dijaga tanpa digeser.`;
    }
  } else if (isDurationAmbiguous && clarificationPrompt) {
    reasoning = `AI mendeteksi alokasi waktu pada ${detectedWeekdays.map((d) => d.dayName).join(' dan ')} dengan durasi ${duration} menit (${Math.round(duration / 60)} jam). ${clarificationPrompt}`;
  } else if (detectedWeekdays.length > 1) {
    if (promptHasTotalSplitKeyword && totalDurationMinutes && durationPerDayMinutes) {
      reasoning = `Total waktu ${totalDurationMinutes} menit dibagi rata menjadi ${durationPerDayMinutes} menit per hari pada ${detectedWeekdays.map((d) => d.dayName).join(' dan ')}${preferredWindow ? ` (${preferredWindow.label})` : ''}${detectedDeadlineDay ? `, sebelum batas tenggat waktu hari ${detectedDeadlineDay.dayName}` : ''}.`;
    } else {
      reasoning = `Dua sesi pengerjaan dijadwalkan masing-masing berdurasi ${duration} menit (${Math.round(duration / 60)} jam) pada ${detectedWeekdays.map((d) => d.dayName).join(' dan ')}${preferredWindow ? ` (${preferredWindow.label})` : ''}${detectedDeadlineDay ? `, sebelum batas tenggat waktu hari ${detectedDeadlineDay.dayName}` : ''}.`;
    }
  } else if (preferredWindow) {
    reasoning = `AI menetapkan jendela preferensi ${preferredWindow.label} dengan durasi ${duration} menit agar sesuai dengan waktu ${preferredTimeOfDay === 'EVENING' ? 'santai atau fokus malam' : preferredTimeOfDay.toLowerCase()} Anda.`;
  } else {
    reasoning = `AI menetapkan estimasi durasi ${duration} menit dengan tenggat waktu ${deadlineDaysFromNow === 0 ? 'hari ini' : `${deadlineDaysFromNow} hari ke depan`}.`;
  }

  return {
    title,
    description: `Catatan asli: "${ctx.userPrompt}"`,
    estimatedDurationMinutes: duration,
    timeConstraintType,
    requestedStartAt,
    requestedEndAt,
    targetDays,
    targetOccurrences,
    isRecurring: promptIsRecurring || (detectedWeekdays.length > 1),
    recurrenceRule: (promptIsRecurring || detectedWeekdays.length > 1) ? 'WEEKLY_ON_DAYS' : undefined,
    hasExplicitDayTarget,
    isDayAmbiguous: isCommitmentKeyword && !hasExplicitDayTarget,
    isDurationAmbiguous,
    totalDurationMinutes,
    durationPerDayMinutes,
    clarificationPrompt,
    preferredWindow,
    preferredTimeOfDay,
    deadlineAt: deadlineIso,
    deadlineDaysFromNow,
    timezone: tz,
    priority,
    allowSplit,
    minimumSessionMinutes: minSession,
    reasoning,
  };
}

export { addDaysInTimezone };
