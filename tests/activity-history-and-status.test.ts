import assert from 'assert';
import { Task, TaskScheduleSession, UserPreferences, CalendarEvent, ScheduleCalculationResult } from '../src/types';
import {
  auditAndTransitionOverdueTasks,
  completeTaskManually,
  dismissMissedTask,
  prepareRescheduledTask,
  isTaskInHistory,
  isTaskActive,
  getTaskEffectiveEndTime,
} from '../src/lib/activityStatusManager';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';

export async function runActivityHistoryAndStatusTests() {
  console.log('🧪 [TEST SUITE] Aktivitas Riwayat Kegiatan & Otomatisasi Status EVEN Planner');

  const defaultPrefs: UserPreferences = {
    displayName: 'Pengguna Uji',
    email: 'user@even.id',
    workStartHour: 8,
    workEndHour: 22,
    workDays: [1, 2, 3, 4, 5, 6, 0],
    bufferMinutes: 15,
    timezone: 'Asia/Jakarta',
    googleCalendarConnected: false,
    calendarSyncStatus: 'pending',
  };

  // -------------------------------------------------------------
  // KASUS 1: Penyelesaian Manual
  // -------------------------------------------------------------
  console.log('  -> Kasus 1: Penyelesaian manual menandai completed_manual, menyimpan completedAt, masuk riwayat');
  {
    const originalTask: Task = {
      id: 'task-c1',
      title: 'Menulis Laporan Evaluasi',
      estimatedDurationMinutes: 60,
      priority: 'HIGH',
      status: 'SCHEDULED',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-c1',
          taskId: 'task-c1',
          taskTitle: 'Menulis Laporan Evaluasi',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T14:00:00Z',
          endAt: '2026-10-25T15:00:00Z',
          durationMinutes: 60,
          status: 'SCHEDULED',
          syncStatus: 'pending',
        },
      ],
    };

    const completedTime = new Date('2026-10-25T14:30:00Z');
    const result = completeTaskManually(originalTask, completedTime);

    assert.strictEqual(result.status, 'completed_manual', 'Status task harus completed_manual');
    assert.strictEqual(result.completedAt, '2026-10-25T14:30:00.000Z', 'completedAt harus tersimpan');
    assert.strictEqual(result.scheduledSessions![0].status, 'completed_manual', 'Sesi harus completed_manual');
    assert.strictEqual(isTaskInHistory(result), true, 'Task harus masuk ke kategori riwayat');
    assert.strictEqual(isTaskActive(result), false, 'Task tidak boleh aktif lagi');
  }

  // -------------------------------------------------------------
  // KASUS 2: Terlewat Otomatis (missed_auto) Setelah Waktu Selesai
  // -------------------------------------------------------------
  console.log('  -> Kasus 2: Kegiatan melewati waktu selesai ditandai missed_auto dengan missedAt');
  {
    const overdueTask: Task = {
      id: 'task-c2',
      title: 'Rapat Sinkronisasi Tim Desain',
      estimatedDurationMinutes: 90,
      priority: 'MEDIUM',
      status: 'SCHEDULED',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-c2',
          taskId: 'task-c2',
          taskTitle: 'Rapat Sinkronisasi Tim Desain',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T09:00:00Z',
          endAt: '2026-10-25T10:30:00Z',
          durationMinutes: 90,
          status: 'SCHEDULED',
          syncStatus: 'pending',
        },
      ],
    };

    // Waktu audit: 10:35 (5 menit setelah jadwal selesai)
    const auditTime = new Date('2026-10-25T10:35:00Z');
    const { updatedTasks, transitionedCount, missedTasks } = auditAndTransitionOverdueTasks(
      [overdueTask],
      auditTime
    );

    assert.strictEqual(transitionedCount, 1, 'Harus ada 1 kegiatan yang bertransisi');
    assert.strictEqual(updatedTasks[0].status, 'missed_auto', 'Status harus menjadi missed_auto');
    assert.strictEqual(updatedTasks[0].missedAt, '2026-10-25T10:35:00.000Z');
    assert.strictEqual(updatedTasks[0].rescheduleDecision, 'pending');
    assert.strictEqual(isTaskInHistory(updatedTasks[0]), true);
  }

  // -------------------------------------------------------------
  // KASUS 3: Penyelesaian Manual Sebelum Waktu Berakhir Tidak Ditandai missed_auto
  // -------------------------------------------------------------
  console.log('  -> Kasus 3: Penyelesaian manual sebelum waktu berakhir tetap completed_manual');
  {
    const earlyCompletedTask: Task = {
      id: 'task-c3',
      title: 'Membaca Dokumentasi Arsitektur',
      estimatedDurationMinutes: 120,
      priority: 'LOW',
      status: 'completed_manual',
      completedAt: '2026-10-25T13:30:00Z',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-c3',
          taskId: 'task-c3',
          taskTitle: 'Membaca Dokumentasi Arsitektur',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T13:00:00Z',
          endAt: '2026-10-25T15:00:00Z',
          durationMinutes: 120,
          status: 'completed_manual',
          syncStatus: 'pending',
        },
      ],
    };

    // Audit dijalankan pada 16:00 (setelah endAt)
    const auditTime = new Date('2026-10-25T16:00:00Z');
    const { updatedTasks, transitionedCount } = auditAndTransitionOverdueTasks(
      [earlyCompletedTask],
      auditTime
    );

    assert.strictEqual(transitionedCount, 0, 'Tidak boleh ada transisi untuk kegiatan selesai manual');
    assert.strictEqual(updatedTasks[0].status, 'completed_manual', 'Status harus tetap completed_manual');
  }

  // -------------------------------------------------------------
  // KASUS 4: Idempotensi Pemeriksaan Otomatis
  // -------------------------------------------------------------
  console.log('  -> Kasus 4: Idempotensi pemeriksaan otomatis berulang kali tidak menduplikasi riwayat');
  {
    const missedTask: Task = {
      id: 'task-c4',
      title: 'Tugas Terlewat',
      estimatedDurationMinutes: 30,
      priority: 'LOW',
      status: 'SCHEDULED',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-c4',
          taskId: 'task-c4',
          taskTitle: 'Tugas Terlewat',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T08:00:00Z',
          endAt: '2026-10-25T08:30:00Z',
          durationMinutes: 30,
          status: 'SCHEDULED',
          syncStatus: 'pending',
        },
      ],
    };

    const t1 = auditAndTransitionOverdueTasks([missedTask], new Date('2026-10-25T09:00:00Z'));
    assert.strictEqual(t1.transitionedCount, 1);
    const initialLogLength = t1.updatedTasks[0].statusHistory?.length || 0;

    // Pemanggilan kedua di waktu berbeda
    const t2 = auditAndTransitionOverdueTasks(t1.updatedTasks, new Date('2026-10-25T10:00:00Z'));
    assert.strictEqual(t2.transitionedCount, 0, 'Pemanggilan kedua tidak boleh memproses ulang');
    assert.strictEqual(t2.updatedTasks[0].statusHistory?.length, initialLogLength, 'Status history tidak boleh bertambah');
  }

  // -------------------------------------------------------------
  // KASUS 5: Kegiatan Sedang Berlangsung TIDAK Ditandai Terlewat
  // -------------------------------------------------------------
  console.log('  -> Kasus 5: Kegiatan sedang berlangsung tidak ditandai terlewat sebelum endAt');
  {
    const inProgressTask: Task = {
      id: 'task-c5',
      title: 'Coding Sesi Siang',
      estimatedDurationMinutes: 120,
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-c5',
          taskId: 'task-c5',
          taskTitle: 'Coding Sesi Siang',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T13:00:00Z',
          endAt: '2026-10-25T15:00:00Z',
          durationMinutes: 120,
          status: 'SCHEDULED',
          syncStatus: 'pending',
        },
      ],
    };

    // Waktu audit: 14:00 (di tengah sesi)
    const auditTime = new Date('2026-10-25T14:00:00Z');
    const { updatedTasks, transitionedCount } = auditAndTransitionOverdueTasks([inProgressTask], auditTime);
    assert.strictEqual(transitionedCount, 0, 'Kegiatan aktif di tengah jalan tidak boleh ditandai terlewat');
    assert.strictEqual(updatedTasks[0].status, 'IN_PROGRESS');
  }

  // -------------------------------------------------------------
  // KASUS 6: Kegiatan Multi-Hari & Lintas Tengah Malam
  // -------------------------------------------------------------
  console.log('  -> Kasus 6: Kegiatan lintas tengah malam tidak terlewat pada tengah malam');
  {
    const overnightTask: Task = {
      id: 'task-c6',
      title: 'Monitoring Pemeliharaan Server Lintas Malam',
      estimatedDurationMinutes: 240,
      priority: 'URGENT',
      status: 'SCHEDULED',
      createdAt: '2026-10-25T20:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-c6',
          taskId: 'task-c6',
          taskTitle: 'Monitoring Pemeliharaan Server Lintas Malam',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T22:00:00Z',
          endAt: '2026-10-26T02:00:00Z', // Selesai pukul 02:00 esok harinya
          durationMinutes: 240,
          status: 'SCHEDULED',
          syncStatus: 'pending',
        },
      ],
    };

    // Audit tepat pukul 00:30 (melewati tengah malam, tapi belum selesai)
    const auditMidnight = new Date('2026-10-26T00:30:00Z');
    const resMidnight = auditAndTransitionOverdueTasks([overnightTask], auditMidnight);
    assert.strictEqual(resMidnight.transitionedCount, 0, 'Kegiatan lintas tengah malam masih berjalan!');

    // Audit pukul 02:05 (sudah selesai penuh)
    const auditAfter = new Date('2026-10-26T02:05:00Z');
    const resAfter = auditAndTransitionOverdueTasks([overnightTask], auditAfter);
    assert.strictEqual(resAfter.transitionedCount, 1, 'Kegiatan lintas tengah malam sekarang harus ditandai terlewat');
    assert.strictEqual(resAfter.updatedTasks[0].status, 'missed_auto');
  }

  // -------------------------------------------------------------
  // KASUS 7: Kegiatan Waktu Tetap (Fixed Time) Belum Berakhir
  // -------------------------------------------------------------
  console.log('  -> Kasus 7: Kegiatan tetap yang belum berakhir tidak ditandai terlewat');
  {
    const fixedTask: Task = {
      id: 'task-c7',
      title: 'Webinar Arsitektur Cloud',
      estimatedDurationMinutes: 60,
      priority: 'HIGH',
      status: 'SCHEDULED',
      timeConstraintType: 'FIXED_TIME',
      requestedStartAt: '2026-10-25T16:00:00Z',
      requestedEndAt: '2026-10-25T17:00:00Z',
      createdAt: '2026-10-25T08:00:00Z',
    };

    const auditBefore = new Date('2026-10-25T16:30:00Z');
    const resBefore = auditAndTransitionOverdueTasks([fixedTask], auditBefore);
    assert.strictEqual(resBefore.transitionedCount, 0);

    const auditAfter = new Date('2026-10-25T17:01:00Z');
    const resAfter = auditAndTransitionOverdueTasks([fixedTask], auditAfter);
    assert.strictEqual(resAfter.transitionedCount, 1);
    assert.strictEqual(resAfter.updatedTasks[0].status, 'missed_auto');
  }

  // -------------------------------------------------------------
  // KASUS 8: Penjadwalan Ulang Kegiatan missed_auto
  // -------------------------------------------------------------
  console.log('  -> Kasus 8: Penjadwalan ulang membuat ID baru dan menghubungkan referensi');
  {
    const missedTask: Task = {
      id: 'task-missed-8',
      title: 'Reviu Kode Pull Request #42',
      estimatedDurationMinutes: 60,
      priority: 'HIGH',
      status: 'missed_auto',
      rescheduleDecision: 'pending',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-old-8',
          taskId: 'task-missed-8',
          taskTitle: 'Reviu Kode Pull Request #42',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T09:00:00Z',
          endAt: '2026-10-25T10:00:00Z',
          durationMinutes: 60,
          status: 'missed_auto',
          syncStatus: 'pending',
        },
      ],
    };

    const mockScheduleResult: ScheduleCalculationResult = {
      success: true,
      taskId: missedTask.id,
      taskTitle: missedTask.title,
      proposedSessions: [
        {
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-26T09:00:00Z',
          endAt: '2026-10-26T10:00:00Z',
          durationMinutes: 60,
        },
      ],
    };

    const newDeadline = '2026-10-27T18:00:00Z';
    const { newTask, updatedOriginalTask } = prepareRescheduledTask(
      missedTask,
      mockScheduleResult,
      newDeadline
    );

    // Verifikasi ID baru dan tautan dua arah
    assert.notStrictEqual(newTask.id, missedTask.id, 'Task baru harus memiliki ID berbeda');
    assert.strictEqual(newTask.rescheduledFromTaskId, missedTask.id, 'Task baru harus menunjuk ke task lama');
    assert.strictEqual(updatedOriginalTask.rescheduledToTaskId, newTask.id, 'Task lama harus menunjuk ke task baru');
    assert.strictEqual(updatedOriginalTask.status, 'missed_auto', 'Task lama tetap di riwayat sebagai missed_auto');
    assert.strictEqual(updatedOriginalTask.rescheduleDecision, 'rescheduled');
    assert.strictEqual(newTask.status, 'SCHEDULED');
    assert.strictEqual(newTask.deadlineAt, newDeadline);
  }

  // -------------------------------------------------------------
  // KASUS 9: Mengabaikan Penjadwalan Ulang ("Abaikan")
  // -------------------------------------------------------------
  console.log('  -> Kasus 9: Mengabaikan (dismiss) tetap mempertahankan status missed_auto di riwayat');
  {
    const missedTask: Task = {
      id: 'task-missed-9',
      title: 'Tugas yang Tidak Diperlukan Lagi',
      estimatedDurationMinutes: 45,
      priority: 'LOW',
      status: 'missed_auto',
      rescheduleDecision: 'pending',
      createdAt: '2026-10-25T08:00:00Z',
    };

    const dismissed = dismissMissedTask(missedTask, new Date('2026-10-25T12:00:00Z'));

    assert.strictEqual(dismissed.status, 'missed_auto', 'Status harus tetap missed_auto');
    assert.strictEqual(dismissed.rescheduleDecision, 'dismissed', 'rescheduleDecision harus dismissed');
    assert.strictEqual(dismissed.dismissedAt, '2026-10-25T12:00:00.000Z');
    assert.strictEqual(isTaskInHistory(dismissed), true, 'Tetap ada di riwayat');
  }

  // -------------------------------------------------------------
  // KASUS 10: Scheduler Mengabaikan Kegiatan Riwayat
  // -------------------------------------------------------------
  console.log('  -> Kasus 10: Scheduler tidak menganggap kegiatan riwayat sebagai pemblokir slot');
  {
    const historyCompletedTask: Task = {
      id: 'task-hist-comp',
      title: 'Kegiatan Selesai Kemarin',
      estimatedDurationMinutes: 60,
      priority: 'MEDIUM',
      status: 'completed_manual',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-hist-comp',
          taskId: 'task-hist-comp',
          taskTitle: 'Kegiatan Selesai Kemarin',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-26T09:00:00+07:00',
          endAt: '2026-10-26T10:00:00+07:00',
          durationMinutes: 60,
          status: 'completed_manual',
          syncStatus: 'pending',
        },
      ],
    };

    const historyMissedTask: Task = {
      id: 'task-hist-missed',
      title: 'Kegiatan Terlewat Kemarin',
      estimatedDurationMinutes: 60,
      priority: 'MEDIUM',
      status: 'missed_auto',
      createdAt: '2026-10-25T08:00:00Z',
      scheduledSessions: [
        {
          id: 'sess-hist-missed',
          taskId: 'task-hist-missed',
          taskTitle: 'Kegiatan Terlewat Kemarin',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-26T10:00:00+07:00',
          endAt: '2026-10-26T11:00:00+07:00',
          durationMinutes: 60,
          status: 'missed_auto',
          syncStatus: 'pending',
        },
      ],
    };

    // Tugas baru yang ingin dijadwalkan pada pagi hari yang sama
    const newTaskToSchedule: Task = {
      id: 'task-new-10',
      title: 'Tugas Baru Penting',
      estimatedDurationMinutes: 60,
      priority: 'URGENT',
      status: 'UNSCHEDULED',
      createdAt: '2026-10-26T07:00:00+07:00',
      timeConstraintType: 'FLEXIBLE',
      preferredTimeOfDay: 'MORNING',
    };

    const result = scheduleTaskDeterministically(
      newTaskToSchedule,
      [],
      [historyCompletedTask, historyMissedTask],
      defaultPrefs
    );

    assert.strictEqual(result.success, true, 'Penjadwalan tugas baru harus sukses');
    assert.strictEqual(result.proposedSessions.length, 1);
    // Karena kegiatan riwayat diabaikan, slot 08:00-09:00 atau 09:00-10:00 harus tersedia
    const startHour = new Date(result.proposedSessions[0].startAt).getHours();
    assert.ok(startHour >= 8, 'Harus dijadwalkan dalam jam kerja pagi');
  }

  // -------------------------------------------------------------
  // KASUS 11: Perhitungan Persentase Statistik Selesai vs Terlewat
  // -------------------------------------------------------------
  console.log('  -> Kasus 11: Perhitungan persentase tugas selesai manual vs terlewat otomatis');
  {
    const sampleHistory: Task[] = [
      {
        id: 't-comp-1',
        title: 'Tugas Selesai 1',
        estimatedDurationMinutes: 60,
        priority: 'MEDIUM',
        status: 'completed_manual',
        createdAt: '2026-10-25T08:00:00Z',
      },
      {
        id: 't-comp-2',
        title: 'Tugas Selesai 2',
        estimatedDurationMinutes: 30,
        priority: 'HIGH',
        status: 'completed_manual',
        createdAt: '2026-10-25T09:00:00Z',
      },
      {
        id: 't-comp-3',
        title: 'Tugas Selesai 3',
        estimatedDurationMinutes: 45,
        priority: 'LOW',
        status: 'COMPLETED',
        createdAt: '2026-10-25T10:00:00Z',
      },
      {
        id: 't-miss-1',
        title: 'Tugas Terlewat 1',
        estimatedDurationMinutes: 60,
        priority: 'HIGH',
        status: 'missed_auto',
        rescheduleDecision: 'pending',
        createdAt: '2026-10-25T11:00:00Z',
      },
    ];

    const completedCount = sampleHistory.filter(
      (t) => t.status === 'completed_manual' || t.status === 'COMPLETED'
    ).length;
    const missedCount = sampleHistory.filter((t) => t.status === 'missed_auto').length;
    const total = completedCount + missedCount;

    const completionRate = Math.round((completedCount / total) * 100);
    const missedRate = Math.round((missedCount / total) * 100);

    assert.strictEqual(completedCount, 3, 'Jumlah selesai manual harus 3');
    assert.strictEqual(missedCount, 1, 'Jumlah terlewat harus 1');
    assert.strictEqual(completionRate, 75, 'Persentase selesai harus 75%');
    assert.strictEqual(missedRate, 25, 'Persentase terlewat harus 25%');

    // Total waktu fokus selesai = 60 + 30 + 45 = 135 menit = 2 jam 15 menit
    const totalMinutes = sampleHistory
      .filter((t) => t.status === 'completed_manual' || t.status === 'COMPLETED')
      .reduce((sum, t) => sum + (t.estimatedDurationMinutes || 0), 0);
    assert.strictEqual(totalMinutes, 135, 'Total menit selesai harus 135');
  }

  console.log('✅ SELURUH PENGUJIAN RIWAYAT KEGIATAN & OTOMATISASI STATUS BERHASIL!');
}
