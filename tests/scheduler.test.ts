import { describe, it, expect } from 'vitest';
import {
  parseIndonesianTemporalRules,
  getNextValidDateForDayOfWeek,
  parseIndonesianDayNames,
} from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences } from '../src/types';
import { getPartsInTimezone } from '../src/lib/timezone';

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

describe('EVEN AI Planner - Logika Penjadwalan Multi-Hari & Parser Hari Indonesia', () => {
  describe('1. Parsing Nama Hari Indonesia (parseIndonesianDayNames)', () => {
    it('mengenali nama-nama hari bahasa Indonesia secara akurat', () => {
      const res = parseIndonesianDayNames('jadwalkan kelas hari senin dan selasa malam');
      expect(res.days).toHaveLength(2);
      expect(res.days[0]).toMatchObject({ dayIndex: 1, dayName: 'Senin' });
      expect(res.days[1]).toMatchObject({ dayIndex: 2, dayName: 'Selasa' });
      expect(res.isRecurring).toBe(false);
    });

    it("mengenali variasi nama hari seperti ahad, rabu, kamis, jum'at, dan sabtu", () => {
      const res = parseIndonesianDayNames("kegiatan hari rabu, kamis, jum'at, dan sabtu");
      const dayIndices = res.days.map((d) => d.dayIndex);
      expect(dayIndices).toContain(3); // Rabu
      expect(dayIndices).toContain(4); // Kamis
      expect(dayIndices).toContain(5); // Jumat / Jum'at
      expect(dayIndices).toContain(6); // Sabtu
    });

    it('mendeteksi pola berulang (recurring) dari kata kunci setiap, rutin, mingguan', () => {
      const res1 = parseIndonesianDayNames('belajar coding setiap senin dan kamis malam');
      expect(res1.isRecurring).toBe(true);

      const res2 = parseIndonesianDayNames('evaluasi rutin per minggu tiap selasa');
      expect(res2.isRecurring).toBe(true);
      expect(res2.days.some((d) => d.dayIndex === 2)).toBe(true);
    });

    it('membedakan kata "minggu" sebagai hari Minggu vs "minggu depan"', () => {
      const resSunday = parseIndonesianDayNames('jadwal ibadah hari minggu pagi jam 08.00');
      expect(resSunday.days.some((d) => d.dayIndex === 0 && d.dayName === 'Minggu')).toBe(true);

      const resNextWeek = parseIndonesianDayNames('jadwalkan senin minggu depan');
      expect(resNextWeek.days.some((d) => d.dayIndex === 1)).toBe(true);
      // "minggu depan" adalah frase penggeser waktu, bukan hari Minggu
      expect(resNextWeek.days.some((d) => d.dayIndex === 0)).toBe(false);
    });
  });

  describe('2. Pemetaan Tanggal Kalender Berikutnya (getNextValidDateForDayOfWeek)', () => {
    // Referensi: Minggu, 18 Oktober 2026, 10:00 WIB (03:00 UTC)
    const sundayIso = '2026-10-18T03:00:00.000Z';
    const sundayRef = new Date(sundayIso);

    it('memetakan hari berikutnya dari Minggu ke Senin (+1 hari)', () => {
      const result = getNextValidDateForDayOfWeek(1, sundayRef, 'Asia/Jakarta');
      expect(result.dayOffset).toBe(1);
      expect(result.dateStr).toBe('2026-10-19');
      expect(result.year).toBe(2026);
      expect(result.month).toBe(10);
      expect(result.day).toBe(19);
    });

    it('memetakan ke Kamis (+4 hari dari Minggu)', () => {
      const result = getNextValidDateForDayOfWeek(4, sundayRef, 'Asia/Jakarta');
      expect(result.dayOffset).toBe(4);
      expect(result.dateStr).toBe('2026-10-22');
    });

    it('mengarahkan ke minggu berikutnya jika jam yang diminta sudah lewat pada hari yang sama', () => {
      // Jam 08.00 sudah lewat dari 10.00 WIB pada hari Minggu yang sama
      const result = getNextValidDateForDayOfWeek(0, sundayRef, 'Asia/Jakarta', { targetHour: 8 });
      expect(result.dayOffset).toBe(7);
      expect(result.dateStr).toBe('2026-10-25');
    });

    it('mempertahankan hari ini jika jam yang diminta belum lewat', () => {
      // Jam 19.00 belum lewat dari 10.00 WIB pada hari Minggu yang sama
      const result = getNextValidDateForDayOfWeek(0, sundayRef, 'Asia/Jakarta', { targetHour: 19 });
      expect(result.dayOffset).toBe(0);
      expect(result.dateStr).toBe('2026-10-18');
    });

    it('mendukung forceNextWeek untuk melompat ke minggu berikutnya', () => {
      const result = getNextValidDateForDayOfWeek(1, sundayRef, 'Asia/Jakarta', { forceNextWeek: true, weekOffset: 1 });
      expect(result.dayOffset).toBe(8); // Senin minggu depannya lagi
      expect(result.dateStr).toBe('2026-10-26');
    });
  });

  describe('3. Interpretasi Temporal Deterministik (parseIndonesianTemporalRules)', () => {
    const sundayIso = '2026-10-18T03:00:00.000Z'; // 10:00 WIB (Minggu)

    it('menghasilkan tanggal target Senin (bukan Minggu) saat diminta "Senin malam"', () => {
      const plan = parseIndonesianTemporalRules({
        userPrompt: 'jadwalkan kelas pada Senin malam jam 19.00 sampai 21.00',
        currentDateTime: sundayIso,
        userTimezone: 'Asia/Jakarta',
      });

      expect(plan.timeConstraintType).toBe('fixed_event');
      expect(plan.hasExplicitDayTarget).toBe(true);
      expect(plan.estimatedDurationMinutes).toBe(120);

      const parts = getPartsInTimezone(new Date(plan.requestedStartAt!), 'Asia/Jakarta');
      expect(parts.dayOfWeek).toBe(1); // Senin
      expect(parts.day).toBe(19);
      expect(parts.hour).toBe(19);
    });

    it('menghasilkan dua targetOccurrences terpisah saat diminta "Senin dan Selasa malam"', () => {
      const plan = parseIndonesianTemporalRules({
        userPrompt: 'jadwalkan kelas pada Senin dan Selasa malam jam 19.00 sampai 21.00',
        currentDateTime: sundayIso,
        userTimezone: 'Asia/Jakarta',
      });

      expect(plan.targetOccurrences).toBeDefined();
      expect(plan.targetOccurrences).toHaveLength(2);

      const occ1 = plan.targetOccurrences![0];
      const occ2 = plan.targetOccurrences![1];

      expect(occ1.dayName).toBe('Senin');
      expect(occ2.dayName).toBe('Selasa');

      const parts1 = getPartsInTimezone(new Date(occ1.requestedStartAt), 'Asia/Jakarta');
      const parts2 = getPartsInTimezone(new Date(occ2.requestedStartAt), 'Asia/Jakarta');

      expect(parts1.dayOfWeek).toBe(1); // Senin
      expect(parts2.dayOfWeek).toBe(2); // Selasa
      expect(parts1.hour).toBe(19);
      expect(parts2.hour).toBe(19);
    });
  });

  describe('4. Penjadwalan Multi-Hari Deterministik & Validasi Benturan (scheduleTaskDeterministically)', () => {
    const sundayIso = '2026-10-18T03:00:00.000Z';
    const sundayRef = new Date(sundayIso);

    it('menjadwalkan multi-hari fixed_event menjadi 2 sesi terpisah tanpa penggabungan 24 jam+', () => {
      const task: Task = {
        id: 'task-test-fixed-multi',
        userId: 'user-1',
        title: 'Kelas Robotika',
        estimatedDurationMinutes: 120,
        priority: 'HIGH',
        status: 'UNSCHEDULED',
        allowSplit: false,
        timeConstraintType: 'fixed_event',
        targetDays: [1, 2],
        targetOccurrences: [
          {
            dayName: 'Senin',
            dayOfWeek: 1,
            requestedStartAt: '2026-10-19T12:00:00.000Z', // 19:00 WIB
            requestedEndAt: '2026-10-19T14:00:00.000Z',   // 21:00 WIB
          },
          {
            dayName: 'Selasa',
            dayOfWeek: 2,
            requestedStartAt: '2026-10-20T12:00:00.000Z', // 19:00 WIB
            requestedEndAt: '2026-10-20T14:00:00.000Z',   // 21:00 WIB
          },
        ],
        timezone: 'Asia/Jakarta',
        createdAt: sundayIso,
      };

      const result = scheduleTaskDeterministically(task, [], [], DEFAULT_PREFS, sundayRef);
      expect(result.success).toBe(true);
      expect(result.proposedSessions).toHaveLength(2);

      // Verifikasi masing-masing sesi berdurasi 120 menit, bukan 24 jam+
      expect(result.proposedSessions[0].durationMinutes).toBe(120);
      expect(result.proposedSessions[1].durationMinutes).toBe(120);

      const p1 = getPartsInTimezone(new Date(result.proposedSessions[0].startAt), 'Asia/Jakarta');
      const p2 = getPartsInTimezone(new Date(result.proposedSessions[1].startAt), 'Asia/Jakarta');
      expect(p1.dayOfWeek).toBe(1); // Senin
      expect(p2.dayOfWeek).toBe(2); // Selasa
    });

    it('melakukan validasi benturan independen: Senin bentrok dilewati & dilaporkan, Selasa tetap terjadwal tanpa digeser diam-diam', () => {
      const blockedMonday: CalendarEvent = {
        id: 'evt-blocking-monday-night',
        provider: 'google',
        title: 'Rapat Evaluasi Tim',
        startAt: '2026-10-19T12:00:00.000Z', // 19:00 WIB
        endAt: '2026-10-19T14:00:00.000Z',   // 21:00 WIB
        isEditable: false,
        syncStatus: 'synced',
      };

      const task: Task = {
        id: 'task-test-partial-collision',
        userId: 'user-1',
        title: 'Kelas Robotika',
        estimatedDurationMinutes: 120,
        priority: 'HIGH',
        status: 'UNSCHEDULED',
        allowSplit: false,
        timeConstraintType: 'fixed_event',
        targetDays: [1, 2],
        targetOccurrences: [
          {
            dayName: 'Senin',
            dayOfWeek: 1,
            requestedStartAt: '2026-10-19T12:00:00.000Z',
            requestedEndAt: '2026-10-19T14:00:00.000Z',
          },
          {
            dayName: 'Selasa',
            dayOfWeek: 2,
            requestedStartAt: '2026-10-20T12:00:00.000Z',
            requestedEndAt: '2026-10-20T14:00:00.000Z',
          },
        ],
        timezone: 'Asia/Jakarta',
        createdAt: sundayIso,
      };

      const result = scheduleTaskDeterministically(task, [blockedMonday], [], DEFAULT_PREFS, sundayRef);

      // Status harus parsial sukses
      expect(result.success).toBe(true);
      expect(result.partialSuccess).toBe(true);
      expect(result.proposedSessions).toHaveLength(1);

      // Sesi yang terjadwal harus tetap Selasa
      const scheduledParts = getPartsInTimezone(new Date(result.proposedSessions[0].startAt), 'Asia/Jakarta');
      expect(scheduledParts.dayOfWeek).toBe(2); // Selasa

      // Kejadian Senin yang bentrok harus tercatat di skippedOccurrences tanpa dipindahkan sembunyi-sembunyi
      expect(result.skippedOccurrences).toBeDefined();
      expect(result.skippedOccurrences).toHaveLength(1);
      expect(result.skippedOccurrences![0].dayName).toBe('Senin');
      expect(result.explanation).toContain('tidak digeser diam-diam');
    });

    it('menjadwalkan flexible recurring task (Senin & Kamis malam) secara deterministik tanpa duplikasi slot', () => {
      const recurringTask: Task = {
        id: 'task-recurring-flex',
        userId: 'user-1',
        title: 'Belajar Next.js & React',
        estimatedDurationMinutes: 60,
        priority: 'MEDIUM',
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
        createdAt: sundayIso,
      };

      const result = scheduleTaskDeterministically(recurringTask, [], [], DEFAULT_PREFS, sundayRef);
      expect(result.success).toBe(true);
      expect(result.proposedSessions).toHaveLength(2);

      const sess1 = result.proposedSessions[0];
      const sess2 = result.proposedSessions[1];

      const p1 = getPartsInTimezone(new Date(sess1.startAt), 'Asia/Jakarta');
      const p2 = getPartsInTimezone(new Date(sess2.startAt), 'Asia/Jakarta');

      expect(p1.dayOfWeek).toBe(1); // Senin
      expect(p2.dayOfWeek).toBe(4); // Kamis
      expect(sess1.startAt).not.toBe(sess2.startAt); // Tanpa duplikasi
    });
  });
});
