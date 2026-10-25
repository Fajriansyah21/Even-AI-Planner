import { strict as assert } from 'assert';
import {
  calculateVerticalPosition,
  ROW_HEIGHT,
  PIXELS_PER_MINUTE,
} from '../src/components/CalendarView';
import { createIsoInTimezone } from '../src/lib/timezone';

export function runCalendarVerticalPositionTests() {
  console.log('\n=== RUNNING CALENDAR VERTICAL POSITION AUDIT & TEST SUITE ===');

  const tz = 'Asia/Jakarta';
  const year = 2026;
  const month = 10;
  const day = 25;

  // 00:00:00 WIB (Day Start)
  const dayStartIso = createIsoInTimezone(year, month, day, 0, 0, 0, tz);
  const dayStartMs = new Date(dayStartIso).getTime();

  // 24:00:00 WIB (Day End = Next day 00:00)
  const dayEndIso = createIsoInTimezone(year, month, day + 1, 0, 0, 0, tz);
  const dayEndMs = new Date(dayEndIso).getTime();

  // --- Test 1: Konfigurasi Skala Standar ---
  console.log('--- Test 1: Skala piksel per menit konsisten dari awal rentang ---');
  assert.equal(ROW_HEIGHT, 56, 'ROW_HEIGHT standar harus 56px');
  assert.equal(
    PIXELS_PER_MINUTE,
    56 / 60,
    'PIXELS_PER_MINUTE harus tepat 56 / 60 (0.9333... px/menit)'
  );
  console.log('✅ PASSED: Skala piksel per menit terkonfirmasi 56/60 px/menit.');

  // --- Test 2: Kegiatan 16:00 - 18:00 (Kasus Masalah Lama) ---
  console.log('--- Test 2: Kegiatan 16:00 - 18:00 dimulai tepat di garis 16:00 dan berakhir di 18:00 ---');
  {
    const startIso = createIsoInTimezone(year, month, day, 16, 0, 0, tz);
    const endIso = createIsoInTimezone(year, month, day, 18, 0, 0, tz);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();

    const result = calculateVerticalPosition(startMs, endMs, dayStartMs, ROW_HEIGHT);

    // 16 jam dari tengah malam = 960 menit
    assert.equal(result.startMinutesFromDayStart, 960, '16:00 harus 960 menit dari 00:00');
    // top = 960 * (56 / 60) = 896px = 16 * 56px
    assert.equal(result.topPx, 896, 'topPx untuk 16:00 harus tepat 896px (garis 16:00)');
    // durasi 2 jam = 120 menit
    assert.equal(result.visibleDurationMinutes, 120, 'durasi terlihat harus 120 menit');
    // height = 120 * (56 / 60) = 112px = 2 * 56px
    assert.equal(result.heightPx, 112, 'heightPx harus tepat 112px (2 baris jam)');
    // berakhir tepat pada garis 18:00: 896 + 112 = 1008px (18 * 56)
    assert.equal(result.topPx + result.heightPx, 1008, 'Titik akhir harus tepat pada garis 18:00 (1008px)');
    console.log('✅ PASSED: Kegiatan 16:00-18:00 mulai tepat di garis 16:00 (896px) dan berakhir di garis 18:00 (1008px).');
  }

  // --- Test 3: Kegiatan 19:00 - 22:00 (Kasus Masalah Lama) ---
  console.log('--- Test 3: Kegiatan 19:00 - 22:00 dimulai tepat di garis 19:00 dan berakhir di 22:00 ---');
  {
    const startIso = createIsoInTimezone(year, month, day, 19, 0, 0, tz);
    const endIso = createIsoInTimezone(year, month, day, 22, 0, 0, tz);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();

    const result = calculateVerticalPosition(startMs, endMs, dayStartMs, ROW_HEIGHT);

    // 19 jam dari tengah malam = 1140 menit
    assert.equal(result.startMinutesFromDayStart, 1140, '19:00 harus 1140 menit dari 00:00');
    // top = 1140 * (56 / 60) = 1064px = 19 * 56px
    assert.equal(result.topPx, 1064, 'topPx untuk 19:00 harus tepat 1064px (garis 19:00)');
    // durasi 3 jam = 180 menit
    assert.equal(result.visibleDurationMinutes, 180, 'durasi terlihat harus 180 menit');
    // height = 180 * (56 / 60) = 168px = 3 * 56px
    assert.equal(result.heightPx, 168, 'heightPx harus tepat 168px (3 baris jam)');
    // berakhir tepat pada garis 22:00: 1064 + 168 = 1232px (22 * 56)
    assert.equal(result.topPx + result.heightPx, 1232, 'Titik akhir harus tepat pada garis 22:00 (1232px)');
    console.log('✅ PASSED: Kegiatan 19:00-22:00 mulai tepat di garis 19:00 (1064px) dan berakhir di garis 22:00 (1232px).');
  }

  // --- Test 4: Kegiatan 30 menit tepat setengah baris (28px) ---
  console.log('--- Test 4: Kegiatan 30 menit memiliki tinggi tepat setengah dari satu baris jam ---');
  {
    const startIso = createIsoInTimezone(year, month, day, 10, 0, 0, tz);
    const endIso = createIsoInTimezone(year, month, day, 10, 30, 0, tz);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();

    const result = calculateVerticalPosition(startMs, endMs, dayStartMs, ROW_HEIGHT);

    assert.equal(result.visibleDurationMinutes, 30, 'durasi harus 30 menit');
    assert.equal(result.heightPx, ROW_HEIGHT / 2, 'tinggi harus tepat setengah baris jam (28px)');
    assert.equal(result.heightPx, 28, 'tinggi harus tepat 28px');
    console.log('✅ PASSED: Kegiatan 30 menit memiliki tinggi tepat 28px (50% dari baris 56px).');
  }

  // --- Test 5: Kegiatan 2 jam memiliki tinggi tepat dua baris jam (112px) ---
  console.log('--- Test 5: Kegiatan 2 jam memiliki tinggi tepat dua baris jam ---');
  {
    const startIso = createIsoInTimezone(year, month, day, 14, 0, 0, tz);
    const endIso = createIsoInTimezone(year, month, day, 16, 0, 0, tz);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();

    const result = calculateVerticalPosition(startMs, endMs, dayStartMs, ROW_HEIGHT);

    assert.equal(result.visibleDurationMinutes, 120, 'durasi harus 120 menit');
    assert.equal(result.heightPx, ROW_HEIGHT * 2, 'tinggi harus tepat 2 baris jam (112px)');
    console.log('✅ PASSED: Kegiatan 2 jam memiliki tinggi tepat 112px (2 baris).');
  }

  // --- Test 6: Kegiatan jam 01:00 ditempatkan pada posisi yang benar ---
  console.log('--- Test 6: Kegiatan yang dimulai pada 01:00 ditempatkan tepat di garis 01:00 ---');
  {
    const startIso = createIsoInTimezone(year, month, day, 1, 0, 0, tz);
    const endIso = createIsoInTimezone(year, month, day, 2, 0, 0, tz);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();

    const result = calculateVerticalPosition(startMs, endMs, dayStartMs, ROW_HEIGHT);

    assert.equal(result.startMinutesFromDayStart, 60, '01:00 harus 60 menit dari 00:00');
    assert.equal(result.topPx, 56, 'topPx untuk 01:00 harus tepat 56px (garis 01:00)');
    console.log('✅ PASSED: Kegiatan 01:00 ditempatkan tepat di garis 01:00 (56px).');
  }

  // --- Test 7: Kegiatan berakhir 24:00 berakhir tepat di batas akhir rentang kalender ---
  console.log('--- Test 7: Kegiatan yang berakhir pada 24:00 berakhir tepat di batas akhir rentang kalender ---');
  {
    const startIso = createIsoInTimezone(year, month, day, 22, 0, 0, tz);
    const endIso = createIsoInTimezone(year, month, day + 1, 0, 0, 0, tz); // 24:00
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();

    // Slicing untuk hari tersebut membatasi visibleEndMs ke dayEndMs
    const visibleEndMs = Math.min(endMs, dayEndMs);
    const result = calculateVerticalPosition(startMs, visibleEndMs, dayStartMs, ROW_HEIGHT);

    assert.equal(result.topPx, 22 * 56, 'Mulai 22:00 harus di 1232px');
    assert.equal(result.heightPx, 2 * 56, 'Tinggi 2 jam harus 112px');
    assert.equal(
      result.topPx + result.heightPx,
      24 * ROW_HEIGHT,
      'Harus berakhir tepat di 1344px (24 * 56px)'
    );
    console.log('✅ PASSED: Kegiatan berakhir tepat di batas bawah kalender (1344px).');
  }

  // --- Test 8: Kegiatan lintas tengah malam (22:00 - 06:00 keesokan hari) ---
  console.log('--- Test 8: Kegiatan lintas tengah malam dirender secara presisi pada kedua tanggal ---');
  {
    // Hari 1: 22:00 - 24:00
    const startMs = new Date(createIsoInTimezone(year, month, day, 22, 0, 0, tz)).getTime();
    const nextDayStartMs = dayEndMs;
    const nextDayEndMs = new Date(createIsoInTimezone(year, month, day + 2, 0, 0, 0, tz)).getTime();
    const fullEndMs = new Date(createIsoInTimezone(year, month, day + 1, 6, 0, 0, tz)).getTime();

    // Slice Hari 1
    const day1Result = calculateVerticalPosition(
      startMs,
      Math.min(fullEndMs, dayEndMs),
      dayStartMs,
      ROW_HEIGHT
    );
    assert.equal(day1Result.topPx, 1232, 'Hari 1 mulai di 22:00 (1232px)');
    assert.equal(day1Result.heightPx, 112, 'Hari 1 durasi 2 jam (112px)');
    assert.equal(day1Result.topPx + day1Result.heightPx, 1344, 'Hari 1 selesai di batas tengah malam (1344px)');

    // Slice Hari 2
    const day2Result = calculateVerticalPosition(
      Math.max(startMs, nextDayStartMs),
      Math.min(fullEndMs, nextDayEndMs),
      nextDayStartMs,
      ROW_HEIGHT
    );
    assert.equal(day2Result.topPx, 0, 'Hari 2 mulai di 00:00 (0px)');
    assert.equal(day2Result.heightPx, 6 * 56, 'Hari 2 durasi 6 jam (336px)');
    assert.equal(day2Result.topPx + day2Result.heightPx, 336, 'Hari 2 selesai di garis 06:00 (336px)');
    console.log('✅ PASSED: Kegiatan lintas tengah malam dirender presisi di Hari 1 (22:00-24:00) dan Hari 2 (00:00-06:00).');
  }

  // --- Test 9: Fleksibilitas saat rowHeight berubah ---
  console.log('--- Test 9: Skala menyesuaikan otomatis saat rowHeight diubah secara dinamis ---');
  {
    const startMs = new Date(createIsoInTimezone(year, month, day, 10, 0, 0, tz)).getTime();
    const endMs = new Date(createIsoInTimezone(year, month, day, 11, 0, 0, tz)).getTime();

    // Uji dengan rowHeight = 60px (1 px per menit)
    const res60 = calculateVerticalPosition(startMs, endMs, dayStartMs, 60);
    assert.equal(res60.pixelsPerMinute, 1, 'Skala harus 1.0 px/menit untuk rowHeight 60');
    assert.equal(res60.topPx, 600, 'topPx untuk 10:00 dengan rowHeight 60 harus 600px');
    assert.equal(res60.heightPx, 60, 'heightPx untuk 1 jam dengan rowHeight 60 harus 60px');

    // Uji dengan rowHeight = 48px (0.8 px per menit)
    const res48 = calculateVerticalPosition(startMs, endMs, dayStartMs, 48);
    assert.equal(res48.pixelsPerMinute, 0.8, 'Skala harus 0.8 px/menit untuk rowHeight 48');
    assert.equal(res48.topPx, 480, 'topPx untuk 10:00 dengan rowHeight 48 harus 480px');
    assert.equal(res48.heightPx, 48, 'heightPx untuk 1 jam dengan rowHeight 48 harus 48px');
    console.log('✅ PASSED: Skala adaptif penuh terhadap perubahan rowHeight tanpa ketergantungan offset tetap.');
  }

  console.log('\n===============================================================');
  console.log('🎉 SEMUA 9 AUDIT & TEST PEMETAAN VERTIKAL KALENDER BERHASIL! 🎉');
  console.log('===============================================================\n');
}

if (import.meta.url.endsWith(process.argv[1])) {
  runCalendarVerticalPositionTests();
}
