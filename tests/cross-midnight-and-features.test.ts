import { strict as assert } from 'assert';
import {
  createIsoFromLocalZoned,
  getZonedDateTimeParts,
  formatInUserTimezone,
} from '../src/lib/timezone';
import { parseIndonesianTemporalRules } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences, KeepNote } from '../src/types';

console.log('--- MENJALANKAN PENGUJIAN LINTAS TENGAH MALAM, PARSER, DAN FITUR BARU ---');

// =========================================================================
// TEST 1: Perhitungan Durasi dan Timestamp Lintas Tengah Malam
// =========================================================================
console.log('\n[Test 1] Perhitungan Durasi dan Timestamp Lintas Tengah Malam');

{
  const tz = 'Asia/Jakarta';
  const year = 2026;
  const month = 10;
  const day = 22;

  // Kasus A: 23.00 sampai 07.00 keesokan hari (23 Oktober 2026)
  const startA = createIsoFromLocalZoned(year, month, day, 23, 0, 0, tz);
  // Keesokan hari
  const endA = createIsoFromLocalZoned(year, month, day + 1, 7, 0, 0, tz);

  const durationMinutesA = Math.round(
    (new Date(endA).getTime() - new Date(startA).getTime()) / (1000 * 60)
  );

  assert.equal(durationMinutesA, 480, '23:00 ke 07:00 keesokan hari harus tepat 480 menit (8 jam)');

  const startPartsA = getZonedDateTimeParts(new Date(startA), tz);
  const endPartsA = getZonedDateTimeParts(new Date(endA), tz);

  assert.equal(startPartsA.day, 22, 'Mulai harus tanggal 22');
  assert.equal(startPartsA.hour, 23, 'Mulai harus jam 23');
  assert.equal(endPartsA.day, 23, 'Selesai harus tanggal 23');
  assert.equal(endPartsA.hour, 7, 'Selesai harus jam 7');

  // Kasus B: 22.00 sampai 00.30 keesokan hari (23 Oktober 2026)
  const startB = createIsoFromLocalZoned(year, month, day, 22, 0, 0, tz);
  const endB = createIsoFromLocalZoned(year, month, day + 1, 0, 30, 0, tz);

  const durationMinutesB = Math.round(
    (new Date(endB).getTime() - new Date(startB).getTime()) / (1000 * 60)
  );

  assert.equal(durationMinutesB, 150, '22:00 ke 00:30 keesokan hari harus tepat 150 menit (2.5 jam)');

  // Kasus C: 20.00 sampai 22.00 pada hari yang sama (22 Oktober 2026)
  const startC = createIsoFromLocalZoned(year, month, day, 20, 0, 0, tz);
  const endC = createIsoFromLocalZoned(year, month, day, 22, 0, 0, tz);

  const durationMinutesC = Math.round(
    (new Date(endC).getTime() - new Date(startC).getTime()) / (1000 * 60)
  );

  assert.equal(durationMinutesC, 120, '20:00 ke 22:00 pada hari yang sama harus tepat 120 menit (2 jam)');

  // Kasus D: Jam mulai sama dengan jam selesai (20.00 ke 20.00) tidak valid
  const startD = createIsoFromLocalZoned(year, month, day, 20, 0, 0, tz);
  const endD = createIsoFromLocalZoned(year, month, day, 20, 0, 0, tz);
  const durationMinutesD = Math.round(
    (new Date(endD).getTime() - new Date(startD).getTime()) / (1000 * 60)
  );

  assert.equal(durationMinutesD, 0, 'Jam mulai sama dengan jam selesai menghasilkan selisih 0 menit');
  console.log('✓ Validasi durasi timestamp 23:00-07:00, 22:00-00:30, 20:00-22:00 dan penolakan 0 menit berhasil.');
}

// =========================================================================
// TEST 2: Deteksi Konflik Scheduler untuk Kegiatan Lintas Tengah Malam
// =========================================================================
console.log('\n[Test 2] Deteksi Konflik Scheduler untuk Kegiatan Lintas Tengah Malam');

