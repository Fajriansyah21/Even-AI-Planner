import React, { useState } from 'react';
import {
  Calendar,
  Clock,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Save,
  Check,
  User,
  Database,
  StickyNote,
  AlertCircle,
  HelpCircle,
  ExternalLink,
} from 'lucide-react';
import { UserPreferences } from '../types';

export interface CalendarDiagnosticInfo {
  connectionStatus:
    | 'unconnected'
    | 'connecting'
    | 'connected_unsynced'
    | 'syncing'
    | 'sync_success'
    | 'sync_failed'
    | 'needs_reauth'
    | 'unconfirmed';
  accountEmail: string | null;
  targetCalendar: string;
  queryRangeStart: string;
  queryRangeEnd: string;
  queryTimezone: string;
  lastSyncedAt: string | null;
  eventsGoogleCount: number;
  eventsLocalCount: number;
  eventsCreatedCount: number;
  eventsFailedCount: number;
  eventsUnconfirmedCount: number;
  lastErrorMessage?: string;
}

interface SettingsViewProps {
  preferences: UserPreferences;
  onUpdatePreferences: (updated: Partial<UserPreferences>) => void;
  onResetData: () => void;
  onSyncCalendar: () => void;
  isSyncing: boolean;
  hasGoogleAccessToken: boolean;
  onConnectCalendar: () => void;
  onDisconnectCalendar: () => void;
  diagnosticInfo?: CalendarDiagnosticInfo;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  preferences,
  onUpdatePreferences,
  onResetData,
  onSyncCalendar,
  isSyncing,
  hasGoogleAccessToken,
  onConnectCalendar,
  onDisconnectCalendar,
  diagnosticInfo,
}) => {
  const [displayName, setDisplayName] = useState(preferences.displayName);
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [workStartHour, setWorkStartHour] = useState(preferences.workStartHour ?? 9);
  const [workEndHour, setWorkEndHour] = useState(preferences.workEndHour ?? 18);
  const [enableLunchBreak, setEnableLunchBreak] = useState(preferences.enableLunchBreak !== false);
  const [lunchStartHour, setLunchStartHour] = useState(preferences.lunchStartHour ?? 12);
  const [lunchEndHour, setLunchEndHour] = useState(preferences.lunchEndHour ?? 13);
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
      enableLunchBreak,
      lunchStartHour: Number(lunchStartHour),
      lunchEndHour: Number(lunchEndHour),
      bufferMinutes: Number(bufferMinutes),
      workDays,
      allowAutoSplit,
    });

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
  };

  // Status mapping
  const statusConfig = {
    unconnected: {
      label: 'Belum Terhubung',
      color: 'bg-slate-100 text-[#53657A] border-slate-200',
      icon: AlertCircle,
    },
    connecting: {
      label: 'Sedang Menghubungkan...',
      color: 'bg-blue-50 text-[#2457A7] border-blue-200 animate-pulse',
      icon: RefreshCw,
    },
    connected_unsynced: {
      label: 'Terhubung (Belum Sinkron)',
      color: 'bg-amber-50 text-[#B86B12] border-amber-200',
      icon: AlertTriangle,
    },
    syncing: {
      label: 'Sedang Menyinkronkan...',
      color: 'bg-blue-50 text-[#2457A7] border-blue-200 animate-pulse',
      icon: RefreshCw,
    },
    sync_success: {
      label: 'Sinkronisasi Berhasil',
      color: 'bg-emerald-50 text-[#16856B] border-emerald-200',
      icon: CheckCircle2,
    },
    sync_failed: {
      label: 'Sinkronisasi Gagal',
      color: 'bg-red-50 text-[#C43D4B] border-red-200',
      icon: AlertCircle,
    },
    needs_reauth: {
      label: 'Perlu Autentikasi Ulang',
      color: 'bg-orange-50 text-[#B86B12] border-orange-200',
      icon: AlertTriangle,
    },
    unconfirmed: {
      label: 'Hasil Belum Terkonfirmasi',
      color: 'bg-amber-50 text-[#B86B12] border-amber-200',
      icon: HelpCircle,
    },
  };

  const currentStatus = diagnosticInfo?.connectionStatus || (hasGoogleAccessToken ? 'connected_unsynced' : 'unconnected');
  const badgeConfig = statusConfig[currentStatus] || statusConfig.unconnected;
  const BadgeIcon = badgeConfig.icon;

  return (
    <div className="flex-1 flex flex-col h-full bg-[#F8FAFC] overflow-y-auto p-4 sm:p-6">
      <div className="max-w-3xl mx-auto w-full space-y-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold font-editorial text-[#172B42] tracking-tight">
            Pengaturan & Integrasi
          </h2>
          <p className="text-xs text-[#53657A] mt-0.5">
            Konfigurasi Firebase Firestore, integrasi Google Calendar, dan preferensi jam kerja Anda.
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
                  Email Akun Terautentikasi
                </label>
                <input
                  type="email"
                  value={preferences.email || 'Belum masuk'}
                  disabled
                  className="w-full px-3.5 py-2 rounded-xl border border-[#D9E3EF] bg-slate-50 text-sm text-[#53657A] cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Firebase Database Status Card */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
                <Database size={16} className="text-[#2457A7]" />
                Basis Data Cloud Firebase Firestore
              </h3>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-[#16856B] border border-emerald-200">
                <CheckCircle2 size={12} /> Terhubung (Enterprise)
              </span>
            </div>

            <div className="p-3.5 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Project ID:</span>
                <span className="font-mono text-[#172B42] font-semibold">gen-lang-client-0031046555</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Database ID:</span>
                <span className="font-mono text-[11px] text-[#2457A7]">ai-studio-evenaiplanner-3511f8bb-57a9-4227-931f-4ee3332059af</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Wilayah Cloud (Region):</span>
                <span className="text-[#172B42]">asia-southeast1 (Singapura)</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Aturan Keamanan (firestore.rules):</span>
                <span className="text-[#16856B] font-semibold">Aktif & Terdokumentasi (ABAC)</span>
              </div>
            </div>
          </div>

          {/* Google Calendar Integration & Diagnostics Card */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-4">
            <div className="flex items-start justify-between flex-wrap gap-2">
              <div>
                <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
                  <Calendar size={16} className="text-[#2457A7]" />
                  Integrasi Google Calendar & Panel Diagnostik
                </h3>
                <p className="text-xs text-[#53657A] mt-0.5">
                  Izin membaca agenda untuk mendeteksi waktu luang dan menulis sesi tugas terencana.
                </p>
              </div>

              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${badgeConfig.color}`}>
                <BadgeIcon size={13} className={isSyncing ? 'animate-spin' : ''} />
                <span>{badgeConfig.label}</span>
              </span>
            </div>

            {/* Diagnostic Information Panel */}
            <div className="p-4 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl text-xs space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Akun Google Kalender:</span>
                <span className="font-semibold text-[#172B42]">
                  {diagnosticInfo?.accountEmail || (hasGoogleAccessToken ? preferences.email : 'Belum terhubung')}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Kalender Target:</span>
                <span className="font-mono text-xs text-[#2457A7] font-semibold">
                  {diagnosticInfo?.targetCalendar || 'primary'} (Kalender Utama)
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Rentang Tanggal Pencarian:</span>
                <span className="text-[#172B42] font-medium">
                  {diagnosticInfo?.queryRangeStart
                    ? `${new Date(diagnosticInfo.queryRangeStart).toLocaleDateString('id-ID')} s/d ${new Date(diagnosticInfo.queryRangeEnd).toLocaleDateString('id-ID')} (${diagnosticInfo.queryTimezone || 'Asia/Jakarta'})`
                    : `-7 hari s/d +30 hari (${timezone})`}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[#53657A]">Waktu Sinkronisasi Terakhir:</span>
                <span className="text-[#172B42]">
                  {diagnosticInfo?.lastSyncedAt
                    ? new Date(diagnosticInfo.lastSyncedAt).toLocaleTimeString('id-ID', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      }) + ' WIB'
                    : preferences.lastSyncedAt
                    ? new Date(preferences.lastSyncedAt).toLocaleTimeString('id-ID', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      }) + ' WIB'
                    : 'Belum pernah sinkron'}
                </span>
              </div>

              <div className="pt-2 border-t border-[#D9E3EF]/70 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div className="p-2 bg-white rounded-lg border border-[#D9E3EF]">
                  <p className="text-[10px] text-[#53657A]">Agenda Google</p>
                  <p className="text-sm font-bold text-[#172B42]">{diagnosticInfo?.eventsGoogleCount ?? 0}</p>
                </div>
                <div className="p-2 bg-white rounded-lg border border-[#D9E3EF]">
                  <p className="text-[10px] text-[#53657A]">Tugas Terjadwal</p>
                  <p className="text-sm font-bold text-[#2457A7]">{diagnosticInfo?.eventsLocalCount ?? 0}</p>
                </div>
                <div className="p-2 bg-white rounded-lg border border-[#D9E3EF]">
                  <p className="text-[10px] text-[#53657A]">Berhasil Dibuat</p>
                  <p className="text-sm font-bold text-[#16856B]">{diagnosticInfo?.eventsCreatedCount ?? 0}</p>
                </div>
                <div className="p-2 bg-white rounded-lg border border-[#D9E3EF]">
                  <p className="text-[10px] text-[#53657A]">Belum Terkonfirmasi</p>
                  <p className="text-sm font-bold text-[#B86B12]">{diagnosticInfo?.eventsUnconfirmedCount ?? 0}</p>
                </div>
              </div>

              {diagnosticInfo?.lastErrorMessage && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-[#C43D4B] flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{diagnosticInfo.lastErrorMessage}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={onSyncCalendar}
                disabled={isSyncing || !hasGoogleAccessToken}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#2457A7] bg-[#EAF3FC] hover:bg-[#d8ebfd] rounded-xl transition-colors disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw size={13} className={isSyncing ? 'animate-spin' : ''} />
                <span>{isSyncing ? 'Menyinkronkan...' : 'Sinkronkan Sekarang'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (hasGoogleAccessToken) {
                    onDisconnectCalendar();
                  } else {
                    onConnectCalendar();
                  }
                }}
                className={`px-3.5 py-2 text-xs font-semibold rounded-xl transition-colors cursor-pointer ${
                  hasGoogleAccessToken
                    ? 'text-[#C43D4B] hover:bg-red-50 border border-red-200'
                    : 'text-white bg-[#2457A7] hover:bg-[#1E4889]'
                }`}
              >
                {hasGoogleAccessToken ? 'Putuskan Hubungan Kalender' : 'Hubungkan Kalender'}
              </button>
            </div>
          </div>

          {/* Google Keep Integration Card */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-3">
            <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
              <StickyNote size={16} className="text-[#B86B12]" />
              Integrasi Google Keep
            </h3>
            <p className="text-xs text-[#53657A] leading-relaxed">
              Catatan ide dan daftar periksa Keep Anda tersinkronisasi dua arah dengan kegiatan kalender di EVEN. Anda dapat mengekspor atau mengubah catatan menjadi sesi terjadwal kapan saja di tab <strong>Google Keep</strong>.
            </p>
          </div>

          {/* Timezone & Working Hours */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-4">
            <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
              <Clock size={16} className="text-[#2457A7]" />
              Zona Waktu & Jam Ketersediaan (01:00 - 24:00)
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

            {/* Work Start & End (01:00 to 24:00) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block text-xs font-semibold text-[#172B42] mb-1">
                  Mulai Kerja
                </label>
                <select
                  value={workStartHour}
                  onChange={(e) => setWorkStartHour(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white"
                >
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00 {h === 24 ? '(Tengah Malam)' : ''}
                    </option>
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
                  className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white"
                >
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00 {h === 24 ? '(Tengah Malam Akhir Hari)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Night shift indicator */}
            {workEndHour < workStartHour && (
              <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-900 flex items-center gap-2">
                <Clock size={15} className="text-indigo-600 shrink-0" />
                <span>
                  <strong>Shift Malam Aktif:</strong> Jam kerja Anda melintasi tengah malam dari pukul {String(workStartHour).padStart(2, '0')}:00 hingga {String(workEndHour).padStart(2, '0')}:00 keesokan harinya. Perencana jadwal tidak akan memaksakan kegiatan ke jam siang.
                </span>
              </div>
            )}

            {/* Lunch break configuration */}
            <div className="p-3.5 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-xs font-semibold text-[#172B42] block">
                    Waktu Istirahat Makan Siang
                  </span>
                  <span className="text-[11px] text-[#53657A]">
                    Bila dinonaktifkan, scheduler tidak akan membuat jeda istirahat otomatis.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={enableLunchBreak}
                  onChange={(e) => setEnableLunchBreak(e.target.checked)}
                  className="w-4 h-4 text-[#2457A7] rounded-sm focus:ring-[#2457A7]"
                />
              </label>

              {enableLunchBreak ? (
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#D9E3EF]/70">
                  <div>
                    <label className="block text-[11px] font-semibold text-[#172B42] mb-1">
                      Mulai Istirahat
                    </label>
                    <select
                      value={lunchStartHour}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setLunchStartHour(val);
                        if (lunchEndHour <= val) setLunchEndHour(val + 1);
                      }}
                      className="w-full px-3 py-1.5 rounded-xl border border-[#D9E3EF] text-xs bg-white"
                    >
                      {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                        <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#172B42] mb-1">
                      Selesai Istirahat
                    </label>
                    <select
                      value={lunchEndHour}
                      onChange={(e) => setLunchEndHour(Number(e.target.value))}
                      className="w-full px-3 py-1.5 rounded-xl border border-[#D9E3EF] text-xs bg-white"
                    >
                      {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                        <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-[#53657A] italic">
                  Tidak ada istirahat — Jam kerja penuh tanpa blok jeda otomatis.
                </div>
              )}
            </div>

            {/* Buffer between sessions */}
            <div>
              <label className="block text-xs font-semibold text-[#172B42] mb-1">
                Jeda Waktu (Buffer) Antar Kegiatan
              </label>
              <select
                value={bufferMinutes}
                onChange={(e) => setBufferMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-[#D9E3EF] text-sm bg-white"
              >
                <option value={0}>0 menit</option>
                <option value={10}>10 menit</option>
                <option value={15}>15 menit (Disarankan)</option>
                <option value={30}>30 menit</option>
              </select>
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

          {/* Reset Demo Data Card */}
          <div className="bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs space-y-3">
            <h3 className="text-sm font-bold text-[#172B42] flex items-center gap-2">
              <RotateCcw size={16} className="text-[#53657A]" />
              Data Uji Coba & Prototipe
            </h3>
            <p className="text-xs text-[#53657A] leading-relaxed">
              Jika Anda ingin menguji kembali alur penjadwalan awal, Anda dapat mereset daftar tugas, catatan Keep, dan rapat ke dataset awal.
            </p>
            <button
              type="button"
              onClick={onResetData}
              className="px-3.5 py-2 text-xs font-medium text-[#53657A] hover:text-[#172B42] border border-[#D9E3EF] rounded-xl hover:bg-slate-50 transition-colors cursor-pointer"
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
              className="flex items-center gap-1.5 px-6 py-2.5 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs cursor-pointer"
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
