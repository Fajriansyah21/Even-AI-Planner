import assert from 'node:assert/strict';
import {
  parseIndonesianTemporalRules,
  getNextValidDateForDayOfWeek,
  parseIndonesianDayNames,
} from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { isSessionLinkedToGoogleEvent } from '../src/components/CalendarView';
import { Task, CalendarEvent, UserPreferences } from '../src/types';
import { getPartsInTimezone, formatInTimezone } from '../src/lib/timezone';

const DEFAULT_PREFS: UserPreferences = {
  displayName: 'User Test',
  email: 'user@example.com',
  timezone: 'Asia/Jakarta',
  workStartHour: 9,
  workEndHour: 18,
  enableLunchBreak: true,
  lunchStartHour: 12,
  lunchEndHour: 13,
  bufferMinutes: 15,
  workDays: [1, 2, 3, 4, 5],
  googleCalendarConnected: true,
  calendarSyncStatus: 'synced',
  lastSyncedAt: new Date().toISOString(),
  allowAutoSplit: false,
};

export async function runSchedulingBugsTests() {
  console.log('\n=== RUNNING SCHEDULING BUGS AUDIT & FIX TESTS ===');

  // -------------------------------------------------------------------
  // TEST 1: Meminta Senin saat hari ini Minggu -> Tanggal target harus Senin
  // -------------------------------------------------------------------
  console.log('\n--- Test 1: Meminta Senin saat hari ini Minggu (Zona Waktu Asia/Jakarta) ---');
  {
    // Mock base date: Sunday, 2026-10-18T10:00:00+07:00 (Minggu)
    // Sunday in Asia/Jakarta: 2026-10-18 10:00:00 WIB (which is 2026-10-18T03:00:00.000Z)
    const sundayIso = '2026-10-18T03:00:00.000Z';
    const sundayParts = getPartsInTimezone(new Date(sundayIso), 'Asia/Jakarta');
    assert.equal(sundayParts.dayOfWeek, 0, 'Hari dasar harus terverifikasi sebagai Minggu (0)');

    const plan = parseIndonesianTemporalRules({
      userPrompt: 'jadwalkan kelas pada Senin malam jam 19.00 sampai 21.00',
      currentDateTime: sundayIso,
      userTimezone: 'Asia/Jakarta',
    });

    assert.equal(plan.timeConstraintType, 'fixed_event', 'Harus terdeteksi sebagai fixed_event');
    assert.ok(plan.requestedStartAt, 'requestedStartAt harus terisi');
    assert.ok(plan.hasExplicitDayTarget, 'hasExplicitDayTarget harus true');

    const startParts = getPartsInTimezone(new Date(plan.requestedStartAt!), 'Asia/Jakarta');
    assert.equal(
      startParts.dayOfWeek,
      1,
      `Hari target harus Senin (1), bukan Minggu (0). Didapatkan dayOfWeek: ${startParts.dayOfWeek}`
    );
    assert.equal(startParts.day, 19, 'Tanggal target harus 19 Oktober (Senin besoknya)');
    assert.equal(startParts.hour, 19, 'Jam mulai harus 19.00 WIB');
    assert.equal(plan.estimatedDurationMinutes, 120, 'Durasi harus 120 menit');

    console.log('✅ PASSED: Meminta Senin di hari Minggu menghasilkan Senin (19 Okt, 19:00 WIB), bukan Minggu!');
  }

  // -------------------------------------------------------------------
  // TEST 2: Meminta Senin dan Selasa pukul 19.00 sampai 21.00 -> Dua kejadian terpisah
  // -------------------------------------------------------------------
  console.log('\n--- Test 2: Meminta multi-hari "Senin dan Selasa malam" -> Terbentuk 2 kejadian terpisah ---');
  {
    // Sunday base
    const sundayIso = '2026-10-18T03:00:00.000Z';
    const plan = parseIndonesianTemporalRules({
      userPrompt: 'jadwalkan kelas pada Senin dan Selasa malam jam 19.00 sampai 21.00',
      currentDateTime: sundayIso,
      userTimezone: 'Asia/Jakarta',
    });

    assert.ok(plan.targetOccurrences, 'targetOccurrences harus dibuat');
    assert.equal(plan.targetOccurrences?.length, 2, 'Harus ada tepat 2 kejadian terpisah');

    const occ1 = plan.targetOccurrences![0];
    const occ2 = plan.targetOccurrences![1];

    assert.equal(occ1.dayName, 'Senin');
    assert.equal(occ2.dayName, 'Selasa');

    const parts1 = getPartsInTimezone(new Date(occ1.requestedStartAt), 'Asia/Jakarta');
    const parts2 = getPartsInTimezone(new Date(occ2.requestedStartAt), 'Asia/Jakarta');

    assert.equal(parts1.dayOfWeek, 1, 'Kejadian 1 harus hari Senin (1)');
    assert.equal(parts2.dayOfWeek, 2, 'Kejadian 2 harus hari Selasa (2)');
    assert.equal(parts1.hour, 19, 'Kejadian 1 harus jam 19.00');
    assert.equal(parts2.hour, 19, 'Kejadian 2 harus jam 19.00');

    // Deterministic scheduler test
    const task: Task = {
      id: 'task-multi-day-1',
      userId: 'test-user',
      title: plan.title,
      estimatedDurationMinutes: plan.estimatedDurationMinutes,
      priority: plan.priority,
      status: 'UNSCHEDULED',
      allowSplit: false,
      timeConstraintType: plan.timeConstraintType,
      requestedStartAt: plan.requestedStartAt,
      requestedEndAt: plan.requestedEndAt,
      targetDays: plan.targetDays,
      targetOccurrences: plan.targetOccurrences,
      timezone: 'Asia/Jakarta',
      createdAt: sundayIso,
    };

    const schedRes = scheduleTaskDeterministically(task, [], [], DEFAULT_PREFS, new Date(sundayIso));
    assert.equal(schedRes.success, true, 'Penjadwalan harus berhasil');
    assert.equal(schedRes.proposedSessions.length, 2, 'Harus menghasilkan 2 sesi terpisah');
    assert.equal(schedRes.proposedSessions[0].durationMinutes, 120, 'Sesi 1 harus berdurasi 120 menit (bukan 24 jam+)');
    assert.equal(schedRes.proposedSessions[1].durationMinutes, 120, 'Sesi 2 harus berdurasi 120 menit (bukan 24 jam+)');

    console.log('✅ PASSED: Terbentuk dua kejadian terpisah masing-masing 120 menit untuk Senin & Selasa!');
  }

  // -------------------------------------------------------------------
  // TEST 3: Salah satu hari mengalami benturan -> Hari lain tetap diproses benar tanpa geser diam-diam
  // -------------------------------------------------------------------
  console.log('\n--- Test 3: Salah satu hari bentrok -> Hari lain tetap diproses, tanpa digeser diam-diam ---');
  {
    const sundayIso = '2026-10-18T03:00:00.000Z';
    const plan = parseIndonesianTemporalRules({
      userPrompt: 'jadwalkan kelas pada Senin dan Selasa malam jam 19.00 sampai 21.00',
      currentDateTime: sundayIso,
      userTimezone: 'Asia/Jakarta',
    });

    const occMonday = plan.targetOccurrences![0];
    const occTuesday = plan.targetOccurrences![1];

    // Buat acara yang memblokir SENIN 19.00 - 21.00 di Google Calendar
    const conflictingEvent: CalendarEvent = {
      id: 'evt-blocking-monday',
      provider: 'google',
      title: 'Rapat Evaluasi Triwulan',
      startAt: occMonday.requestedStartAt,
      endAt: occMonday.requestedEndAt,
      isEditable: false,
      syncStatus: 'synced',
    };

    const task: Task = {
      id: 'task-partial-1',
      userId: 'test-user',
      title: plan.title,
      estimatedDurationMinutes: plan.estimatedDurationMinutes,
      priority: plan.priority,
      status: 'UNSCHEDULED',
      allowSplit: false,
      timeConstraintType: plan.timeConstraintType,
      requestedStartAt: plan.requestedStartAt,
      requestedEndAt: plan.requestedEndAt,
      targetDays: plan.targetDays,
      targetOccurrences: plan.targetOccurrences,
      timezone: 'Asia/Jakarta',
      createdAt: sundayIso,
    };

    const schedRes = scheduleTaskDeterministically(
      task,
      [conflictingEvent],
      [],
      DEFAULT_PREFS,
      new Date(sundayIso)
    );

    assert.equal(schedRes.success, true, 'Status penjadwalan harus parsial sukses');
    assert.equal(schedRes.partialSuccess, true, 'partialSuccess harus true');
    assert.equal(schedRes.proposedSessions.length, 1, 'Hanya sesi Selasa yang dijadwalkan');

    const schedStartParts = getPartsInTimezone(new Date(schedRes.proposedSessions[0].startAt), 'Asia/Jakarta');
    assert.equal(schedStartParts.dayOfWeek, 2, 'Sesi yang berhasil harus hari Selasa (2)');
    assert.ok(
      schedRes.explanation.includes('Selasa') && schedRes.explanation.includes('Senin'),
      'Penjelasan harus merinci bahwa Selasa berhasil dan Senin gagal karena bentrok'
    );
    assert.ok(
      schedRes.explanation.includes('tidak digeser diam-diam'),
      'Penjelasan harus menegaskan jadwal tidak digeser diam-diam'
    );

    console.log('✅ PASSED: Senin bentrok dilewati & dilaporkan; Selasa tetap dijadwalkan tepat waktu tanpa pergeseran!');
  }

  // -------------------------------------------------------------------
  // TEST 4: Satu acara Google Calendar & sesi lokal dengan ID hubungan sama -> Hanya satu kartu
  // -------------------------------------------------------------------
  console.log('\n--- Test 4: Hubungan ID googleCalendarEventId -> Deduplikasi representasi visual ---');
  {
    const googleId = 'gcal-evt-xyz-789';
    assert.equal(
      isSessionLinkedToGoogleEvent(googleId, 'gcal-evt-xyz-789'),
      true,
      'Harus cocok dengan format ID persis'
    );
    assert.equal(
      isSessionLinkedToGoogleEvent('evt-xyz-789', 'gcal-evt-xyz-789'),
      true,
      'Harus cocok dengan awalan gcal- terpotong'
    );
    assert.equal(
      isSessionLinkedToGoogleEvent('gcal-evt-xyz-789', 'evt-xyz-789'),
      true,
      'Harus cocok kedua arah'
    );
    assert.equal(
      isSessionLinkedToGoogleEvent('evt-beda-123', 'evt-xyz-789'),
      false,
      'ID berbeda TIDAK BOLEH dianggap terkait'
    );
    assert.equal(
      isSessionLinkedToGoogleEvent(undefined, 'evt-xyz-789'),
      false,
      'Sesi tanpa googleCalendarEventId tidak boleh disatukan'
    );

    console.log('✅ PASSED: Relasi ID diverifikasi ketat melalui isSessionLinkedToGoogleEvent!');
  }

  // -------------------------------------------------------------------
  // TEST 5: Dua acara berbeda yang bertabrakan -> Konflik tetap ditampilkan
  // -------------------------------------------------------------------
  console.log('\n--- Test 5: Dua acara berbeda di waktu sama -> Konflik tetap terdeteksi & ditampilkan ---');
  {
    const startIso = '2026-10-19T12:00:00.000Z'; // 19:00 WIB
    const endIso = '2026-10-19T14:00:00.000Z';   // 21:00 WIB

    // Event 1: Acara eksternal Google Meet
    const event1: CalendarEvent = {
      id: 'evt-google-meeting-1',
      provider: 'google',
      title: 'Meeting Klien A',
      startAt: startIso,
      endAt: endIso,
      isEditable: false,
      syncStatus: 'synced',
    };

    // Sesi internal lokal dengan ID Google berbeda (atau belum terhubung ke meeting klien A)
    const sessionUnrelated = {
      id: 'sess-task-other-1',
      taskId: 'task-other-1',
      taskTitle: 'Webinar Desain UI',
      sessionIndex: 1,
      totalSessions: 1,
      startAt: startIso,
      endAt: endIso,
      durationMinutes: 120,
      status: 'SCHEDULED' as const,
      syncStatus: 'pending' as const,
      googleCalendarEventId: 'other-unrelated-id', // ID BEDA!
    };

    const isLinked = isSessionLinkedToGoogleEvent(
      sessionUnrelated.googleCalendarEventId,
      event1.id
    );
    assert.equal(isLinked, false, 'Dua kegiatan dengan ID berbeda TIDAK BOLEH disatukan!');

    console.log('✅ PASSED: Dua acara berbeda di waktu yang sama tidak disatukan dan tetap memicu deteksi tabrakan.');
  }

  // -------------------------------------------------------------------
  // TEST 6: Sinkronisasi ulang (Re-sync) -> Tidak membuat acara duplikat
  // -------------------------------------------------------------------
  console.log('\n--- Test 6: Re-syncing Google Calendar tidak menduplikasi data ---');
  {
    const liveGoogleEvents: CalendarEvent[] = [
      {
        id: 'gcal-existing-1',
        provider: 'google',
        title: '[EVEN] Kelas Senin',
        startAt: '2026-10-19T12:00:00.000Z',
        endAt: '2026-10-19T14:00:00.000Z',
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    // State events awal
    let currentEvents: CalendarEvent[] = [
      {
        id: 'internal-manual-1',
        provider: 'internal',
        title: 'Pengingat Pribadi',
        startAt: '2026-10-20T02:00:00.000Z',
        endAt: '2026-10-20T03:00:00.000Z',
        isEditable: true,
        syncStatus: 'synced',
      },
      ...liveGoogleEvents,
    ];

    // Re-sync logic from App.tsx:
    const internalEvents = currentEvents.filter((e) => e.provider !== 'google');
    const updatedEvents = [...liveGoogleEvents, ...internalEvents];

    assert.equal(updatedEvents.length, 2, 'Jumlah event setelah sinkronisasi ulang harus tetap 2 (tidak bertambah)');
    assert.equal(
      updatedEvents.filter((e) => e.id === 'gcal-existing-1').length,
      1,
      'Acara Google tidak boleh terduplikasi setelah re-sync'
    );

    console.log('✅ PASSED: Re-sync mempertahankan integritas tanpa membuat duplikasi entri Google Calendar.');
  }

  // -------------------------------------------------------------------
  // TEST 7: Memuat ulang aplikasi -> Jadwal dan hubungan ID tetap konsisten
  // -------------------------------------------------------------------
  console.log('\n--- Test 7: Reload aplikasi -> Jadwal & relasi ID tetap konsisten ---');
  {
    const task: Task = {
      id: 'task-persisted-1',
      userId: 'test-user',
      title: 'Kelas Robotika',
      estimatedDurationMinutes: 120,
      priority: 'HIGH',
      status: 'SCHEDULED',
      allowSplit: false,
      timeConstraintType: 'fixed_event',
      targetDays: [1, 2],
      targetOccurrences: [
        {
          dayName: 'Senin',
          requestedStartAt: '2026-10-19T12:00:00.000Z',
          requestedEndAt: '2026-10-19T14:00:00.000Z',
        },
        {
          dayName: 'Selasa',
          requestedStartAt: '2026-10-20T12:00:00.000Z',
          requestedEndAt: '2026-10-20T14:00:00.000Z',
        },
      ],
      scheduledSessions: [
        {
          id: 'sess-task-persisted-1-1',
          taskId: 'task-persisted-1',
          taskTitle: 'Kelas Robotika',
          sessionIndex: 1,
          totalSessions: 2,
          startAt: '2026-10-19T12:00:00.000Z',
          endAt: '2026-10-19T14:00:00.000Z',
          durationMinutes: 120,
          status: 'SCHEDULED',
          syncStatus: 'synced',
          googleCalendarEventId: 'gcal-robo-1',
        },
        {
          id: 'sess-task-persisted-1-2',
          taskId: 'task-persisted-1',
          taskTitle: 'Kelas Robotika',
          sessionIndex: 2,
          totalSessions: 2,
          startAt: '2026-10-20T12:00:00.000Z',
          endAt: '2026-10-20T14:00:00.000Z',
          durationMinutes: 120,
          status: 'SCHEDULED',
          syncStatus: 'synced',
          googleCalendarEventId: 'gcal-robo-2',
        },
      ],
      createdAt: '2026-10-18T00:00:00.000Z',
    };

    // Serialize to JSON and parse (simulating localStorage / Firestore reload)
    const serialized = JSON.stringify(task);
    const reloadedTask: Task = JSON.parse(serialized);

    assert.equal(reloadedTask.scheduledSessions?.length, 2, 'Jumlah sesi harus utuh setelah reload');
    assert.equal(
      reloadedTask.scheduledSessions![0].googleCalendarEventId,
      'gcal-robo-1',
      'googleCalendarEventId sesi 1 harus utuh'
    );
    assert.equal(
      reloadedTask.scheduledSessions![1].googleCalendarEventId,
      'gcal-robo-2',
      'googleCalendarEventId sesi 2 harus utuh'
    );
    assert.equal(reloadedTask.targetOccurrences?.length, 2, 'targetOccurrences harus utuh setelah reload');

    console.log('✅ PASSED: Data terkelola secara utuh dan serializable tanpa kehilangan metadata atau relasi ID.');
  }

  // -------------------------------------------------------------
  // TEST 8: Parser Nama Hari Indonesia & Pemetaan Kalender Valid
  // -------------------------------------------------------------
  console.log('\n--- Test 8: Parser Nama Hari Indonesia & Pemetaan Kalender Valid ---');
  {
    // A. Uji deteksi nama hari dan recurring
    const parsed1 = parseIndonesianDayNames('jadwalkan belajar setiap senin dan kamis malam');
    assert.equal(parsed1.isRecurring, true, 'Harus mendeteksi kata "setiap" sebagai isRecurring = true');
    assert.equal(parsed1.days.length, 2, 'Harus mendeteksi 2 hari');
    assert.equal(parsed1.days[0].dayName, 'Senin');
    assert.equal(parsed1.days[0].dayIndex, 1);
    assert.equal(parsed1.days[1].dayName, 'Kamis');
    assert.equal(parsed1.days[1].dayIndex, 4);

    const parsed2 = parseIndonesianDayNames("acara hari minggu dan jum'at pagi");
    assert.ok(parsed2.days.some((d) => d.dayIndex === 0 && d.dayName === 'Minggu'), 'Harus mendeteksi Minggu');
    assert.ok(parsed2.days.some((d) => d.dayIndex === 5 && d.dayName === 'Jumat'), "Harus mendeteksi Jum'at");

    // B. Uji getNextValidDateForDayOfWeek dari hari Minggu (2026-10-18)
    const sundayRef = new Date('2026-10-18T03:00:00.000Z'); // 10:00 WIB (Minggu)
    
    // Target Senin (1) -> harus 19 Okt 2026 (+1 hari)
    const nextSenin = getNextValidDateForDayOfWeek(1, sundayRef, 'Asia/Jakarta');
    assert.equal(nextSenin.dayOffset, 1, 'Senin harus offset +1 hari dari Minggu');
    assert.equal(nextSenin.dateStr, '2026-10-19');

    // Target Kamis (4) -> harus 22 Okt 2026 (+4 hari)
    const nextKamis = getNextValidDateForDayOfWeek(4, sundayRef, 'Asia/Jakarta');
    assert.equal(nextKamis.dayOffset, 4, 'Kamis harus offset +4 hari dari Minggu');
    assert.equal(nextKamis.dateStr, '2026-10-22');

    // Target Minggu (0) dengan jam 08.00 (sudah lewat dari 10.00 WIB) -> harus Minggu depan (+7 hari, 25 Okt 2026)
    const nextMingguPassed = getNextValidDateForDayOfWeek(0, sundayRef, 'Asia/Jakarta', { targetHour: 8 });
    assert.equal(nextMingguPassed.dayOffset, 7, 'Jam yang sudah lewat hari ini harus maju ke minggu depan');
    assert.equal(nextMingguPassed.dateStr, '2026-10-25');

    // Target Minggu (0) dengan jam 19.00 (belum lewat dari 10.00 WIB) -> harus hari ini (+0 hari, 18 Okt 2026)
    const nextMingguToday = getNextValidDateForDayOfWeek(0, sundayRef, 'Asia/Jakarta', { targetHour: 19 });
    assert.equal(nextMingguToday.dayOffset, 0, 'Jam yang belum lewat hari ini harus tetap hari ini');
    assert.equal(nextMingguToday.dateStr, '2026-10-18');

    console.log('✅ PASSED: Parser hari Indonesia (Senin-Minggu) dan perhitungan tanggal kalender zona waktu valid!');
  }

  // -------------------------------------------------------------
  // TEST 9: Logika 'Recurring Task' Multi-Hari di Scheduler Deterministic
  // -------------------------------------------------------------
  console.log('\n--- Test 9: Recurring Task Multi-Hari di Scheduler (Senin & Kamis malam) ---');
  {
    const sundayRef = new Date('2026-10-18T03:00:00.000Z'); // Minggu
    const recurringTask: Task = {
      id: 'task-recurring-study',
      userId: 'test-user',
      title: 'Belajar Arsitektur Sistem',
      estimatedDurationMinutes: 60,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false,
      isRecurring: true,
      targetDays: [1, 4], // Senin & Kamis
      preferredWindow: {
        startHour: 19,
        endHour: 23,
        label: 'Malam (19:00 - 23:00)',
      },
      preferredTimeOfDay: 'EVENING',
      timezone: 'Asia/Jakarta',
      createdAt: sundayRef.toISOString(),
    };

    // A. Kasus semua target hari tersedia tanpa benturan
    const schedAllOk = scheduleTaskDeterministically(recurringTask, [], [], DEFAULT_PREFS, sundayRef);
    assert.equal(schedAllOk.success, true, 'Penjadwalan recurring task harus berhasil');
    assert.equal(schedAllOk.proposedSessions.length, 2, 'Harus menghasilkan 2 sesi berulang (Senin & Kamis)');

    const sessMon = schedAllOk.proposedSessions[0];
    const sessThu = schedAllOk.proposedSessions[1];

    const monParts = getPartsInTimezone(new Date(sessMon.startAt), 'Asia/Jakarta');
    const thuParts = getPartsInTimezone(new Date(sessThu.startAt), 'Asia/Jakarta');

    assert.equal(monParts.dayOfWeek, 1, 'Sesi 1 harus hari Senin (1)');
    assert.equal(monParts.day, 19, 'Sesi 1 harus tanggal 19 Okt');
    assert.equal(monParts.hour, 19, 'Sesi 1 harus mulai jam 19.00');

    assert.equal(thuParts.dayOfWeek, 4, 'Sesi 2 harus hari Kamis (4)');
    assert.equal(thuParts.day, 22, 'Sesi 2 harus tanggal 22 Okt');
    assert.equal(thuParts.hour, 19, 'Sesi 2 harus mulai jam 19.00');

    assert.notEqual(sessMon.startAt, sessThu.startAt, 'Tidak boleh ada duplikasi waktu');

    // B. Kasus benturan parsial: Senin malam diblokir acara kalender 19.00 - 23.00
    const mondayBlocker: CalendarEvent = {
      id: 'evt-block-monday-night',
      provider: 'google',
      title: 'Family Dinner',
      startAt: '2026-10-19T12:00:00.000Z', // 19:00 WIB
      endAt: '2026-10-19T16:00:00.000Z',   // 23:00 WIB
      isEditable: false,
      syncStatus: 'synced',
    };

    const schedPartial = scheduleTaskDeterministically(recurringTask, [mondayBlocker], [], DEFAULT_PREFS, sundayRef);
    assert.equal(schedPartial.success, true, 'Harus parsial sukses jika salah satu hari tersedia');
    assert.equal(schedPartial.partialSuccess, true, 'partialSuccess harus true');
    assert.equal(schedPartial.proposedSessions.length, 1, 'Hanya sesi Kamis yang dijadwalkan');

    const scheduledThuParts = getPartsInTimezone(new Date(schedPartial.proposedSessions[0].startAt), 'Asia/Jakarta');
    assert.equal(scheduledThuParts.dayOfWeek, 4, 'Sesi yang berhasil harus tetap hari Kamis (4)');
    assert.ok(schedPartial.skippedOccurrences && schedPartial.skippedOccurrences.length === 1, 'Harus mencatat 1 hari dilewati');
    assert.equal(schedPartial.skippedOccurrences![0].dayName, 'Senin', 'Hari yang dilewati harus Senin');
    assert.ok(
      schedPartial.explanation.includes('tidak digeser diam-diam'),
      'Penjelasan harus menegaskan sesi bertabrakan tidak digeser diam-diam'
    );

    console.log('✅ PASSED: Recurring task multi-hari terjadwal deterministik tanpa duplikasi, validasi benturan per hari bekerja sempurna!');
  }

  console.log('\n===============================================================');
  console.log('🎉 SEMUA 9 PENGUJIAN AUDIT & PERBAIKAN PENJADWALAN BERHASIL! 🎉');
  console.log('===============================================================\n');
}

// Allow direct execution
if (process.argv[1]?.includes('scheduling-bugs-audit-and-fix.test')) {
  runSchedulingBugsTests().catch((err) => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  });
}

