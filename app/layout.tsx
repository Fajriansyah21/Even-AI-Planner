import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EVEN - Perencana Pribadi AI',
  description: 'AI-powered personal planner yang mengubah tugas, durasi, dan tenggat menjadi jadwal realistis dengan Google Calendar dan Firebase.',
  openGraph: {
    title: 'EVEN - Perencana Pribadi AI',
    description: 'AI-powered personal planner yang mengubah tugas, durasi, dan tenggat menjadi jadwal realistis dengan Google Calendar dan Firebase.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EVEN - Perencana Pribadi AI',
    description: 'AI-powered personal planner yang mengubah tugas, durasi, dan tenggat menjadi jadwal realistis dengan Google Calendar dan Firebase.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="bg-[#F8FAFC] text-[#172B42] antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
