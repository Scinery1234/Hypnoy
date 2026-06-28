/**
 * Procedurally generated ambient soundscapes using the Web Audio API.
 *
 * Everything here is synthesised in the browser — there are no audio files,
 * no network requests, and no licensing or dead-link concerns. Each soundscape
 * is a small graph of oscillators / filtered noise modulated by slow LFOs to
 * produce an evolving, non-repeating background bed for a hypnosis session.
 */

export const SOUNDSCAPES = [
  { value: 'none', label: 'None', desc: 'Silence' },
  { value: 'deep-calm', label: 'Deep Calm', desc: 'Low warm drone' },
  { value: 'warm-hum', label: 'Warm Hum', desc: 'Soft chord pad' },
  { value: 'ocean', label: 'Ocean', desc: 'Rolling waves' },
  { value: 'rain', label: 'Rain', desc: 'Gentle rainfall' },
  { value: 'night', label: 'Night', desc: 'Airy shimmer' },
];

const VALID = new Set(SOUNDSCAPES.map((s) => s.value));

export function isValidSoundscape(value) {
  return VALID.has(value);
}

// A few seconds of looped noise, generated once per source.
function makeNoiseBuffer(ctx, kind) {
  const length = ctx.sampleRate * 4;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = Math.max(-1, Math.min(1, last * 3.5));
    }
  } else {
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

export class Soundscape {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.nodes = [];
    this.current = 'none';
    this.targetVolume = 0.35;
  }

  // Create / resume the AudioContext. Must be called from a user gesture
  // (browsers start the context suspended otherwise).
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  setVolume(v) {
    this.targetVolume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.master && this.current !== 'none') {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.targetVolume, now, 0.3);
    }
  }

  start(type) {
    if (!isValidSoundscape(type) || type === 'none') {
      this.stop();
      return;
    }
    if (!this.unlock()) return;
    if (type === this.current && this.nodes.length) return; // already running

    this._teardown(true);
    this.current = type;
    this._build(type);

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), now);
    this.master.gain.linearRampToValueAtTime(this.targetVolume, now + 2.5);
  }

  stop() {
    this.current = 'none';
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 1.2);
    this._teardown(false, 1400);
  }

  dispose() {
    this._teardown(true);
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
    }
  }

  _teardown(immediate, delayMs = 0) {
    const toStop = this.nodes;
    this.nodes = [];
    const kill = () =>
      toStop.forEach((n) => {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      });
    if (immediate || delayMs <= 0) kill();
    else setTimeout(kill, delayMs);
  }

  _build(type) {
    const ctx = this.ctx;
    const dest = this.master;

    const start = (n) => {
      this.nodes.push(n);
      if (typeof n.start === 'function') n.start();
      return n;
    };

    const osc = (freq, wave = 'sine') => {
      const o = ctx.createOscillator();
      o.type = wave;
      o.frequency.value = freq;
      return o;
    };

    const noise = (kind) => {
      const src = ctx.createBufferSource();
      src.buffer = makeNoiseBuffer(ctx, kind);
      src.loop = true;
      return src;
    };

    // Slowly modulate an AudioParam around `base` by ±`depth` at `rate` Hz.
    const modulate = (param, base, depth, rate) => {
      param.value = base;
      const lfo = osc(rate, 'sine');
      const g = ctx.createGain();
      g.gain.value = depth;
      lfo.connect(g);
      g.connect(param);
      start(lfo);
    };

    if (type === 'deep-calm') {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      [55, 55.3, 82.5].forEach((f, i) => start(osc(f, i === 2 ? 'sine' : 'triangle')).connect(filter));
      filter.connect(gain).connect(dest);
      modulate(gain.gain, 0.5, 0.18, 0.06); // breathing swell
    } else if (type === 'warm-hum') {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 700;
      const gain = ctx.createGain();
      [110, 110.4, 164.81, 220].forEach((f) => start(osc(f, 'triangle')).connect(filter));
      filter.connect(gain).connect(dest);
      modulate(gain.gain, 0.22, 0.08, 0.08);
    } else if (type === 'ocean') {
      const src = noise('brown');
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      src.connect(filter).connect(gain).connect(dest);
      start(src);
      modulate(filter.frequency, 600, 380, 0.09); // cutoff sweep = swell
      modulate(gain.gain, 0.45, 0.3, 0.09); // amplitude swell in sync
    } else if (type === 'rain') {
      const src = noise('white');
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      const gain = ctx.createGain();
      src.connect(hp).connect(lp).connect(gain).connect(dest);
      start(src);
      modulate(gain.gain, 0.18, 0.05, 0.5); // subtle intensity flicker
    } else if (type === 'night') {
      const src = noise('white');
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 0.6;
      const ng = ctx.createGain();
      ng.gain.value = 0.06;
      src.connect(bp).connect(ng).connect(dest);
      start(src);
      modulate(bp.frequency, 2400, 600, 0.05);

      const shimmer = ctx.createGain();
      [660, 990].forEach((f) => start(osc(f, 'sine')).connect(shimmer));
      shimmer.connect(dest);
      modulate(shimmer.gain, 0.025, 0.02, 0.12);
    }
  }
}
