/* Synthesized sound. No audio files -- a few oscillators and a noise buffer get
   further than a handful of short WAVs would, and cost nothing against the
   size cap. Audio contexts start suspended until a user gesture resumes them. */
TA = globalThis.TA || {};

TA.audio = (function () {
  var ctx = null, master = null, noiseBuf = null, engine = null;
  var muted = false, ready = false;

  function init() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    var len = Math.floor(ctx.sampleRate * 0.7);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    ready = true;
  }

  function resume() {
    init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function noise(dur, gain, type, freq, q) {
    if (!ready || muted) return;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q || 1;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function tone(type, f0, f1, dur, gain, delay) {
    if (!ready || muted) return;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    var t = ctx.currentTime + (delay || 0);
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  var lastFire = 0;

  return {
    resume: resume,
    setMuted: function (m) { muted = m; if (master) master.gain.value = m ? 0 : 0.5; },
    isMuted: function () { return muted; },

    fire: function (far) {
      var now = performance.now();
      if (now - lastFire < 35) return;      // cap the pile-up during a 8-way brawl
      lastFire = now;
      noise(0.09, far ? 0.12 : 0.3, 'bandpass', far ? 900 : 1500, 0.8);
      tone('square', far ? 130 : 200, 40, 0.1, far ? 0.05 : 0.13);
    },
    hit: function (mine) {
      noise(0.07, mine ? 0.28 : 0.14, 'bandpass', mine ? 2600 : 1200, 2.2);
      tone('triangle', mine ? 620 : 300, 180, 0.09, 0.07);
    },
    explode: function (far) {
      noise(far ? 0.5 : 0.85, far ? 0.18 : 0.42, 'lowpass', far ? 700 : 1100, 0.6);
      tone('sine', far ? 90 : 130, 28, 0.5, far ? 0.08 : 0.2);
    },
    spark: function () { noise(0.05, 0.07, 'highpass', 3200, 1); },
    ui: function () { tone('triangle', 520, 700, 0.06, 0.05); },
    start: function () { tone('sawtooth', 160, 480, 0.28, 0.07); tone('triangle', 320, 900, 0.3, 0.05, 0.06); },
    over: function (win) {
      tone('triangle', win ? 420 : 300, win ? 840 : 120, 0.5, 0.09);
      if (win) tone('triangle', 620, 1240, 0.55, 0.07, 0.12);
    },

    /* Continuous engine tone whose gain tracks throttle. */
    engine: function (on, load) {
      if (!ready) return;
      if (on && !engine) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        var f = ctx.createBiquadFilter();
        o.type = 'sawtooth'; o.frequency.value = 46;
        f.type = 'lowpass'; f.frequency.value = 180;
        g.gain.value = 0;
        o.connect(f); f.connect(g); g.connect(master);
        o.start();
        engine = { o: o, g: g, f: f };
      }
      if (engine) {
        var target = muted ? 0 : (on ? 0.05 + load * 0.06 : 0);
        engine.g.gain.value += (target - engine.g.gain.value) * 0.12;
        engine.o.frequency.value = 42 + load * 26;
      }
    }
  };
})();
