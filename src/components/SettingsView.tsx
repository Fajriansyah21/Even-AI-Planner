import React, { useState } from 'react';
import {
  Calendar,
  Clock,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Save,
  Check,
  User,
} from 'lucide-react';
import { UserPreferences } from '../types';

interface SettingsViewProps {
  preferences: UserPreferences;
  onUpdatePreferences: (updated: Partial<UserPreferences>) => void;
  onResetData: () => void;
  onSyncCalendar: () => void;
  isSyncing: boolean;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  preferences,
  onUpdatePreferences,
  onResetData,
  onSyncCalendar,
  isSyncing,
}) => {
  const [displayName, setDisplayName] = useState(preferences.displayName);
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [workStartHour, setWorkStartHour] = useState(preferences.workStartHour);
  const [workEndHour, setWorkEndHour] = useState(preferences.workEndHour);
  const [lunchStartHour, setLunchStartHour] = useState(preferences.lunchStartHour);
  const [lunchEndHour, setLunchEndHour] = useState(preferences.lunchEndHour);
  const [bufferMinutes, setBufferMinutes] = useState(preferences.bufferMinutes);
  const [workDays, setWorkDays] = useState<number[]>(preferences.workDays);
  const [allowAutoSplit, setAllowAutoSplit] = useState(preferences.allowAutoSplit);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const daysLabels = [
    { day: 1, label: 'Sen' },
    { day: 2, label: 'Sel' },
    { day: 3, label: 'Rab' },
    { day: 4, label: 'Kam' },
    { day: 5, label: 'Jum' },
    { day: 6, label: 'Sab' },
    { day: 0, label: 'Min' },
  ];

  const toggleDay = (dayNum: number) => {
    if (workDays.includes(dayNum)) {
      if (workDays.length > 1) {
        setWorkDays(workDays.filter((d) => d !== dayNum));
      }
    } else {
      setWorkDays([...workDays, dayNum].sort());
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdatePreferences({
      displayName,
      timezone,
      workStartHour: Number(workStartHour),
      workEndHour: Number(workEndHour),
      lunchStartHour: Number(lunchStartHour),
      lunchEndHour: Number(lunchEndHour),
      bufferMinutes: Number(bufferMinutes),
      workDays,
      allowAutoSplit,
    });

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
  };

  const toggleGoogleCalendar = () => {
    const nextState = !preferences.googleCalendarConnected;
    onUpdatePreferences({
      googleCalendarConnected: nextState,
      calendarSyncStatus: nextState ? 'synced' : 'pending',
      lastSyncedAt: nextState ? new Date().toISOString() : null,
    });
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-y-auto p-4 sm:p-6">
      <div className="max-w-3xl mx-auto w-full space-y-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold font-editorial text-[#172B42] tracking-tight">
            Pengaturan & Integrasi
          </h2>
          <p className="text-xs text-[#53657A] mt-0.5">
            Sesuaikan jam kerja, batasan ketersediaan, serta kelola otorisasi Google Calendar Anda.
          </p>
        </div>

        <form onSubmit={handleSave} className="space-y-6">
          {/* Profile Card */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-4">
            <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
              <User size={16} className="text-[#2457A7]" />
              Profil Pengguna
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Nama Tampilan
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:ring-2 focus:ring-[#2457A7]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Email Akun Google
                </label>
                <input
                  type="email"
                  value={preferences.email}
                  disabled
                  className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] bg-slate-50 text-sm text-[#53657A] cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Timezone & Working Hours */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-4">
            <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
              <Clock size={16} className="text-[#2457A7]" />
              Zona Waktu & Jam Ketersediaan
            </h3>

            <div>
              <label className="block text-xs font-semibold text-[#172B42] mb-1">
                Zona Waktu
              </label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#D9E3EF] text-sm text-[#172B42] focus:ring-2 focus:ring-[#2457A7]"
              >
                <option value="Asia/Jakarta (WIB)">WIB — Waktu Indonesia Barat (UTC+7)</option>
                <option value="Asia/Makassar (WITA)">WITA — Waktu Indonesia Tengah (UTC+8)</option>
                <option value="Asia/Jayapura (WIT)">WIT — Waktu Indonesia Timur (UTC+9)</option>
                <option value="UTC">UTC (Universal Coordinated Time)</option>
              </select>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Mulai Kerja
                </label>
                <select
                  value={workStartHour}
                  onChange={(e) => setWorkStartHour(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-sm"
                >
                  {[7, 8, 9, 10].map((h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Selesai Kerja
                </label>
                <select
                  value={workEndHour}
                  onChange={(e) => setWorkEndHour(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-sm"
                >
                  {[16, 17, 18, 19, 20, 21].map((h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Makan Siang
                </label>
                <select
                  value={lunchStartHour}
                  onChange={(e) => {
                    const start = Number(e.target.value);
                    setLunchStartHour(start);
                    setLunchEndHour(start + 1);
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-sm"
                >
                  <option value={11}>11:00 - 12:00</option>
                  <option value={12}>12:00 - 13:00</option>
                  <option value={13}>13:00 - 14:00</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Buffer Antar Sesi
                </label>
                <select
                  value={bufferMinutes}
                  onChange={(e) => setBufferMinutes(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-sm"
                >
                  <option value={0}>0 menit</option>
                  <option value={10}>10 menit</option>
                  <option value={15}>15 menit</option>
                  <option value={30}>30 menit</option>
                </select>
              </div>
            </div>

            {/* Workdays */}
            <div className="pt-2">
              <label className="block text-xs font-semibold text-[#172B42] mb-2">
                Hari Kerja Aktif
              </label>
              <div className="flex flex-wrap gap-2">
                {daysLabels.map(({ day, label }) => {
                  const isSelected = workDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(day)}
                      className={`w-10 h-10 rounded-xl text-xs font-semibold transition-all ${
                        isSelected
                          ? 'bg-[#2457A7] text-white shadow-2xs'
                          : 'bg-slate-100 text-[#53657A] hover:bg-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Google Calendar Integration Card */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
                  <Calendar size={16} className="text-[#2457A7]" />
                  Integrasi Google Calendar
                </h3>
                <p className="text-xs text-[#53657A] mt-0.5">
                  Izin membaca rapat untuk mendeteksi waktu luang dan menulis sesi tugas terjadwal.
                </p>
              </div>

              {preferences.googleCalendarConnected ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-[#16856B] border border-emerald-200">
                  <CheckCircle2 size={12} /> Terhubung
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-[#B86B12] border border-amber-200">
                  <AlertTriangle size={12} /> Terputus
                </span>
              )}
            </div>

            <div className="p-4 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl text-xs space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Akun Google Kalender:</span>
                <span className="font-semibold text-[#172B42]">{preferences.email}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Cakupan Scope OAuth:</span>
                <span className="font-mono text-[10px] bg-white border border-[#D9E3EF] px-2 py-0.5 rounded-sm text-[#2457A7]">
                  calendar.readonly, calendar.events
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Sinkronisasi Terakhir:</span>
                <span className="text-[#172B42]">
                  {preferences.lastSyncedAt
                    ? new Date(preferences.lastSyncedAt).toLocaleTimeString('id-ID', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })
                    : 'Belum pernah'}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              {preferences.googleCalendarConnected ? (
                <>
                  <button
                    type="button"
                    onClick={onSyncCalendar}
                    disabled={isSyncing}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#2457A7] bg-[#EAF3FC] hover:bg-[#d8ebfd] rounded-xl transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={isSyncing ? 'animate-spin' : ''} />
                    <span>{isSyncing ? 'Menyinkronkan...' : 'Sinkronkan Ulang Sekarang'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={toggleGoogleCalendar}
                    className="px-3.5 py-2 text-xs font-semibold text-[#C43D4B] hover:bg-red-50 rounded-xl transition-colors border border-red-200"
                  >
                    Putuskan Hubungan Kalender
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={toggleGoogleCalendar}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2457A7] hover:bg-[#1E4889] rounded-xl transition-colors shadow-xs"
                >
                  <Calendar size={13} />
                  <span>Hubungkan Google Calendar</span>
                </button>
              )}
            </div>
          </div>

          {/* Reset Demo Data Card */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-3">
            <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
              <RotateCcw size={16} className="text-[#53657A]" />
              Data Uji Coba & Prototipe
            </h3>
            <p className="text-xs text-[#53657A] leading-relaxed">
              Jika Anda ingin menguji kembali alur penjadwalan awal, Anda dapat mereset daftar tugas dan rapat ke dataset awal.
            </p>
            <button
              type="button"
              onClick={onResetData}
              className="px-3.5 py-2 text-xs font-medium text-[#53657A] hover:text-[#172B42] border border-[#D9E3EF] rounded-xl hover:bg-slate-50 transition-colors"
            >
              Kembalikan ke Data Awal
            </button>
          </div>

          {/* Submit Save */}
          <div className="flex items-center justify-between pt-2">
            {saveSuccess ? (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[#16856B]">
                <Check size={16} /> Pengaturan berhasil disimpan!
              </span>
            ) : (
              <div />
            )}

            <button
              type="submit"
              className="flex items-center gap-1.5 px-6 py-2.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs"
            >
              <Save size={14} />
              <span>Simpan Perubahan</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
