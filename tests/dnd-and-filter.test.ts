import { describe, it, expect } from 'vitest';
import { Task, Priority, TaskStatus } from '../src/types';
import { getZonedDateTimeParts, createIsoInTimezone } from '../src/lib/timezone';

export function filterTasks(
  tasks: Task[],
  selectedPriorities: Priority[],
  selectedStatuses: TaskStatus[],
  searchQuery: string = ''
): Task[] {
  return tasks.filter((task) => {
    // 1. Priority filter
    if (selectedPriorities.length > 0 && !selectedPriorities.includes(task.priority)) {
      return false;
    }

    // 2. Status filter
    if (selectedStatuses.length > 0) {
      if (!selectedStatuses.includes(task.status)) {
        return false;
      }
    }

    // 3. Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = task.title.toLowerCase().includes(q);
      const matchDesc = task.description?.toLowerCase().includes(q) ?? false;
      if (!matchTitle && !matchDesc) {
        return false;
      }
    }

    return true;
  });
}

export function computeDropSlotTimes(
  dropDate: Date,
  dropHour: number,
  durationMinutes: number,
  timeZone: string = 'Asia/Jakarta'
): { startIso: string; endIso: string } {
  const startParts = getZonedDateTimeParts(dropDate, timeZone);
  const startIso = createIsoInTimezone(
    startParts.year,
    startParts.month,
    startParts.day,
    dropHour,
    0,
    0,
    timeZone
  );

  const effDuration = durationMinutes > 0 ? durationMinutes : 60;
  const startDate = new Date(startIso);
  const endDate = new Date(startDate.getTime() + effDuration * 60 * 1000);
  const endIso = endDate.toISOString();

  return { startIso, endIso };
}

describe('Task Filtering and Drag-and-Drop Slot Computation', () => {
  const sampleTasks: Task[] = [
    {
      id: 'task-1',
      userId: 'user-1',
      title: 'Tugas Kalkulus Lanjutan',
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      estimatedDurationMinutes: 120,
      createdAt: '2026-10-20T08:00:00Z',
    },
    {
      id: 'task-2',
      userId: 'user-1',
      title: 'Desain Antarmuka Mobile',
      priority: 'MEDIUM',
      status: 'SCHEDULED',
      estimatedDurationMinutes: 90,
      createdAt: '2026-10-20T09:00:00Z',
    },
    {
      id: 'task-3',
      userId: 'user-1',
      title: 'Membaca Dokumentasi API',
      priority: 'LOW',
      status: 'COMPLETED',
      estimatedDurationMinutes: 45,
      createdAt: '2026-10-20T10:00:00Z',
    },
    {
      id: 'task-4',
      userId: 'user-1',
      title: 'Presentasi Proyek Akhir',
      priority: 'HIGH',
      status: 'SCHEDULED',
      estimatedDurationMinutes: 60,
      createdAt: '2026-10-20T11:00:00Z',
    },
  ];

  it('memfilter kegiatan berdasarkan prioritas saja (High)', () => {
    const result = filterTasks(sampleTasks, ['HIGH'], []);
    expect(result.length).toBe(2);
    expect(result.map((t) => t.id)).toEqual(['task-1', 'task-4']);
  });

  it('memfilter kegiatan berdasarkan status saja (UNSCHEDULED)', () => {
    const result = filterTasks(sampleTasks, [], ['UNSCHEDULED']);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('task-1');
  });

  it('menggabungkan filter prioritas (HIGH) dan status (SCHEDULED)', () => {
    const result = filterTasks(sampleTasks, ['HIGH'], ['SCHEDULED']);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('task-4');
  });

  it('memfilter dengan pencarian teks bersama filter status', () => {
    const result = filterTasks(sampleTasks, [], ['SCHEDULED'], 'Desain');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('task-2');
  });

  it('menghitung waktu mulai dan selesai drag-and-drop slot secara presisi pada zona waktu Asia/Jakarta', () => {
    const testDate = new Date('2026-10-22T00:00:00Z');
    const dropHour = 14; // 14:00 WIB
    const durationMinutes = 120; // 2 jam

    const { startIso, endIso } = computeDropSlotTimes(testDate, dropHour, durationMinutes, 'Asia/Jakarta');

    const startDate = new Date(startIso);
    const endDate = new Date(endIso);

    // Durasi tepat 120 menit (7200000 ms)
    expect(endDate.getTime() - startDate.getTime()).toBe(120 * 60 * 1000);

    const parts = getZonedDateTimeParts(startDate, 'Asia/Jakarta');
    expect(parts.hour).toBe(14);
    expect(parts.minute).toBe(0);

    const endParts = getZonedDateTimeParts(endDate, 'Asia/Jakarta');
    expect(endParts.hour).toBe(16);
    expect(endParts.minute).toBe(0);
  });
});
