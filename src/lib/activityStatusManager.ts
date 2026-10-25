import { Task, TaskScheduleSession, TaskStatus, ScheduleCalculationResult } from '../types';

/**
 * Modul Pengelolaan Status Kegiatan dan Riwayat EVEN AI Planner
 * Menjamin:
 * 1. Pemisahan tegas status `completed_manual` (penyelesaian manual oleh pengguna)
 *    dan `missed_auto` (terlewat otomatis oleh sistem waktu).
 * 2. Idempotensi penuh: pemanggilan berulang tidak menduplikasi data atau merusak riwayat.
 * 3. Pemeriksaan waktu selesai penuh (termasuk kegiatan multi-hari & lintas tengah malam).
 * 4. Penjadwalan ulang dengan tautan dua arah (rescheduledFromTaskId <-> rescheduledToTaskId).
 */

export function isTaskInHistory(task: Task): boolean {
  return (
    task.status === 'completed_manual' ||
    task.status === 'missed_auto' ||
    task.status === 'COMPLETED'
  );
}

export function isTaskActive(task: Task): boolean {
  return (
    task.status === 'UNSCHEDULED' ||
    task.status === 'SCHEDULED' ||
    task.status === 'IN_PROGRESS'
  );
}

/**
 * Mengambil timestamp waktu selesai aktual/terakhir dari suatu kegiatan.
 * Mengutamakan sesi terjadwal (termasuk bagian terakhir kegiatan multi-sesi),
 * atau requestedEndAt untuk komitmen waktu tetap.
 */
