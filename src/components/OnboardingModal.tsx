import React, { useState } from 'react';
import { Clock, Calendar, Check, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { UserPreferences } from '../types';

interface OnboardingModalProps {
  isOpen: boolean;
  preferences: UserPreferences;
  onComplete: (updated: Partial<UserPreferences>) => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  preferences,
  onComplete,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [workStartHour, setWorkStartHour] = useState(preferences.workStartHour);
  const [workEndHour, setWorkEndHour] = useState(preferences.workEndHour);
  const [lunchStartHour, setLunchStartHour] = useState(preferences.lunchStartHour);
  const [lunchEndHour, setLunchEndHour] = useState(preferences.lunchEndHour);
  const [connectCalendar, setConnectCalendar] = useState(true);

  if (!isOpen) return null;

  const handleFinish = () => {
    onComplete({
      timezone,
      workStartHour,
      workEndHour,
      lunchStartHour,
      lunchEndHour,
      googleCalendarConnected: connectCalendar,
      calendarSyncStatus: connectCalendar ? 'synced' : 'pending',
      lastSyncedAt: connectCalendar ? new Date().toISOString() : null,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
      <div 
        className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-[#D9E3EF] overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* Progress indicator */}
        <div className="px-6 pt-6 pb-4 border-b border-[#D9E3EF] bg-[#F8FAFC]">
          <div className="flex items-center justify-between text-xs text-[#53657A] mb-2 font-medium">
            <span>Inisiasi Pengaturan EVEN</span>
            <span>Langkah {step} dari 3</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className={`h-1.5 rounded-full transition-all ${step >= 1 ? 'bg-[#2457A7]' : 'bg-[#D9E3EF]'}`} />
            <div className={`h-1.5 rounded-full transition-all ${step >= 2 ? 'bg-[#2457A7]' : 'bg-[#D9E3EF]'}`} />
            <div className={`h-1.5 rounded-full transition-all ${step >= 3 ? 'bg-[#2457A7]' : 'bg-[#D9E3EF]'}`} />
          </div>
        </div>

        {/* Step Content */}
        <div className="p-6">
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#EAF3FC] text-[#2457A7] flex items-center justify-center font-bold">
                  <Clock size={20} />
                </div>
                <div>
                  <h3 className="font-bold text-[#172B42] text-lg">Zona Waktu Anda</h3>
                  <p className="text-xs text-[#53657A]">
                    EVEN menjamin setiap durasi dan tenggat tugas valid sesuai waktu setempat.
                  </p>
                </div>
              </div>

              <div className="pt-2 space-y-2">
                <label className="text-xs font-semibold text-[#172B42] block">
                  Pilih Zona Waktu Wilayah
                </label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full p-3 rounded-xl border border-[#D9E3EF] bg-white text-sm text-[#172B42] focus:outline-hidden focus:ring-2 focus:ring-[#2457A7]"
                >
                  <option value="Asia/Jakarta (WIB)">WIB — Waktu Indonesia Barat (UTC+7, Jakarta)</option>
                  <option value="Asia/Makassar (WITA)">WITA — Waktu Indonesia Tengah (UTC+8, Makassar/Bali)</option>
                  <option value="Asia/Jayapura (WIT)">WIT — Waktu Indonesia Timur (UTC+9, Jayapura)</option>
                  <option value="UTC">UTC (Waktu Universal Terkoordinasi)</option>
                </select>
                <p className="text-xs text-[#53657A] italic">
                  Format tanggal dan kalkulasi slot waktu akan otomatis diselaraskan dengan zona ini.
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#EAF3FC] text-[#2457A7] flex items-center justify-center font-bold">
                  <Clock size={20} />
                </div>
                <div>
                  <h3 className="font-bold text-[#172B42] text-lg">Jam Kerja & Istirahat</h3>
                  <p className="text-xs text-[#53657A]">
                    Tugas hanya akan dijadwalkan di dalam rentang waktu yang Anda izinkan.
                  </p>
                </div>
              </div>

              <div className="pt-2 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="font-semibold text-[#172B42] block mb-1">Mulai Jam Kerja</label>
                  <select
                    value={workStartHour}
                    onChange={(e) => setWorkStartHour(Number(e.target.value))}
                    className="w-full p-2.5 rounded-xl border border-[#D9E3EF] bg-white text-sm"
                  >
                    {[7, 8, 9, 10].map(h => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="font-semibold text-[#172B42] block mb-1">Selesai Jam Kerja</label>
                  <select
                    value={workEndHour}
                    onChange={(e) => setWorkEndHour(Number(e.target.value))}
                    className="w-full p-2.5 rounded-xl border border-[#D9E3EF] bg-white text-sm"
                  >
                    {[16, 17, 18, 19, 20].map(h => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="p-3 bg-[#F8FAFC] border border-[#D9E3EF] rounded-xl text-xs space-y-2">
                <span className="font-medium text-[#172B42] block">Jeda Istirahat Terlindungi:</span>
                <div className="flex items-center justify-between text-[#53657A]">
                  <span>Makan siang & istirahat:</span>
                  <span className="font-semibold text-[#172B42]">12:00 - 13:00</span>
                </div>
                <div className="flex items-center justify-between text-[#53657A]">
                  <span>Jeda buffer antar tugas:</span>
                  <span className="font-semibold text-[#172B42]">15 menit</span>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#EAF3FC] text-[#2457A7] flex items-center justify-center font-bold">
                  <Calendar size={20} />
                </div>
                <div>
                  <h3 className="font-bold text-[#172B42] text-lg">Hubungkan Google Calendar</h3>
                  <p className="text-xs text-[#53657A]">
                    EVEN membaca rapat Anda agar tugas ditempatkan di waktu kosong tanpa tumpang tindih.
                  </p>
                </div>
              </div>

              <div className="p-4 border border-[#D9E3EF] rounded-xl bg-[#F8FAFC] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={18} className="text-[#16856B]" />
                    <span className="text-xs font-semibold text-[#172B42]">
                      Izin Aman & Terkontrol
                    </span>
                  </div>
                  <span className="text-[10px] bg-[#EAF3FC] text-[#2457A7] px-2 py-0.5 rounded-full font-medium">
                    Google API Scopes
                  </span>
                </div>
                <p className="text-xs text-[#53657A] leading-relaxed">
                  Cakupan: Membaca jadwal rapat agar tidak bentrok, dan menyimpan sesi tugas terjadwal ke kalender pribadi Anda setelah persetujuan Anda.
                </p>
                <label className="flex items-center gap-2.5 pt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={connectCalendar}
                    onChange={(e) => setConnectCalendar(e.target.checked)}
                    className="w-4 h-4 text-[#2457A7] rounded-sm focus:ring-[#2457A7]"
                  />
                  <span className="text-xs font-medium text-[#172B42]">
                    Aktifkan sinkronisasi Google Calendar sekarang
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div className="px-6 py-4 bg-[#F8FAFC] border-t border-[#D9E3EF] flex items-center justify-between">
          {step > 1 ? (
            <button
              onClick={() => setStep((s) => (s - 1) as 1 | 2)}
              className="text-xs font-medium text-[#53657A] hover:text-[#172B42] py-2 px-3 rounded-lg"
            >
              Kembali
            </button>
          ) : (
            <div />
          )}

          {step < 3 ? (
            <button
              onClick={() => setStep((s) => (s + 1) as 2 | 3)}
              className="flex items-center gap-2 bg-[#2457A7] hover:bg-[#1E4889] text-white text-xs font-semibold py-2.5 px-4 rounded-xl transition-colors shadow-xs"
            >
              Lanjutkan <ArrowRight size={14} />
            </button>
          ) : (
            <button
              onClick={handleFinish}
              className="flex items-center gap-2 bg-[#16856B] hover:bg-[#126E58] text-white text-xs font-semibold py-2.5 px-5 rounded-xl transition-colors shadow-xs"
            >
              <Check size={14} /> Masuk ke Ruang Kerja EVEN
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
