import React, { useState, useMemo } from 'react';
import {
  Pin,
  Plus,
  CheckSquare,
  Square,
  ArrowRight,
  Trash2,
  Tag as TagIcon,
  Download,
  Info,
  Calendar,
  Layers,
  Edit2,
  X,
  Search,
  Hash,
  Flag,
} from 'lucide-react';
import { KeepNote, KeepChecklistItem, Priority } from '../types';

interface KeepNotesViewProps {
  notes: KeepNote[];
  onCreateNote: (note: Omit<KeepNote, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onUpdateNote: (note: KeepNote) => void;
  onDeleteNote: (noteId: string) => void;
  onConvertNoteToTask: (note: KeepNote) => void;
}

const PRESET_TAGS = ['Kerja', 'Kuliah', 'Ide', 'Projek', 'Pribadi', 'Keuangan'];

const PRIORITY_BADGES: Record<Priority, { label: string; bg: string; text: string; border: string }> = {
  URGENT: { label: 'Mendesak', bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-700 dark:text-rose-400', border: 'border-rose-200 dark:border-rose-800' },
  HIGH: { label: 'Tinggi', bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-400', border: 'border-amber-200 dark:border-amber-800' },
  MEDIUM: { label: 'Sedang', bg: 'bg-[#EAF3FC] dark:bg-blue-950/40', text: 'text-[#2457A7] dark:text-blue-400', border: 'border-[#8DBCEB]/50 dark:border-blue-800' },
  LOW: { label: 'Rendah', bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-[#53657A] dark:text-slate-400', border: 'border-slate-200 dark:border-slate-700' },
};

export const KeepNotesView: React.FC<KeepNotesViewProps> = ({
  notes,
  onCreateNote,
  onUpdateNote,
  onDeleteNote,
  onConvertNoteToTask,
}) => {
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PINNED' | 'ARCHIVED'>('ALL');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null);
  const [selectedPriorityFilter, setSelectedPriorityFilter] = useState<Priority | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Create Form State
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [isChecklist, setIsChecklist] = useState(false);
  const [checklistText, setChecklistText] = useState('');
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState('');
  const [newPriority, setNewPriority] = useState<Priority>('MEDIUM');

  // Edit Modal State
  const [editingNote, setEditingNote] = useState<KeepNote | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editChecklist, setEditChecklist] = useState<KeepChecklistItem[]>([]);
  const [newChecklistText, setNewChecklistText] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editTagInput, setEditTagInput] = useState('');
  const [editPriority, setEditPriority] = useState<Priority>('MEDIUM');
  const [editError, setEditError] = useState('');

  const colorClasses: Record<KeepNote['color'], string> = {
    default: 'bg-white border-[#D9E3EF]',
    sand: 'bg-amber-50/70 border-amber-200/80',
    coral: 'bg-rose-50/70 border-rose-200/80',
    sage: 'bg-emerald-50/70 border-emerald-200/80',
    fog: 'bg-sky-50/70 border-sky-200/80',
    storm: 'bg-slate-100/70 border-slate-300/80',
  };

  // Extract all unique tags across notes for the tag filter bar
  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    notes.forEach((n) => {
      if (n.tags && Array.isArray(n.tags)) {
        n.tags.forEach((t) => {
          const clean = t.trim().replace(/^#/, '');
          if (clean) tagSet.add(clean);
        });
      }
    });
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const handleAddTagToNew = (tag: string) => {
    const clean = tag.trim().replace(/^#/, '');
    if (!clean) return;
    if (!newTags.includes(clean)) {
      setNewTags([...newTags, clean]);
    }
    setNewTagInput('');
  };

  const handleRemoveTagFromNew = (tag: string) => {
    setNewTags(newTags.filter((t) => t !== tag));
  };

  const handleAddTagToEdit = (tag: string) => {
    const clean = tag.trim().replace(/^#/, '');
    if (!clean) return;
    if (!editTags.includes(clean)) {
      setEditTags([...editTags, clean]);
    }
    setEditTagInput('');
  };

  const handleRemoveTagFromEdit = (tag: string) => {
    setEditTags(editTags.filter((t) => t !== tag));
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() && !newContent.trim() && !checklistText.trim()) return;

    const checklistItems = isChecklist
      ? checklistText
          .split('\n')
          .filter((line) => line.trim())
          .map((item, idx) => ({
            id: `c-${Date.now()}-${idx}`,
            text: item.trim(),
            checked: false,
          }))
      : [];

    onCreateNote({
      userId: 'user-default',
      title: newTitle.trim(),
      content: newContent.trim(),
      checklist: checklistItems,
      color: 'default',
      isPinned: false,
      isArchived: false,
      tags: newTags,
      priority: newPriority,
    });

    setNewTitle('');
    setNewContent('');
    setChecklistText('');
    setNewTags([]);
    setNewTagInput('');
    setNewPriority('MEDIUM');
    setIsCreating(false);
    setIsChecklist(false);
  };

  const toggleChecklistItem = (note: KeepNote, itemId: string) => {
    if (!note.checklist) return;
    const updated = note.checklist.map((item) =>
      item.id === itemId ? { ...item, checked: !item.checked } : item
    );
    onUpdateNote({
      ...note,
      checklist: updated,
      updatedAt: new Date().toISOString(),
    });
  };

  const togglePin = (note: KeepNote) => {
    onUpdateNote({
      ...note,
      isPinned: !note.isPinned,
      updatedAt: new Date().toISOString(),
    });
  };

  const openEditNote = (note: KeepNote) => {
    setEditingNote(note);
    setEditTitle(note.title || '');
    setEditContent(note.content || '');
    setEditChecklist(note.checklist ? note.checklist.map((c) => ({ ...c })) : []);
    setEditTags(note.tags ? [...note.tags] : []);
    setEditPriority(note.priority || 'MEDIUM');
    setEditTagInput('');
    setNewChecklistText('');
    setEditError('');
  };

  const closeEditModal = () => {
    setEditingNote(null);
    setEditError('');
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingNote) return;

    const trimmedTitle = editTitle.trim();
    const trimmedContent = editContent.trim();
    const hasChecklist = editChecklist.length > 0;

    if (!trimmedTitle && !trimmedContent && !hasChecklist) {
      setEditError('Catatan tidak boleh kosong. Isi judul, isi teks, atau item daftar periksa.');
      return;
    }

    const updatedNote: KeepNote = {
      ...editingNote,
      title: trimmedTitle,
      content: trimmedContent,
      checklist: editChecklist,
      tags: editTags,
      priority: editPriority,
      updatedAt: new Date().toISOString(),
    };

    onUpdateNote(updatedNote);
    closeEditModal();
  };

  const handleAddEditChecklistItem = () => {
    if (!newChecklistText.trim()) return;
    const newItem: KeepChecklistItem = {
      id: `c-${Date.now()}-${editChecklist.length}`,
      text: newChecklistText.trim(),
      checked: false,
    };
    setEditChecklist([...editChecklist, newItem]);
    setNewChecklistText('');
  };

  const handleUpdateEditChecklistItemText = (id: string, text: string) => {
    setEditChecklist(editChecklist.map((item) => (item.id === id ? { ...item, text } : item)));
  };

  const handleToggleEditChecklistItem = (id: string) => {
    setEditChecklist(
      editChecklist.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item))
    );
  };

  const handleRemoveEditChecklistItem = (id: string) => {
    setEditChecklist(editChecklist.filter((item) => item.id !== id));
  };

  const exportKeepJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(notes, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `even-google-keep-notes-${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Filter notes based on status, tag, priority, and search query
  const filteredNotes = notes.filter((n) => {
    // 1. Status Filter
    if (statusFilter === 'PINNED' && (!n.isPinned || n.isArchived)) return false;
    if (statusFilter === 'ARCHIVED' && !n.isArchived) return false;
    if (statusFilter === 'ALL' && n.isArchived) return false;

    // 2. Priority Filter
    if (selectedPriorityFilter !== 'ALL') {
      const p = n.priority || 'MEDIUM';
      if (p !== selectedPriorityFilter) return false;
    }

    // 3. Tag Filter
    if (selectedTagFilter) {
      const noteTags = (n.tags || []).map((t) => t.trim().toLowerCase().replace(/^#/, ''));
      if (!noteTags.includes(selectedTagFilter.toLowerCase())) return false;
    }

    // 4. Search Query Filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = (n.title || '').toLowerCase().includes(q);
      const matchContent = (n.content || '').toLowerCase().includes(q);
      const matchTags = (n.tags || []).some((t) => t.toLowerCase().includes(q));
      const matchChecklist = (n.checklist || []).some((c) => c.text.toLowerCase().includes(q));
      if (!matchTitle && !matchContent && !matchTags && !matchChecklist) return false;
    }

    return true;
  });

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-y-auto p-4 sm:p-6">
      <div className="max-w-5xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl sm:text-2xl font-bold font-editorial text-[#172B42] tracking-tight">
                Catatan Google Keep & Ide Kegiatan
              </h2>
              <span className="text-[10px] bg-amber-100 text-[#B86B12] px-2 py-0.5 rounded-full font-semibold border border-amber-200">
                Google Keep
              </span>
            </div>
            <p className="text-xs text-[#53657A] mt-0.5">
              Tulis catatan cepat, kelompokkan dengan label tag dan prioritas, lalu jadwalkan langsung ke kalender EVEN.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={exportKeepJson}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#53657A] hover:text-[#172B42] bg-white border border-[#D9E3EF] hover:bg-slate-50 rounded-xl transition-colors shadow-2xs"
              title="Unduh catatan format JSON Google Keep"
            >
              <Download size={13} />
              <span>Ekspor Keep JSON</span>
            </button>
            <button
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] rounded-xl transition-colors shadow-xs"
            >
              <Plus size={15} />
              <span>Buat Catatan</span>
            </button>
          </div>
        </div>

        {/* Enterprise Notice Banner */}
        <div className="p-3.5 bg-amber-50/70 border border-amber-200 rounded-2xl flex items-start gap-2.5 text-xs text-[#53657A]">
          <Info size={16} className="text-[#B86B12] shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <strong className="text-[#172B42]">Tentang Integrasi Google Keep:</strong> Google Keep API resmi dari Google Workspace mensyaratkan <em>Domain-Wide Delegation</em> di Google Admin Console. Di EVEN, catatan Keep Anda disinkronkan langsung ke database cloud Firestore dengan dukungan konversi dua arah ke kalender, pelabelan kategori, dan ekspor JSON.
          </div>
        </div>

        {/* Quick Note Creator with Tagging & Priority */}
        {isCreating && (
          <form
            onSubmit={handleCreateSubmit}
            className="bg-white border border-[#2457A7] rounded-2xl p-4 shadow-sm space-y-3.5 animate-in fade-in"
          >
            <input
              type="text"
              placeholder="Judul catatan..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="w-full text-sm font-bold text-[#172B42] focus:outline-hidden"
              autoFocus
            />

            {!isChecklist ? (
              <textarea
                placeholder="Tuliskan catatan atau ide kegiatan Anda..."
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={3}
                className="w-full text-xs text-[#172B42] focus:outline-hidden resize-none"
              />
            ) : (
              <textarea
                placeholder="Tulis daftar item (satu per baris)..."
                value={checklistText}
                onChange={(e) => setChecklistText(e.target.value)}
                rows={4}
                className="w-full text-xs text-[#172B42] font-mono focus:outline-hidden resize-none p-2 bg-[#F8FAFC] rounded-lg border border-[#D9E3EF]"
              />
            )}

            {/* Tag & Priority Selector Area */}
            <div className="p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF] space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                {/* Priority Selector */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-semibold text-[#53657A] flex items-center gap-1">
                    <Flag size={12} className="text-[#2457A7]" /> Prioritas:
                  </span>
                  {(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as Priority[]).map((p) => {
                    const cfg = PRIORITY_BADGES[p];
                    const active = newPriority === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setNewPriority(p)}
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all ${
                          active
                            ? `${cfg.bg} ${cfg.text} ${cfg.border} ring-1 ring-black/5 shadow-2xs`
                            : 'bg-white text-[#53657A] border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>

                {/* Preset Quick Tags */}
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[10px] text-[#53657A]">Label Cepat:</span>
                  {PRESET_TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleAddTagToNew(tag)}
                      className="text-[10px] px-2 py-0.5 bg-white hover:bg-[#EAF3FC] text-[#2457A7] border border-[#D9E3EF] rounded-md transition-colors"
                    >
                      +{tag}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tag Input & Display */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {newTags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#EAF3FC] text-[#2457A7] text-[11px] font-medium border border-[#8DBCEB]/50"
                    >
                      <Hash size={10} />
                      <span>{t}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTagFromNew(t)}
                        className="hover:text-red-600 transition-colors"
                        title="Hapus tag"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Hash size={12} className="absolute left-2.5 top-2 text-[#53657A]" />
                    <input
                      type="text"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTagToNew(newTagInput);
                        }
                      }}
                      placeholder="Ketik nama tag dan tekan Enter (misal: kuliah, projek)..."
                      className="w-full pl-7 pr-3 py-1 text-xs rounded-lg border border-[#D9E3EF] bg-white text-[#172B42] focus:outline-hidden focus:ring-1 focus:ring-[#2457A7]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAddTagToNew(newTagInput)}
                    className="px-2.5 py-1 text-xs font-semibold bg-white hover:bg-slate-50 border border-[#D9E3EF] text-[#2457A7] rounded-lg transition-colors"
                  >
                    + Tag
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[#D9E3EF] text-xs">
              <button
                type="button"
                onClick={() => setIsChecklist(!isChecklist)}
                className="text-[#2457A7] font-medium hover:underline flex items-center gap-1"
              >
                <CheckSquare size={14} />
                {isChecklist ? 'Beralih ke Catatan Teks' : 'Beralih ke Daftar Periksa (Checklist)'}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className="px-3 py-1.5 font-medium text-[#53657A] hover:text-[#172B42]"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] rounded-xl shadow-2xs"
                >
                  Simpan Catatan
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Filter Controls Bar: Search, Status, Priority & Tags */}
        <div className="bg-white border border-[#D9E3EF] rounded-2xl p-4 shadow-xs space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search size={14} className="absolute left-3 top-2.5 text-[#53657A]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari catatan berdasarkan judul, isi, atau tag..."
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-[#D9E3EF] text-[#172B42] focus:outline-hidden focus:ring-1 focus:ring-[#2457A7] bg-[#F8FAFC]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2.5 text-[#53657A] hover:text-[#172B42]"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Status Filter Tabs */}
            <div className="flex items-center gap-1 p-1 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl w-fit text-xs font-medium">
              <button
                onClick={() => setStatusFilter('ALL')}
                className={`px-3 py-1 rounded-lg transition-all ${
                  statusFilter === 'ALL' ? 'bg-[#2457A7] text-white font-semibold shadow-2xs' : 'text-[#53657A] hover:text-[#172B42]'
                }`}
              >
                Semua ({notes.filter((n) => !n.isArchived).length})
              </button>
              <button
                onClick={() => setStatusFilter('PINNED')}
                className={`px-3 py-1 rounded-lg transition-all ${
                  statusFilter === 'PINNED' ? 'bg-[#2457A7] text-white font-semibold shadow-2xs' : 'text-[#53657A] hover:text-[#172B42]'
                }`}
              >
                Disematkan ({notes.filter((n) => n.isPinned && !n.isArchived).length})
              </button>
            </div>
          </div>

          {/* Sub-Filters: Priority & Available Tags */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-[#D9E3EF]/70 text-xs">
            {/* Priority Filter */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-semibold text-[#53657A] flex items-center gap-1">
                <Flag size={12} /> Prioritas:
              </span>
              <button
                onClick={() => setSelectedPriorityFilter('ALL')}
                className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold transition-all ${
                  selectedPriorityFilter === 'ALL'
                    ? 'bg-[#2457A7] text-white shadow-2xs'
                    : 'bg-[#F8FAFC] text-[#53657A] hover:bg-slate-100 border border-[#D9E3EF]'
                }`}
              >
                Semua
              </button>
              {(['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as Priority[]).map((p) => {
                const cfg = PRIORITY_BADGES[p];
                const active = selectedPriorityFilter === p;
                return (
                  <button
                    key={p}
                    onClick={() => setSelectedPriorityFilter(active ? 'ALL' : p)}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold transition-all ${
                      active
                        ? `${cfg.bg} ${cfg.text} ${cfg.border} ring-1 ring-black/5 shadow-2xs`
                        : 'bg-[#F8FAFC] text-[#53657A] hover:bg-slate-100 border border-[#D9E3EF]'
                    }`}
                  >
                    {cfg.label}
                  </button>
                );
              })}
            </div>

            {/* Tag Filter Chips */}
            {availableTags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-semibold text-[#53657A] flex items-center gap-1">
                  <TagIcon size={12} /> Tag:
                </span>
                <button
                  onClick={() => setSelectedTagFilter(null)}
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold transition-all ${
                    selectedTagFilter === null
                      ? 'bg-[#2457A7] text-white shadow-2xs'
                      : 'bg-[#F8FAFC] text-[#53657A] hover:bg-slate-100 border border-[#D9E3EF]'
                  }`}
                >
                  Semua Tag
                </button>
                {availableTags.map((tag) => {
                  const active = selectedTagFilter === tag;
                  return (
                    <button
                      key={tag}
                      onClick={() => setSelectedTagFilter(active ? null : tag)}
                      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-lg text-[10px] font-semibold transition-all ${
                        active
                          ? 'bg-[#EAF3FC] text-[#2457A7] border border-[#2457A7] shadow-2xs ring-1 ring-[#2457A7]/20'
                          : 'bg-[#F8FAFC] text-[#53657A] hover:text-[#2457A7] hover:bg-slate-100 border border-[#D9E3EF]'
                      }`}
                    >
                      <Hash size={10} />
                      <span>{tag}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Empty State */}
        {filteredNotes.length === 0 && (
          <div className="p-12 text-center bg-white border border-[#D9E3EF] rounded-2xl space-y-3">
            <div className="w-12 h-12 rounded-full bg-[#EAF3FC] text-[#2457A7] flex items-center justify-center mx-auto">
              <TagIcon size={20} />
            </div>
            <h3 className="text-sm font-bold text-[#172B42]">Tidak Ada Catatan yang Cocok</h3>
            <p className="text-xs text-[#53657A] max-w-sm mx-auto leading-relaxed">
              {searchQuery || selectedTagFilter || selectedPriorityFilter !== 'ALL'
                ? 'Tidak ditemukan catatan dengan kriteria pencarian, label tag, atau prioritas yang dipilih. Coba bersihkan filter.'
                : 'Mulai buat catatan ide, daftar periksa, atau rencana Anda menggunakan tombol "Buat Catatan" di atas.'}
            </p>
            {(searchQuery || selectedTagFilter || selectedPriorityFilter !== 'ALL') && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setSelectedTagFilter(null);
                  setSelectedPriorityFilter('ALL');
                }}
                className="px-3 py-1.5 text-xs font-semibold text-[#2457A7] bg-[#EAF3FC] rounded-xl hover:bg-[#d8e9fa] transition-colors"
              >
                Reset Semua Filter
              </button>
            )}
          </div>
        )}

        {/* Notes Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNotes.map((note) => {
            const colorClass = colorClasses[note.color] || colorClasses.default;
            const priorityCfg = PRIORITY_BADGES[note.priority || 'MEDIUM'];

            return (
              <div
                key={note.id}
                className={`border rounded-2xl p-4 shadow-2xs flex flex-col justify-between transition-all hover:shadow-xs group ${colorClass}`}
              >
                <div>
                  {/* Note Card Header with Priority & Pin */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="space-y-1">
                      {/* Priority Badge */}
                      {note.priority && (
                        <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full border ${priorityCfg.bg} ${priorityCfg.text} ${priorityCfg.border}`}>
                          <Flag size={9} /> {priorityCfg.label}
                        </span>
                      )}
                      <h3 className="text-sm font-bold text-[#172B42] leading-tight">
                        {note.title || '(Tanpa Judul)'}
                      </h3>
                    </div>

                    <button
                      onClick={() => togglePin(note)}
                      className={`p-1 rounded-lg transition-colors ${
                        note.isPinned
                          ? 'text-[#2457A7] bg-[#EAF3FC]'
                          : 'text-[#53657A] opacity-40 group-hover:opacity-100 hover:text-[#172B42]'
                      }`}
                      title={note.isPinned ? 'Lepas sematan' : 'Sematkan catatan'}
                    >
                      <Pin size={14} className={note.isPinned ? 'fill-current' : ''} />
                    </button>
                  </div>

                  {/* Note Body Text */}
                  {note.content && (
                    <p className="text-xs text-[#172B42] whitespace-pre-line leading-relaxed mb-3">
                      {note.content}
                    </p>
                  )}

                  {/* Checklist Items */}
                  {note.checklist && note.checklist.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {note.checklist.map((item) => (
                        <div
                          key={item.id}
                          onClick={() => toggleChecklistItem(note, item.id)}
                          className="flex items-start gap-2 cursor-pointer select-none text-xs"
                        >
                          {item.checked ? (
                            <CheckSquare size={14} className="text-[#16856B] shrink-0 mt-0.5" />
                          ) : (
                            <Square size={14} className="text-slate-400 shrink-0 mt-0.5" />
                          )}
                          <span className={item.checked ? 'line-through text-slate-400' : 'text-[#172B42]'}>
                            {item.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tags Chips on Note Card */}
                  {note.tags && note.tags.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap pt-1 mb-2">
                      {note.tags.map((tag) => {
                        const clean = tag.replace(/^#/, '');
                        const isSelected = selectedTagFilter === clean;
                        return (
                          <button
                            key={clean}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedTagFilter(isSelected ? null : clean);
                            }}
                            className={`inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-md font-medium transition-colors ${
                              isSelected
                                ? 'bg-[#2457A7] text-white'
                                : 'bg-black/5 hover:bg-[#EAF3FC] text-[#2457A7] hover:text-[#1E4889]'
                            }`}
                            title={`Filter catatan dengan tag #${clean}`}
                          >
                            <Hash size={10} />
                            <span>{clean}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Footer Actions */}
                <div className="pt-3 border-t border-black/5 flex items-center justify-between mt-2">
                  <div className="flex items-center gap-1.5">
                    {/* Edit Note Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditNote(note);
                      }}
                      className="flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-slate-50 text-[#2457A7] border border-[#D9E3EF] rounded-lg text-[11px] font-semibold transition-colors shadow-2xs"
                      title="Ubah rincian catatan"
                    >
                      <Edit2 size={12} />
                      <span>Ubah</span>
                    </button>

                    {/* Convert to EVEN Task */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onConvertNoteToTask(note);
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-[#2457A7] hover:bg-[#1E4889] text-white rounded-lg text-[11px] font-semibold transition-colors shadow-2xs"
                      title="Jadikan kegiatan di kalender EVEN"
                    >
                      <Calendar size={12} />
                      <span>Jadikan Kegiatan</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteNote(note.id);
                    }}
                    className="text-[#53657A] hover:text-[#C43D4B] p-1.5 rounded-md opacity-40 group-hover:opacity-100 transition-opacity"
                    title="Hapus catatan"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Modal Ubah Catatan Keep dengan Pengaturan Label & Prioritas */}
        {editingNote && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
            <div
              className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-[#D9E3EF] overflow-hidden animate-in fade-in zoom-in-95"
              role="dialog"
              aria-modal="true"
            >
              <div className="px-6 py-4 flex items-center justify-between border-b border-[#D9E3EF]">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold bg-amber-100 text-[#B86B12] px-2 py-0.5 rounded-full border border-amber-200">
                    Google Keep
                  </span>
                  <h3 className="text-base font-bold text-[#172B42]">
                    Ubah Catatan
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={closeEditModal}
                  className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleSaveEdit} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
                {editError && (
                  <div className="p-3 bg-red-50 border border-[#C43D4B]/30 rounded-xl text-xs text-[#C43D4B]">
                    {editError}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Judul Catatan
                  </label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Judul catatan..."
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:ring-2 focus:ring-[#2457A7] focus:outline-hidden"
                  />
                </div>

                {/* Priority Selection in Edit Modal */}
                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1.5 flex items-center gap-1">
                    <Flag size={12} className="text-[#2457A7]" /> Prioritas Catatan
                  </label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as Priority[]).map((p) => {
                      const cfg = PRIORITY_BADGES[p];
                      const active = editPriority === p;
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setEditPriority(p)}
                          className={`text-xs font-bold px-3 py-1 rounded-xl border transition-all ${
                            active
                              ? `${cfg.bg} ${cfg.text} ${cfg.border} ring-1 ring-black/5 shadow-2xs`
                              : 'bg-white text-[#53657A] border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          {cfg.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Tags Management in Edit Modal */}
                <div className="space-y-2 p-3 bg-[#F8FAFC] rounded-xl border border-[#D9E3EF]">
                  <label className="block text-xs font-semibold text-[#172B42] flex items-center gap-1">
                    <TagIcon size={12} className="text-[#2457A7]" /> Label & Tag Catatan
                  </label>

                  {/* Existing Tags Chips */}
                  <div className="flex items-center gap-1.5 flex-wrap min-h-6">
                    {editTags.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#EAF3FC] text-[#2457A7] text-[11px] font-medium border border-[#8DBCEB]/50"
                      >
                        <Hash size={10} />
                        <span>{t}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTagFromEdit(t)}
                          className="hover:text-red-600 transition-colors"
                          title="Hapus tag"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    {editTags.length === 0 && (
                      <span className="text-[11px] text-[#53657A] italic">Belum ada tag yang ditambahkan.</span>
                    )}
                  </div>

                  {/* Add Tag Input */}
                  <div className="flex items-center gap-2 pt-1">
                    <div className="relative flex-1">
                      <Hash size={12} className="absolute left-2.5 top-2 text-[#53657A]" />
                      <input
                        type="text"
                        value={editTagInput}
                        onChange={(e) => setEditTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddTagToEdit(editTagInput);
                          }
                        }}
                        placeholder="Tambah tag baru (tekan Enter)..."
                        className="w-full pl-7 pr-3 py-1.5 text-xs rounded-xl border border-[#D9E3EF] bg-white text-[#172B42] focus:outline-hidden focus:ring-1 focus:ring-[#2457A7]"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAddTagToEdit(editTagInput)}
                      className="px-3 py-1.5 text-xs font-semibold bg-[#2457A7] text-white hover:bg-[#1E4889] rounded-xl transition-colors shadow-2xs"
                    >
                      + Tambah
                    </button>
                  </div>

                  {/* Quick Preset Tags */}
                  <div className="flex items-center gap-1 flex-wrap pt-1">
                    <span className="text-[10px] text-[#53657A]">Preset:</span>
                    {PRESET_TAGS.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleAddTagToEdit(tag)}
                        className="text-[10px] px-2 py-0.5 bg-white hover:bg-[#EAF3FC] text-[#2457A7] border border-[#D9E3EF] rounded-md transition-colors"
                      >
                        +{tag}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Checklist Section */}
                {editChecklist.length > 0 && (
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold text-[#172B42]">
                      Daftar Periksa (Checklist)
                    </label>
                    <div className="space-y-2 max-h-48 overflow-y-auto p-2 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl">
                      {editChecklist.map((item) => (
                        <div key={item.id} className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleEditChecklistItem(item.id)}
                            className="text-[#53657A] hover:text-[#16856B] shrink-0"
                          >
                            {item.checked ? (
                              <CheckSquare size={16} className="text-[#16856B]" />
                            ) : (
                              <Square size={16} className="text-slate-400" />
                            )}
                          </button>
                          <input
                            type="text"
                            value={item.text}
                            onChange={(e) => handleUpdateEditChecklistItemText(item.id, e.target.value)}
                            className={`flex-1 px-2.5 py-1 text-xs rounded-lg border border-[#D9E3EF] bg-white text-[#172B42] ${
                              item.checked ? 'line-through text-slate-400' : ''
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveEditChecklistItem(item.id)}
                            className="text-[#53657A] hover:text-[#C43D4B] p-1"
                            title="Hapus baris"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* Add new item to checklist */}
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={newChecklistText}
                        onChange={(e) => setNewChecklistText(e.target.value)}
                        placeholder="Tambah item baru..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddEditChecklistItem();
                          }
                        }}
                        className="flex-1 px-3 py-1.5 text-xs rounded-xl border border-[#D9E3EF] text-[#172B42]"
                      />
                      <button
                        type="button"
                        onClick={handleAddEditChecklistItem}
                        className="px-3 py-1.5 text-xs font-semibold bg-[#EAF3FC] text-[#2457A7] hover:bg-[#d8e9fa] rounded-xl transition-colors"
                      >
                        + Tambah
                      </button>
                    </div>
                  </div>
                )}

                {/* Content / Body Text */}
                <div>
                  <label className="block text-xs font-semibold text-[#172B42] mb-1">
                    Isi Catatan Teks
                  </label>
                  <textarea
                    rows={4}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder="Tuliskan catatan detail atau ide Anda di sini..."
                    className="w-full p-3 text-xs rounded-xl border border-[#D9E3EF] text-[#172B42] focus:ring-2 focus:ring-[#2457A7] focus:outline-hidden resize-none"
                  />
                </div>

                {editChecklist.length === 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditChecklist([
                        { id: `c-${Date.now()}-0`, text: '', checked: false },
                      ]);
                    }}
                    className="text-xs text-[#2457A7] font-semibold hover:underline flex items-center gap-1.5"
                  >
                    <CheckSquare size={14} />
                    <span>Tambahkan Daftar Periksa (Checklist)</span>
                  </button>
                )}

                <div className="pt-3 border-t border-[#D9E3EF] flex items-center justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={closeEditModal}
                    className="px-4 py-2 text-xs font-semibold text-[#53657A] hover:text-[#172B42] transition-colors"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] rounded-xl shadow-2xs transition-colors"
                  >
                    Simpan Perubahan
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
