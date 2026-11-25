import { loadSave } from './save';

/**
 * All sound in GOLIBAAZ is synthesized at runtime with WebAudio:
 * no audio files to load. SFX are short layered noise/oscillator bursts,
 * music is a small step sequencer whose layers fade with combat intensity.
 */

type NoiseOpts = {
  dur: number;
  gain: number;
  type?: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  attack?: number;
  when?: number;
  send?: number;
  bus?: AudioNode;
};

type ToneOpts = {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  dur: number;
  gain: number;
  attack?: number;
  when?: number;
  send?: number;
  bus?: AudioNode;
};

export type Sfx =
  | 'pistol' | 'revolver' | 'smg' | 'shotgun' | 'rifle' | 'twin' | 'sniper' | 'launcher' | 'minigun' | 'nail'
  | 'eshoot' | 'eshootBig' | 'hit' | 'crit' | 'kill' | 'hurt' | 'roll' | 'reload' | 'reloadDone' | 'perfect'
  | 'jam' | 'empty' | 'coin' | 'pickup' | 'heart' | 'explosion' | 'doorClose' | 'doorOpen' | 'click' | 'hover'
  | 'blank' | 'bossIntro' | 'bossDeath' | 'telegraph' | 'charge' | 'wallHit' | 'crate' | 'shield' | 'buy'
  | 'deny' | 'swap' | 'upgrade' | 'spawn' | 'clear' | 'death' | 'combo' | 'stairs' | 'lob' | 'step';

class AudioSys {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private reverb!: ConvolverNode;
  private reverbGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private last = new Map<string, number>();
  sfxVol = 0.8;
  musicVol = 0.5;

  // music state
  private layerDrone!: GainNode;
  private layerPluck!: GainNode;
  private layerBass!: GainNode;
  private layerDrums!: GainNode;
  private layerLead!: GainNode;
  private droneOsc: OscillatorNode[] = [];
  private musicTimer: number | null = null;
  private nextStep = 0;
  private step = 0;
  private intensity = 0;
  private root = 73.42; // D2
  private bassPattern = 0;
  private musicOn = false;
  private wantMusic = false;