export function getTaskEffectiveEndTime(task: Task): Date | null {
  if (task.scheduledSessions && task.scheduledSessions.length > 0) {
    const endTimes = task.scheduledSessions
      .map((s) => new Date(s.endAt).getTime())
      .filter((t) => !isNaN(t));

    if (endTimes.length > 0) {
      return new Date(Math.max(...endTimes));
    }
  }

  if (task.requestedEndAt) {
    const d = new Date(task.requestedEndAt);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Mengambil timestamp waktu mulai awal dari suatu kegiatan.
 */
export function getTaskEffectiveStartTime(task: Task): Date | null {
  if (task.scheduledSessions && task.scheduledSessions.length > 0) {
    const startTimes = task.scheduledSessions
      .map((s) => new Date(s.startAt).getTime())
      .filter((t) => !isNaN(t));

    if (startTimes.length > 0) {
      return new Date(Math.min(...startTimes));
    }
  }

  if (task.requestedStartAt) {
    const d = new Date(task.requestedStartAt);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Memeriksa seluruh daftar kegiatan aktif dan memindahkan kegiatan yang waktu akhirnya
 * telah terlampaui tanpa diselesaikan manual menjadi `missed_auto`.
 *
 * Sifat: Idempoten, murni (pure function), aman dipanggil berulang kali.
 */
export function auditAndTransitionOverdueTasks(
  tasks: Task[],
  now: Date = new Date()
): {
  updatedTasks: Task[];
  transitionedCount: number;
  missedTasks: Task[];
} {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  let transitionedCount = 0;
  const missedTasks: Task[] = [];

  const updatedTasks = tasks.map((task) => {
    // Abaikan kegiatan yang sudah berada di riwayat atau dibatalkan
    if (
      task.status === 'completed_manual' ||
      task.status === 'missed_auto' ||
      task.status === 'COMPLETED'
    ) {
      return task;
    }

    // Hanya evaluasi kegiatan aktif yang memiliki waktu jadwal
    const effectiveEndTime = getTaskEffectiveEndTime(task);
    if (!effectiveEndTime) {
      // Kegiatan belum dijadwalkan (UNSCHEDULED tanpa requestedEndAt) tidak otomatis missed
      return task;
    }

    const endMs = effectiveEndTime.getTime();

    // Jika waktu selesai kegiatan belum lewat atau masih berlangsung, pertahankan status aktif!
    // KASUS LINTAS TENGAH MALAM / MULTI-HARI: ditunggu hingga waktu selesai penuh berlalu.
    if (nowMs < endMs) {
      return task;
    }

    // Waktu selesai telah berlalu dan belum diselesaikan manual -> Tandai missed_auto!
    transitionedCount++;

    const updatedSessions = task.scheduledSessions?.map((session) => {
      const sessEndMs = new Date(session.endAt).getTime();
      if (sessEndMs <= nowMs && session.status !== 'completed_manual' && session.status !== 'COMPLETED') {
        return {
          ...session,
          status: 'missed_auto' as const,
          missedAt: nowIso,
        };
      }
      return session;
    });

    const transitionedTask: Task = {
      ...task,
      status: 'missed_auto',
      missedAt: task.missedAt || nowIso,
      rescheduleDecision: task.rescheduleDecision || 'pending',
      scheduledSessions: updatedSessions,
      statusHistory: [
        ...(task.statusHistory || []),
        {
          status: 'missed_auto',
          changedAt: nowIso,
          reason: 'Waktu selesai jadwal telah berlalu tanpa penandaan selesai manual',
        },
      ],
    };

    missedTasks.push(transitionedTask);
    return transitionedTask;
  });

  return {
    updatedTasks,
    transitionedCount,
    missedTasks,
  };
}

/**
 * Menyelesaikan kegiatan secara manual oleh tindakan pengguna.
 * Menandai status sebagai `completed_manual` dan menyimpan timestamp penyelesaian.
 */
export function completeTaskManually(
  task: Task,
  now: Date = new Date(),
  sessionId?: string
): Task {
  const nowIso = now.toISOString();

  // Jika spesifik satu sesi yang diselesaikan
  if (sessionId && task.scheduledSessions && task.scheduledSessions.length > 0) {
    const updatedSessions = task.scheduledSessions.map((s) => {
      if (s.id === sessionId) {
        return {
          ...s,
          status: 'completed_manual' as const,
          completedAt: nowIso,
        };
      }
      return s;
    });

    const allSessionsCompleted = updatedSessions.every(
      (s) => s.status === 'completed_manual' || s.status === 'COMPLETED'
    );

    const nextStatus: TaskStatus = allSessionsCompleted ? 'completed_manual' : 'IN_PROGRESS';

    return {
      ...task,
      status: nextStatus,
      completedAt: allSessionsCompleted ? nowIso : task.completedAt,
      scheduledSessions: updatedSessions,
      statusHistory: [
        ...(task.statusHistory || []),
        {
          status: nextStatus,
          changedAt: nowIso,
          reason: allSessionsCompleted
            ? 'Seluruh sesi diselesaikan manual oleh pengguna'
            : `Sesi ${sessionId} diselesaikan manual`,
        },
      ],
    };
  }

  // Menyelesaikan seluruh kegiatan
  const updatedSessions = task.scheduledSessions?.map((s) => ({
    ...s,
    status: 'completed_manual' as const,
    completedAt: nowIso,
  }));

  return {
    ...task,
    status: 'completed_manual',
    completedAt: nowIso,
    scheduledSessions: updatedSessions,
    statusHistory: [
      ...(task.statusHistory || []),
      {
        status: 'completed_manual',
        changedAt: nowIso,
        reason: 'Kegiatan diselesaikan secara manual oleh pengguna',
      },
    ],
  };
}

/**
 * Menandai kegiatan terlewat (`missed_auto`) sebagai diabaikan oleh pengguna.
 * Kegiatan tetap berada di riwayat dengan status historis `missed_auto`.
 */
export function dismissMissedTask(task: Task, now: Date = new Date()): Task {
  const nowIso = now.toISOString();

  return {
    ...task,
    rescheduleDecision: 'dismissed',
    dismissedAt: nowIso,
    statusHistory: [
      ...(task.statusHistory || []),
      {
        status: task.status,
        changedAt: nowIso,
        reason: 'Penjadwalan ulang diabaikan oleh pengguna',
      },
    ],
  };
}

/**
 * Menyiapkan kegiatan baru hasil penjadwalan ulang dari kegiatan `missed_auto`,
 * serta menautkan referensi ID kedua kegiatan secara persisten.
 */
export function prepareRescheduledTask(
  originalTask: Task,
  scheduleResult: ScheduleCalculationResult,
  newDeadlineAt?: string | null,
  now: Date = new Date()
): {
  newTask: Task;
  updatedOriginalTask: Task;
} {
  const nowIso = now.toISOString();
  const newTaskId = `task-rescheduled-${Date.now()}`;
  const sessionIdBase = `sess-${newTaskId}`;

  const newSessions: TaskScheduleSession[] = scheduleResult.proposedSessions.map((s) => ({
    id: `${sessionIdBase}-${s.sessionIndex}`,
    taskId: newTaskId,
    taskTitle: originalTask.title,
    sessionIndex: s.sessionIndex,
    totalSessions: s.totalSessions,
    startAt: s.startAt,
    endAt: s.endAt,
    durationMinutes: s.durationMinutes,
    status: 'SCHEDULED',
    syncStatus: 'pending',
  }));

  const newTask: Task = {
    id: newTaskId,
    userId: originalTask.userId,
    title: originalTask.title,
    description: originalTask.description,
    estimatedDurationMinutes: originalTask.estimatedDurationMinutes,
    deadlineAt: newDeadlineAt !== undefined ? newDeadlineAt : null,
    priority: originalTask.priority,
    status: 'SCHEDULED',
    allowSplit: originalTask.allowSplit,
    minimumSessionMinutes: originalTask.minimumSessionMinutes,
    preferredTimeOfDay: originalTask.preferredTimeOfDay,
    timeConstraintType: originalTask.timeConstraintType,
    preferredWindow: originalTask.preferredWindow,
    category: originalTask.category,
    timezone: originalTask.timezone,
    createdAt: nowIso,
    rescheduledFromTaskId: originalTask.id,
    scheduledSessions: newSessions,
    statusHistory: [
      {
        status: 'SCHEDULED',
        changedAt: nowIso,
        reason: `Hasil penjadwalan ulang dari kegiatan "${originalTask.title}" (${originalTask.id})`,
      },
    ],
  };

  const updatedOriginalTask: Task = {
    ...originalTask,
    rescheduledToTaskId: newTaskId,
    rescheduleDecision: 'rescheduled',
    statusHistory: [
      ...(originalTask.statusHistory || []),
      {
        status: originalTask.status,
        changedAt: nowIso,
        reason: `Berhasil dijadwalkan ulang ke kegiatan baru (ID: ${newTaskId})`,
      },
    ],
  };

  return {
    newTask,
    updatedOriginalTask,
  };
}
