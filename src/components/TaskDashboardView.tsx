import React, { useMemo, useState } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  Calendar,
  BarChart2,
  PieChart as PieIcon,
  ArrowRight,
  TrendingUp,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { Task, UserPreferences } from '../types';
import { getPartsInTimezone, formatInTimezone } from '../lib/timezone';

interface TaskDashboardViewProps {
  tasks: Task[];
  preferences: UserPreferences;
  onOpenTaskModal?: () => void;
  onNavigateToTasks?: () => void;
  onNavigateToCalendar?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  Selesai: '#16856B', // Hijau toska
  Terjadwal: '#2457A7', // Biru EVEN
  'Belum Terjadwal': '#D97706', // Amber hangat
};

export const TaskDashboardView: React.FC<TaskDashboardViewProps> = ({
  tasks,
  preferences,
  onOpenTaskModal,
  onNavigateToTasks,
  onNavigateToCalendar,
}) => {
  const userTz = preferences.timezone || 'Asia/Jakarta';
  const [activeRange, setActiveRange] = useState<'week' | 'all'>('week');

  // 1. Perhitungan Distribusi Status Tugas
  const distributionData = useMemo(() => {
    let completedCount = 0;
    let scheduledCount = 0;
    let unscheduledCount = 0;

    for (const t of tasks) {
      if (t.status === 'COMPLETED' || t.status === 'completed_manual') {
        completedCount++;
      } else if (
        t.status === 'SCHEDULED' ||
        t.status === 'IN_PROGRESS' ||
        (t.scheduledSessions && t.scheduledSessions.length > 0)
      ) {
        scheduledCount++;
      } else {
        unscheduledCount++;
      }
    }

    const total = tasks.length || 1;
    return [
      {
        name: 'Selesai',
        value: completedCount,
        percentage: Math.round((completedCount / total) * 100),
        color: STATUS_COLORS['Selesai'],
      },
      {
        name: 'Terjadwal',
        value: scheduledCount,
        percentage: Math.round((scheduledCount / total) * 100),
        color: STATUS_COLORS['Terjadwal'],
      },
      {
        name: 'Belum Terjadwal',
        value: unscheduledCount,
        percentage: Math.round((unscheduledCount / total) * 100),
        color: STATUS_COLORS['Belum Terjadwal'],
      },
    ];
  }, [tasks]);

  // 2. Perhitungan Grafik Batang Beban Pengerjaan Mingguan (7 Hari)
  const weeklyWorkloadData = useMemo(() => {
    const today = new Date();
    const todayParts = getPartsInTimezone(today, userTz);
    // Hitung awal minggu (Senin)
    const diffToMonday = todayParts.dayOfWeek === 0 ? -6 : 1 - todayParts.dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToMonday);

    const dayNames = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
    const weekDays: {
      hari: string;
      tanggal: string;
      dateObj: Date;
      bebanMenit: number;
      bebanJam: number;
      jumlahSesi: number;
    }[] = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const parts = getPartsInTimezone(d, userTz);
      const dateStr = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      weekDays.push({
        hari: dayNames[i],
        tanggal: dateStr,
        dateObj: d,
        bebanMenit: 0,
        bebanJam: 0,
        jumlahSesi: 0,
      });
    }

    // Akumulasi durasi sesi yang terjadwal
    for (const task of tasks) {
      if (task.scheduledSessions && task.scheduledSessions.length > 0) {
        for (const sess of task.scheduledSessions) {
          if (sess.status === 'CANCELLED') continue;
          const sDate = new Date(sess.startAt);
          const sessParts = getPartsInTimezone(sDate, userTz);
          const sessDateStr = `${sessParts.year}-${String(sessParts.month).padStart(2, '0')}-${String(sessParts.day).padStart(2, '0')}`;

          const targetDay = weekDays.find((w) => w.tanggal === sessDateStr);
          if (targetDay) {
            targetDay.bebanMenit += sess.durationMinutes || 60;
            targetDay.jumlahSesi += 1;
          }
        }
      }
    }

    // Konversi ke jam (1 desimal)
    return weekDays.map((w) => ({
      ...w,
      bebanJam: Math.round((w.bebanMenit / 60) * 10) / 10,
    }));
  }, [tasks, userTz]);

  // Statistik Ringkasan
  const totalTasks = tasks.length;
  const completedTasks = distributionData.find((d) => d.name === 'Selesai')?.value || 0;
  const scheduledTasks = distributionData.find((d) => d.name === 'Terjadwal')?.value || 0;
  const unscheduledTasks = distributionData.find((d) => d.name === 'Belum Terjadwal')?.value || 0;
  const totalWeeklyMinutes = weeklyWorkloadData.reduce((acc, curr) => acc + curr.bebanMenit, 0);
  const totalWeeklyHours = Math.round((totalWeeklyMinutes / 60) * 10) / 10;

  return (
    <div className="flex-1 h-screen overflow-y-auto bg-[#F8FAFC] p-6 lg:p-8">
      {/* Header Halaman */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-[#EAF3FC] text-[#2457A7]">
              <TrendingUp size={20} />
            </span>
            <h1 className="text-2xl font-bold text-[#172B42] font-sans tracking-tight">
              Dashboard Statistik Kegiatan
            </h1>
          </div>
          <p className="text-xs text-[#53657A] mt-1">
            Visualisasi distribusi penyelesaian tugas dan analisis beban kerja mingguan Anda.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onOpenTaskModal && (
            <button
              onClick={onOpenTaskModal}
              className="px-3.5 py-2 bg-[#2457A7] text-white text-xs font-semibold rounded-xl hover:bg-[#1d4685] transition-colors shadow-xs"
            >
              + Kegiatan Baru
            </button>
          )}
        </div>
      </div>

      {/* Baris 1: Kartu Metrik Ringkasan */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="p-4 bg-white border border-[#D9E3EF] rounded-2xl shadow-xs"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#53657A]">Total Kegiatan</span>
            <span className="p-1.5 rounded-lg bg-slate-100 text-[#172B42]">
              <BarChart2 size={16} />
            </span>
          </div>
          <div className="text-2xl font-bold text-[#172B42]">{totalTasks}</div>
          <div className="text-[11px] text-[#53657A] mt-1">Seluruh agenda terdaftar</div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="p-4 bg-white border border-[#D9E3EF] rounded-2xl shadow-xs"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#16856B]">Kegiatan Selesai</span>
            <span className="p-1.5 rounded-lg bg-[#E6F5F0] text-[#16856B]">
              <CheckCircle2 size={16} />
            </span>
          </div>
          <div className="text-2xl font-bold text-[#16856B]">{completedTasks}</div>
          <div className="text-[11px] text-[#53657A] mt-1">
            {totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}% dari total kegiatan` : '0%'}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="p-4 bg-white border border-[#D9E3EF] rounded-2xl shadow-xs"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#2457A7]">Terjadwal di Kalender</span>
            <span className="p-1.5 rounded-lg bg-[#EAF3FC] text-[#2457A7]">
              <Clock size={16} />
            </span>
          </div>
          <div className="text-2xl font-bold text-[#2457A7]">{scheduledTasks}</div>
          <div className="text-[11px] text-[#53657A] mt-1">Memiliki slot waktu aktif</div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="p-4 bg-white border border-[#D9E3EF] rounded-2xl shadow-xs"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#D97706]">Beban Minggu Ini</span>
            <span className="p-1.5 rounded-lg bg-amber-50 text-[#D97706]">
              <Calendar size={16} />
            </span>
          </div>
          <div className="text-2xl font-bold text-[#172B42]">{totalWeeklyHours} <span className="text-sm font-normal text-[#53657A]">Jam</span></div>
          <div className="text-[11px] text-[#53657A] mt-1">Total {totalWeeklyMinutes} menit pengerjaan</div>
        </motion.div>
      </div>

      {/* Baris 2: Dua Grafik Utama (Diagram Lingkaran & Grafik Batang) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
        {/* DIAGRAM LINGKARAN: Distribusi Status Tugas */}
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          className="lg:col-span-5 bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-[#EAF3FC] text-[#2457A7] rounded-lg">
                  <PieIcon size={16} />
                </span>
                <h2 className="text-sm font-bold text-[#172B42]">Distribusi Status Tugas</h2>
              </div>
              <span className="text-[11px] text-[#53657A]">Selesai, Terjadwal, Belum</span>
            </div>
            <p className="text-xs text-[#53657A] mb-4">
              Komposisi status kegiatan Anda berdasarkan tahapan penyelesaian saat ini.
            </p>

            {/* Container Recharts PieChart */}
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={distributionData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {distributionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(val: any, name: any, item: any) => [
                      `${val} kegiatan (${item.payload.percentage}%)`,
                      name,
                    ]}
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderRadius: '12px',
                      border: '1px solid #D9E3EF',
                      fontSize: '12px',
                      boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)',
                    }}
                  />
                  <Legend
                    verticalAlign="bottom"
                    iconType="circle"
                    wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Rincian Angka Legenda */}
          <div className="grid grid-cols-3 gap-2 pt-4 border-t border-[#D9E3EF] mt-4">
            {distributionData.map((item) => (
              <div key={item.name} className="text-center p-2 rounded-xl bg-slate-50 border border-slate-100">
                <span className="block text-[11px] text-[#53657A] truncate font-medium">{item.name}</span>
                <span className="block text-base font-bold text-[#172B42] mt-0.5">{item.value}</span>
                <span className="text-[10px] font-semibold text-[#53657A]">{item.percentage}%</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* GRAFIK BATANG: Beban Pengerjaan Mingguan */}
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35 }}
          className="lg:col-span-7 bg-white border border-[#D9E3EF] rounded-2xl p-5 shadow-xs flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-[#EAF3FC] text-[#2457A7] rounded-lg">
                  <BarChart2 size={16} />
                </span>
                <h2 className="text-sm font-bold text-[#172B42]">Grafik Beban Pengerjaan Mingguan</h2>
              </div>
              <span className="text-[11px] text-[#2457A7] font-medium bg-[#EAF3FC] px-2 py-0.5 rounded-full">
                7 Hari (Senin - Minggu)
              </span>
            </div>
            <p className="text-xs text-[#53657A] mb-4">
              Estimasi total jam fokus teralokasi di kalender per hari untuk minggu berjalan.
            </p>

            {/* Container Recharts BarChart */}
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weeklyWorkloadData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis
                    dataKey="hari"
                    stroke="#53657A"
                    fontSize={11}
                    tickLine={false}
                    axisLine={{ stroke: '#E2E8F0' }}
                  />
                  <YAxis
                    stroke="#53657A"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    unit="j"
                  />
                  <Tooltip
                    formatter={(val: any, name: any, item: any) => [
                      `${val} Jam (${item.payload.bebanMenit} menit) • ${item.payload.jumlahSesi} sesi`,
                      'Beban Kerja',
                    ]}
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderRadius: '12px',
                      border: '1px solid #D9E3EF',
                      fontSize: '12px',
                      boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)',
                    }}
                  />
                  <Bar
                    dataKey="bebanJam"
                    name="Beban Kegiatan (Jam)"
                    fill="#2457A7"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={38}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Navigasi / Tindakan Cepat */}
          <div className="flex items-center justify-between pt-4 border-t border-[#D9E3EF] mt-4 text-xs">
            <span className="text-[#53657A]">
              Hari terpadat:{' '}
              <strong className="text-[#172B42]">
                {[...weeklyWorkloadData].sort((a, b) => b.bebanMenit - a.bebanMenit)[0]?.hari || 'Senin'}
              </strong>
            </span>
            {onNavigateToCalendar && (
              <button
                onClick={onNavigateToCalendar}
                className="inline-flex items-center gap-1 font-semibold text-[#2457A7] hover:underline"
              >
                Buka Kalender Mingguan <ArrowRight size={13} />
              </button>
            )}
          </div>
        </motion.div>
      </div>

      {/* Baris 3: Rekomendasi Beban & Tindakan */}
      {unscheduledTasks > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="p-4 bg-amber-50/80 border border-amber-200/80 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
        >
          <div className="flex items-start gap-3">
            <span className="p-2 bg-amber-100 text-[#B86B12] rounded-xl shrink-0 mt-0.5">
              <AlertCircle size={18} />
            </span>
            <div>
              <h3 className="text-xs font-bold text-[#172B42]">
                Ada {unscheduledTasks} kegiatan belum terjadwal di kalender
              </h3>
              <p className="text-[11px] text-[#53657A] mt-0.5 leading-relaxed">
                Manfaatkan penjadwalan deterministik otomatis atau Asisten AI untuk menempatkan kegiatan pada slot waktu luang tanpa benturan.
              </p>
            </div>
          </div>
          {onNavigateToTasks && (
            <button
              onClick={onNavigateToTasks}
              className="px-3 py-1.5 bg-[#2457A7] text-white text-xs font-semibold rounded-xl hover:bg-[#1d4685] transition-colors shrink-0"
            >
              Jadwalkan di Daftar Kegiatan
            </button>
          )}
        </motion.div>
      )}
    </div>
  );
};
