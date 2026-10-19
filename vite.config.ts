import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, Plugin } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

function apiServerPlugin(): Plugin {
  return {
    name: 'even-api-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/api/gemini/plan' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => {
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const { userPrompt, currentDateTime } = JSON.parse(body || '{}');

              if (!userPrompt || typeof userPrompt !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Permintaan teks tidak boleh kosong.' }));
                return;
              }

              const apiKey = process.env.GEMINI_API_KEY;
              if (!apiKey) {
                // Honest fallback if no key is provided
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: true,
                  source: 'rule_engine',
                  note: 'API key tidak terpasang di runtime server. Menggunakan pemroses aturan lokal.',
                  plan: {
                    title: userPrompt.length > 50 ? userPrompt.slice(0, 47) + '...' : userPrompt,
                    description: `Ditafsirkan dari catatan: "${userPrompt}"`,
                    estimatedDurationMinutes: 60,
                    deadlineDaysFromNow: 1,
                    priority: 'MEDIUM',
                    allowSplit: userPrompt.toLowerCase().includes('bagi') || userPrompt.toLowerCase().includes('sesi'),
                    minimumSessionMinutes: 30,
                    preferredTimeOfDay: userPrompt.toLowerCase().includes('pagi') ? 'MORNING' : userPrompt.toLowerCase().includes('sore') ? 'AFTERNOON' : 'ANY',
                    reasoning: 'AI mengenali tugas dan menetapkan durasi standar 60 menit dengan batas waktu besok.'
                  }
                }));
                return;
              }

              const ai = new GoogleGenAI({
                apiKey: apiKey,
                httpOptions: {
                  headers: {
                    'User-Agent': 'aistudio-build',
                  }
                }
              });

              const systemInstruction = `Kamu adalah perencana AI untuk EVEN (AI-powered personal planner).
Bahasa utama: Bahasa Indonesia baku, ringkas, objektif.
Pengguna ingin mengubah niat atau tugas menjadi jadwal realistis.
Tugasmu:
1. Ekstrak judul ringkas, catatan penting, estimasi durasi dalam menit, estimasi tenggat (berapa hari dari sekarang), prioritas (LOW, MEDIUM, HIGH, URGENT), preferensi pemecahan sesi (allowSplit), durasi sesi minimum, dan waktu hari yang disukai (MORNING, AFTERNOON, EVENING, ANY).
2. Berikan penjelasan ringkas (reasoning) dalam Bahasa Indonesia mengapa kamu memilih estimasi durasi dan pengaturan tersebut.
3. Waktu sistem saat ini: ${currentDateTime || new Date().toISOString()}.
4. Jangan berhalusinasi atau memberikan klaim palsu.`;

              const response = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: `Tafsirkan permintaan tugas berikut ke dalam JSON schema terstruktur:\n"${userPrompt}"`,
                config: {
                  systemInstruction,
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: 'Judul tugas ringkas' },
                      description: { type: Type.STRING, description: 'Deskripsi atau catatan tugas' },
                      estimatedDurationMinutes: { type: Type.INTEGER, description: 'Estimasi durasi dalam menit' },
                      deadlineDaysFromNow: { type: Type.INTEGER, description: 'Tenggat waktu dalam jumlah hari dari sekarang' },
                      priority: { type: Type.STRING, description: 'Prioritas: LOW, MEDIUM, HIGH, atau URGENT' },
                      allowSplit: { type: Type.BOOLEAN, description: 'Boleh dipecah beberapa sesi' },
                      minimumSessionMinutes: { type: Type.INTEGER, description: 'Durasi minimal per sesi jika dipecah' },
                      preferredTimeOfDay: { type: Type.STRING, description: 'MORNING, AFTERNOON, EVENING, atau ANY' },
                      reasoning: { type: Type.STRING, description: 'Alasan rasional pemilihan durasi & struktur dalam Bahasa Indonesia' },
                    },
                    required: ['title', 'estimatedDurationMinutes', 'priority', 'allowSplit', 'reasoning']
                  }
                }
              });

              const plan = JSON.parse(response.text || '{}');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, source: 'gemini', plan }));
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: err?.message || 'Gagal memproses dengan Gemini API.' }));
            }
          });
          return;
        }

        next();
      });
    }
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), apiServerPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
