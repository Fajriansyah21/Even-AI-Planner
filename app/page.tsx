'use client';

import { useSyncExternalStore } from 'react';
import App from '../src/App';

const emptySubscribe = () => () => {};

export default function Page() {
  const isClient = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

  if (!isClient) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#F8FAFC]">
        <div className="text-center space-y-3">
          <div className="w-11 h-11 rounded-2xl bg-[#2457A7] text-white flex items-center justify-center font-editorial text-2xl font-bold mx-auto shadow-xs animate-pulse">
            E
          </div>
          <div>
            <h1 className="font-editorial text-xl font-bold text-[#172B42]">EVEN</h1>
            <p className="text-xs text-[#53657A] mt-0.5">Memuat jadwal dan kalender realistis...</p>
          </div>
        </div>
      </div>
    );
  }

  return <App />;
}

