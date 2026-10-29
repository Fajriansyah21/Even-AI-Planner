import { describe, it, expect } from 'vitest';
import {
  markMissedTaskAsCompleted,
  auditAndTransitionOverdueTasks,
} from '../src/lib/activityStatusManager';
import { Task } from '../src/types';

describe('Tandai Kegiatan Terlewat sebagai Selesai (markMissedTaskAsCompleted)', () => {
  const baseMissedTask: Task = {
    id: 'task-missed-1',
    title: 'Mengerjakan Laporan Praktikum',
    description: 'Modul 3 Pemrograman Web',
    estimatedDurationMinutes: 120,
    priority: 'HIGH',
    status: 'missed_auto',
    missedAt: '2026-10-25T14:00:00.000Z',
    deadlineAt: '2026-10-25T13:00:00.000Z',
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-25T14:00:00.000Z',
    userId: 'user-123',
    scheduledSessions: [
      {
        id: 'sess-1',
        sessionIndex: 1,
        totalSessions: 1,
        startAt: '2026-10-25T10:00:00.000Z',
        endAt: '2026-10-25T12:00:00.000Z',
        durationMinutes: 120,
        status: 'missed_auto',
        googleCalendarEventId: 'gcal-evt-999',
        googleCalendarHtmlLink: 'https://calendar.google.com/event?eid=gcal-evt-999',
      },
    ],
    statusHistory: [
      {
        status: 'SCHEDULED',
        changedAt: '2026-10-20T08:05:00.000Z',
        reason: 'Penjadwalan otomatis pertama kali',
      },
      {
        status: 'missed_auto',
        changedAt: '2026-10-25T14:00:00.000Z',
        reason: 'Kegiatan terlewat dari jadwal tanpa konfirmasi',
      },
    ],
  };

  it('mengubah status missed_auto menjadi completed_manual dan mencatat completedAt', () => {
    const confirmationTime = new Date('2026-10-26T09:30:00.000Z');
    const result = markMissedTaskAsCompleted(baseMissedTask, confirmationTime);

    expect(result.status).toBe('completed_manual');
    expect(result.completedAt).toBe(confirmationTime.toISOString());
  });

  it('mempertahankan nilai missedAt asli sebagai bukti audit historis', () => {
    const confirmationTime = new Date('2026-10-26T09:30:00.000Z');
    const result = markMissedTaskAsCompleted(baseMissedTask, confirmationTime);

    expect(result.missedAt).toBe('2026-10-25T14:00:00.000Z');
    expect(result.missedAt).not.toBe(result.completedAt);
  });

  it('mengeluarkan kegiatan dari antrean tindakan penjadwalan ulang (rescheduleDecision = dismissed)', () => {
    const result = markMissedTaskAsCompleted(baseMissedTask);
    expect(result.rescheduleDecision).toBe('dismissed');
  });

  it('memperbarui status sesi jadwal menjadi completed_manual tanpa menghapus relasi Google Calendar', () => {
    const confirmationTime = new Date('2026-10-26T09:30:00.000Z');
    const result = markMissedTaskAsCompleted(baseMissedTask, confirmationTime);

    expect(result.scheduledSessions).toBeDefined();
    expect(result.scheduledSessions?.length).toBe(1);

    const session = result.scheduledSessions![0];
    expect(session.status).toBe('completed_manual');
    expect(session.completedAt).toBe(confirmationTime.toISOString());
    expect(session.startAt).toBe('2026-10-25T10:00:00.000Z');
    expect(session.endAt).toBe('2026-10-25T12:00:00.000Z');
    expect(session.googleCalendarEventId).toBe('gcal-evt-999');
    expect(session.googleCalendarHtmlLink).toBe('https://calendar.google.com/event?eid=gcal-evt-999');
  });

  it('menambahkan riwayat statusHistory dengan status completed_manual dan alasan yang jelas', () => {
    const confirmationTime = new Date('2026-10-26T09:30:00.000Z');
    const customReason = 'Pengguna mengonfirmasi bahwa kegiatan telah selesai.';
    const result = markMissedTaskAsCompleted(baseMissedTask, confirmationTime, customReason);

    expect(result.statusHistory).toBeDefined();
    expect(result.statusHistory?.length).toBe(3);

    const latestHistory = result.statusHistory![result.statusHistory!.length - 1];
    expect(latestHistory.status).toBe('completed_manual');
    expect(latestHistory.changedAt).toBe(confirmationTime.toISOString());
    expect(latestHistory.reason).toBe(customReason);
  });

  it('idempoten: tidak mengubah tugas jika statusnya bukan missed_auto', () => {
    const alreadyCompletedTask: Task = {
      ...baseMissedTask,
      status: 'completed_manual',
      completedAt: '2026-10-25T15:00:00.000Z',
    };

    const attempt1 = markMissedTaskAsCompleted(alreadyCompletedTask);
    expect(attempt1).toBe(alreadyCompletedTask);
    expect(attempt1.statusHistory?.length).toBe(baseMissedTask.statusHistory?.length);

    const scheduledTask: Task = {
      ...baseMissedTask,
      status: 'SCHEDULED',
      missedAt: undefined,
    };

    const attempt2 = markMissedTaskAsCompleted(scheduledTask);
    expect(attempt2).toBe(scheduledTask);
    expect(attempt2.status).toBe('SCHEDULED');
  });

  it('memastikan tugas terhitung sebagai selesai dan tidak lagi terhitung sebagai missed pada kalkulasi metrik riwayat', () => {
    const taskList: Task[] = [
      baseMissedTask,
      {
        id: 'task-other-1',
        title: 'Membaca Dokumentasi',
        status: 'completed_manual',
        completedAt: '2026-10-24T10:00:00.000Z',
        createdAt: '2026-10-20T08:00:00.000Z',
        updatedAt: '2026-10-24T10:00:00.000Z',
        estimatedDurationMinutes: 60,
      },
    ];

    // Sebelum ditandai: 1 selesai, 1 terlewat
    const completedBefore = taskList.filter((t) => t.status === 'completed_manual' || t.status === 'COMPLETED').length;
    const missedBefore = taskList.filter((t) => t.status === 'missed_auto').length;
    expect(completedBefore).toBe(1);
    expect(missedBefore).toBe(1);

    // Setelah ditandai
    const updatedTaskList = taskList.map((t) => (t.id === baseMissedTask.id ? markMissedTaskAsCompleted(t) : t));
    const completedAfter = updatedTaskList.filter((t) => t.status === 'completed_manual' || t.status === 'COMPLETED').length;
    const missedAfter = updatedTaskList.filter((t) => t.status === 'missed_auto').length;
    expect(completedAfter).toBe(2);
    expect(missedAfter).toBe(0);
  });
});

