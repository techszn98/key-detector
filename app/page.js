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
    if (freq < 60 || freq > 2000) continue;
    const db = dataArray[i];
    if (db < -80) continue;
    const amplitude = Math.pow(10, db / 20);
    const freqWeight = 1 / (1 + freq / 500);
    const midiNote = 12 * Math.log2(freq / 440) + 69;
    const pitchClass = ((Math.round(midiNote) % 12) + 12) % 12;
    chroma[pitchClass] += amplitude * freqWeight;
    totalEnergy += amplitude * freqWeight;
  }

  if (totalEnergy < 0.005) return null;
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 16384;
      analyser.smoothingTimeConstant = 0.6;
      analyserRef.current = analyser;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      chromaBufferRef.current = [];
      voteHistoryRef.current = [];
      setListening(true);
      setStatus("Listening...");

      // Collect frames every 150ms + update chroma bars live
      const collectInterval = setInterval(() => {
        const c = getChroma(analyserRef.current);
        if (c) {
          chromaBufferRef.current.push(c);
          if (chromaBufferRef.current.length > 10) chromaBufferRef.current.shift();
          setChroma(c); // live bar update
        }
      }, 150);

      // Analyze & vote every 600ms
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
        if (voteHistoryRef.current.length > 5) voteHistoryRef.current.shift();

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

      {/* Title */}
      <div className="text-center">
        <h1 className="text-5xl font-bold tracking-tight">Key Detector</h1>
        <p className="text-gray-400 mt-2 text-lg">Sing or play an instrument, get the key instantly</p>
      </div>

      {/* Key + Confidence */}
      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-8 flex flex-col items-center gap-3 w-full max-w-sm">
        <p className="text-gray-500 text-xs uppercase tracking-widest">Detected Key</p>
        <div className="text-8xl font-black text-white leading-none">{rootNote}</div>
        <div className="text-2xl text-indigo-400 font-semibold">{keyMode}</div>

        {/* Confidence bar */}
        {confInfo ? (
          <div className="w-full mt-2">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-500 uppercase tracking-widest">Confidence</span>
              <span className={`font-bold ${confInfo.color}`}>{confInfo.label}</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-500 ${confInfo.bar}`}
                style={{ width: `${confInfo.pct}%` }}
              />
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
                    ? "#818cf8"  // indigo for root note
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