  /** Must be called from a user gesture; safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch {
        this.ctx = null;
        return;
      }
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.wantMusic && !this.musicOn) this.startMusic();
  }

  private build(): void {
    const ctx = this.ctx!;
    const save = loadSave();
    this.sfxVol = save.sfxVol;
    this.musicVol = save.musicVol;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVol;
    this.sfx.connect(this.master);

    this.music = ctx.createGain();
    this.music.gain.value = this.musicVol * 0.55;
    this.music.connect(this.master);

    // White noise source buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Small room reverb from a generated impulse response
    const irLen = Math.floor(ctx.sampleRate * 1.3);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 400 ? i / 400 : 1);
      }
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.5;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    // Music layers
    const mk = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.music);
      return g;
    };
    this.layerDrone = mk();
    this.layerPluck = mk();
    this.layerBass = mk();
    this.layerDrums = mk();
    this.layerLead = mk();
  }

  setSfxVol(v: number): void {
    this.sfxVol = v;
    if (this.ctx) this.sfx.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setMusicVol(v: number): void {
    this.musicVol = v;
    if (this.ctx) this.music.gain.setTargetAtTime(v * 0.55, this.ctx.currentTime, 0.05);
  }

  // ---------------------------------------------------------------- primitives

  private noise(o: NoiseOpts): void {
    const ctx = this.ctx!;
    const t = o.when ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'lowpass';
    f.Q.value = o.q ?? 0.7;
    f.frequency.setValueAtTime(Math.max(20, o.f0), t);
    if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    const g = ctx.createGain();
    const a = o.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(o.bus ?? this.sfx);
    if (o.send) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      g.connect(s);
      s.connect(this.reverb);
    }
    src.start(t, Math.random() * 1.5);
    src.stop(t + o.dur + 0.05);
  }

  private tone(o: ToneOpts): void {
    const ctx = this.ctx!;
    const t = o.when ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(10, o.f0), t);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1), t + o.dur);
    const g = ctx.createGain();
    const a = o.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g);
    g.connect(o.bus ?? this.sfx);
    if (o.send) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      g.connect(s);
      s.connect(this.reverb);
    }
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  private gunshot(thump: number, body: number, crack: number, dur: number, lp: number, pitch = 1): void {
    const j = (0.94 + Math.random() * 0.12) * pitch;
    this.tone({ f0: 190 * j, f1: 42, dur: dur * 0.7, gain: thump });
    this.noise({ type: 'lowpass', f0: lp * j, f1: 320, dur, gain: body, send: 0.35 });
    this.noise({ type: 'highpass', f0: 2200 * j, dur: 0.045, gain: crack });
  }

  // ---------------------------------------------------------------- sfx

  play(name: Sfx, vol = 1): void {
    if (!this.ctx || this.ctx.state !== 'running' || this.sfxVol <= 0) return;
    const now = this.ctx.currentTime;
    const gap = MIN_GAP[name] ?? 0.02;
    const prev = this.last.get(name) ?? -1;
    if (now - prev < gap) return;
    this.last.set(name, now);
    const v = vol;
    const j = 0.95 + Math.random() * 0.1;

    switch (name) {
      case 'pistol': this.gunshot(0.5 * v, 0.42 * v, 0.3 * v, 0.16, 3800, 1.15); break;
      case 'revolver': this.gunshot(0.8 * v, 0.6 * v, 0.42 * v, 0.3, 3000, 0.85); break;
      case 'smg': this.gunshot(0.34 * v, 0.34 * v, 0.26 * v, 0.1, 4600, 1.35); break;
      case 'rifle': this.gunshot(0.48 * v, 0.44 * v, 0.34 * v, 0.15, 4000, 1.05); break;
      case 'minigun': this.gunshot(0.3 * v, 0.3 * v, 0.2 * v, 0.08, 3600, 1.2); break;
      case 'nail':
        this.noise({ type: 'bandpass', f0: 3200 * j, f1: 1400, q: 3, dur: 0.07, gain: 0.4 * v });
        this.tone({ type: 'square', f0: 620 * j, f1: 240, dur: 0.05, gain: 0.12 * v });
        break;
      case 'shotgun':
        this.gunshot(0.9 * v, 0.8 * v, 0.4 * v, 0.34, 2400, 0.75);
        this.noise({ type: 'lowpass', f0: 900, f1: 120, dur: 0.42, gain: 0.35 * v, send: 0.4 });
        break;
      case 'twin':
        this.gunshot(1.0 * v, 0.9 * v, 0.45 * v, 0.4, 2100, 0.65);
        this.noise({ type: 'lowpass', f0: 800, f1: 100, dur: 0.5, gain: 0.4 * v, send: 0.45 });
        break;
      case 'sniper':
        this.gunshot(0.9 * v, 0.7 * v, 0.6 * v, 0.5, 5200, 0.9);
        this.noise({ type: 'bandpass', f0: 1800, f1: 500, q: 1.2, dur: 0.7, gain: 0.2 * v, send: 0.7 });
        break;
      case 'launcher':
        this.tone({ f0: 260 * j, f1: 60, dur: 0.22, gain: 0.7 * v });
        this.noise({ type: 'lowpass', f0: 1200, f1: 200, dur: 0.16, gain: 0.4 * v });
        break;
      case 'eshoot':
        this.noise({ type: 'bandpass', f0: 1500 * j, f1: 500, q: 1.4, dur: 0.11, gain: 0.2 * v, send: 0.2 });
        this.tone({ f0: 240 * j, f1: 90, dur: 0.09, gain: 0.16 * v });
        break;
      case 'eshootBig':
        this.noise({ type: 'lowpass', f0: 1600 * j, f1: 260, dur: 0.24, gain: 0.34 * v, send: 0.3 });
        this.tone({ f0: 170 * j, f1: 55, dur: 0.2, gain: 0.34 * v });
        break;
      case 'hit':
        this.noise({ type: 'bandpass', f0: 2600 * j, q: 2, dur: 0.045, gain: 0.26 * v });
        this.tone({ type: 'triangle', f0: 520 * j, f1: 260, dur: 0.05, gain: 0.14 * v });
        break;
      case 'crit':
        this.noise({ type: 'highpass', f0: 3000, dur: 0.07, gain: 0.3 * v });
        this.tone({ type: 'triangle', f0: 1250, f1: 880, dur: 0.12, gain: 0.2 * v, send: 0.3 });
        break;
      case 'kill':
        this.noise({ type: 'lowpass', f0: 2400 * j, f1: 220, dur: 0.2, gain: 0.42 * v, send: 0.25 });
        this.tone({ type: 'triangle', f0: 300 * j, f1: 70, dur: 0.18, gain: 0.32 * v });
        break;
      case 'hurt':
        this.tone({ type: 'sawtooth', f0: 220, f1: 55, dur: 0.34, gain: 0.4 * v });
        this.noise({ type: 'lowpass', f0: 1800, f1: 160, dur: 0.3, gain: 0.5 * v, send: 0.3 });
        this.tone({ f0: 110, f1: 40, dur: 0.3, gain: 0.5 * v });
        break;
      case 'roll':
        this.noise({ type: 'bandpass', f0: 500, f1: 2000, q: 0.9, dur: 0.22, gain: 0.22 * v, attack: 0.06 });
        break;
      case 'reload':
        this.noise({ type: 'bandpass', f0: 2400, q: 4, dur: 0.035, gain: 0.3 * v });
        this.tone({ type: 'square', f0: 180, dur: 0.03, gain: 0.08 * v });
        break;
      case 'reloadDone':
        this.noise({ type: 'bandpass', f0: 1900, q: 3, dur: 0.04, gain: 0.34 * v });
        this.noise({ type: 'bandpass', f0: 3100, q: 4, dur: 0.04, gain: 0.34 * v, when: this.ctx.currentTime + 0.07 });
        this.tone({ type: 'square', f0: 140, dur: 0.04, gain: 0.1 * v, when: this.ctx.currentTime + 0.07 });
        break;
      case 'perfect':
        this.noise({ type: 'bandpass', f0: 3100, q: 4, dur: 0.04, gain: 0.34 * v });
        this.tone({ type: 'triangle', f0: 1318, dur: 0.16, gain: 0.2 * v, send: 0.4 });
        this.tone({ type: 'triangle', f0: 1976, dur: 0.22, gain: 0.16 * v, when: this.ctx.currentTime + 0.05, send: 0.4 });
        break;
      case 'jam':
        this.tone({ type: 'square', f0: 110, f1: 80, dur: 0.14, gain: 0.16 * v });
        this.noise({ type: 'bandpass', f0: 900, q: 3, dur: 0.08, gain: 0.25 * v });
        break;
      case 'empty':
        this.noise({ type: 'bandpass', f0: 3400, q: 6, dur: 0.025, gain: 0.25 * v });
        break;
      case 'coin':
        this.tone({ type: 'triangle', f0: 1568 * j, dur: 0.07, gain: 0.12 * v });
        this.tone({ type: 'triangle', f0: 2093 * j, dur: 0.14, gain: 0.12 * v, when: this.ctx.currentTime + 0.05, send: 0.2 });
        break;
      case 'pickup':
        [659, 880, 1175].forEach((f, i) =>
          this.tone({ type: 'triangle', f0: f, dur: 0.14, gain: 0.15 * v, when: this.ctx!.currentTime + i * 0.055, send: 0.3 }));
        break;
      case 'heart':
        [523, 659, 784, 1047].forEach((f, i) =>
          this.tone({ type: 'sine', f0: f, dur: 0.2, gain: 0.17 * v, when: this.ctx!.currentTime + i * 0.06, send: 0.4 }));
        break;
      case 'explosion':
        this.tone({ f0: 130, f1: 28, dur: 0.6, gain: 0.9 * v });
        this.noise({ type: 'lowpass', f0: 3200, f1: 90, dur: 0.75, gain: 0.85 * v, send: 0.5 });
        this.noise({ type: 'highpass', f0: 1800, dur: 0.08, gain: 0.4 * v });
        break;
      case 'doorClose':
        this.tone({ f0: 110, f1: 45, dur: 0.22, gain: 0.5 * v });
        this.noise({ type: 'bandpass', f0: 700, q: 2, dur: 0.16, gain: 0.4 * v, send: 0.5 });
        this.tone({ type: 'square', f0: 310, f1: 290, dur: 0.12, gain: 0.05 * v, send: 0.6 });
        break;
      case 'doorOpen':
        this.noise({ type: 'bandpass', f0: 400, f1: 1300, q: 2, dur: 0.24, gain: 0.3 * v, attack: 0.05, send: 0.4 });
        this.tone({ f0: 70, f1: 110, dur: 0.2, gain: 0.3 * v });
        break;
      case 'click':
        this.noise({ type: 'bandpass', f0: 2600, q: 5, dur: 0.03, gain: 0.3 * v });
        this.tone({ type: 'triangle', f0: 660, dur: 0.06, gain: 0.12 * v });
        break;
      case 'hover':
        this.tone({ type: 'triangle', f0: 880, dur: 0.035, gain: 0.05 * v });
        break;
      case 'blank':
        this.noise({ type: 'bandpass', f0: 300, f1: 5000, q: 0.8, dur: 0.3, gain: 0.5 * v, attack: 0.12 });
        this.tone({ f0: 90, f1: 30, dur: 0.8, gain: 0.8 * v, when: this.ctx.currentTime + 0.05 });
        this.noise({ type: 'lowpass', f0: 5000, f1: 120, dur: 0.9, gain: 0.5 * v, when: this.ctx.currentTime + 0.05, send: 0.7 });
        break;
      case 'bossIntro':
        this.tone({ type: 'sawtooth', f0: 55, f1: 36, dur: 1.6, gain: 0.4 * v, attack: 0.3, send: 0.6 });
        this.tone({ type: 'sawtooth', f0: 82.5, f1: 54, dur: 1.6, gain: 0.25 * v, attack: 0.3, send: 0.6 });
        this.noise({ type: 'lowpass', f0: 200, f1: 900, dur: 1.4, gain: 0.3 * v, attack: 0.6, send: 0.6 });
        break;
      case 'bossDeath':
        this.tone({ f0: 160, f1: 22, dur: 1.6, gain: 1.0 * v });
        this.noise({ type: 'lowpass', f0: 5000, f1: 60, dur: 1.8, gain: 0.9 * v, send: 0.8 });
        break;
      case 'telegraph':
        this.tone({ type: 'triangle', f0: 740, f1: 990, dur: 0.12, gain: 0.07 * v });
        break;
      case 'charge':
        this.noise({ type: 'bandpass', f0: 300, f1: 1400, q: 1.2, dur: 0.4, gain: 0.34 * v, attack: 0.15 });
        this.tone({ type: 'sawtooth', f0: 70, f1: 140, dur: 0.4, gain: 0.2 * v, attack: 0.1 });
        break;
      case 'wallHit':
        this.tone({ f0: 100, f1: 36, dur: 0.3, gain: 0.7 * v });
        this.noise({ type: 'lowpass', f0: 1500, f1: 150, dur: 0.3, gain: 0.5 * v, send: 0.5 });
        break;
      case 'crate':
        this.noise({ type: 'bandpass', f0: 900 * j, f1: 300, q: 1.2, dur: 0.16, gain: 0.45 * v });
        this.tone({ type: 'triangle', f0: 190 * j, f1: 90, dur: 0.1, gain: 0.2 * v });
        break;
      case 'shield':
        this.tone({ type: 'square', f0: 1400 * j, f1: 900, dur: 0.06, gain: 0.08 * v, send: 0.4 });
        this.noise({ type: 'highpass', f0: 4000, dur: 0.04, gain: 0.2 * v });
        break;
      case 'buy':
        [784, 988, 1319].forEach((f, i) =>
          this.tone({ type: 'triangle', f0: f, dur: 0.16, gain: 0.16 * v, when: this.ctx!.currentTime + i * 0.07, send: 0.3 }));
        break;
      case 'deny':
        this.tone({ type: 'square', f0: 150, dur: 0.09, gain: 0.12 * v });
        this.tone({ type: 'square', f0: 120, dur: 0.14, gain: 0.12 * v, when: this.ctx.currentTime + 0.1 });
        break;
      case 'swap':
        this.noise({ type: 'bandpass', f0: 1500, f1: 2600, q: 3, dur: 0.07, gain: 0.25 * v });
        break;
      case 'upgrade':
        [392, 523, 659, 784, 1047].forEach((f, i) =>
          this.tone({ type: 'triangle', f0: f, dur: 0.3, gain: 0.16 * v, when: this.ctx!.currentTime + i * 0.07, send: 0.5 }));
        break;
      case 'spawn':
        this.noise({ type: 'bandpass', f0: 250, f1: 900, q: 1.5, dur: 0.2, gain: 0.16 * v, attack: 0.08 });
        break;
      case 'clear':
        [587, 740, 880].forEach((f, i) =>
          this.tone({ type: 'triangle', f0: f, dur: 0.4, gain: 0.13 * v, when: this.ctx!.currentTime + i * 0.09, send: 0.6 }));
        break;
      case 'death':
        this.tone({ type: 'sawtooth', f0: 196, f1: 30, dur: 1.4, gain: 0.5 * v, send: 0.6 });
        this.noise({ type: 'lowpass', f0: 1400, f1: 60, dur: 1.4, gain: 0.5 * v, send: 0.6 });
        break;
      case 'combo':
        this.tone({ type: 'triangle', f0: 990 * j, f1: 1320, dur: 0.09, gain: 0.1 * v, send: 0.2 });
        break;
      case 'stairs':
        [220, 196, 165, 147].forEach((f, i) =>
          this.tone({ type: 'triangle', f0: f, dur: 0.3, gain: 0.2 * v, when: this.ctx!.currentTime + i * 0.12, send: 0.6 }));
        break;
      case 'lob':
        this.tone({ f0: 320 * j, f1: 120, dur: 0.16, gain: 0.3 * v });
        this.noise({ type: 'lowpass', f0: 900, dur: 0.1, gain: 0.2 * v });
        break;
      case 'step':
        this.noise({ type: 'lowpass', f0: 500 * j, dur: 0.05, gain: 0.07 * v });
        break;
    }
  }

  // ---------------------------------------------------------------- music

  startMusic(): void {
    // If audio isn't unlocked yet, remember the request and start on the first user gesture.
    this.wantMusic = true;
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    const ctx = this.ctx;

    // Low drone: two detuned saws through a dark filter
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 210;
    f.Q.value = 0.5;
    f.connect(this.layerDrone);
    for (const det of [-6, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = this.root;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = 0.16;
      o.connect(g);
      g.connect(f);
      o.start();
      this.droneOsc.push(o);
    }
    this.nextStep = ctx.currentTime + 0.1;
    this.step = 0;
    this.applyIntensity(1.5);
    this.musicTimer = window.setInterval(() => this.schedule(), 40);
  }

  stopMusic(): void {
    if (!this.musicOn) return;
    this.musicOn = false;
    if (this.musicTimer !== null) window.clearInterval(this.musicTimer);
    this.musicTimer = null;
    for (const o of this.droneOsc) {
      try { o.stop(); } catch { /* already stopped */ }
    }
    this.droneOsc = [];
  }

  /** 0 = calm exploration, 1 = combat, 2 = boss. */
  setIntensity(i: number): void {
    if (i === this.intensity) return;
    this.intensity = i;
    this.applyIntensity(i === 0 ? 2.0 : 0.5);
  }

  setFloor(floorIndex: number): void {
    const roots = [73.42, 65.41, 82.41, 61.74];
    this.root = roots[floorIndex % roots.length];
    if (this.ctx) {
      for (const o of this.droneOsc) o.frequency.setTargetAtTime(this.root, this.ctx.currentTime, 0.8);
    }
  }

  private applyIntensity(tc: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const i = this.intensity;
    this.layerDrone.gain.setTargetAtTime(i === 0 ? 0.9 : 0.6, t, tc);
    this.layerPluck.gain.setTargetAtTime(i === 0 ? 0.8 : 0.35, t, tc);
    this.layerBass.gain.setTargetAtTime(i >= 1 ? 0.8 : 0, t, tc);
    this.layerDrums.gain.setTargetAtTime(i >= 1 ? 0.85 : 0, t, tc);
    this.layerLead.gain.setTargetAtTime(i >= 2 ? 0.6 : 0, t, tc);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const bpm = this.intensity >= 2 ? 132 : 112;
    const stepDur = 60 / bpm / 4;
    // If the tab was throttled, don't try to catch up on a backlog of steps.
    if (this.nextStep < ctx.currentTime - 0.2) this.nextStep = ctx.currentTime + 0.05;
    while (this.nextStep < ctx.currentTime + 0.14) {
      this.playStep(this.step, this.nextStep, stepDur);
      this.step++;
      this.nextStep += stepDur;
    }
  }

  private playStep(step: number, t: number, sd: number): void {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const boss = this.intensity >= 2;
    const r = this.root;
    const PENTA = [0, 3, 5, 7, 10, 12, 15];
    const semi = (n: number) => Math.pow(2, n / 12);

    if (s === 0 && bar % 4 === 0) this.bassPattern = Math.floor(Math.random() * BASS.length);

    // Sparse plucks (always scheduled; the layer gain decides audibility)
    if ((s === 0 || s === 6 || s === 10) && Math.random() < 0.55) {
      const n = PENTA[Math.floor(Math.random() * PENTA.length)];
      const f = r * 4 * semi(n);
      this.tone({ type: 'triangle', f0: f, dur: 0.9, gain: 0.16, when: t, send: 0.8, bus: this.layerPluck });
      this.tone({ type: 'sine', f0: f * 2, dur: 0.3, gain: 0.04, when: t, send: 0.6, bus: this.layerPluck });
    }

    if (this.intensity >= 1) {
      // Kick
      const kick = boss ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 11];
      if (kick.includes(s)) {
        this.tone({ f0: 135, f1: 38, dur: 0.22, gain: 0.85, when: t, bus: this.layerDrums });
        this.noise({ type: 'lowpass', f0: 900, dur: 0.03, gain: 0.25, when: t, bus: this.layerDrums });
      }
      // Snare
      if (s === 4 || s === 12) {
        this.noise({ type: 'bandpass', f0: 1700, q: 0.8, dur: 0.16, gain: 0.42, when: t, send: 0.3, bus: this.layerDrums });
        this.tone({ type: 'triangle', f0: 210, f1: 150, dur: 0.09, gain: 0.25, when: t, bus: this.layerDrums });
      }
      // Low tom fill at the end of every 4th bar
      if (bar % 4 === 3 && s >= 12) {
        this.tone({ f0: 150 - (s - 12) * 16, f1: 60, dur: 0.2, gain: 0.5, when: t, send: 0.3, bus: this.layerDrums });
      }
      // Hats
      if (boss || s % 2 === 0) {
        const acc = s % 4 === 2 ? 0.16 : 0.08;
        this.noise({ type: 'highpass', f0: 7000, dur: 0.035, gain: acc, when: t, bus: this.layerDrums });
      }
      // Bass ostinato on 8th notes
      if (s % 2 === 0) {
        const n = BASS[this.bassPattern][s / 2];
        if (n !== null) {
          const f = r * semi(n);
          this.tone({ type: 'sawtooth', f0: f, dur: sd * 1.8, gain: 0.22, when: t, bus: this.layerBass });
          this.tone({ type: 'sine', f0: f, dur: sd * 1.9, gain: 0.34, when: t, bus: this.layerBass });
        }
      }
    }

    if (boss && (s === 0 || s === 3 || s === 8 || s === 11) && bar % 2 === 0) {
      const n = [12, 15, 10, 7][[0, 3, 8, 11].indexOf(s)];
      this.tone({ type: 'sawtooth', f0: r * 2 * semi(n), dur: 0.22, gain: 0.1, when: t, send: 0.5, bus: this.layerLead });
    }
  }
}

const BASS: (number | null)[][] = [
  [0, 0, 3, 0, 5, 0, 3, null],
  [0, null, 0, 7, 0, null, 5, 3],
  [0, 0, 10, 0, 7, 0, 5, 3],
  [0, 12, 0, 10, 0, 7, 5, null],
];

const MIN_GAP: Partial<Record<Sfx, number>> = {
  hit: 0.035,
  kill: 0.03,
  coin: 0.04,
  eshoot: 0.05,
  eshootBig: 0.08,
  explosion: 0.06,
  shield: 0.05,
  crate: 0.04,
  minigun: 0.03,
  smg: 0.03,
  telegraph: 0.08,
  spawn: 0.1,
  hover: 0.03,
  step: 0.1,
};

export const audio = new AudioSys();
