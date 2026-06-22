import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateHypnosisScript } from '@/api/hypnosis';

// Tuned for a slow, low, hypnotic delivery.
const DEFAULT_RATE = 0.72;
const VOICE_PITCH = 0.88;

const DURATIONS = [5, 10, 20];
const TONES = [
  { value: 'gentle', label: 'Gentle' },
  { value: 'authoritative', label: 'Authoritative' },
  { value: 'warm', label: 'Warm' },
];

const speechSupported =
  typeof window !== 'undefined' && 'speechSynthesis' in window;

// Estimate spoken time so we can show a duration and drive the progress bar.
function estimateSegmentMs(text, rate) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // ~110 wpm at rate 1.0 for slow delivery; scales inversely with rate.
  const wordsPerMs = (110 / 60 / 1000) * rate;
  return words / Math.max(wordsPerMs, 0.0001);
}

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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [script, setScript] = useState(null);

  const [voices, setVoices] = useState([]);
  const [voiceURI, setVoiceURI] = useState('');
  const [rate, setRate] = useState(DEFAULT_RATE);

  const [status, setStatus] = useState('idle'); // idle | playing | paused | finished
  const [activeIndex, setActiveIndex] = useState(-1);

  // Playback state kept in refs so async callbacks never read stale values.
  const indexRef = useRef(0);
  const pausedRef = useRef(false);
  const gapTimerRef = useRef(null);
  const gapRemainingRef = useRef(0);
  const gapStartedAtRef = useRef(0);
  const rateRef = useRef(rate);
  const voiceRef = useRef(null);
  // Bumped on every stop/play so stale utterance callbacks can be ignored.
  const playIdRef = useRef(0);

  // Flatten phases into a single ordered list of segments with phase metadata.
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

  const estimatedTotalMs = useMemo(() => {
    return segments.reduce(
      (acc, s) => acc + estimateSegmentMs(s.text, rate) + s.pauseAfterMs,
      0
    );
  }, [segments, rate]);

  // --- Voice loading -------------------------------------------------------
  useEffect(() => {
    if (!speechSupported) return undefined;

    const loadVoices = () => {
      const list = window.speechSynthesis.getVoices();
      if (!list.length) return;
      setVoices(list);
      setVoiceURI((current) => {
        if (current && list.some((v) => v.voiceURI === current)) return current;
        // Prefer an English voice; nudge toward calmer-sounding defaults.
        const preferred =
          list.find((v) => /en[-_]GB/i.test(v.lang) && /female|samantha|sonia|libby/i.test(v.name)) ||
          list.find((v) => /^en/i.test(v.lang)) ||
          list[0];
        return preferred?.voiceURI || '';
      });
    };

    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, []);

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  useEffect(() => {
    voiceRef.current = voices.find((v) => v.voiceURI === voiceURI) || null;
  }, [voiceURI, voices]);

  const clearGapTimer = useCallback(() => {
    if (gapTimerRef.current) {
      clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    playIdRef.current += 1; // invalidate any in-flight utterance callbacks
    clearGapTimer();
    pausedRef.current = false;
    gapRemainingRef.current = 0;
    if (speechSupported) window.speechSynthesis.cancel();
    setStatus('idle');
    setActiveIndex(-1);
    indexRef.current = 0;
  }, [clearGapTimer]);

  // Speak segment at `i`, then hold its pause, then advance.
  const speakFrom = useCallback(
    (i) => {
      const myPlay = playIdRef.current;
      if (i >= segments.length) {
        setStatus('finished');
        setActiveIndex(-1);
        indexRef.current = 0;
        return;
      }
      indexRef.current = i;
      setActiveIndex(i);

      const seg = segments[i];
      const utterance = new SpeechSynthesisUtterance(seg.text);
      utterance.rate = rateRef.current;
      utterance.pitch = VOICE_PITCH;
      utterance.volume = 1;
      if (voiceRef.current) {
        utterance.voice = voiceRef.current;
        utterance.lang = voiceRef.current.lang;
      }

      const startGap = () => {
        if (myPlay !== playIdRef.current) return; // superseded by stop/replay
        gapRemainingRef.current = seg.pauseAfterMs;
        if (pausedRef.current) return; // resume will restart the gap
        gapStartedAtRef.current = Date.now();
        gapTimerRef.current = setTimeout(() => {
          gapTimerRef.current = null;
          gapRemainingRef.current = 0;
          if (myPlay !== playIdRef.current) return;
          speakFrom(i + 1);
        }, seg.pauseAfterMs);
      };

      utterance.onend = startGap;
      utterance.onerror = startGap; // don't get stuck on a single failed line

      window.speechSynthesis.speak(utterance);
    },
    [segments]
  );

  const handlePlay = useCallback(() => {
    if (!speechSupported || !segments.length) return;
    playIdRef.current += 1;
    window.speechSynthesis.cancel();
    clearGapTimer();
    pausedRef.current = false;
    setStatus('playing');
    speakFrom(0);
  }, [segments.length, speakFrom, clearGapTimer]);

  const handlePause = useCallback(() => {
    if (status !== 'playing') return;
    pausedRef.current = true;
    setStatus('paused');

    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      // Mid-utterance: the browser can pause/resume the active line.
      window.speechSynthesis.pause();
    }
    if (gapTimerRef.current) {
      // Mid-gap: stop the timer and remember the remaining silence.
      const elapsed = Date.now() - gapStartedAtRef.current;
      gapRemainingRef.current = Math.max(0, gapRemainingRef.current - elapsed);
      clearGapTimer();
    }
  }, [status, clearGapTimer]);

  const handleResume = useCallback(() => {
    if (status !== 'paused') return;
    pausedRef.current = false;
    setStatus('playing');

    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    } else if (gapRemainingRef.current > 0) {
      // We were paused during a silence gap — resume the remaining time.
      gapStartedAtRef.current = Date.now();
      const remaining = gapRemainingRef.current;
      gapTimerRef.current = setTimeout(() => {
        gapTimerRef.current = null;
        gapRemainingRef.current = 0;
        speakFrom(indexRef.current + 1);
      }, remaining);
    } else {
      // Edge case: nothing in flight — restart from the current line.
      speakFrom(indexRef.current);
    }
  }, [status, speakFrom]);

  // Tear down speech on unmount or when a new script replaces the old one.
  useEffect(() => {
    return () => {
      clearGapTimer();
      if (speechSupported) window.speechSynthesis.cancel();
    };
  }, [clearGapTimer]);

  const handleGenerate = useCallback(
    async (e) => {
      e.preventDefault();
      if (prompt.trim().length < 3) {
        setError('Describe what you would like the session to help with.');
        return;
      }
      setError('');
      setLoading(true);
      stopPlayback();
      setScript(null);
      setStatus('idle');

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
    },
    [prompt, durationMinutes, tone, stopPlayback]
  );

  const isPlaying = status === 'playing';
  const progress =
    segments.length > 0 && activeIndex >= 0
      ? ((activeIndex + 1) / segments.length) * 100
      : status === 'finished'
        ? 100
        : 0;

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
          {!speechSupported && (
            <p className="text-center text-sm text-amber-300/80">
              Your browser does not support speech synthesis, so playback is
              unavailable. You can still read the generated script.
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
                {segments.length} passages · ~{formatClock(estimatedTotalMs)}
              </p>
            </div>

            {/* Playback controls */}
            {speechSupported && segments.length > 0 && (
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

                {/* Voice + pace */}
                <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                  <div>
                    <label htmlFor="hypno-voice" className="hypno-label">
                      Voice
                    </label>
                    <select
                      id="hypno-voice"
                      value={voiceURI}
                      onChange={(e) => setVoiceURI(e.target.value)}
                      className="hypno-input mt-2 w-full px-3 py-2 text-sm"
                    >
                      {voices.map((v) => (
                        <option key={v.voiceURI} value={v.voiceURI} className="bg-indigo-950">
                          {v.name} ({v.lang})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="hypno-rate" className="hypno-label">
                      Pace · {rate.toFixed(2)}×
                    </label>
                    <input
                      id="hypno-rate"
                      type="range"
                      min="0.5"
                      max="1"
                      step="0.01"
                      value={rate}
                      onChange={(e) => setRate(Number(e.target.value))}
                      className="hypno-range mt-4 w-full"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Script text */}
            <div className="mt-12 space-y-10">
              {script.phases?.map((phase, pi) => {
                // Compute the flat offset for this phase to map highlighting.
                let offset = 0;
                for (let k = 0; k < pi; k += 1) {
                  offset += script.phases[k].segments?.length || 0;
                }
                return (
                  <div key={`${phase.name}-${pi}`}>
                    <h3 className="hypno-phase-label">{phase.label}</h3>
                    <div className="mt-3 space-y-2">
                      {phase.segments?.map((seg, si) => {
                        const flatIndex = offset + si;
                        const active = flatIndex === activeIndex;
                        return (
                          <p
                            key={si}
                            className={`hypno-line ${active ? 'is-active' : ''}`}
                          >
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

  .hypno-generate {
    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
    color: #1e1b4b;
    border: none;
    cursor: pointer;
    box-shadow: 0 0 30px rgba(245, 158, 11, 0.25);
    transition: box-shadow 0.3s ease, transform 0.1s ease;
  }
  .hypno-generate:hover:not(:disabled) {
    box-shadow: 0 0 45px rgba(245, 158, 11, 0.4);
  }
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

  .hypno-range { accent-color: #f59e0b; }

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

  /* The signature breathing orb */
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
