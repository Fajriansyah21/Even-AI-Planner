import { KeepNote, Task } from '../types';

export function getInitialKeepNotes(): KeepNote[] {
  const now = new Date();

  return [
    {
      id: 'keep-1',
      userId: 'user-default',
      title: 'Ide Fitur EVEN v2 & Integrasi Google Workspace',
      content: '1. Sinkronisasi kalender dua arah dengan penanganan event berulang.\n2. Ekspor ringkasan rencana harian ke Keep sebagai checklist.\n3. Widget fokus mode pomodoro.',
      checklist: [
        { id: 'c1', text: 'Konfigurasi Google Calendar OAuth scopes', checked: true },
        { id: 'c2', text: 'Integrasikan Firestore persistence', checked: true },
        { id: 'c3', text: 'Uji sinkronisasi Keep notes ke daftar tugas', checked: false },
        { id: 'c4', text: 'Tampilkan status izin domain-wide delegation Keep', checked: true },
      ],
      color: 'sage',
      isPinned: true,
      isArchived: false,
      tags: ['workspace', 'roadmap', 'projek'],
      priority: 'HIGH',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: 'keep-2',
      userId: 'user-default',
      title: 'Daftar Bacaan & Referensi Algoritma Penjadwalan',
      content: 'Tinjau Interval Scheduling Algorithm, greedy approach dengan earliest deadline first (EDF), dan constraint satisfaction problem (CSP).',
      checklist: [],
      color: 'sand',
      isPinned: false,
      isArchived: false,
      tags: ['belajar', 'algoritma'],
      priority: 'MEDIUM',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    },
  ];
}

/**
 * Converts a Keep note into an EVEN task candidate
 */
export function convertKeepNoteToTask(note: KeepNote): Partial<Task> {
  // Estimate duration: 45 min default or calculate from checklist
  const estimatedDuration = note.checklist && note.checklist.length > 0 ? note.checklist.length * 20 : 60;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(17, 0, 0, 0);

  const baseDescription = note.content || note.checklist?.map((c) => (c.checked ? `[x] ${c.text}` : `[ ] ${c.text}`)).join('\n') || '';
  const tagsText = note.tags && note.tags.length > 0 ? `\n\nTag: ${note.tags.map((t) => `#${t.replace(/^#/, '')}`).join(' ')}` : '';

  return {
    title: note.title || 'Tugas dari Catatan Keep',
    description: `${baseDescription}${tagsText}`.trim(),
    estimatedDurationMinutes: estimatedDuration,
    deadlineAt: tomorrow.toISOString(),
    priority: note.priority || 'MEDIUM',
    allowSplit: true,
    minimumSessionMinutes: 30,
  };
}

/**
 * Converts an EVEN task into a Keep checklist note
 */
export function convertTaskToKeepNote(task: Task, userId: string): KeepNote {
  const checklist = task.scheduledSessions?.map((s, i) => ({
    id: `chk-${Date.now()}-${i}`,
    text: `Sesi ${s.sessionIndex}: ${s.durationMinutes} mnt (${new Date(s.startAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })})`,
    checked: s.status === 'COMPLETED',
  })) || [
    {
      id: `chk-${Date.now()}-0`,
      text: `Selesaikan: ${task.title} (${task.estimatedDurationMinutes} menit)`,
      checked: task.status === 'COMPLETED',
    },
  ];

  return {
    id: `keep-${Date.now()}`,
    userId,
    title: task.title,
    content: task.description || '',
    checklist,
    color: 'default',
    isPinned: false,
    isArchived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