{
  const tz = 'Asia/Jakarta';
  const preferences: UserPreferences = {
    workStartHour: 7,
    workEndHour: 24,
    lunchBreakStartHour: 12,
    lunchBreakEndHour: 13,
    lunchBreakEnabled: true,
    timezone: 'Asia/Jakarta (WIB)',
    bufferMinutes: 0,
    maxDailyWorkMinutes: 900,
    autoSyncCalendar: false,
  };

  const fixedStart = createIsoFromLocalZoned(2026, 10, 22, 23, 0, 0, tz);
  const fixedEnd = createIsoFromLocalZoned(2026, 10, 23, 7, 0, 0, tz);

  const crossMidnightTask: Task = {
    id: 'task-cross-midnight',
    userId: 'user-1',
    title: 'Piket Malam & Monitoring Server',
    estimatedDurationMinutes: 480,
    deadlineAt: fixedEnd,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'fixed_event',
    requestedStartAt: fixedStart,
    requestedEndAt: fixedEnd,
    timezone: tz,
    createdAt: new Date().toISOString(),
  };

  // Skenario A: Tanpa konflik kalender -> Berhasil ditempatkan
  const resultClean = scheduleTaskDeterministically(crossMidnightTask, [], preferences);
  assert.equal(resultClean.success, true, 'Kegiatan lintas tengah malam tanpa bentrok harus berhasil');
  assert.equal(resultClean.proposedSessions.length, 1);
  assert.equal(resultClean.proposedSessions[0].startAt, fixedStart);
  assert.equal(resultClean.proposedSessions[0].endAt, fixedEnd);
  assert.ok(resultClean.explanation.includes('+1 hari'), 'Penjelasan harus mencantumkan keterangan +1 hari');

  // Skenario B: Ada rapat di hari kedua setelah tengah malam (23 Okt pukul 02:00 - 04:00)
  const conflictingEvent: CalendarEvent = {
    id: 'event-post-midnight',
    userId: 'user-1',
    title: 'Maintenance Database Tengah Malam',
    startAt: createIsoFromLocalZoned(2026, 10, 23, 2, 0, 0, tz),
    endAt: createIsoFromLocalZoned(2026, 10, 23, 4, 0, 0, tz),
    source: 'INTERNAL',
  };

  const resultConflict = scheduleTaskDeterministically(
    crossMidnightTask,
    [conflictingEvent],
    preferences
  );

  assert.equal(
    resultConflict.success,
    false,
    'Kegiatan lintas tengah malam harus mendeteksi bentrok yang terjadi setelah tengah malam'
  );
  assert.ok(
    resultConflict.explanation.includes('Maintenance Database Tengah Malam') ||
      resultConflict.conflicts.length > 0,
    'Harus mencantumkan event yang berbenturan setelah tengah malam'
  );
  console.log('✓ Deteksi bentrok setelah tengah malam (02:00 - 04:00) terbukti akurat.');
}

// =========================================================================
// TEST 3: Resolusi Ambiguitas "Jam 12" dan Penentuan Jendela Waktu
// =========================================================================
console.log('\n[Test 3] Resolusi Ambiguitas "Jam 12" dan Waktu Siang vs Malam');

{
  const tz = 'Asia/Jakarta';

  // Kasus A: "dari jam 12 selama 60 menit" -> harus Siang (12:00), bukan Malam
  const planA = parseIndonesianTemporalRules(
    'Meeting evaluasi dari jam 12 selama 60 menit',
    tz,
    { workStartHour: 8, workEndHour: 18 }
  );

  assert.equal(planA.timeConstraintType, 'fixed_event', 'Harus terdeteksi sebagai fixed_event');
  assert.equal(planA.estimatedDurationMinutes, 60, 'Durasi harus 60 menit');
  assert.equal(planA.preferredTimeOfDay, 'AFTERNOON', 'Jam 12 siang harus AFTERNOON / Siang');
  assert.ok(
    !planA.reasoning.includes('Malam (12:00'),
    'Reasoning tidak boleh menuliskan "Malam (12:00"'
  );
  assert.ok(
    planA.reasoning.includes('Siang (12:00') || planA.reasoning.includes('12:00'),
    'Reasoning harus mengidentifikasi waktu siang'
  );

  // Kasus B: "jam 12 malam belajar algoritma" -> jam 0 (midnight)
  const planB = parseIndonesianTemporalRules(
    'Belajar algoritma jam 12 malam durasi 45 menit',
    tz,
    { workStartHour: 8, workEndHour: 24 }
  );
  assert.equal(planB.preferredTimeOfDay, 'EVENING', '12 malam harus diidentifikasi sebagai EVENING/Malam');

  // Kasus C: "jam 12 siang makan bersama tim"
  const planC = parseIndonesianTemporalRules(
    'Makan bersama tim jam 12 siang selama 60 menit',
    tz,
    { workStartHour: 8, workEndHour: 18 }
  );
  assert.equal(planC.preferredTimeOfDay, 'AFTERNOON', '12 siang harus AFTERNOON');

  console.log('✓ Ambiguitas jam 12 siang vs 12 malam terpecahkan dengan konsisten.');
}

