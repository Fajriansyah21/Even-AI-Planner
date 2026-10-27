import React, { useState, useRef, useEffect } from 'react';
import { Filter, Check, RotateCcw, X, SlidersHorizontal, CheckSquare, Square } from 'lucide-react';
import { Priority, Task, CalendarEvent } from '../types';

export type TaskCategory = 'work' | 'personal' | 'study' | 'focus';

export interface CategoryOption {
  id: TaskCategory;
  label: string;
  dotClass: string;
  badgeClass: string;
  description: string;
}

export interface PriorityOption {
  id: Priority;
  label: string;
  dotClass: string;
  badgeClass: string;
  description: string;
}

export const CATEGORY_OPTIONS: CategoryOption[] = [
  {
    id: 'work',
    label: 'Pekerjaan',
    dotClass: 'bg-blue-500',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
    description: 'Tugas profesional, meeting, dan pekerjaan kantor',
  },
  {
    id: 'personal',
    label: 'Pribadi',
    dotClass: 'bg-purple-500',
    badgeClass: 'bg-purple-50 text-purple-700 border-purple-200',
    description: 'Kegiatan pribadi, keluarga, dan komitmen mandiri',
  },
  {
    id: 'study',
    label: 'Belajar',
    dotClass: 'bg-amber-500',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
    description: 'Kursus, membaca, pelatihan, dan materi pembelajaran',
  },
  {
    id: 'focus',
    label: 'Fokus',
    dotClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    description: 'Sesi deep work tanpa gangguan',
  },
];

export const PRIORITY_OPTIONS: PriorityOption[] = [
  {
    id: 'URGENT',
    label: 'Mendesak',
    dotClass: 'bg-red-500',
    badgeClass: 'bg-red-50 text-red-700 border-red-200 font-semibold',
    description: 'Harus segera diselesaikan hari ini',
  },
  {
    id: 'HIGH',
    label: 'Tinggi',
    dotClass: 'bg-amber-500',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
    description: 'Prioritas utama dengan dampak signifikan',
  },
  {
    id: 'MEDIUM',
    label: 'Sedang',
    dotClass: 'bg-blue-500',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
    description: 'Aktivitas rutin dan komitmen terencana',
  },
  {
    id: 'LOW',
    label: 'Rendah',
    dotClass: 'bg-slate-400',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-200',
    description: 'Kegiatan fleksibel dan opsional',
  },
];

export const ALL_CATEGORIES: TaskCategory[] = ['work', 'personal', 'study', 'focus'];
export const ALL_PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/**
 * Menentukan kategori item secara konsisten:
 * Memprioritaskan task.category jika tersedia, lalu event.category, atau default 'personal'.
 */
export function resolveItemCategory(item: { task?: Task; event?: CalendarEvent }): TaskCategory {
  if (item.task?.category) return item.task.category;
  if (item.event?.category) {
    if (item.event.category === 'focus') return 'focus';
    if (item.event.category === 'personal') return 'personal';
    if (item.event.category === 'meeting' || item.event.category === 'deadline') return 'work';
  }
  return 'personal';
}

/**
 * Menentukan prioritas item secara konsisten:
 * Memprioritaskan task.priority jika tersedia, atau default 'MEDIUM' untuk acara Google Calendar.
 */
export function resolveItemPriority(item: { task?: Task; event?: CalendarEvent }): Priority {
  if (item.task?.priority) return item.task.priority;
  return 'MEDIUM';
}

interface CalendarFilterPopoverProps {
  selectedCategories: TaskCategory[];
  selectedPriorities: Priority[];
  onToggleCategory: (cat: TaskCategory) => void;
  onTogglePriority: (prio: Priority) => void;
  onSelectAllCategories: () => void;
  onSelectAllPriorities: () => void;
  onResetFilters: () => void;
  totalItemsCount?: number;
  filteredItemsCount?: number;
}

