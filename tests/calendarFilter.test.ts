import { describe, it, expect } from 'vitest';
import {
  resolveItemCategory,
  resolveItemPriority,
  CATEGORY_OPTIONS,
  PRIORITY_OPTIONS,
  ALL_CATEGORIES,
  ALL_PRIORITIES,
  TaskCategory,
} from '../src/components/CalendarFilterPopover';
import { Task, CalendarEvent, Priority } from '../src/types';

describe('Calendar Filter Logic & Resolvers', () => {
  it('semua opsi kategori dan prioritas valid dan lengkap', () => {
    expect(ALL_CATEGORIES).toEqual(['work', 'personal', 'study', 'focus']);
    expect(ALL_PRIORITIES).toEqual(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
    expect(CATEGORY_OPTIONS.length).toBe(4);
    expect(PRIORITY_OPTIONS.length).toBe(4);

    CATEGORY_OPTIONS.forEach((cat) => {
      expect(cat.id).toBeDefined();
      expect(cat.label).toBeDefined();
      expect(cat.dotClass).toContain('bg-');
    });

    PRIORITY_OPTIONS.forEach((prio) => {
      expect(prio.id).toBeDefined();
      expect(prio.label).toBeDefined();
      expect(prio.badgeClass).toBeDefined();
    });
  });

  it('resolveItemCategory mendeteksi kategori task secara akurat', () => {
    const taskWork: Partial<Task> = { id: 't1', title: 'Coding', category: 'work' };
    const taskStudy: Partial<Task> = { id: 't2', title: 'Belajar TS', category: 'study' };
    const taskFocus: Partial<Task> = { id: 't3', title: 'Deep Work', category: 'focus' };
    const taskPersonal: Partial<Task> = { id: 't4', title: 'Olahraga', category: 'personal' };

    expect(resolveItemCategory({ task: taskWork as Task })).toBe('work');
    expect(resolveItemCategory({ task: taskStudy as Task })).toBe('study');
    expect(resolveItemCategory({ task: taskFocus as Task })).toBe('focus');
    expect(resolveItemCategory({ task: taskPersonal as Task })).toBe('personal');
  });

  it('resolveItemCategory mendeteksi kategori acara Google Calendar dengan pemetaan yang sesuai', () => {
    const evtMeeting: Partial<CalendarEvent> = { id: 'g1', title: 'Sync Tim', category: 'meeting' };
    const evtFocus: Partial<CalendarEvent> = { id: 'g2', title: 'Focus Time', category: 'focus' };
    const evtPersonal: Partial<CalendarEvent> = { id: 'g3', title: 'Dokter', category: 'personal' };

    expect(resolveItemCategory({ event: evtMeeting as CalendarEvent })).toBe('work');
    expect(resolveItemCategory({ event: evtFocus as CalendarEvent })).toBe('focus');
    expect(resolveItemCategory({ event: evtPersonal as CalendarEvent })).toBe('personal');
  });

  it('resolveItemPriority mengekstrak prioritas task dan memberikan fallback MEDIUM untuk Google event', () => {
    const urgentTask: Partial<Task> = { id: 't1', priority: 'URGENT' };
    const lowTask: Partial<Task> = { id: 't2', priority: 'LOW' };
    const googleEvt: Partial<CalendarEvent> = { id: 'g1', title: 'Meeting' };

    expect(resolveItemPriority({ task: urgentTask as Task })).toBe('URGENT');
    expect(resolveItemPriority({ task: lowTask as Task })).toBe('LOW');
    expect(resolveItemPriority({ event: googleEvt as CalendarEvent })).toBe('MEDIUM');
  });

  it('filter real-time menyembunyikan item yang tidak ada dalam kategori atau prioritas yang dipilih', () => {
    const items = [
      { id: '1', title: 'Tugas Kantor', category: 'work' as TaskCategory, priority: 'HIGH' as Priority },
      { id: '2', title: 'Belajar Golang', category: 'study' as TaskCategory, priority: 'MEDIUM' as Priority },
      { id: '3', title: 'Sesi Santai', category: 'personal' as TaskCategory, priority: 'LOW' as Priority },
      { id: '4', title: 'Bug Kritis', category: 'work' as TaskCategory, priority: 'URGENT' as Priority },
    ];

    // Filter hanya kategori 'work'
    const filteredByWork = items.filter(
      (item) => ['work'].includes(item.category) && ALL_PRIORITIES.includes(item.priority)
    );
    expect(filteredByWork.length).toBe(2);
    expect(filteredByWork.map((i) => i.id)).toEqual(['1', '4']);

    // Filter hanya prioritas 'URGENT' & 'HIGH'
    const filteredByUrgentAndHigh = items.filter(
      (item) => ALL_CATEGORIES.includes(item.category) && ['URGENT', 'HIGH'].includes(item.priority)
    );
    expect(filteredByUrgentAndHigh.length).toBe(2);
    expect(filteredByUrgentAndHigh.map((i) => i.id)).toEqual(['1', '4']);

    // Filter kombinasi: category 'study' dan priority 'MEDIUM'
    const filteredCombined = items.filter(
      (item) => ['study'].includes(item.category) && ['MEDIUM'].includes(item.priority)
    );
    expect(filteredCombined.length).toBe(1);
    expect(filteredCombined[0].id).toBe('2');

    // Filter kombinasi tidak cocok
    const filteredEmpty = items.filter(
      (item) => ['personal'].includes(item.category) && ['URGENT'].includes(item.priority)
    );
    expect(filteredEmpty.length).toBe(0);
  });
});
