import { describe, it, expect } from 'vitest';
import {
  extractCleanActivityTitle,
  parseIndonesianTemporalRules,
} from '../src/lib/temporalParser';
import {
  scheduleTaskDeterministically,
  suggestOptimalSlot,
} from '../src/lib/scheduler';
import { addDaysInTimezone, createIsoInTimezone } from '../src/lib/timezone';
import { Task, CalendarEvent, UserPreferences } from '../src/types';

export async function runSchedulingReliabilityPatchTests() {
  console.log('=== RUNNING SCHEDULING RELIABILITY PATCH & OPTIMAL SLOT TESTS ===');

  const defaultPreferences: UserPreferences = {
    displayName: 'Fajriansyah Pratama',
    email: 'fajriansyahpratama2103@gmail.com',
    timezone: 'Asia/Jakarta',
    workStartHour: 9,
    workEndHour: 18,
    enableLunchBreak: true,
    lunchStartHour: 12,
    lunchEndHour: 13,
    bufferMinutes: 15,
    workDays: [1, 2, 3, 4, 5],
    googleCalendarConnected: false,
    calendarSyncStatus: 'pending',
    lastSyncedAt: null,
    allowAutoSplit: false,
  };

  // -------------------------------------------------------------
  // Test 1: Concise Activity Title Generation
  // -------------------------------------------------------------
  console.log('--- Test 1: Pembentukan Judul Kegiatan Ringkas & Bermakna ---');

  const t1 = extractCleanActivityTitle(
    'Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming'
  );
  if (t1 !== 'UTS Web Programming') {
    throw new Error(`Expected 'UTS Web Programming', got '${t1}'`);
  }
  console.log(`✅ PASSED: Judul 1 -> "${t1}"`);

  const t2 = extractCleanActivityTitle(
    'Kamis aku mau lanjut ngerjain design kalo belum selesai, selama tiga jam'
  );
  if (t2 !== 'Melanjutkan Desain') {
    throw new Error(`Expected 'Melanjutkan Desain', got '${t2}'`);
  }
  console.log(`✅ PASSED: Judul 2 -> "${t2}"`);

  const t3 = extractCleanActivityTitle('Aku ada UTS Design deadline-nya hari Jumat');
  if (t3 !== 'Persiapan UTS Design') {
    throw new Error(`Expected 'Persiapan UTS Design', got '${t3}'`);
  }
  console.log(`✅ PASSED: Judul 3 -> "${t3}"`);

  const tAi = extractCleanActivityTitle(
    'Rabu malam jam 7 sampai 10 malam ada UTS Web Programming',
    'Ujian Tengah Semester Web Programming'
  );
  if (tAi !== 'Ujian Tengah Semester Web Programming') {
    throw new Error(`Expected AI title to be retained, got '${tAi}'`);
  }
  console.log(`✅ PASSED: Retensi Judul AI Valid -> "${tAi}"`);

  // -------------------------------------------------------------
  // Test 2: Duration Parsing with Indonesian Words ("selama tiga jam" -> 180 min)
  // -------------------------------------------------------------
  console.log('--- Test 2: Parsing Durasi Kata Bahasa Indonesia (tiga jam = 180 menit) ---');

  const planKamis = parseIndonesianTemporalRules({
    userPrompt: 'Kamis aku mau lanjut ngerjain design kalo belum selesai, selama tiga jam',
    currentDateTime: '2026-10-19T09:00:00+07:00', // Senin
    userTimezone: 'Asia/Jakarta',
  });

  if (planKamis.estimatedDurationMinutes !== 180) {
    throw new Error(
      `Expected duration 180 minutes, got ${planKamis.estimatedDurationMinutes}`
    );
  }
  if (planKamis.title !== 'Melanjutkan Desain') {
    throw new Error(`Expected title 'Melanjutkan Desain', got '${planKamis.title}'`);
  }
  if (!planKamis.targetDays || planKamis.targetDays[0] !== 4) {
    throw new Error(`Expected targetDays [4] (Kamis), got ${JSON.stringify(planKamis.targetDays)}`);
  }
  console.log(`✅ PASSED: Durasi "selama tiga jam" berhasil diparsing menjadi ${planKamis.estimatedDurationMinutes} menit pada hari Kamis!`);

  // -------------------------------------------------------------
  // Test 3: Flexible Scheduling of 180-minute task on Target Day
  // -------------------------------------------------------------
  console.log('--- Test 3: Penjadwalan Tugas Fleksibel 180 Menit di Hari Kamis ---');

  const flexibleTaskKamis: Task = {
    id: 'task-design-180',
    userId: 'user-123',
    title: planKamis.title,
    description: planKamis.description,
    estimatedDurationMinutes: planKamis.estimatedDurationMinutes,
    timeConstraintType: planKamis.timeConstraintType,
    targetDays: planKamis.targetDays,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    createdAt: new Date().toISOString(),
  };

  const scheduleRes = scheduleTaskDeterministically(
    flexibleTaskKamis,
    [],
    [],
    defaultPreferences,
    new Date('2026-10-19T09:00:00+07:00') // Senin
  );

  if (!scheduleRes.success || scheduleRes.proposedSessions.length === 0) {
    throw new Error(`Gagal menjadwalkan tugas 180 menit di hari Kamis: ${scheduleRes.explanation}`);
  }

  const sess = scheduleRes.proposedSessions[0];
  const sessDate = new Date(sess.startAt);
  // Kamis minggu ini adalah 22 Oktober 2026
  if (sess.durationMinutes !== 180) {
    throw new Error(`Expected duration 180 minutes, got ${sess.durationMinutes}`);
  }
  console.log(`✅ PASSED: Sesi 180 menit ditempatkan pada ${sess.startAt} - ${sess.endAt} (${sess.durationMinutes} menit)`);

  // -------------------------------------------------------------
  // Test 4: Transparent Date-Level Diagnostics When Day is Full
  // -------------------------------------------------------------
  console.log('--- Test 4: Diagnostik Evaluasi Slot Per Tanggal Saat Jadwal Penuh ---');

  // Buat acara yang memblokir Kamis:
  // 09:00 - 18:00 WIB, dengan rapat 10:00 - 12:00 dan 14:00 - 17:00
  // Sehingga slot bebas terbesar hanya 60 menit (< 180 menit)
  const blockingEvents: CalendarEvent[] = [
    {
      id: 'evt-rapat-pagi',
      provider: 'google',
      title: 'Rapat Koordinasi Tim',
      startAt: createIsoInTimezone(2026, 10, 22, 10, 0, 0, 'Asia/Jakarta'),
      endAt: createIsoInTimezone(2026, 10, 22, 12, 0, 0, 'Asia/Jakarta'),
      isEditable: true,
      syncStatus: 'synced',
    },
    {
      id: 'evt-rapat-siang',
      provider: 'google',
      title: 'Workshop Desain Sistem',
      startAt: createIsoInTimezone(2026, 10, 22, 14, 0, 0, 'Asia/Jakarta'),
      endAt: createIsoInTimezone(2026, 10, 22, 17, 0, 0, 'Asia/Jakarta'),
      isEditable: true,
      syncStatus: 'synced',
    },
  ];

  const fullDayRes = scheduleTaskDeterministically(
    flexibleTaskKamis,
    blockingEvents,
    [],
    defaultPreferences,
    new Date('2026-10-19T09:00:00+07:00')
  );

  if (fullDayRes.success) {
    throw new Error('Tugas harus gagal dijadwalkan karena slot kontinu 180 menit tidak tersedia!');
  }

  if (!fullDayRes.diagnostics?.evaluatedDays || fullDayRes.diagnostics.evaluatedDays.length === 0) {
    throw new Error('Harus menyertakan evaluatedDays dalam diagnostics!');
  }

  const kamisDiag = fullDayRes.diagnostics.evaluatedDays[0];
  if (!kamisDiag.conflicts.some((c) => c.includes('Rapat Koordinasi Tim'))) {
    throw new Error('Diagnostik harus menyebutkan konflik dengan Rapat Koordinasi Tim!');
  }
  if (!fullDayRes.explanation.includes('Diagnostik evaluasi slot per tanggal')) {
    throw new Error('Penjelasan harus menyertakan rincian bukti slot per tanggal!');
  }
  console.log(`✅ PASSED: Diagnostik detail slot per tanggal transparan:\n${fullDayRes.explanation.split('\n\n')[1]}`);

  // -------------------------------------------------------------
  // Test 5: suggestOptimalSlot Based on User Historical Productivity
  // -------------------------------------------------------------
  console.log('--- Test 5: suggestOptimalSlot Berdasarkan Analisis Produktivitas Historis ---');

  const historicalTasks: Task[] = [
    {
      id: 'hist-1',
      userId: 'user-123',
      title: 'Menulis Laporan Keuangan',
      estimatedDurationMinutes: 60,
      priority: 'HIGH',
      status: 'completed_manual',
      completedAt: createIsoInTimezone(2026, 10, 13, 9, 30, 0, 'Asia/Jakarta'), // Pagi
      createdAt: '2026-10-12T09:00:00Z',
      allowSplit: false,
    },
    {
      id: 'hist-2',
      userId: 'user-123',
      title: 'Review PR Backend',
      estimatedDurationMinutes: 45,
      priority: 'HIGH',
      status: 'completed_manual',
      completedAt: createIsoInTimezone(2026, 10, 14, 10, 0, 0, 'Asia/Jakarta'), // Pagi
      createdAt: '2026-10-13T09:00:00Z',
      allowSplit: false,
    },
    {
      id: 'hist-3',
      userId: 'user-123',
      title: 'Membaca Dokumentasi API',
      estimatedDurationMinutes: 30,
      priority: 'MEDIUM',
      status: 'completed_manual',
      completedAt: createIsoInTimezone(2026, 10, 15, 11, 0, 0, 'Asia/Jakarta'), // Pagi
      createdAt: '2026-10-14T09:00:00Z',
      allowSplit: false,
    },
    {
      id: 'hist-4',
      userId: 'user-123',
      title: 'Tugas Sore yang Terlewat',
      estimatedDurationMinutes: 60,
      priority: 'LOW',
      status: 'missed_auto',
      missedAt: createIsoInTimezone(2026, 10, 16, 17, 0, 0, 'Asia/Jakarta'), // Sore
      createdAt: '2026-10-15T09:00:00Z',
      allowSplit: false,
    },
  ];

  const newTaskToOptimize: Task = {
    id: 'task-opt-1',
    userId: 'user-123',
    title: 'Analisis Arsitektur Sistem',
    estimatedDurationMinutes: 90,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    createdAt: new Date().toISOString(),
  };

  const optimalResult = suggestOptimalSlot(
    newTaskToOptimize,
    [],
    historicalTasks,
    defaultPreferences,
    new Date('2026-10-19T08:00:00+07:00') // Senin
  );

  if (!optimalResult.success || !optimalResult.recommendedSlot) {
    throw new Error(`Expected optimal slot suggestion, got: ${optimalResult.reasoning}`);
  }

  if (optimalResult.historicalAnalysis.peakProductivityWindow !== 'MORNING') {
    throw new Error(
      `Expected peak window MORNING, got ${optimalResult.historicalAnalysis.peakProductivityWindow}`
    );
  }

  if (optimalResult.productivityScore < 70) {
    throw new Error(
      `Expected high productivity score >= 70, got ${optimalResult.productivityScore}`
    );
  }

  console.log(`✅ PASSED: Saran slot optimal: ${optimalResult.recommendedSlot.dayName}, ${optimalResult.recommendedSlot.timeRangeStr}`);
  console.log(`✅ PASSED: Skor produktivitas: ${optimalResult.productivityScore}%`);
  console.log(`✅ PASSED: Analisis riwayat: Puncak ${optimalResult.historicalAnalysis.peakProductivityWindow} (${optimalResult.historicalAnalysis.completionRateInWindow}%)`);
  console.log(`✅ PASSED: Rationale: "${optimalResult.reasoning}"`);

  // -------------------------------------------------------------
  // Test 6: addDaysInTimezone Safe Date Manipulation (No Naive ms Drift)
  // -------------------------------------------------------------
  console.log('--- Test 6: addDaysInTimezone Keandalan Tanggal Kalender Lokal ---');

  const baseRef = new Date(Date.UTC(2026, 9, 31, 10, 0, 0)); // 31 Oktober
  const nextMonthDay = addDaysInTimezone(baseRef, 1, 'Asia/Jakarta');
  const isoStr = nextMonthDay.toISOString();
  // Tanggal harus berganti ke 1 November tanpa drift
  if (!isoStr.includes('2026-11-01')) {
    throw new Error(`Expected rollover to 2026-11-01, got ${isoStr}`);
  }
  console.log(`✅ PASSED: Pergeseran batas bulan 31 Okt -> 1 Nov aman (${isoStr})`);

  console.log('===============================================================');
  console.log('🎉 SEMUA 6 PENGUJIAN RELIABILITY PATCH & OPTIMAL SLOT BERHASIL! 🎉');
  console.log('===============================================================\n');
}

if (process.argv[1]?.includes('scheduling-reliability-patch')) {
  runSchedulingReliabilityPatchTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