export function runMarkMissedCompletedTests() {
  console.log('=== RUNNING MARK MISSED TASK AS COMPLETED TESTS ===');
  const baseMissedTask: Task = {
    id: 'task-missed-1',
    title: 'Mengerjakan Laporan Praktikum',
    description: 'Modul 3 Pemrograman Web',
    estimatedDurationMinutes: 120,
    priority: 'HIGH',
    status: 'missed_auto',
    missedAt: '2026-10-25T14:00:00.000Z',
    deadlineAt: '2026-10-25T13:00:00.000Z',
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-25T14:00:00.000Z',
    userId: 'user-123',
    scheduledSessions: [
      {
        id: 'sess-1',
        sessionIndex: 1,
        totalSessions: 1,
        startAt: '2026-10-25T10:00:00.000Z',
        endAt: '2026-10-25T12:00:00.000Z',
        durationMinutes: 120,
        status: 'missed_auto',
        googleCalendarEventId: 'gcal-evt-999',
        googleCalendarHtmlLink: 'https://calendar.google.com/event?eid=gcal-evt-999',
      },
    ],
    statusHistory: [
      {
        status: 'SCHEDULED',
        changedAt: '2026-10-20T08:05:00.000Z',
        reason: 'Penjadwalan otomatis pertama kali',
      },
      {
        status: 'missed_auto',
        changedAt: '2026-10-25T14:00:00.000Z',
        reason: 'Kegiatan terlewat dari jadwal tanpa konfirmasi',
      },
    ],
  };

  const confirmationTime = new Date('2026-10-26T09:30:00.000Z');
  const result = markMissedTaskAsCompleted(baseMissedTask, confirmationTime);

  if (result.status !== 'completed_manual') {
    throw new Error(`Expected completed_manual status, got ${result.status}`);
  }
  console.log('✅ PASSED: Status transitioned to completed_manual');

  if (result.completedAt !== confirmationTime.toISOString()) {
    throw new Error(`Expected completedAt ${confirmationTime.toISOString()}, got ${result.completedAt}`);
  }
  console.log('✅ PASSED: completedAt set to confirmation time');

  if (result.missedAt !== '2026-10-25T14:00:00.000Z') {
    throw new Error(`Expected missedAt to be preserved, got ${result.missedAt}`);
  }
  console.log('✅ PASSED: Original missedAt preserved');

  if (result.rescheduleDecision !== 'dismissed') {
    throw new Error(`Expected rescheduleDecision dismissed, got ${result.rescheduleDecision}`);
  }
  console.log('✅ PASSED: rescheduleDecision set to dismissed');

  const session = result.scheduledSessions?.[0];
  if (!session || session.status !== 'completed_manual' || session.googleCalendarEventId !== 'gcal-evt-999') {
    throw new Error('Scheduled session status or Google Calendar event ID corrupted');
  }
  console.log('✅ PASSED: Session updated with completed_manual while preserving Google Calendar relation');

  const latestHistory = result.statusHistory?.[result.statusHistory.length - 1];
  if (!latestHistory || latestHistory.status !== 'completed_manual' || !latestHistory.reason) {
    throw new Error('Status history entry missing or invalid');
  }
  console.log('✅ PASSED: Status history entry appended with transition reason');

  const idempotentCheck = markMissedTaskAsCompleted(result);
  if (idempotentCheck !== result) {
    throw new Error('Function must be idempotent for non-missed_auto tasks');
  }
  console.log('✅ PASSED: Idempotency confirmed for already-completed task');
  console.log('========================================================================');
  console.log('🎉 SEMUA PENGUJIAN TANDAI TERLEWAT SELESAI BERHASIL 100%! 🎉');
  console.log('========================================================================');
}
