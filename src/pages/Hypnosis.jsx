import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateHypnosisScript } from '@/api/hypnosis';

const DURATIONS = [5, 10, 20];
const TONES = [
  { value: 'gentle', label: 'Gentle' },
  { value: 'authoritative', label: 'Authoritative' },
  { value: 'warm', label: 'Warm' },
];
const VOICES = [
  { value: 'nova', label: 'Nova', desc: 'Warm & clear' },
  { value: 'shimmer', label: 'Shimmer', desc: 'Soft & soothing' },
  { value: 'alloy', label: 'Alloy', desc: 'Neutral & calm' },
  { value: 'echo', label: 'Echo', desc: 'Deep & smooth' },
  { value: 'fable', label: 'Fable', desc: 'Expressive' },
  { value: 'onyx', label: 'Onyx', desc: 'Rich & grounded' },
];

function formatClock(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Hypnosis() {
  const [prompt, setPrompt] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [tone, setTone] = useState('gentle');
  const [selectedVoice, setSelectedVoice] = useState('nova');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [script, setScript] = useState(null);

  const [status, setStatus] = useState('idle'); // idle | loading-audio | playing | paused | finished
  const [activeIndex, setActiveIndex] = useState(-1);

  // Refs for playback coordination
  const playIdRef = useRef(0);
  const indexRef = useRef(0);
  const currentAudioRef = useRef(null);
  const gapTimerRef = useRef(null);
  const gapRemainingRef = useRef(0);
  const gapStartedAtRef = useRef(0);
  const pausedInGapRef = useRef(false);
  // Cache: index -> blob URL (persists across pause/resume, cleared on new script/voice)
  const audioCacheRef = useRef({});
  const selectedVoiceRef = useRef(selectedVoice);

  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
  }, [selectedVoice]);

  const segments = useMemo(() => {
    if (!script?.phases) return [];
    const flat = [];
    for (const phase of script.phases) {
      for (const seg of phase.segments || []) {
        flat.push({
          text: seg.text,
          pauseAfterMs: Math.max(0, Math.min(20000, Number(seg.pauseAfterMs) || 0)),
          phase: phase.name,
          phaseLabel: phase.label,
        });
      }
    }
    return flat;
  }, [script]);

  // Clear audio cache and revoke blob URLs
  const clearAudioCache = useCallback(() => {
    Object.values(audioCacheRef.current).forEach((url) => {
      if (typeof url === 'string') URL.revokeObjectURL(url);
    });
    audioCacheRef.current = {};
  }, []);

  // Clear on new script or voice change
  useEffect(() => {
    clearAudioCache();
  }, [script, selectedVoice, clearAudioCache]);

  useEffect(() => {
    return () => clearAudioCache();
  }, [clearAudioCache]);

  const fetchSegmentAudio = useCallback(async (index) => {
    if (audioCacheRef.current[index]) return audioCacheRef.current[index];
    const seg = segments[index];
    if (!seg) return null;
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: seg.text, voice: selectedVoiceRef.current }),
    });
    if (!res.ok) throw new Error('TTS fetch failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    audioCacheRef.current[index] = url;
    return url;
  }, [segments]);

  const clearGapTimer = useCallback(() => {
    if (gapTimerRef.current) {
      clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    playIdRef.current += 1;
    clearGapTimer();
    pausedInGapRef.current = false;
    gapRemainingRef.current = 0;
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    setStatus('idle');
    setActiveIndex(-1);
    indexRef.current = 0;
  }, [clearGapTimer]);

  const speakFrom = useCallback(async (i) => {
    const myPlay = playIdRef.current;
    if (i >= segments.length) {
      setStatus('finished');
      setActiveIndex(-1);
      indexRef.current = 0;
      return;
    }

    indexRef.current = i;
    setActiveIndex(i);

    // Prefetch next 3 segments silently in background
    for (let j = i + 1; j <= i + 3 && j < segments.length; j++) {
      fetchSegmentAudio(j).catch(() => {});
    }

    let url;
    try {
      url = await fetchSegmentAudio(i);
    } catch {
      if (myPlay !== playIdRef.current) return;
      // Skip failed segment
      speakFrom(i + 1);
      return;
    }

    if (myPlay !== playIdRef.current) return;

    const audio = new Audio(url);
    currentAudioRef.current = audio;

    audio.onended = () => {
      if (myPlay !== playIdRef.current) return;
      currentAudioRef.current = null;
      const pause = segments[i].pauseAfterMs;
      if (pause > 0) {
        gapRemainingRef.current = pause;
        gapStartedAtRef.current = Date.now();
        gapTimerRef.current = setTimeout(() => {
          gapTimerRef.current = null;
          gapRemainingRef.current = 0;
          if (myPlay !== playIdRef.current) return;
          speakFrom(i + 1);
        }, pause);
      } else {
        speakFrom(i + 1);
      }
    };

    audio.onerror = () => {
      if (myPlay !== playIdRef.current) return;
      speakFrom(i + 1);
    };

    try {
      await audio.play();
    } catch {
      if (myPlay !== playIdRef.current) return;
      speakFrom(i + 1);
    }
  }, [segments, fetchSegmentAudio]);

  const handlePlay = useCallback(async () => {
    if (!segments.length) return;
    stopPlayback();
    playIdRef.current += 1;
    const myPlay = playIdRef.current;
    setStatus('loading-audio');

    // Pre-fetch first segment before showing playing state
    try {
      await fetchSegmentAudio(0);
    } catch {
      if (myPlay !== playIdRef.current) return;
      setError('Could not load audio. Check your connection and try again.');
      setStatus('idle');
      return;
    }

    if (myPlay !== playIdRef.current) return;
    setStatus('playing');
    speakFrom(0);
  }, [segments, stopPlayback, fetchSegmentAudio, speakFrom]);

  const handlePause = useCallback(() => {
    if (status !== 'playing') return;
    setStatus('paused');

    if (currentAudioRef.current && !currentAudioRef.current.paused) {
      currentAudioRef.current.pause();
      pausedInGapRef.current = false;
    } else if (gapTimerRef.current) {
      const elapsed = Date.now() - gapStartedAtRef.current;
      gapRemainingRef.current = Math.max(0, gapRemainingRef.current - elapsed);
      clearGapTimer();
      pausedInGapRef.current = true;
    }
  }, [status, clearGapTimer]);

  const handleResume = useCallback(() => {
    if (status !== 'paused') return;
    setStatus('playing');

    if (currentAudioRef.current) {
      currentAudioRef.current.play().catch(() => speakFrom(indexRef.current));
      pausedInGapRef.current = false;
    } else if (pausedInGapRef.current && gapRemainingRef.current > 0) {
      gapStartedAtRef.current = Date.now();
      const remaining = gapRemainingRef.current;
      gapTimerRef.current = setTimeout(() => {
        gapTimerRef.current = null;
        gapRemainingRef.current = 0;
        speakFrom(indexRef.current + 1);
      }, remaining);
      pausedInGapRef.current = false;
    } else {
      speakFrom(indexRef.current);
    }
  }, [status, speakFrom]);

  useEffect(() => {
    return () => {
      clearGapTimer();
      if (currentAudioRef.current) currentAudioRef.current.pause();
    };
  }, [clearGapTimer]);

  const handleGenerate = useCallback(async (e) => {
    e.preventDefault();
    if (prompt.trim().length < 3) {
      setError('Describe what you would like the session to help with.');
      return;
    }
    setError('');
    setLoading(true);
    stopPlayback();
    setScript(null);

    try {
      const { script: generated } = await generateHypnosisScript({
        prompt: prompt.trim(),
        durationMinutes,
        tone,
      });
      setScript(generated);
    } catch (err) {
      setError(
        err?.response?.data?.message ||
          'Could not generate a session right now. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  }, [prompt, durationMinutes, tone, stopPlayback]);

  const isPlaying = status === 'playing';
  const isLoadingAudio = status === 'loading-audio';
  const progress =
    segments.length > 0 && activeIndex >= 0
      ? ((activeIndex + 1) / segments.length) * 100
      : status === 'finished' ? 100 : 0;
  const orbState = isPlaying ? 'orb-breathing' : 'orb-idle';

  return (
    <div className="hypno-root min-h-[calc(100vh-4rem)] w-full text-stone-100">
      <style>{ORB_STYLES}</style>

      <div className="mx-auto max-w-3xl px-5 py-16 sm:py-24">
        {/* Header + breathing orb */}
        <div className="flex flex-col items-center text-center">
          <div className={`hypno-orb ${orbState}`} aria-hidden="true">
            <div className="hypno-orb-core" />
          </div>
          <h1 className="mt-10 hypno-display text-4xl sm:text-5xl font-medium tracking-tight text-amber-50">
            Hypnotic Voice
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-indigo-200/70">
            Describe an intention. A guided hypnosis session is written for it and
            spoken aloud with deliberate timing, tone, and pause.
          </p>
        </div>

        {/* Generator form */}
        <form onSubmit={handleGenerate} className="mt-14 space-y-6">
          <div>
            <label htmlFor="hypno-prompt" className="hypno-label">
              Intention
            </label>
            <textarea
              id="hypno-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              maxLength={600}
              placeholder="e.g. deep, restful sleep — letting go of the day"
              className="hypno-input mt-2 w-full resize-none px-4 py-3 text-base"
            />
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <label className="hypno-label">Duration</label>
              <div className="mt-2 flex gap-2">
                {DURATIONS.map((d) => (
                  <button
                    type="button"
                    key={d}
                    onClick={() => setDurationMinutes(d)}
                    className={`hypno-chip flex-1 ${durationMinutes === d ? 'is-active' : ''}`}
                  >
                    {d} min
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="hypno-tone" className="hypno-label">
                Tone
              </label>
              <select
                id="hypno-tone"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                className="hypno-input mt-2 w-full px-4 py-3 text-base"
              >
                {TONES.map((t) => (
                  <option key={t.value} value={t.value} className="bg-indigo-950">
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Voice picker */}
          <div>
            <label className="hypno-label">Voice</label>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {VOICES.map((v) => (
                <button
                  type="button"
                  key={v.value}
                  onClick={() => setSelectedVoice(v.value)}
                  className={`hypno-voice-chip ${selectedVoice === v.value ? 'is-active' : ''}`}
                >
                  <span className="block font-medium">{v.label}</span>
                  <span className="block text-[0.65rem] opacity-60">{v.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="hypno-generate w-full px-5 py-3.5 text-sm font-medium tracking-wide disabled:opacity-50"
          >
            {loading ? 'Composing your session…' : 'Generate session'}
          </button>

          {error && (
            <p className="text-center text-sm text-rose-300/90" role="alert">
              {error}
            </p>
          )}
        </form>

        {/* Generated session */}
        {script && (
          <section className="mt-16">
            <div className="text-center">
              <h2 className="hypno-display text-2xl sm:text-3xl font-medium text-amber-50">
                {script.title}
              </h2>
              {script.intention && (
                <p className="mt-2 text-sm italic text-indigo-200/70">
                  {script.intention}
                </p>
              )}
              <p className="mt-1 text-xs uppercase tracking-[0.2em] text-indigo-300/50">
                {segments.length} passages
              </p>
            </div>

            {/* Playback controls */}
            {segments.length > 0 && (
              <div className="mt-8 space-y-4">
                <div className="hypno-progress">
                  <div
                    className="hypno-progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3">
                  {status === 'idle' || status === 'finished' ? (
                    <button onClick={handlePlay} className="hypno-control is-primary">
                      ▶ Begin
                    </button>
                  ) : isLoadingAudio ? (
                    <button disabled className="hypno-control opacity-60">
                      Loading audio…
                    </button>
                  ) : isPlaying ? (
                    <button onClick={handlePause} className="hypno-control">
                      ❙❙ Pause
                    </button>
                  ) : (
                    <button onClick={handleResume} className="hypno-control is-primary">
                      ▶ Resume
                    </button>
                  )}
                  <button
                    onClick={stopPlayback}
                    disabled={status === 'idle'}
                    className="hypno-control disabled:opacity-40"
                  >
                    ■ Stop
                  </button>
                </div>
              </div>
            )}

            {/* Script text */}
            <div className="mt-12 space-y-10">
              {script.phases?.map((phase, pi) => {
                let offset = 0;
                for (let k = 0; k < pi; k++) offset += script.phases[k].segments?.length || 0;
                return (
                  <div key={`${phase.name}-${pi}`}>
                    <h3 className="hypno-phase-label">{phase.label}</h3>
                    <div className="mt-3 space-y-2">
                      {phase.segments?.map((seg, si) => {
                        const flatIndex = offset + si;
                        const active = flatIndex === activeIndex;
                        return (
                          <p key={si} className={`hypno-line ${active ? 'is-active' : ''}`}>
                            {seg.text}
                          </p>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

const ORB_STYLES = `
  .hypno-root {
    background:
      radial-gradient(120% 80% at 50% -10%, #312e81 0%, #1e1b4b 38%, #0b0a1f 78%, #05040f 100%);
  }
  .hypno-display { font-family: "Cormorant Garamond", Georgia, serif; }

  .hypno-label {
    display: block;
    font-size: 0.7rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(165, 180, 252, 0.6);
  }

  .hypno-input {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(165, 180, 252, 0.18);
    border-radius: 0;
    color: #f5f3ff;
    outline: none;
    transition: border-color 0.2s ease, background 0.2s ease;
  }
  .hypno-input::placeholder { color: rgba(165, 180, 252, 0.4); }
  .hypno-input:focus {
    border-color: rgba(251, 191, 36, 0.6);
    background: rgba(255, 255, 255, 0.06);
  }

  .hypno-chip {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(165, 180, 252, 0.18);
    color: rgba(224, 231, 255, 0.8);
    padding: 0.6rem 0.5rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .hypno-chip:hover { border-color: rgba(165, 180, 252, 0.4); }
  .hypno-chip.is-active {
    border-color: rgba(251, 191, 36, 0.7);
    color: #fde68a;
    background: rgba(251, 191, 36, 0.08);
  }

  .hypno-voice-chip {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(165, 180, 252, 0.18);
    color: rgba(224, 231, 255, 0.8);
    padding: 0.55rem 0.4rem;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: center;
    line-height: 1.3;
  }
  .hypno-voice-chip:hover { border-color: rgba(165, 180, 252, 0.4); }
  .hypno-voice-chip.is-active {
    border-color: rgba(251, 191, 36, 0.7);
    color: #fde68a;
    background: rgba(251, 191, 36, 0.08);
  }

  .hypno-generate {
    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
    color: #1e1b4b;
    border: none;
    cursor: pointer;
    box-shadow: 0 0 30px rgba(245, 158, 11, 0.25);
    transition: box-shadow 0.3s ease, transform 0.1s ease;
  }
  .hypno-generate:hover:not(:disabled) { box-shadow: 0 0 45px rgba(245, 158, 11, 0.4); }
  .hypno-generate:active:not(:disabled) { transform: translateY(1px); }

  .hypno-control {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(165, 180, 252, 0.25);
    color: #e0e7ff;
    padding: 0.6rem 1.4rem;
    font-size: 0.85rem;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .hypno-control:hover:not(:disabled) { border-color: rgba(251, 191, 36, 0.5); }
  .hypno-control.is-primary {
    background: rgba(251, 191, 36, 0.12);
    border-color: rgba(251, 191, 36, 0.6);
    color: #fde68a;
  }

  .hypno-progress {
    height: 2px;
    width: 100%;
    background: rgba(165, 180, 252, 0.15);
    overflow: hidden;
  }
  .hypno-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #f59e0b, #fcd34d);
    transition: width 0.6s ease;
  }

  .hypno-phase-label {
    font-size: 0.7rem;
    letter-spacing: 0.25em;
    text-transform: uppercase;
    color: rgba(251, 191, 36, 0.55);
    border-bottom: 1px solid rgba(165, 180, 252, 0.12);
    padding-bottom: 0.5rem;
  }

  .hypno-line {
    font-family: "Cormorant Garamond", Georgia, serif;
    font-size: 1.35rem;
    line-height: 1.7;
    color: rgba(199, 210, 254, 0.5);
    transition: color 0.4s ease, text-shadow 0.4s ease;
  }
  .hypno-line.is-active {
    color: #fef3c7;
    text-shadow: 0 0 22px rgba(251, 191, 36, 0.35);
  }

  .hypno-orb {
    position: relative;
    width: 140px;
    height: 140px;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hypno-orb-core {
    width: 100%;
    height: 100%;
    border-radius: 9999px;
    background: radial-gradient(circle at 50% 45%, #fde68a 0%, #f59e0b 35%, #b45309 70%, rgba(180, 83, 9, 0) 100%);
    box-shadow: 0 0 60px rgba(245, 158, 11, 0.45), 0 0 120px rgba(245, 158, 11, 0.25);
  }
  .orb-idle .hypno-orb-core { animation: hypno-breathe 8s ease-in-out infinite; }
  .orb-breathing .hypno-orb-core { animation: hypno-breathe 5.5s ease-in-out infinite; }

  @keyframes hypno-breathe {
    0%, 100% { transform: scale(0.82); opacity: 0.75; }
    50% { transform: scale(1.08); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .hypno-orb-core { animation: none !important; }
    .hypno-progress-fill, .hypno-line { transition: none; }
  }
`;
