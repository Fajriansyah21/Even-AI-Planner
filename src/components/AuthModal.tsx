import React, { useState } from 'react';
import { ShieldCheck, Calendar, ArrowRight, X, AlertCircle } from 'lucide-react';
import { googleSignIn } from '../lib/firebase';

interface AuthModalProps {
  isOpen: boolean;
  initialMode: 'login' | 'register';
  onClose: () => void;
  onSuccess: (email: string, name: string, isNewUser: boolean, accessToken?: string) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  initialMode,
  onClose,
  onSuccess,
}) => {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  if (!isOpen) return null;

  const handleGoogleAuth = async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const result = await googleSignIn();
      if (result && result.user) {
        const isNew = mode === 'register';
        onSuccess(
          result.user.email || '',
          result.user.displayName || 'Pengguna EVEN',
          isNew,
          result.accessToken
        );
        onClose();
      }
    } catch (err: any) {
      console.warn('Google sign-in caught:', err);
      // Properly handle real errors and user cancellation without fake login
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        setErrorMessage('Jendela login ditutup sebelum proses selesai. Silakan coba kembali.');
      } else if (err.code === 'auth/popup-blocked') {
        setErrorMessage('Jendela popup login diblokir oleh peramban. Harap izinkan pop-up di peramban Anda.');
      } else if (err.code === 'auth/network-request-failed') {
        setErrorMessage('Gagal terhubung ke jaringan. Periksa koneksi internet Anda dan coba lagi.');
      } else if (err.code === 'auth/unauthorized-domain') {
        setErrorMessage('Domain aplikasi ini belum diotorisasi di Firebase Authentication Console.');
      } else {
        setErrorMessage(
          err.message
            ? `Autentikasi gagal: ${err.message}`
            : 'Terjadi kesalahan saat menghubungkan akun Google. Silakan coba kembali.'
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div 
        className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-[#D9E3EF] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-center justify-between border-b border-[#D9E3EF]/60">
          <div className="flex items-center gap-2">
            <span className="font-logo text-2xl font-bold text-[#2457A7] tracking-wide">
              EVEN
            </span>
            <span className="text-xs bg-[#EAF3FC] text-[#2457A7] font-medium px-2 py-0.5 rounded-full">
              Google Workspace & Firebase
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-[#53657A] hover:text-[#172B42] p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            aria-label="Tutup dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {errorMessage && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-xs text-[#C43D4B]">
              <AlertCircle size={15} className="shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {mode === 'login' ? (
            <div>
              <h2 id="auth-modal-title" className="text-xl font-bold text-[#172B42]">
                Masuk ke EVEN
              </h2>
              <p className="mt-1 text-sm text-[#53657A] leading-relaxed">
                Akses jadwal personal, sinkronisasi Google Calendar langsung, dan simpan tugas di Firestore.
              </p>
            </div>
          ) : (
            <div>
              <h2 id="auth-modal-title" className="text-xl font-bold text-[#172B42]">
                Buat Akun EVEN
              </h2>
              <p className="mt-1 text-sm text-[#53657A] leading-relaxed">
                Mulai ubah niat dan tugas Anda menjadi jadwal nyata tanpa konflik waktu.
              </p>
            </div>
          )}

          {/* Official Google Sign-in button */}
          <button
            onClick={handleGoogleAuth}
            disabled={isLoading}
            className="mt-6 w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl border border-[#D9E3EF] bg-white hover:bg-slate-50 text-[#172B42] font-semibold text-sm transition-all shadow-xs hover:shadow-sm focus:outline-hidden focus:ring-2 focus:ring-[#2457A7] disabled:opacity-60 cursor-pointer"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4 text-[#2457A7]" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                Menghubungkan ke Google...
              </span>
            ) : (
              <>
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                {mode === 'login' ? 'Masuk dengan Google' : 'Daftar dengan Akun Google'}
              </>
            )}
          </button>

          {/* Privacy & No password note */}
          <div className="mt-5 space-y-2 text-xs text-[#53657A]">
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-[#16856B] shrink-0 mt-0.5" />
              <span>
                Firebase Authentication & Firestore Enterprise aktif untuk mengamankan data jadwal Anda.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <Calendar className="w-4 h-4 text-[#2457A7] shrink-0 mt-0.5" />
              <span>
                Izin Google Calendar memungkinkan pembacaan rapat dan penulisan tugas terencana.
              </span>
            </div>
          </div>

          {/* Toggle between Login and Register */}
          <div className="mt-6 pt-4 border-t border-[#D9E3EF] flex items-center justify-between text-xs">
            {mode === 'login' ? (
              <>
                <span className="text-[#53657A]">Belum memiliki akun EVEN?</span>
                <button
                  type="button"
                  onClick={() => setMode('register')}
                  className="font-medium text-[#2457A7] hover:underline flex items-center gap-1"
                >
                  Buat akun baru <ArrowRight size={12} />
                </button>
              </>
            ) : (
              <>
                <span className="text-[#53657A]">Sudah terdaftar sebelumnya?</span>
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="font-medium text-[#2457A7] hover:underline flex items-center gap-1"
                >
                  Masuk ke akun <ArrowRight size={12} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
