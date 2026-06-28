import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateHypnosisScript, refineHypnosisScript } from '@/api/hypnosis';
import { SOUNDSCAPES, Soundscape } from '@/lib/soundscape';

const DURATION_PRESETS = [3, 5, 10, 20, 30, 45];
const MIN_DURATION = 1;
const MAX_DURATION = 60;
const REFINE_SUGGESTIONS = [
  'Make it calmer and slower',
  'Add longer pauses',
  'More vivid imagery',
  'Focus more on the intention',
  'Make it a little shorter',
];
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
  const [soundscape, setSoundscape] = useState('deep-calm');
  const [musicVolume, setMusicVolume] = useState(0.35);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [script, setScript] = useState(null);

  // Chat-based refinement of the generated script (before playback).
  const [refineInput, setRefineInput] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState('');
  const [refineHistory, setRefineHistory] = useState([]);

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
  // Web Audio background soundscape (created once, lazily unlocked on first play).
  const soundscapeRef = useRef(null);

  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
  }, [selectedVoice]);

  useEffect(() => {
    soundscapeRef.current = new Soundscape();
    soundscapeRef.current.setVolume(musicVolume);
    return () => {
      soundscapeRef.current?.dispose();
      soundscapeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the background soundscape from playback status + selection.
  useEffect(() => {
    const ss = soundscapeRef.current;
    if (!ss) return;
    if (status === 'playing') {
      ss.start(soundscape);
    } else if (status === 'idle' || status === 'finished') {
      ss.stop();
    }
    // 'paused' intentionally leaves the ambient bed playing softly.
  }, [status, soundscape]);

  useEffect(() => {
    soundscapeRef.current?.setVolume(musicVolume);
  }, [musicVolume]);

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
    // Unlock the audio context synchronously inside the user gesture so the
    // background soundscape is allowed to start.
    soundscapeRef.current?.unlock();
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
    setRefineHistory([]);
    setRefineError('');
    setRefineInput('');

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

  const handleRefine = useCallback(
    async (rawInstruction) => {
      const instruction = (rawInstruction ?? refineInput).trim();
      if (!script || refining) return;
      if (instruction.length < 2) {
        setRefineError('Type how you would like to adjust the session.');
        return;
      }
      setRefineError('');
      setRefining(true);
      // Editing the script invalidates any in-progress playback / cached audio.
      stopPlayback();

      try {
        const { script: revised } = await refineHypnosisScript({
          baseScript: script,
          editInstruction: instruction,
          tone,
          durationMinutes: script.durationMinutes || durationMinutes,
        });
        setScript(revised);
        setRefineHistory((h) => [...h, instruction]);
        setRefineInput('');
      } catch (err) {
        setRefineError(
          err?.response?.data?.message ||
            'Could not apply that change. Please try rephrasing.'
        );
      } finally {
        setRefining(false);
      }
    },
    [refineInput, script, refining, tone, durationMinutes, stopPlayback]
  );

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
              <label className="hypno-label flex items-center justify-between">
                <span>Duration</span>
                <span className="hypno-duration-value">{durationMinutes} min</span>
              </label>
              <div className="mt-2 grid grid-cols-6 gap-2">
                {DURATION_PRESETS.map((d) => (
                  <button
                    type="button"
                    key={d}
                    onClick={() => setDurationMinutes(d)}
                    className={`hypno-chip ${durationMinutes === d ? 'is-active' : ''}`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={MIN_DURATION}
                max={MAX_DURATION}
                step={1}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="hypno-range mt-3 w-full"
                aria-label="Session length in minutes"
              />
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

          {/* Background soundscape picker */}
          <div>
            <label className="hypno-label">Background sound</label>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {SOUNDSCAPES.map((s) => (
                <button
                  type="button"
                  key={s.value}
                  onClick={() => setSoundscape(s.value)}
                  className={`hypno-voice-chip ${soundscape === s.value ? 'is-active' : ''}`}
                >
                  <span className="block font-medium">{s.label}</span>
                  <span className="block text-[0.65rem] opacity-60">{s.desc}</span>
                </button>
              ))}
            </div>
            {soundscape !== 'none' && (
              <div className="mt-3 flex items-center gap-3">
                <span className="hypno-volume-label">Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={musicVolume}
                  onChange={(e) => setMusicVolume(Number(e.target.value))}
                  className="hypno-range flex-1"
                  aria-label="Background music volume"
                />
              </div>
            )}
            <p className="mt-2 text-[0.7rem] text-indigo-300/40">
              Ambient sound is generated live in your browser — no downloads, fully royalty-free.
            </p>
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

            {/* Refine the script with chat-style edits before pressing play */}
            <div className="hypno-refine mt-8">
              <p className="hypno-refine-title">Adjust before you begin</p>
              <p className="hypno-refine-hint">
                Reshape the session in plain language — its focus, pacing, length, or
                imagery — then press Begin when it feels right.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {REFINE_SUGGESTIONS.map((s) => (
                  <button
                    type="button"
                    key={s}
                    disabled={refining}
                    onClick={() => handleRefine(s)}
                    className="hypno-suggest disabled:opacity-40"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRefine();
                }}
                className="mt-3 flex flex-col gap-2 sm:flex-row"
              >
                <input
                  type="text"
                  value={refineInput}
                  onChange={(e) => setRefineInput(e.target.value)}
                  maxLength={400}
                  disabled={refining}
                  placeholder="e.g. add more about feeling confident and calm"
                  className="hypno-input flex-1 px-4 py-2.5 text-sm"
                />
                <button
                  type="submit"
                  disabled={refining || refineInput.trim().length < 2}
                  className="hypno-control is-primary whitespace-nowrap disabled:opacity-40"
                >
                  {refining ? 'Revising…' : 'Apply edit'}
                </button>
              </form>
              {refineError && (
                <p className="mt-2 text-sm text-rose-300/90" role="alert">
                  {refineError}
                </p>
              )}
              {refineHistory.length > 0 && (
                <ul className="hypno-refine-log mt-3">
                  {refineHistory.map((h, i) => (
                    <li key={i}>✓ {h}</li>
                  ))}
                </ul>
              )}
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
            <div className={`mt-12 space-y-10 transition-opacity ${refining ? 'opacity-40' : ''}`}>
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

  .hypno-duration-value {
    letter-spacing: 0.05em;
    color: #fde68a;
    text-transform: none;
    font-variant-numeric: tabular-nums;
  }

  .hypno-volume-label {
    font-size: 0.7rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(165, 180, 252, 0.6);
    white-space: nowrap;
  }

  .hypno-range {
    -webkit-appearance: none;
    appearance: none;
    height: 2px;
    background: rgba(165, 180, 252, 0.25);
    border-radius: 9999px;
    outline: none;
    cursor: pointer;
  }
  .hypno-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    background: #fcd34d;
    box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
    cursor: pointer;
  }
  .hypno-range::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 9999px;
    background: #fcd34d;
    box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
    cursor: pointer;
  }

  .hypno-refine {
    border: 1px solid rgba(165, 180, 252, 0.16);
    background: rgba(255, 255, 255, 0.03);
    padding: 1.1rem 1.2rem;
  }
  .hypno-refine-title {
    font-size: 0.7rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(251, 191, 36, 0.7);
  }
  .hypno-refine-hint {
    margin-top: 0.4rem;
    font-size: 0.85rem;
    line-height: 1.5;
    color: rgba(199, 210, 254, 0.6);
  }
  .hypno-suggest {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(165, 180, 252, 0.2);
    color: rgba(224, 231, 255, 0.85);
    padding: 0.35rem 0.7rem;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .hypno-suggest:hover:not(:disabled) {
    border-color: rgba(251, 191, 36, 0.5);
    color: #fde68a;
  }
  .hypno-refine-log {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 0.78rem;
    color: rgba(134, 239, 172, 0.7);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
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
