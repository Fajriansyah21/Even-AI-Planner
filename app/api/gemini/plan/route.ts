import { GoogleGenAI, Type } from '@google/genai';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { userPrompt, currentDateTime } = await req.json();

    if (!userPrompt || typeof userPrompt !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Permintaan teks tidak boleh kosong.' },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Rule-based fallback if no API key is injected yet
      return NextResponse.json({
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
          preferredTimeOfDay: userPrompt.toLowerCase().includes('pagi')
            ? 'MORNING'
            : userPrompt.toLowerCase().includes('sore')
            ? 'AFTERNOON'
            : 'ANY',
          reasoning: 'AI mengenali tugas dan menetapkan durasi standar 60 menit dengan batas waktu besok.',
        },
      });
    }

    const ai = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
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
          required: ['title', 'estimatedDurationMinutes', 'priority', 'allowSplit', 'reasoning'],
        },
      },
    });

    const plan = JSON.parse(response.text || '{}');
    return NextResponse.json({ success: true, source: 'gemini', plan });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Gagal memproses dengan Gemini API.' },
      { status: 500 }
    );
  }
}
