"use client";

import { useState, useRef } from "react";

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(chroma, profile) {
  const n = 12;
  const meanC = chroma.reduce((a, b) => a + b, 0) / n;
  const meanP = profile.reduce((a, b) => a + b, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const a = chroma[i] - meanC;
    const b = profile[i] - meanP;
    num += a * b;
    denA += a * a;
    denB += b * b;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

function detectKey(chroma) {
  let bestKey = 0, bestMode = "Major", bestScore = -Infinity;
  for (let i = 0; i < 12; i++) {
    const rotated = [...chroma.slice(i), ...chroma.slice(0, i)];
    const majScore = correlate(rotated, MAJOR_PROFILE);
    const minScore = correlate(rotated, MINOR_PROFILE);
    if (majScore > bestScore) { bestScore = majScore; bestKey = i; bestMode = "Major"; }
    if (minScore > bestScore) { bestScore = minScore; bestKey = i; bestMode = "Minor"; }
  }
  return { root: NOTES[bestKey], mode: bestMode, confidence: bestScore };
}

function getChroma(analyser) {
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Float32Array(bufferLength);
  analyser.getFloatFrequencyData(dataArray);
  const sampleRate = analyser.context.sampleRate;
  const chroma = new Array(12).fill(0);
  let totalEnergy = 0;

  for (let i = 1; i < bufferLength; i++) {
    const freq = (i * sampleRate) / (2 * bufferLength);

    // Extended range: 27Hz (lowest piano A) to 4200Hz
    if (freq < 27 || freq > 4200) continue;

    const db = dataArray[i];
    if (db < -90) continue;

    const amplitude = Math.pow(10, db / 20);

    // Strong boost for low frequencies (bass octaves)
    // Below 250Hz gets the biggest boost, tapers off above
    let freqWeight;
    if (freq < 250) {
      freqWeight = 4.0 / (1 + freq / 80);   // aggressive bass boost
    } else if (freq < 1000) {
      freqWeight = 1.5 / (1 + freq / 500);  // mid-range moderate weight
    } else {
      freqWeight = 0.5 / (1 + freq / 1000); // reduce high harmonics
    }

    const midiNote = 12 * Math.log2(freq / 440) + 69;
    const pitchClass = ((Math.round(midiNote) % 12) + 12) % 12;
    chroma[pitchClass] += amplitude * freqWeight;
    totalEnergy += amplitude * freqWeight;
  }

  // Lower silence threshold so quiet low notes aren't ignored
  if (totalEnergy < 0.001) return null;

  const max = Math.max(...chroma);
  return max > 0 ? chroma.map((v) => v / max) : null;
}

function majorityVote(history) {
  const counts = {};
  for (const item of history) {
    const key = `${item.root}|${item.mode}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > bestCount) { bestCount = count; best = key; }
  }
  if (!best) return null;
  const [root, mode] = best.split("|");
  return { root, mode, votes: bestCount };
}

function getConfidenceLabel(score) {
  if (score >= 0.85) return { label: "High", color: "text-green-400", bar: "bg-green-400", pct: 100 };
  if (score >= 0.70) return { label: "Good", color: "text-lime-400", bar: "bg-lime-400", pct: 75 };
  if (score >= 0.55) return { label: "Medium", color: "text-yellow-400", bar: "bg-yellow-400", pct: 50 };
  return { label: "Low", color: "text-red-400", bar: "bg-red-400", pct: 25 };
}

function TrebleClef({ className }) {
  return (
    <svg className={className} viewBox="0 0 100 180" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M55 10 C55 10 35 30 35 65 C35 85 45 95 55 100 C65 105 75 100 75 88 C75 76 65 68 55 68 C45 68 38 75 38 85 C38 95 45 102 55 105 C55 105 55 140 45 155 C40 162 33 165 33 165"
        stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
      <path
        d="M55 105 C55 120 57 135 55 155 C53 165 47 172 42 170 C37 168 33 162 35 155 C37 148 45 147 50 152 C55 157 53 165 48 166"
        stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
    </svg>
  );
}

export default function Home() {
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("Not listening");
  const [rootNote, setRootNote] = useState("—");
  const [keyMode, setKeyMode] = useState("—");
  const [chroma, setChroma] = useState(new Array(12).fill(0));
  const [confidence, setConfidence] = useState(null);

  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const intervalsRef = useRef([]);
  const chromaBufferRef = useRef([]);
  const voteHistoryRef = useRef([]);

  const startListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,  // off — echo cancellation distorts low notes
          noiseSuppression: false,  // off — noise suppression kills bass frequencies
          autoGainControl: false,   // off — we want raw unmodified signal
          sampleRate: 48000,        // high sample rate for better low freq resolution
        }
      });
      streamRef.current = stream;

      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 32768;           // maximum resolution for low freq accuracy
      analyser.smoothingTimeConstant = 0.7;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      chromaBufferRef.current = [];
      voteHistoryRef.current = [];
      setListening(true);
      setStatus("Listening...");

      const collectInterval = setInterval(() => {
        const c = getChroma(analyserRef.current);
        if (c) {
          chromaBufferRef.current.push(c);
          if (chromaBufferRef.current.length > 12) chromaBufferRef.current.shift();
          setChroma(c);
        }
      }, 150);

      const analyzeInterval = setInterval(() => {
        const buffer = chromaBufferRef.current;
        if (buffer.length < 3) {
          setStatus("Listening... (play a note or chord)");
          return;
        }

        const avgChroma = new Array(12).fill(0);
        for (const frame of buffer) {
          for (let i = 0; i < 12; i++) avgChroma[i] += frame[i];
        }
        const averaged = avgChroma.map((v) => v / buffer.length);
        const result = detectKey(averaged);

        voteHistoryRef.current.push(result);
        if (voteHistoryRef.current.length > 6) voteHistoryRef.current.shift();

        const winner = majorityVote(voteHistoryRef.current);
        const matchCount = voteHistoryRef.current.filter(
          (v) => v.root === winner?.root && v.mode === winner?.mode
        ).length;

        if (winner && matchCount >= 3) {
          setRootNote(winner.root);
          setKeyMode(winner.mode);
          setConfidence(result.confidence);
          setStatus("Listening...");
        } else {
          setStatus("Listening... (analyzing...)");
        }

        chromaBufferRef.current = [];
      }, 600);

      intervalsRef.current = [collectInterval, analyzeInterval];
    } catch (err) {
      console.error("Mic error:", err);
      setStatus("Microphone access denied");
    }
  };

  const stopListening = () => {
    intervalsRef.current.forEach(clearInterval);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();
    chromaBufferRef.current = [];
    voteHistoryRef.current = [];
    setListening(false);
    setStatus("Not listening");
    setChroma(new Array(12).fill(0));
    setConfidence(null);
  };

  const handleMicClick = () => {
    if (listening) stopListening();
    else startListening();
  };

  const confInfo = confidence ? getConfidenceLabel(confidence) : null;

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-6 px-4 py-10">

      {/* Title with Treble Clef */}
      <div className="text-center flex flex-col items-center gap-2">
        <div className="flex items-center justify-center gap-3">
          <TrebleClef className="w-8 h-14 text-indigo-400" />
          <h1 className="text-5xl font-bold tracking-tight">Key Detector</h1>
          <TrebleClef className="w-8 h-14 text-indigo-400 scale-x-[-1]" />
        </div>
        <p className="text-gray-400 mt-1 text-lg">Sing or play an instrument — get the key instantly</p>
      </div>

      {/* Key + Confidence */}
      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-8 flex flex-col items-center gap-3 w-full max-w-sm">
        <p className="text-gray-500 text-xs uppercase tracking-widest">Detected Key</p>
        <div className="text-8xl font-black text-white leading-none">{rootNote}</div>
        <div className="text-2xl text-indigo-400 font-semibold">{keyMode}</div>

        {confInfo ? (
          <div className="w-full mt-2">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-500 uppercase tracking-widest">Confidence</span>
              <span className={`font-bold ${confInfo.color}`}>{confInfo.label}</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div className={`h-2 rounded-full transition-all duration-500 ${confInfo.bar}`}
                style={{ width: `${confInfo.pct}%` }} />
            </div>
          </div>
        ) : (
          <div className="w-full mt-2">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-500 uppercase tracking-widest">Confidence</span>
              <span className="text-gray-600">—</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2" />
          </div>
        )}
      </div>

      {/* Chroma Bars */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 w-full max-w-sm">
        <p className="text-gray-500 text-xs uppercase tracking-widest mb-4 text-center">Note Activity</p>
        <div className="flex items-end justify-between gap-1 h-16">
          {NOTES.map((note, i) => (
            <div key={note} className="flex flex-col items-center flex-1 gap-1">
              <div className="w-full rounded-sm transition-all duration-150"
                style={{
                  height: `${Math.max(4, chroma[i] * 60)}px`,
                  backgroundColor: note === rootNote
                    ? "#818cf8"
                    : `hsl(${160 + chroma[i] * 60}, 70%, 50%)`,
                }}
              />
              <span className={`text-xs font-medium ${note === rootNote ? "text-indigo-400" : "text-gray-600"}`}>
                {note}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Mic Button */}
      <button
        onClick={handleMicClick}
        className={`w-20 h-20 rounded-full transition-all duration-150 flex items-center justify-center shadow-lg active:scale-95 ${
          listening
            ? "bg-red-600 hover:bg-red-500 shadow-red-900 animate-pulse"
            : "bg-indigo-600 hover:bg-indigo-500 shadow-indigo-900"
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-7 10a7 7 0 0 0 14 0h2a9 9 0 0 1-8 8.94V22h-2v-2.06A9 9 0 0 1 3 11h2z" />
        </svg>
      </button>

      <p className={`text-sm ${listening ? "text-red-400" : "text-gray-600"}`}>
        {status}
      </p>

    </main>
  );
}