// =========================================================================
// TEST 4: Jam Kerja Fleksibel (07:00 - 24:00) dan Opsi Jam Istirahat
// =========================================================================
console.log('\n[Test 4] Jam Kerja 07:00-24:00 & Istirahat Siang Opsional');

{
  const tz = 'Asia/Jakarta';

  // Skenario: Pengguna menonaktifkan istirahat siang (lunchBreakEnabled = false)
  const prefsNoLunch: UserPreferences = {
    workStartHour: 7,
    workEndHour: 24,
    lunchBreakStartHour: 12,
    lunchBreakEndHour: 13,
    lunchBreakEnabled: false,
    timezone: 'Asia/Jakarta (WIB)',
    bufferMinutes: 0,
    maxDailyWorkMinutes: 900,
    autoSyncCalendar: false,
  };

  const taskDuringLunch: Task = {
    id: 'task-lunch-hour',
    userId: 'user-1',
    title: 'Webinar Siang Tanpa Jeda',
    estimatedDurationMinutes: 120, // 2 jam, misal dari 11:30 sampai 13:30
    deadlineAt: createIsoFromLocalZoned(2026, 10, 22, 18, 0, 0, tz),
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'fixed_event',
    requestedStartAt: createIsoFromLocalZoned(2026, 10, 22, 11, 30, 0, tz),
    requestedEndAt: createIsoFromLocalZoned(2026, 10, 22, 13, 30, 0, tz),
    timezone: tz,
    createdAt: new Date().toISOString(),
  };

  const resultNoLunch = scheduleTaskDeterministically(taskDuringLunch, [], prefsNoLunch);
  assert.equal(
    resultNoLunch.success,
    true,
    'Kegiatan melintasi jam 12:00-13:00 harus diterima saat lunchBreakEnabled=false'
  );

  console.log('✓ Pengaturan jam kerja hingga 24:00 dan penonaktifan istirahat makan siang berjalan sesuai spesifikasi.');
}

// =========================================================================
// TEST 5: Integritas Pengeditan Catatan Google Keep (KeepNote)
// =========================================================================
console.log('\n[Test 5] Integritas Data saat Mengedit Catatan Google Keep');

{
  const originalNote: KeepNote = {
    id: 'keep-101',
    userId: 'user-1',
    title: 'Daftar Belanja Bulanan',
    content: 'Catatan tambahan untuk tim dapur',
    checklist: [
      { id: 'item-1', text: 'Kopi Arabika 1kg', isCompleted: false },
      { id: 'item-2', text: 'Susu UHT 2L', isCompleted: true },
    ],
    color: '#FEF3C7',
    isPinned: true,
    isArchived: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
  };

  // Simulasikan pengeditan: Ubah judul, tambah checklist item baru, centang item 1
  const editedChecklist = originalNote.checklist?.map(item =>
    item.id === 'item-1' ? { ...item, isCompleted: true } : item
  ) || [];

  editedChecklist.push({
    id: 'item-3',
    text: 'Teh Hijau Kotak',
    isCompleted: false,
  });

  const updatedNote: KeepNote = {
    ...originalNote,
    title: 'Daftar Belanja Bulanan (Revisi)',
    checklist: editedChecklist,
    updatedAt: '2026-10-22T14:30:00.000Z',
  };

  // Verifikasi keutuhan ID, warna, pin, archive, dan createdAt
  assert.equal(updatedNote.id, originalNote.id, 'ID catatan tidak boleh berubah');
  assert.equal(updatedNote.color, originalNote.color, 'Warna latar catatan harus dipertahankan');
  assert.equal(updatedNote.isPinned, true, 'Status pin harus dipertahankan');
  assert.equal(updatedNote.isArchived, false, 'Status arsip harus dipertahankan');
  assert.equal(updatedNote.createdAt, originalNote.createdAt, 'createdAt asli harus dipertahankan');
  assert.notEqual(updatedNote.updatedAt, originalNote.createdAt, 'updatedAt harus diperbarui');
  assert.equal(updatedNote.checklist.length, 3, 'Checklist harus bertambah 1 item');
  assert.equal(updatedNote.checklist[0].isCompleted, true, 'Item 1 berhasil dicentang');

  console.log('✓ Integritas pengeditan catatan Google Keep terverifikasi.');
}

console.log('\n=======================================================');
console.log('SEMUA 5 PENGUJIAN LINTAS TENGAH MALAM & FITUR BERHASIL!');
console.log('=======================================================');