export const CalendarFilterPopover: React.FC<CalendarFilterPopoverProps> = ({
  selectedCategories,
  selectedPriorities,
  onToggleCategory,
  onTogglePriority,
  onSelectAllCategories,
  onSelectAllPriorities,
  onResetFilters,
  totalItemsCount,
  filteredItemsCount,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const hasActiveFilters =
    selectedCategories.length < ALL_CATEGORIES.length ||
    selectedPriorities.length < ALL_PRIORITIES.length;

  const activeFilterCount =
    (ALL_CATEGORIES.length - selectedCategories.length) +
    (ALL_PRIORITIES.length - selectedPriorities.length);

  return (
    <div className="relative inline-block" ref={popoverRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
          hasActiveFilters
            ? 'bg-[#EAF3FC] border-[#2457A7] text-[#2457A7] shadow-2xs ring-1 ring-[#2457A7]/20'
            : 'bg-white border-[#D9E3EF] text-[#53657A] hover:text-[#172B42] hover:bg-slate-50'
        }`}
        title="Filter sesi kegiatan berdasarkan kategori atau prioritas"
        aria-expanded={isOpen}
      >
        <Filter size={14} className={hasActiveFilters ? 'text-[#2457A7]' : 'text-[#53657A]'} />
        <span>Filter</span>
        {hasActiveFilters && (
          <span className="ml-0.5 inline-flex items-center justify-center bg-[#2457A7] text-white text-[10px] w-4 h-4 rounded-full font-bold">
            {activeFilterCount}
          </span>
        )}
      </button>

      {/* Popover Card */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white border border-[#D9E3EF] rounded-2xl shadow-xl z-50 overflow-hidden animate-fadeIn select-text">
          {/* Popover Header */}
          <div className="p-3.5 bg-[#F8FAFC] border-b border-[#D9E3EF] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-[#EAF3FC] rounded-lg text-[#2457A7]">
                <SlidersHorizontal size={15} />
              </div>
              <div>
                <h4 className="text-xs font-bold text-[#172B42]">Filter Tampilan Kegiatan</h4>
                <p className="text-[10px] text-[#53657A]">Saring sesi kalender secara real-time</p>
              </div>
            </div>
            {hasActiveFilters && (
              <button
                onClick={onResetFilters}
                className="flex items-center gap-1 text-[11px] font-semibold text-[#2457A7] hover:text-[#1E4889] hover:underline"
                title="Reset semua filter ke kondisi semula"
              >
                <RotateCcw size={12} />
                <span>Reset</span>
              </button>
            )}
          </div>

          <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
            {/* Kategori Section */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-[#172B42] uppercase tracking-wider">
                  Kategori
                </span>
                <button
                  onClick={onSelectAllCategories}
                  className="text-[10px] font-semibold text-[#2457A7] hover:underline"
                >
                  {selectedCategories.length === ALL_CATEGORIES.length ? 'Pilih Semua' : 'Tampilkan Semua'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {CATEGORY_OPTIONS.map((cat) => {
                  const isChecked = selectedCategories.includes(cat.id);
                  return (
                    <button
                      key={cat.id}
                      onClick={() => onToggleCategory(cat.id)}
                      className={`flex items-center justify-between p-2 rounded-xl border text-left transition-all ${
                        isChecked
                          ? 'bg-white border-[#2457A7] text-[#172B42] shadow-2xs ring-1 ring-[#2457A7]/10'
                          : 'bg-slate-50/70 border-slate-200 text-slate-400 opacity-60 hover:opacity-80'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${cat.dotClass}`} />
                        <span className="text-xs font-semibold truncate">{cat.label}</span>
                      </div>
                      {isChecked ? (
                        <CheckSquare size={14} className="text-[#2457A7] shrink-0" />
                      ) : (
                        <Square size={14} className="text-slate-300 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Separator */}
            <div className="border-t border-[#D9E3EF]" />

            {/* Prioritas Section */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-[#172B42] uppercase tracking-wider">
                  Prioritas
                </span>
                <button
                  onClick={onSelectAllPriorities}
                  className="text-[10px] font-semibold text-[#2457A7] hover:underline"
                >
                  {selectedPriorities.length === ALL_PRIORITIES.length ? 'Pilih Semua' : 'Tampilkan Semua'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {PRIORITY_OPTIONS.map((prio) => {
                  const isChecked = selectedPriorities.includes(prio.id);
                  return (
                    <button
                      key={prio.id}
                      onClick={() => onTogglePriority(prio.id)}
                      className={`flex items-center justify-between p-2 rounded-xl border text-left transition-all ${
                        isChecked
                          ? 'bg-white border-[#2457A7] text-[#172B42] shadow-2xs ring-1 ring-[#2457A7]/10'
                          : 'bg-slate-50/70 border-slate-200 text-slate-400 opacity-60 hover:opacity-80'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${prio.dotClass}`} />
                        <span className="text-xs font-semibold truncate">{prio.label}</span>
                      </div>
                      {isChecked ? (
                        <CheckSquare size={14} className="text-[#2457A7] shrink-0" />
                      ) : (
                        <Square size={14} className="text-slate-300 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Popover Footer */}
          <div className="p-3 bg-[#F8FAFC] border-t border-[#D9E3EF] flex items-center justify-between text-xs">
            <span className="text-[11px] text-[#53657A]">
              {typeof filteredItemsCount === 'number' && typeof totalItemsCount === 'number'
                ? `Menampilkan ${filteredItemsCount} dari ${totalItemsCount} kegiatan`
                : 'Penyaringan instan'}
            </span>
            <button
              onClick={() => setIsOpen(false)}
              className="px-3 py-1 bg-[#2457A7] text-white rounded-lg font-semibold hover:bg-[#1E4889] transition-colors"
            >
              Tutup
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

interface CalendarActiveFilterBarProps {
  selectedCategories: TaskCategory[];
  selectedPriorities: Priority[];
  onToggleCategory: (cat: TaskCategory) => void;
  onTogglePriority: (prio: Priority) => void;
  onResetFilters: () => void;
}

export const CalendarActiveFilterBar: React.FC<CalendarActiveFilterBarProps> = ({
  selectedCategories,
  selectedPriorities,
  onToggleCategory,
  onTogglePriority,
  onResetFilters,
}) => {
  const isCategoryFiltered = selectedCategories.length < ALL_CATEGORIES.length;
  const isPriorityFiltered = selectedPriorities.length < ALL_PRIORITIES.length;

  if (!isCategoryFiltered && !isPriorityFiltered) {
    return null;
  }

  return (
    <div className="px-6 py-2 bg-[#EAF3FC]/70 border-b border-[#8DBCEB]/50 flex items-center justify-between gap-3 text-xs flex-wrap">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-[#172B42] flex items-center gap-1.5 shrink-0">
          <Filter size={13} className="text-[#2457A7]" />
          <span>Filter Aktif:</span>
        </span>

        {/* Kategori chips */}
        {isCategoryFiltered && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-[#53657A]">Kategori:</span>
            {selectedCategories.length === 0 ? (
              <span className="text-[11px] italic text-red-600 font-medium">
                (Tidak ada kategori dipilih)
              </span>
            ) : (
              selectedCategories.map((catId) => {
                const opt = CATEGORY_OPTIONS.find((c) => c.id === catId);
                return (
                  <span
                    key={catId}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-white border border-[#D9E3EF] text-[#172B42] shadow-2xs"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${opt?.dotClass}`} />
                    <span>{opt?.label}</span>
                    <button
                      onClick={() => onToggleCategory(catId)}
                      className="hover:text-red-500 ml-0.5 text-slate-400"
                      title={`Sembunyikan kategori ${opt?.label}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                );
              })
            )}
          </div>
        )}

        {/* Prioritas chips */}
        {isPriorityFiltered && (
          <div className="flex items-center gap-1.5 flex-wrap ml-1">
            <span className="text-[11px] text-[#53657A]">Prioritas:</span>
            {selectedPriorities.length === 0 ? (
              <span className="text-[11px] italic text-red-600 font-medium">
                (Tidak ada prioritas dipilih)
              </span>
            ) : (
              selectedPriorities.map((prioId) => {
                const opt = PRIORITY_OPTIONS.find((p) => p.id === prioId);
                return (
                  <span
                    key={prioId}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-white border border-[#D9E3EF] text-[#172B42] shadow-2xs"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${opt?.dotClass}`} />
                    <span>{opt?.label}</span>
                    <button
                      onClick={() => onTogglePriority(prioId)}
                      className="hover:text-red-500 ml-0.5 text-slate-400"
                      title={`Sembunyikan prioritas ${opt?.label}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                );
              })
            )}
          </div>
        )}
      </div>

      <button
        onClick={onResetFilters}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2457A7] hover:text-[#1E4889] hover:underline shrink-0"
      >
        <RotateCcw size={11} />
        <span>Reset Semua Filter</span>
      </button>
    </div>
  );
};
