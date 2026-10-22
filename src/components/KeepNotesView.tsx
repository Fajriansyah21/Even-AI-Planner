import React, { useState } from 'react';
import {
  Pin,
  Plus,
  CheckSquare,
  Square,
  Sparkles,
  ArrowRight,
  Trash2,
  Tag,
  Download,
  Info,
  Calendar,
  Layers,
  Edit2,
  X,
  Check,
} from 'lucide-react';
import { KeepNote, KeepChecklistItem } from '../types';

interface KeepNotesViewProps {
  notes: KeepNote[];
  onCreateNote: (note: Omit<KeepNote, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onUpdateNote: (note: KeepNote) => void;
  onDeleteNote: (noteId: string) => void;
  onConvertNoteToTask: (note: KeepNote) => void;
}

export const KeepNotesView: React.FC<KeepNotesViewProps> = ({
  notes,
  onCreateNote,
  onUpdateNote,
  onDeleteNote,
  onConvertNoteToTask,
}) => {
  const [filter, setFilter] = useState<'ALL' | 'PINNED' | 'ARCHIVED'>('ALL');
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [isChecklist, setIsChecklist] = useState(false);
  const [checklistText, setChecklistText] = useState('');

  // Edit Modal State
  const [editingNote, setEditingNote] = useState<KeepNote | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editChecklist, setEditChecklist] = useState<KeepChecklistItem[]>([]);
  const [newChecklistText, setNewChecklistText] = useState('');
  const [editError, setEditError] = useState('');

  const colorClasses: Record<KeepNote['color'], string> = {
    default: 'bg-white border-[#D9E3EF]',
    sand: 'bg-amber-50/70 border-amber-200/80',
    coral: 'bg-rose-50/70 border-rose-200/80',
    sage: 'bg-emerald-50/70 border-emerald-200/80',
    fog: 'bg-sky-50/70 border-sky-200/80',
    storm: 'bg-slate-100/70 border-slate-300/80',
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
    });

    setNewTitle('');
    setNewContent('');
    setChecklistText('');
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

  const filteredNotes = notes.filter((n) => {
    if (filter === 'PINNED') return n.isPinned && !n.isArchived;
    if (filter === 'ARCHIVED') return n.isArchived;
    return !n.isArchived;
  });

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-y-auto p-4 sm:p-6">
      <div className="max-w-5xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl sm:text-2xl font-bold font-editorial text-[#172B42] tracking-tight">
                Catatan Google Keep & Ide Tugas
              </h2>
              <span className="text-[10px] bg-amber-100 text-[#B86B12] px-2 py-0.5 rounded-full font-semibold border border-amber-200">
                Google Keep
              </span>
            </div>
            <p className="text-xs text-[#53657A] mt-0.5">
              Tulis catatan cepat, daftar cek ide, dan konversikan langsung menjadi tugas terencana di kalender EVEN.
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
            <strong className="text-[#172B42]">Tentang Integrasi Google Keep:</strong> Google Keep API resmi dari Google Workspace merupakan API tingkat enterprise yang mensyaratkan <em>Domain-Wide Delegation</em> di Google Admin Console. Di EVEN, catatan Keep Anda disinkronkan langsung ke database cloud Firestore dengan dukungan konversi dua arah ke kalender dan ekspor JSON.
          </div>
        </div>

        {/* Quick Note Creator */}
        {isCreating && (
          <form
            onSubmit={handleCreateSubmit}
            className="bg-white border border-[#2457A7] rounded-2xl p-4 shadow-sm space-y-3 animate-in fade-in"
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
                placeholder="Tuliskan catatan atau ide..."
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

        {/* Filter Tabs */}
        <div className="flex items-center gap-1 p-1 bg-white border border-[#D9E3EF] rounded-xl w-fit text-xs font-medium">
          <button
            onClick={() => setFilter('ALL')}
            className={`px-3 py-1 rounded-lg transition-all ${
              filter === 'ALL' ? 'bg-[#2457A7] text-white font-semibold' : 'text-[#53657A] hover:text-[#172B42]'
            }`}
          >
            Semua Catatan ({notes.filter((n) => !n.isArchived).length})
          </button>
          <button
            onClick={() => setFilter('PINNED')}
            className={`px-3 py-1 rounded-lg transition-all ${
              filter === 'PINNED' ? 'bg-[#2457A7] text-white font-semibold' : 'text-[#53657A] hover:text-[#172B42]'
            }`}
          >
            Disematkan ({notes.filter((n) => n.isPinned && !n.isArchived).length})
          </button>
        </div>

        {/* Notes Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNotes.map((note) => {
            const colorClass = colorClasses[note.color] || colorClasses.default;

            return (
              <div
                key={note.id}
                className={`border rounded-2xl p-4 shadow-2xs flex flex-col justify-between transition-all hover:shadow-xs group ${colorClass}`}
              >
                <div>
                  {/* Note Card Header */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h3 className="text-sm font-bold text-[#172B42] leading-tight">
                      {note.title || '(Tanpa Judul)'}
                    </h3>
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
                      title="Jadikan tugas di kalender EVEN"
                    >
                      <Calendar size={12} />
                      <span>Jadikan Tugas</span>
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

        {/* Modal Ubah Catatan Keep */}
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
