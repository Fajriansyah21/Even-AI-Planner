import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#F8FAFC] px-4 text-center">
      <div className="w-12 h-12 rounded-2xl bg-[#2457A7] text-white flex items-center justify-center font-editorial text-2xl font-bold mb-4 shadow-xs">
        E
      </div>
      <h1 className="font-editorial text-3xl font-bold text-[#172B42]">Halaman Tidak Ditemukan</h1>
      <p className="mt-2 text-sm text-[#53657A] max-w-md">
        Halaman yang Anda tuju tidak tersedia atau telah dipindahkan. Silakan kembali ke beranda kalender EVEN.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center px-4 py-2 rounded-xl bg-[#2457A7] text-xs font-semibold text-white hover:bg-[#1E4889] transition-colors shadow-xs"
      >
        Kembali ke Kalender
      </Link>
    </div>
  );
}
