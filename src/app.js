// EchoShift web audio engine and UI. Moved verbatim from the inline script in
// index.html so the page loads a local application module; the functions the
// markup calls from inline handlers are exposed on window as before.
    /* ==========================================================================
       EchoShift Web Audio Core Engine & State Management
       ========================================================================== */

    // Application State
    const state = {
      audioCtx: null,
      activeSourceTab: 'spoken',
      micStream: null,
      micSourceNode: null,
      micRequestId: 0,
      liveMonitorEnabled: false,

      // Spoken Demo Audio State
      demoSourceNode: null,
      demoAudioBuffer: null,
      demoPlaying: false,
      demoLoadedVoice: '',

      // Quick 3s Voice Loop State
      quickLoopRecorder: null,
      quickLoopChunks: [],
      quickLoopBuffer: null,
      quickLoopSourceNode: null,
      quickLoopPlaying: false,
      quickLoopInterval: null,

      // Uploaded Audio State
      uploadedBuffer: null,
      uploadedSourceNode: null,
      uploadedPlaying: false,

      // Audio Graph Nodes
      inputGainNode: null,
      effectsInputNode: null,
      effectsOutputNode: null,
      monitorGainNode: null,
      recordDestNode: null,
      analyserNode: null,

      // Active Preset & Effect Nodes
      activePreset: 'normal',
      pitchShifterNode: null,
      effectSubNodes: [],

      // Recording State
      mediaRecorder: null,
      recordedChunks: [],
      recordingStartTime: 0,
      recordingTimerId: null,
      previousObjectUrl: null,

      // Visualizer
      visualizerMode: 'waveform'
    };

    // DOM Elements Cache
    const UI = {
      statusBadge: document.getElementById('engineStatusBadge'),
      statusDot: document.getElementById('statusDot'),
      statusText: document.getElementById('statusText'),
      noticeBanner: document.getElementById('noticeBanner'),
      noticeText: document.getElementById('noticeText'),
      sampleRateLabel: document.getElementById('sampleRateLabel'),

      // Source Tabs & Panels
      panelSpoken: document.getElementById('panelSpoken'),
      panelMic: document.getElementById('panelMic'),
      panelQuickLoop: document.getElementById('panelQuickLoop'),
      panelUpload: document.getElementById('panelUpload'),
      demoVoiceSelect: document.getElementById('demoVoiceSelect'),
      demoLoopToggle: document.getElementById('demoLoopToggle'),
      btnPlayDemo: document.getElementById('btnPlayDemo'),
      btnPlayDemoLabel: document.getElementById('btnPlayDemoLabel'),
      btnMic: document.getElementById('btnMic'),
      btnMicLabel: document.getElementById('btnMicLabel'),
      btnToggleMonitor: document.getElementById('btnToggleMonitor'),
      btnToggleMonitorLabel: document.getElementById('btnToggleMonitorLabel'),
      btnQuickRecord: document.getElementById('btnQuickRecord'),
      btnQuickRecordLabel: document.getElementById('btnQuickRecordLabel'),
      btnQuickStop: document.getElementById('btnQuickStop'),
      quickLoopProgress: document.getElementById('quickLoopProgress'),
      quickLoopProgressFill: document.getElementById('quickLoopProgressFill'),
      uploadedFileInfo: document.getElementById('uploadedFileInfo'),
      uploadedFileName: document.getElementById('uploadedFileName'),
      btnUploadedPlay: document.getElementById('btnUploadedPlay'),

      // Monitoring & Output
      sliderMonitoring: document.getElementById('sliderMonitoring'),
      sliderVolVal: document.getElementById('sliderVolVal'),
      sliderInputGain: document.getElementById('sliderInputGain'),
      sliderGainVal: document.getElementById('sliderGainVal'),

      // Presets & Recording
      activeFilterBadge: document.getElementById('activeFilterBadge'),
      btnRecord: document.getElementById('btnRecord'),
      btnStopRecord: document.getElementById('btnStopRecord'),
      recIndicator: document.getElementById('recIndicator'),
      recIdleNotice: document.getElementById('recIdleNotice'),
      recTimerDisplay: document.getElementById('recTimerDisplay'),
      audioPlayer: document.getElementById('audioPlayer'),
      btnDownload: document.getElementById('btnDownload'),
      recCodecInfo: document.getElementById('recCodecInfo'),

      // Visualizer Canvas
      canvas: document.getElementById('oscilloscope'),
      statFps: document.getElementById('statFps'),
      statLevel: document.getElementById('statLevel')
    };

    /* --------------------------------------------------------------------------
       Safe AudioContext Initializer (Strict User Interaction)
       -------------------------------------------------------------------------- */
    function ensureAudioContext() {
      if (!state.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          showNotice('Web Audio API is not supported in this browser.', 'warning');
          return null;
        }
        state.audioCtx = new AudioContextClass();
        UI.sampleRateLabel.textContent = (state.audioCtx.sampleRate / 1000).toFixed(1) + ' kHz';
        buildAudioRoutingGraph();
        startVisualizerLoop();
      }

      if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
      }

      return state.audioCtx;
    }

    /* --------------------------------------------------------------------------
       Audio DSP Graph Assembly
       -------------------------------------------------------------------------- */
    function buildAudioRoutingGraph() {
      const ctx = state.audioCtx;

      // 1. Input Gain Stage
      state.inputGainNode = ctx.createGain();
      state.inputGainNode.gain.value = 1.0;

      // 2. Effects Entry & Exit Points
      state.effectsInputNode = ctx.createGain();
      state.effectsOutputNode = ctx.createGain();
      state.inputGainNode.connect(state.effectsInputNode);

      // 3. Monitoring Stage (Default 75% for spoken demo/audio, with clear feedback safeguard for live mic)
      state.monitorGainNode = ctx.createGain();
      state.monitorGainNode.gain.value = 0.75;
      state.effectsOutputNode.connect(state.monitorGainNode);
      state.monitorGainNode.connect(ctx.destination);

      // 4. Visualizer Stage (Analyser taps post-effects stream)
      state.analyserNode = ctx.createAnalyser();
      state.analyserNode.fftSize = 2048;
      state.analyserNode.smoothingTimeConstant = 0.82;
      state.effectsOutputNode.connect(state.analyserNode);

      // 5. Recording Destination Stage
      if (ctx.createMediaStreamDestination) {
        state.recordDestNode = ctx.createMediaStreamDestination();
        state.effectsOutputNode.connect(state.recordDestNode);
      }

      // Initialize default filter connection
      applyFilterPreset('normal');
    }

    /* --------------------------------------------------------------------------
       Overlapping Dual-Delay Line Pitch Shifter (~1.68x Pitch Shift Factor)
       Uses two modulated DelayNodes with a periodic sawtooth LFO running at ~75Hz
       Crossfaded with symmetric triangular gain windows + 400Hz HP & 2.5kHz peaking
       -------------------------------------------------------------------------- */
    function createDualDelayPitchShifter(ctx, pitchRatio = 1.68, lfoFreq = 75) {
      const now = ctx.currentTime;
      const sr = ctx.sampleRate;

      // 1. Formant-shaping filters: 400Hz Highpass + 2.5kHz Peaking to brighten vocal formant
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(400, now);
      hp.Q.setValueAtTime(0.7, now);

      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.setValueAtTime(2500, now);
      peak.gain.setValueAtTime(7.5, now);
      peak.Q.setValueAtTime(2.2, now);

      // 2. Dual delay lines (native Web Audio DelayNodes)
      const maxDelay = 0.1;
      const delay1 = ctx.createDelay(maxDelay);
      const delay2 = ctx.createDelay(maxDelay);

      // 3. Crossfade gain nodes (triangular gain windows)
      const gain1 = ctx.createGain();
      const gain2 = ctx.createGain();
      gain1.gain.setValueAtTime(0, now);
      gain2.gain.setValueAtTime(0, now);

      // Summing output node with slight makeup boost
      const outGain = ctx.createGain();
      outGain.gain.setValueAtTime(1.15, now);

      // Clean DSP routing: hp -> peak -> (delay1 & delay2) -> (gain1 & gain2) -> outGain
      hp.connect(peak);
      peak.connect(delay1);
      peak.connect(delay2);
      delay1.connect(gain1);
      delay2.connect(gain2);
      gain1.connect(outGain);
      gain2.connect(outGain);

      // 4. Modulation buffers for delay times (periodic sawtooth) & crossfade gains (triangular windows)
      const cycleSamples = Math.max(8, Math.round(sr / lfoFreq));
      const numCycles = 16;
      const totalSamples = cycleSamples * numCycles;

      const delayChange = (pitchRatio - 1.0) * (cycleSamples / sr);
      const baseDelay = 0.003; // 3ms base delay floor

      const bufD1 = ctx.createBuffer(1, totalSamples, sr);
      const bufD2 = ctx.createBuffer(1, totalSamples, sr);
      const bufG1 = ctx.createBuffer(1, totalSamples, sr);
      const bufG2 = ctx.createBuffer(1, totalSamples, sr);

      const d1 = bufD1.getChannelData(0);
      const d2 = bufD2.getChannelData(0);
      const g1 = bufG1.getChannelData(0);
      const g2 = bufG2.getChannelData(0);

      for (let i = 0; i < totalSamples; i++) {
        const phi1 = (i % cycleSamples) / cycleSamples;
        const phi2 = ((i % cycleSamples) / cycleSamples + 0.5) % 1.0;

        // Periodic downward sawtooth ramp creates true upward pitch shifting
        d1[i] = baseDelay + delayChange * (1.0 - phi1);
        d2[i] = baseDelay + delayChange * (1.0 - phi2);

        // Symmetric triangular crossfade: gain = 0 at wrap-around point (phi = 0/1), peaks at phi = 0.5
        g1[i] = 1.0 - Math.abs(2.0 * phi1 - 1.0);
        g2[i] = 1.0 - Math.abs(2.0 * phi2 - 1.0);
      }

      // Base AudioParam values set to 0 so buffer source modulates absolute values
      delay1.delayTime.setValueAtTime(0, now);
      delay2.delayTime.setValueAtTime(0, now);

      const modD1 = ctx.createBufferSource();
      modD1.buffer = bufD1;
      modD1.loop = true;
      modD1.connect(delay1.delayTime);

      const modD2 = ctx.createBufferSource();
      modD2.buffer = bufD2;
      modD2.loop = true;
      modD2.connect(delay2.delayTime);

      const modG1 = ctx.createBufferSource();
      modG1.buffer = bufG1;
      modG1.loop = true;
      modG1.connect(gain1.gain);

      const modG2 = ctx.createBufferSource();
      modG2.buffer = bufG2;
      modG2.loop = true;
      modG2.connect(gain2.gain);

      modD1.start(now);
      modD2.start(now);
      modG1.start(now);
      modG2.start(now);

      return {
        input: hp,
        output: outGain,
        nodes: [hp, peak, delay1, delay2, gain1, gain2, outGain, modD1, modD2, modG1, modG2]
      };
    }

    /* --------------------------------------------------------------------------
       Distortion Waveshaper Helpers & DSP Curves
       -------------------------------------------------------------------------- */
    function makeSoftDistortionCurve(amount = 20) {
      const k = amount;
      const n_samples = 44100;
      const curve = new Float32Array(n_samples);
      const deg = Math.PI / 180;
      for (let i = 0; i < n_samples; ++i) {
        const x = (i * 2) / n_samples - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
      }
      return curve;
    }

    function makeAsymmetricCurve(samples = 44100) {
      const curve = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        if (x < 0) {
          curve[i] = -Math.tanh(Math.abs(x) * 2.8);
        } else {
          curve[i] = Math.tanh(x * 1.3) * 0.88;
        }
      }
      return curve;
    }

    function makeHardClipCurve(samples = 44100, threshold = 0.35) {
      const curve = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        const scaled = x * 2.4;
        curve[i] = Math.max(-threshold, Math.min(threshold, scaled)) / threshold;
      }
      return curve;
    }

    function makeCyberpunkCurve(samples = 44100) {
      const curve = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        curve[i] = Math.tanh(x * 3.5);
      }
      return curve;
    }

    function makeDemonCurve(samples = 44100) {
      const curve = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        curve[i] = Math.sin(x * Math.PI * 1.5) * 0.95;
      }
      return curve;
    }

    function makePhoneCurve(samples = 44100) {
      const curve = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        curve[i] = Math.atan(x * 4) / Math.atan(4);
      }
      return curve;
    }

    /* --------------------------------------------------------------------------
       Filter DSP Configurations (16 Distinct Audio Presets)
       -------------------------------------------------------------------------- */
    function clearCurrentFilters() {
      if (!state.audioCtx) return;

      try {
        state.effectsInputNode.disconnect();
      } catch (e) {}

      // Disconnect all tracked sub-nodes
      state.effectSubNodes.forEach(node => {
        try {
          if (node.stop) node.stop();
          node.disconnect();
        } catch (e) {}
      });
      state.effectSubNodes = [];
      state.pitchShifterNode = null;
    }

    function applyFilterPreset(presetKey) {
      if (!state.audioCtx) return;
      clearCurrentFilters();

      const ctx = state.audioCtx;
      const inNode = state.effectsInputNode;
      const outNode = state.effectsOutputNode;
      const now = ctx.currentTime;

      switch (presetKey) {
        case 'normal': {
          // 1. Normal: Direct clean pass-through bypass
          inNode.connect(outNode);
          break;
        }

        case 'ghost': {
          // 2. Ghost / Wraith: 350ms delay with 60% feedback + 0.5Hz LFO modulating a bandpass filter
          const dry = ctx.createGain();
          dry.gain.setValueAtTime(0.7, now);

          const delay = ctx.createDelay(1.0);
          delay.delayTime.setValueAtTime(0.35, now);

          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.setValueAtTime(1100, now);
          bp.Q.setValueAtTime(2.2, now);

          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.setValueAtTime(0.5, now);

          const lfoGain = ctx.createGain();
          lfoGain.gain.setValueAtTime(550, now);

          lfo.connect(lfoGain);
          lfoGain.connect(bp.frequency);
          lfo.start(now);

          const fb = ctx.createGain();
          fb.gain.setValueAtTime(0.60, now);

          const wet = ctx.createGain();
          wet.gain.setValueAtTime(0.85, now);

          inNode.connect(dry);
          dry.connect(outNode);

          inNode.connect(delay);
          delay.connect(bp);
          bp.connect(fb);
          fb.connect(delay);
          bp.connect(wet);
          wet.connect(outNode);

          state.effectSubNodes.push(dry, delay, bp, lfo, lfoGain, fb, wet);
          break;
        }

        case 'deep': {
          // 3. Deep Monster: Steep lowpass filter (cutoff 400Hz) + asymmetric WaveShaper saturation curve
          const lp1 = ctx.createBiquadFilter();
          lp1.type = 'lowpass';
          lp1.frequency.setValueAtTime(400, now);
          lp1.Q.setValueAtTime(1.8, now);

          const lp2 = ctx.createBiquadFilter();
          lp2.type = 'lowpass';
          lp2.frequency.setValueAtTime(400, now);
          lp2.Q.setValueAtTime(1.2, now);

          const shaper = ctx.createWaveShaper();
          shaper.curve = makeAsymmetricCurve(44100);
          shaper.oversample = '2x';

          const makeup = ctx.createGain();
          makeup.gain.setValueAtTime(1.5, now);

          inNode.connect(lp1);
          lp1.connect(lp2);
          lp2.connect(shaper);
          shaper.connect(makeup);
          makeup.connect(outNode);

          state.effectSubNodes.push(lp1, lp2, shaper, makeup);
          break;
        }

        case 'chipmunk': {
          // 4. Chipmunk: Genuine Overlapping Dual-Delay Line Pitch Shifter (~75Hz sawtooth LFO, 1.68x pitch shift, triangular crossfade, 400Hz HP & 2.5kHz peaking formant boost)
          const shifter = createDualDelayPitchShifter(ctx, 1.68, 75);
          inNode.connect(shifter.input);
          shifter.output.connect(outNode);
          state.effectSubNodes.push(...shifter.nodes);
          break;
        }

        case 'robot': {
          // 5. Robot Vocoder: Ring modulation using a 50Hz sine OscillatorNode into GainNode modulation
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(50, now);

          const ringGain = ctx.createGain();
          ringGain.gain.value = 0.0;
          osc.connect(ringGain.gain);
          osc.start(now);

          const dry = ctx.createGain();
          dry.gain.setValueAtTime(0.25, now);

          const wet = ctx.createGain();
          wet.gain.setValueAtTime(0.85, now);

          inNode.connect(dry);
          dry.connect(outNode);

          inNode.connect(ringGain);
          ringGain.connect(wet);
          wet.connect(outNode);

          state.effectSubNodes.push(osc, ringGain, dry, wet);
          break;
        }

        case 'walkie': {
          // 6. Walkie-Talkie: Narrow bandpass filter (1800Hz, Q: 4.5) + light clipping distortion + 3500Hz shelf
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.setValueAtTime(1800, now);
          bp.Q.setValueAtTime(4.5, now);

          const dist = ctx.createWaveShaper();
          dist.curve = makeSoftDistortionCurve(16);
          dist.oversample = '2x';

          const shelf = ctx.createBiquadFilter();
          shelf.type = 'highshelf';
          shelf.frequency.setValueAtTime(3500, now);
          shelf.gain.setValueAtTime(-12, now);

          const makeup = ctx.createGain();
          makeup.gain.setValueAtTime(2.2, now);

          inNode.connect(bp);
          bp.connect(dist);
          dist.connect(shelf);
          shelf.connect(makeup);
          makeup.connect(outNode);

          state.effectSubNodes.push(bp, dist, shelf, makeup);
          break;
        }

        case 'megaphone': {
          // 7. Megaphone: Peaking filter at 1200Hz (+14dB boost) + hard-clip distortion curve via WaveShaper
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.setValueAtTime(500, now);

          const peak = ctx.createBiquadFilter();
          peak.type = 'peaking';
          peak.frequency.setValueAtTime(1200, now);
          peak.gain.setValueAtTime(14, now);
          peak.Q.setValueAtTime(2.8, now);

          const hardClip = ctx.createWaveShaper();
          hardClip.curve = makeHardClipCurve(44100, 0.35);

          const outGain = ctx.createGain();
          outGain.gain.setValueAtTime(0.85, now);

          inNode.connect(hp);
          hp.connect(peak);
          peak.connect(hardClip);
          hardClip.connect(outGain);
          outGain.connect(outNode);

          state.effectSubNodes.push(hp, peak, hardClip, outGain);
          break;
        }

        case 'echo': {
          // 8. Cave Echo: 420ms DelayNode feedback loop damped by a 1200Hz lowpass filter
          const dry = ctx.createGain();
          dry.gain.setValueAtTime(0.75, now);

          const delay = ctx.createDelay(1.0);
          delay.delayTime.setValueAtTime(0.42, now);

          const damp = ctx.createBiquadFilter();
          damp.type = 'lowpass';
          damp.frequency.setValueAtTime(1200, now);

          const fb = ctx.createGain();
          fb.gain.setValueAtTime(0.52, now);

          const wet = ctx.createGain();
          wet.gain.setValueAtTime(0.75, now);

          inNode.connect(dry);
          dry.connect(outNode);

          inNode.connect(delay);
          delay.connect(damp);
          damp.connect(fb);
          fb.connect(delay);
          damp.connect(wet);
          wet.connect(outNode);

          state.effectSubNodes.push(dry, delay, damp, fb, wet);
          break;
        }

        case 'cathedral': {
          // 9. Cathedral Reverb: Dual parallel delay lines (180ms & 340ms) with 75% cross-feedback
          const dry = ctx.createGain();
          dry.gain.setValueAtTime(0.65, now);

          const delay1 = ctx.createDelay(1.0);
          delay1.delayTime.setValueAtTime(0.18, now);

          const delay2 = ctx.createDelay(1.0);
          delay2.delayTime.setValueAtTime(0.34, now);

          const damp1 = ctx.createBiquadFilter();
          damp1.type = 'lowpass';
          damp1.frequency.setValueAtTime(2800, now);

          const damp2 = ctx.createBiquadFilter();
          damp2.type = 'lowpass';
          damp2.frequency.setValueAtTime(2400, now);

          const cross1 = ctx.createGain();
          cross1.gain.setValueAtTime(0.55, now);

          const cross2 = ctx.createGain();
          cross2.gain.setValueAtTime(0.55, now);

          const wet = ctx.createGain();
          wet.gain.setValueAtTime(0.75, now);

          inNode.connect(dry);
          dry.connect(outNode);

          inNode.connect(delay1);
          inNode.connect(delay2);

          delay1.connect(damp1);
          damp1.connect(cross1);
          cross1.connect(delay2);

          delay2.connect(damp2);
          damp2.connect(cross2);
          cross2.connect(delay1);

          damp1.connect(wet);
          damp2.connect(wet);
          wet.connect(outNode);

          state.effectSubNodes.push(dry, delay1, delay2, damp1, damp2, cross1, cross2, wet);
          break;
        }

        case 'underwater': {
          // 10. Underwater: Muffled 320Hz lowpass filter + 1.2Hz LFO gentle frequency sweep
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(320, now);
          lp.Q.setValueAtTime(2.5, now);

          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.setValueAtTime(1.2, now);

          const lfoGain = ctx.createGain();
          lfoGain.gain.setValueAtTime(140, now);

          lfo.connect(lfoGain);
          lfoGain.connect(lp.frequency);
          lfo.start(now);

          const gain = ctx.createGain();
          gain.gain.setValueAtTime(1.6, now);

          inNode.connect(lp);
          lp.connect(gain);
          gain.connect(outNode);

          state.effectSubNodes.push(lp, lfo, lfoGain, gain);
          break;
        }

        case 'alien': {
          // 11. Cosmic Alien: 18Hz square-wave ring modulation + peaking resonant band at 2800Hz
          const osc = ctx.createOscillator();
          osc.type = 'square';
          osc.frequency.setValueAtTime(18, now);

          const ringGain = ctx.createGain();
          ringGain.gain.value = 0.0;
          osc.connect(ringGain.gain);
          osc.start(now);

          const peak = ctx.createBiquadFilter();
          peak.type = 'peaking';
          peak.frequency.setValueAtTime(2800, now);
          peak.Q.setValueAtTime(4.0, now);
          peak.gain.setValueAtTime(9.0, now);

          const dry = ctx.createGain();
          dry.gain.setValueAtTime(0.35, now);

          const wet = ctx.createGain();
          wet.gain.setValueAtTime(0.85, now);

          inNode.connect(dry);
          dry.connect(outNode);

          inNode.connect(ringGain);
          ringGain.connect(peak);
          peak.connect(wet);
          wet.connect(outNode);

          state.effectSubNodes.push(osc, ringGain, peak, dry, wet);
          break;
        }

        case 'phone': {
          // 12. Vintage 1920s Phone: Dual bandpass (600Hz highpass + 2400Hz lowpass) + aggressive dynamic compression curve
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.setValueAtTime(600, now);

          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(2400, now);

          const compressor = ctx.createDynamicsCompressor();
          compressor.threshold.setValueAtTime(-30, now);
          compressor.knee.setValueAtTime(3, now);
          compressor.ratio.setValueAtTime(16, now);
          compressor.attack.setValueAtTime(0.003, now);
          compressor.release.setValueAtTime(0.05, now);

          const shaper = ctx.createWaveShaper();
          shaper.curve = makePhoneCurve(44100);

          const makeup = ctx.createGain();
          makeup.gain.setValueAtTime(1.8, now);

          inNode.connect(hp);
          hp.connect(lp);
          lp.connect(compressor);
          compressor.connect(shaper);
          shaper.connect(makeup);
          makeup.connect(outNode);

          state.effectSubNodes.push(hp, lp, compressor, shaper, makeup);
          break;
        }

        case 'vibrato': {
          // 13. Shivering Vibrato: 20ms modulated delay line driven by a 6Hz sine LFO
          const delay = ctx.createDelay(0.1);
          delay.delayTime.setValueAtTime(0.020, now);

          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.setValueAtTime(6.0, now);

          const lfoGain = ctx.createGain();
          lfoGain.gain.setValueAtTime(0.0035, now);

          lfo.connect(lfoGain);
          lfoGain.connect(delay.delayTime);
          lfo.start(now);

          inNode.connect(delay);
          delay.connect(outNode);

          state.effectSubNodes.push(delay, lfo, lfoGain);
          break;
        }

        case 'cyberpunk': {
          // 14. Cyberpunk Overdrive: Pre-gain boost (+15dB) + extreme S-curve WaveShaper digital overdrive + 1000Hz mid-scoop
          const preGain = ctx.createGain();
          preGain.gain.setValueAtTime(4.5, now);

          const shaper = ctx.createWaveShaper();
          shaper.curve = makeCyberpunkCurve(44100);
          shaper.oversample = '4x';

          const midScoop = ctx.createBiquadFilter();
          midScoop.type = 'peaking';
          midScoop.frequency.setValueAtTime(1000, now);
          midScoop.Q.setValueAtTime(1.8, now);
          midScoop.gain.setValueAtTime(-12, now);

          const postGain = ctx.createGain();
          postGain.gain.setValueAtTime(0.45, now);

          inNode.connect(preGain);
          preGain.connect(shaper);
          shaper.connect(midScoop);
          midScoop.connect(postGain);
          postGain.connect(outNode);

          state.effectSubNodes.push(preGain, shaper, midScoop, postGain);
          break;
        }

        case 'astronaut': {
          // 15. Astronaut Apollo: 18ms comb filter delay + narrow helmet comms bandpass (800Hz - 2200Hz)
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.setValueAtTime(800, now);

          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(2200, now);

          const combDelay = ctx.createDelay(0.1);
          combDelay.delayTime.setValueAtTime(0.018, now);

          const combFb = ctx.createGain();
          combFb.gain.setValueAtTime(0.65, now);

          const combDry = ctx.createGain();
          combDry.gain.setValueAtTime(0.7, now);

          const combWet = ctx.createGain();
          combWet.gain.setValueAtTime(0.6, now);

          const shaper = ctx.createWaveShaper();
          shaper.curve = makeSoftDistortionCurve(10);

          const outGain = ctx.createGain();
          outGain.gain.setValueAtTime(1.35, now);

          inNode.connect(hp);
          hp.connect(lp);

          lp.connect(combDry);
          lp.connect(combDelay);

          combDelay.connect(combFb);
          combFb.connect(combDelay);
          combDelay.connect(combWet);

          combDry.connect(shaper);
          combWet.connect(shaper);

          shaper.connect(outGain);
          outGain.connect(outNode);

          state.effectSubNodes.push(hp, lp, combDelay, combFb, combDry, combWet, shaper, outGain);
          break;
        }

        case 'demon': {
          // 16. Demon Pitch: Ultra-low lowpass filter (280Hz) + sub-harmonic 35Hz ring modulation + heavy distortion
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(280, now);
          lp.Q.setValueAtTime(2.0, now);

          const subOsc = ctx.createOscillator();
          subOsc.type = 'sine';
          subOsc.frequency.setValueAtTime(35, now);

          const ringGain = ctx.createGain();
          ringGain.gain.value = 0.0;
          subOsc.connect(ringGain.gain);
          subOsc.start(now);

          const heavyDist = ctx.createWaveShaper();
          heavyDist.curve = makeDemonCurve(44100);

          const bassBoost = ctx.createBiquadFilter();
          bassBoost.type = 'lowshelf';
          bassBoost.frequency.setValueAtTime(180, now);
          bassBoost.gain.setValueAtTime(7.0, now);

          const dry = ctx.createGain();
          dry.gain.setValueAtTime(0.35, now);

          const demonWet = ctx.createGain();
          demonWet.gain.setValueAtTime(0.95, now);

          inNode.connect(dry);
          dry.connect(outNode);

          inNode.connect(lp);
          lp.connect(ringGain);
          ringGain.connect(heavyDist);
          heavyDist.connect(bassBoost);
          bassBoost.connect(demonWet);
          demonWet.connect(outNode);

          state.effectSubNodes.push(lp, subOsc, ringGain, heavyDist, bassBoost, dry, demonWet);
          break;
        }
      }
    }

    function selectFilterPreset(presetKey) {
      state.activePreset = presetKey;
      const allCards = document.querySelectorAll('.preset-card');
      allCards.forEach(card => card.classList.remove('active'));

      const target = document.getElementById('preset-' + presetKey);
      if (target) target.classList.add('active');

      const presetNames = {
        normal: 'Normal',
        ghost: 'Ghost / Wraith',
        deep: 'Deep Monster',
        chipmunk: 'Chipmunk',
        robot: 'Robot Vocoder',
        walkie: 'Walkie-Talkie',
        megaphone: 'Megaphone',
        echo: 'Cave Echo',
        cathedral: 'Cathedral Reverb',
        underwater: 'Underwater',
        alien: 'Cosmic Alien',
        phone: '1920s Phone',
        vibrato: 'Shivering Vibrato',
        cyberpunk: 'Cyberpunk Overdrive',
        astronaut: 'Astronaut Apollo',
        demon: 'Demon Pitch'
      };
      UI.activeFilterBadge.textContent = 'Preset: ' + (presetNames[presetKey] || presetKey);

     // Dynamic Playback Speed Pitch Shifter (1.15x makes normal speech sound natural)
      const rate = (presetKey === 'chipmunk') ? 1.6 : (presetKey === 'deep' ? 0.9 : 1.15);
      if (state.demoSourceNode && state.audioCtx) {
        state.demoSourceNode.playbackRate.setValueAtTime(rate, state.audioCtx.currentTime);
      }
      if (state.quickLoopSourceNode && state.audioCtx) {
        state.quickLoopSourceNode.playbackRate.setValueAtTime(rate, state.audioCtx.currentTime);
      }
      if (state.uploadedSourceNode && state.audioCtx) {
        state.uploadedSourceNode.playbackRate.setValueAtTime(rate, state.audioCtx.currentTime);
      }

      if (state.audioCtx) {
        applyFilterPreset(presetKey);
      }
    }

    /* --------------------------------------------------------------------------
       Source Switching (Spoken Demo vs Mic vs Quick Loop vs Upload)
       -------------------------------------------------------------------------- */
 function switchSourceTab(tabKey) {
      if (state.activeSourceTab === 'mic' && tabKey !== 'mic') {
        stopMicrophone();
      }
      state.activeSourceTab = tabKey;
      const tabs = ['spoken', 'mic', 'upload'];
      tabs.forEach(t => {
        const btn = document.getElementById('tabBtn' + capitalize(t));
        const panel = document.getElementById('panel' + capitalize(t));
        if (btn) btn.classList.toggle('active', t === tabKey);
        if (panel) panel.classList.toggle('active', t === tabKey);
      });
    }

    function capitalize(str) {
      if (str === 'quickloop') return 'QuickLoop';
      return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /* --------------------------------------------------------------------------
       Source 1: Spoken Voice Demo (Real Spoken Human Words)
       -------------------------------------------------------------------------- */
    /* Helper to convert base64 data URI to ArrayBuffer without network fetch */
    function base64ToArrayBuffer(base64) {
      const binaryString = window.atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    }

    /* --------------------------------------------------------------------------
       Source 1: Spoken Voice Demo (Real Spoken Human Words)
       -------------------------------------------------------------------------- */
    async function loadSpokenBuffer(voiceKey) {
      const ctx = ensureAudioContext();
      if (!ctx) return null;

      try {
        let arrayBuf;

        if (window.SPEECH_SAMPLES && window.SPEECH_SAMPLES[voiceKey]) {
          const sample = window.SPEECH_SAMPLES[voiceKey];
          if (sample.startsWith('data:')) {
            const base64Data = sample.split(',')[1];
            arrayBuf = base64ToArrayBuffer(base64Data);
          } else {
            const res = await fetch(sample);
            arrayBuf = await res.arrayBuffer();
          }
        } else {
          const res = await fetch(`./assets/sample_${voiceKey}.mp3`);
          arrayBuf = await res.arrayBuffer();
        }

        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        state.demoAudioBuffer = audioBuf;
        state.demoLoadedVoice = voiceKey;
        return audioBuf;
      } catch (err) {
        console.error('Failed to decode speech sample:', err);
        showNotice('Failed to load spoken demo sample. Please check your browser audio support.', 'warning');
        return null;
      }
    }

    async function toggleSpokenDemo() {
      const ctx = ensureAudioContext();
      if (!ctx) return;

      if (state.demoPlaying) {
        stopSpokenDemo();
        return;
      }

      const voiceKey = UI.demoVoiceSelect.value;
      if (!state.demoAudioBuffer || state.demoLoadedVoice !== voiceKey) {
        showNotice('Loading crystal-clear spoken voice demo...', 'info');
        await loadSpokenBuffer(voiceKey);
      }

      if (!state.demoAudioBuffer) return;

      // Stop any other active sources
      stopMicrophone();
      stopUploadedAudio();

      // Ensure monitor volume is audible
      if (state.monitorGainNode.gain.value < 0.1) {
        setVolumeQuick(75);
      }

      const source = ctx.createBufferSource();
      source.buffer = state.demoAudioBuffer;
      source.loop = UI.demoLoopToggle.checked;
      source.playbackRate.value = (state.activePreset === 'chipmunk') ? 1.6 : (state.activePreset === 'deep' ? 0.9 : 1.15);
      source.connect(state.inputGainNode);

      source.onended = () => {
        if (!source.loop) {
          stopSpokenDemo();
        }
      };

      source.start(0);
      state.demoSourceNode = source;
      state.demoPlaying = true;

      UI.btnPlayDemo.classList.add('btn-warning');
      UI.btnPlayDemoLabel.textContent = 'Stop Spoken Demo';
      UI.btnRecord.disabled = false;
      setEngineStatus('demo', 'Playing Spoken Voice Demo');
      showNotice('Playing real spoken demo! Switch between presets (Deep Monster, Chipmunk, Robot, etc.) to hear immediate voice changes.', 'success');
    }

    function stopSpokenDemo() {
      if (state.demoSourceNode) {
        try { state.demoSourceNode.stop(); state.demoSourceNode.disconnect(); } catch (e) {}
        state.demoSourceNode = null;
      }
      state.demoPlaying = false;
      UI.btnPlayDemo.classList.remove('btn-warning');
      UI.btnPlayDemoLabel.textContent = 'Play Spoken Demo';

      if (!state.micStream && !state.uploadedPlaying) {
        setEngineStatus('idle', 'Engine Ready (Idle)');
      }
    }

    // Refresh sample when voice select changes
    UI.demoVoiceSelect.addEventListener('change', () => {
      if (state.demoPlaying) {
        stopSpokenDemo();
        toggleSpokenDemo();
      }
    });

    UI.demoLoopToggle.addEventListener('change', () => {
      if (state.demoSourceNode) {
        state.demoSourceNode.loop = UI.demoLoopToggle.checked;
      }
    });


    /* --------------------------------------------------------------------------
       Source 2: Live Microphone
       -------------------------------------------------------------------------- */
   async function toggleMicrophone() {
      const ctx = ensureAudioContext();
      if (!ctx) return;

      if (state.micStream) {
        stopMicrophone();
        return;
      }

      stopSpokenDemo();
      stopUploadedAudio();

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showNotice('Microphone API (getUserMedia) is not supported in this browser.', 'warning');
        return;
      }

      UI.btnMic.disabled = true;
      const requestId = ++state.micRequestId;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (requestId !== state.micRequestId) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        // Demo/upload playback can leave the speakers unmuted.
        state.liveMonitorEnabled = false;
        UI.btnToggleMonitorLabel.textContent = 'Hear Myself: OFF';
        UI.btnToggleMonitor.classList.remove('btn-warning');
        UI.btnToggleMonitor.classList.add('btn-secondary');
        setVolumeQuick(0);
        state.micStream = stream;
        state.micSourceNode = ctx.createMediaStreamSource(stream);
        state.micSourceNode.connect(state.inputGainNode);

        setEngineStatus('active', 'Microphone Live');
        UI.btnMic.classList.remove('btn-primary');
        UI.btnMic.classList.add('btn-warning');
        UI.btnMicLabel.textContent = 'Mute Microphone';
        UI.btnRecord.disabled = false;

        showNotice('Microphone connected! Speak into your mic. Click "Hear Myself" to monitor live.', 'success');
      } catch (err) {
        if (requestId !== state.micRequestId) return;
        stopMicrophone();
        console.warn('Physical mic access error:', err);

        const pp = document.permissionsPolicy || document.featurePolicy;
        const blockedByPolicy = pp && typeof pp.allowsFeature === 'function' && !pp.allowsFeature('microphone');
        if (blockedByPolicy) {
          const inFrame = window.self !== window.top;
          showNotice(
            inFrame
              ? 'Microphone blocked by iframe container. Open directly in a new tab: ' + location.href
              : 'Microphone blocked by site hosting policy (Permissions-Policy header).',
            'warning'
          );
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          showNotice('No microphone detected. Please check your system sound input settings.', 'warning');
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showNotice('Microphone permission blocked. Please allow mic access in your browser bar.', 'warning');
        } else {
          showNotice(`Microphone error: ${err.message || err.name}`, 'warning');
        }
      } finally {
        if (requestId === state.micRequestId) UI.btnMic.disabled = false;
      }
    }

    function stopMicrophone() {
      state.micRequestId++;
      UI.btnMic.disabled = false;
      if (state.micStream) {
        state.micStream.getTracks().forEach(track => track.stop());
        state.micStream = null;
      }
      if (state.micSourceNode) {
        try { state.micSourceNode.disconnect(); } catch (e) {}
        state.micSourceNode = null;
      }

      UI.btnMic.classList.add('btn-primary');
      UI.btnMic.classList.remove('btn-warning');
      UI.btnMicLabel.textContent = 'Enable Microphone';
      setEngineStatus('idle', 'Engine Ready (Idle)');
    }

    function toggleLiveMonitoring() {
      state.liveMonitorEnabled = !state.liveMonitorEnabled;
      if (state.liveMonitorEnabled) {
        UI.btnToggleMonitor.classList.remove('btn-secondary');
        UI.btnToggleMonitor.classList.add('btn-warning');
        UI.btnToggleMonitorLabel.textContent = 'Hear Myself: ON';
        setVolumeQuick(50);
        showNotice('Live speaker monitor ON! Wear headphones to prevent acoustic microphone feedback.', 'warning');
      } else {
        UI.btnToggleMonitor.classList.add('btn-secondary');
        UI.btnToggleMonitor.classList.remove('btn-warning');
        UI.btnToggleMonitorLabel.textContent = 'Hear Myself: OFF';
        setVolumeQuick(0);
        showNotice('Live speaker monitor muted. Visualizer and recording remain 100% active.', 'info');
      }
    }

   /* --------------------------------------------------------------------------
       Source 4: Audio File Upload (With Pause/Resume & Clean Track Switching)
       -------------------------------------------------------------------------- */
    function handleDragOver(e) {
      e.preventDefault();
      e.currentTarget.classList.add('dragover');
    }

    function handleDragLeave(e) {
      e.currentTarget.classList.remove('dragover');
    }

    function handleFileDrop(e) {
      e.preventDefault();
      e.currentTarget.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        processUploadedFile(e.dataTransfer.files[0]);
      }
    }

    function handleAudioFileUpload(e) {
      if (e.target.files && e.target.files[0]) {
        processUploadedFile(e.target.files[0]);
      }
    }

    async function processUploadedFile(file) {
      const ctx = ensureAudioContext();
      if (!ctx) return;

      // 1. Immediately stop any currently playing song and reset position to 0
      stopUploadedAudio(true);
      stopSpokenDemo();
      stopMicrophone();

      showNotice(`Loading ${file.name}...`, 'info');
      const arrayBuf = await file.arrayBuffer();

      try {
        state.uploadedBuffer = await ctx.decodeAudioData(arrayBuf);
      } catch (err) {
        console.error('Failed to decode audio:', err);
        showNotice('Could not decode audio file. Please try another MP3 or WAV file.', 'warning');
        return;
      }

      state.uploadedPausedAt = 0;
      UI.uploadedFileName.textContent = file.name;
      UI.uploadedFileInfo.style.display = 'flex';
      showNotice(`File "${file.name}" loaded! Click Play to audition through voice filters.`, 'success');
      playUploadedAudio();
    }

    function toggleUploadedAudioPlay() {
      if (state.uploadedPlaying) {
        stopUploadedAudio(false); // Pause: saves current timestamp
      } else {
        playUploadedAudio();      // Resume: starts from saved timestamp
      }
    }

    function playUploadedAudio() {
      const ctx = ensureAudioContext();
      if (!ctx || !state.uploadedBuffer) return;

      stopSpokenDemo();
      stopMicrophone();

      // Ensure any existing node is stopped so tracks never overlap
      if (state.uploadedSourceNode) {
        try {
          state.uploadedSourceNode.onended = null;
          state.uploadedSourceNode.stop();
          state.uploadedSourceNode.disconnect();
        } catch (e) {}
        state.uploadedSourceNode = null;
      }

      setVolumeQuick(75);

      const rate = (state.activePreset === 'chipmunk') ? 1.6 : (state.activePreset === 'deep' ? 0.9 : 1.15);
      const duration = state.uploadedBuffer.duration || 1;
      const offset = (state.uploadedPausedAt || 0) % duration;

      const source = ctx.createBufferSource();
      source.buffer = state.uploadedBuffer;
      source.loop = true;
      source.playbackRate.value = rate;
      source.connect(state.inputGainNode);

      source.onended = () => {
        if (!source.loop) stopUploadedAudio(true);
      };

      // Resume from the saved offset
      source.start(0, offset);
      state.uploadedStartedAt = ctx.currentTime;
      state.uploadedSourceNode = source;
      state.uploadedPlaying = true;

      UI.btnUploadedPlay.textContent = 'Pause';
      UI.btnRecord.disabled = false;
      setEngineStatus('demo', 'Playing Uploaded Audio File');
    }

    function stopUploadedAudio(reset = false) {
      // Calculate elapsed playback time before destroying the node
      if (state.uploadedPlaying && state.audioCtx && state.uploadedBuffer) {
        const rate = state.uploadedSourceNode ? state.uploadedSourceNode.playbackRate.value : 1.0;
        const elapsed = (state.audioCtx.currentTime - state.uploadedStartedAt) * rate;
        const duration = state.uploadedBuffer.duration || 1;
        state.uploadedPausedAt = ((state.uploadedPausedAt || 0) + elapsed) % duration;
      }

      if (reset) {
        state.uploadedPausedAt = 0;
      }

      if (state.uploadedSourceNode) {
        try {
          state.uploadedSourceNode.onended = null;
          state.uploadedSourceNode.stop();
          state.uploadedSourceNode.disconnect();
        } catch (e) {}
        state.uploadedSourceNode = null;
      }

      state.uploadedPlaying = false;
      if (UI.btnUploadedPlay) UI.btnUploadedPlay.textContent = 'Play';

      if (!state.micStream && !state.demoPlaying) {
        setEngineStatus('idle', 'Engine Ready (Idle)');
      }
    }
    /* --------------------------------------------------------------------------
       Volume & Monitoring Controls (Fixes "Beside original voice I can't hear")
       -------------------------------------------------------------------------- */
    function setVolumeQuick(pct) {
      UI.sliderMonitoring.value = pct;
      updateMonitorVolume(pct);
    }

    function updateMonitorVolume(val) {
      ensureAudioContext();
      const num = parseInt(val, 10);
      UI.sliderVolVal.textContent = num === 0 ? '0% (Muted)' : num + '%';

      if (state.monitorGainNode && state.audioCtx) {
        // Natural logarithmic volume scaling
        const gain = num === 0 ? 0 : Math.pow(num / 100, 2);
        state.monitorGainNode.gain.setTargetAtTime(gain, state.audioCtx.currentTime, 0.02);
      }
    }

    function updateInputGain(val) {
      ensureAudioContext();
      const mult = (val / 100).toFixed(1);
      UI.sliderGainVal.textContent = mult + 'x';

      if (state.inputGainNode && state.audioCtx) {
        state.inputGainNode.gain.setTargetAtTime(parseFloat(mult), state.audioCtx.currentTime, 0.02);
      }
    }

    /* --------------------------------------------------------------------------
       MediaRecorder (Records Processed Voice Output)
       -------------------------------------------------------------------------- */
    function getBestAudioMimeType() {
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4',
        'audio/aac'
      ];
      for (let i = 0; i < candidates.length; i++) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) {
          return candidates[i];
        }
      }
      return '';
    }

    function startRecording() {
      const ctx = ensureAudioContext();
      if (!ctx || !state.recordDestNode) {
        showNotice('Audio stream not available for recording.', 'warning');
        return;
      }

      const mimeType = getBestAudioMimeType();
      state.recordedChunks = [];

      try {
        const options = mimeType ? { mimeType } : undefined;
        state.mediaRecorder = new MediaRecorder(state.recordDestNode.stream, options);
      } catch (err) {
        console.error('MediaRecorder initialization failed:', err);
        showNotice('MediaRecorder error: ' + err.message, 'warning');
        return;
      }

      state.mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
      };

      state.mediaRecorder.onstop = finalizeRecording;
      state.mediaRecorder.start(100);
      state.recordingStartTime = Date.now();

      UI.btnRecord.disabled = true;
      UI.btnStopRecord.disabled = false;
      UI.recIndicator.style.display = 'flex';
      UI.recIdleNotice.style.display = 'none';
      setEngineStatus('recording', 'Recording Processed Output');

      state.recordingTimerId = setInterval(() => {
        const elapsed = Date.now() - state.recordingStartTime;
        const totalSec = Math.floor(elapsed / 1000);
        const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
        const secs = String(totalSec % 60).padStart(2, '0');
        const tenths = Math.floor((elapsed % 1000) / 100);
        UI.recTimerDisplay.textContent = `${mins}:${secs}.${tenths}`;
      }, 100);

      UI.recCodecInfo.textContent = `Recording with ${state.mediaRecorder.mimeType || 'audio'} codec &bull; Preset: ${state.activePreset}`;
    }

    function stopRecording() {
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
      }
      if (state.recordingTimerId) {
        clearInterval(state.recordingTimerId);
        state.recordingTimerId = null;
      }

      UI.btnRecord.disabled = false;
      UI.btnStopRecord.disabled = true;
      UI.recIndicator.style.display = 'none';
      UI.recIdleNotice.style.display = 'block';

      if (state.micStream) {
        setEngineStatus('active', 'Microphone Live');
      } else if (state.demoPlaying || state.quickLoopPlaying || state.uploadedPlaying) {
        setEngineStatus('demo', 'Audio Source Active');
      } else {
        setEngineStatus('idle', 'Engine Ready');
      }
    }

    function finalizeRecording() {
      const mime = state.mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(state.recordedChunks, { type: mime });

      if (state.previousObjectUrl) {
        URL.revokeObjectURL(state.previousObjectUrl);
        state.previousObjectUrl = null;
      }

      const audioUrl = URL.createObjectURL(blob);
      state.previousObjectUrl = audioUrl;

      UI.audioPlayer.src = audioUrl;
      UI.audioPlayer.style.display = 'block';

      const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
      const filename = `echoshift-${state.activePreset}-${Date.now()}.${ext}`;
      UI.btnDownload.href = audioUrl;
      UI.btnDownload.download = filename;
      UI.btnDownload.style.display = 'inline-flex';

      showNotice(`Recording finished! Exported ${(blob.size / 1024).toFixed(1)} KB clip. Click Play or Download below.`, 'success');
    }

    /* --------------------------------------------------------------------------
       Real-Time Oscilloscope & Spectrum Visualizer
       -------------------------------------------------------------------------- */
    let lastFrameTime = performance.now();
    let frameCount = 0;
    let fps = 60;

    function setVisualizerMode(mode) {
      state.visualizerMode = mode;
      document.getElementById('btnModeWaveform').classList.toggle('active', mode === 'waveform');
      document.getElementById('btnModeFrequency').classList.toggle('active', mode === 'frequency');
    }

    function startVisualizerLoop() {
      const canvas = UI.canvas;
      const ctx2d = canvas.getContext('2d');

      function render() {
        requestAnimationFrame(render);

        const now = performance.now();
        frameCount++;
        if (now - lastFrameTime >= 1000) {
          fps = frameCount;
          frameCount = 0;
          lastFrameTime = now;
          UI.statFps.textContent = fps + ' FPS';
        }

        const rect = canvas.getBoundingClientRect();
        if (canvas.width !== rect.width || canvas.height !== rect.height) {
          canvas.width = rect.width;
          canvas.height = rect.height;
        }

        const width = canvas.width;
        const height = canvas.height;

        ctx2d.fillStyle = '#060910';
        ctx2d.fillRect(0, 0, width, height);

        // Background Grid
        ctx2d.strokeStyle = 'rgba(28, 39, 60, 0.45)';
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        for (let y = 0; y < height; y += 30) {
          ctx2d.moveTo(0, y);
          ctx2d.lineTo(width, y);
        }
        for (let x = 0; x < width; x += 40) {
          ctx2d.moveTo(x, 0);
          ctx2d.lineTo(x, height);
        }
        ctx2d.stroke();

        if (!state.analyserNode) {
          ctx2d.strokeStyle = 'rgba(56, 189, 248, 0.25)';
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.moveTo(0, height / 2);
          ctx2d.lineTo(width, height / 2);
          ctx2d.stroke();
          return;
        }

        const bufferLength = state.analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        if (state.visualizerMode === 'waveform') {
          state.analyserNode.getByteTimeDomainData(dataArray);

          let sumSquares = 0;
          for (let i = 0; i < bufferLength; i++) {
            const norm = (dataArray[i] - 128) / 128;
            sumSquares += norm * norm;
          }
          const rms = Math.sqrt(sumSquares / bufferLength);
          const db = rms > 0.0001 ? Math.round(20 * Math.log10(rms)) : -60;
          UI.statLevel.textContent = `RMS: ${db} dB`;

          ctx2d.shadowBlur = 10;
          ctx2d.shadowColor = '#38bdf8';
          ctx2d.lineWidth = 2.4;

          const gradient = ctx2d.createLinearGradient(0, 0, width, 0);
          gradient.addColorStop(0, '#38bdf8');
          gradient.addColorStop(0.5, '#818cf8');
          gradient.addColorStop(1, '#38bdf8');
          ctx2d.strokeStyle = gradient;

          ctx2d.beginPath();
          const sliceWidth = width / bufferLength;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * height) / 2;
            if (i === 0) {
              ctx2d.moveTo(x, y);
            } else {
              ctx2d.lineTo(x, y);
            }
            x += sliceWidth;
          }

          ctx2d.stroke();
          ctx2d.shadowBlur = 0;
        } else {
          state.analyserNode.getByteFrequencyData(dataArray);

          const barCount = Math.min(64, bufferLength);
          const barWidth = (width / barCount) - 2;
          let x = 0;

          const barGradient = ctx2d.createLinearGradient(0, height, 0, 0);
          barGradient.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
          barGradient.addColorStop(0.7, '#38bdf8');
          barGradient.addColorStop(1, '#818cf8');
          ctx2d.fillStyle = barGradient;

          for (let i = 0; i < barCount; i++) {
            const barHeight = (dataArray[i] / 255) * (height - 10);
            ctx2d.fillRect(x, height - barHeight, barWidth, barHeight);
            x += barWidth + 2;
          }
        }
      }

      render();
    }

    /* --------------------------------------------------------------------------
       UI Helpers & Status Badges
       -------------------------------------------------------------------------- */
    function setEngineStatus(type, message) {
      UI.statusText.textContent = message;
      UI.statusDot.className = 'status-dot';
      if (type === 'active') UI.statusDot.classList.add('active');
      if (type === 'recording') UI.statusDot.classList.add('recording');
      if (type === 'demo') UI.statusDot.classList.add('demo');
    }

    function showNotice(text, type = 'info') {
      UI.noticeText.innerHTML = text;
      UI.noticeBanner.className = `banner-alert banner-${type}`;
    }

    window.addEventListener('load', () => {
      const rect = UI.canvas.getBoundingClientRect();
      UI.canvas.width = rect.width;
      UI.canvas.height = rect.height;
    });

Object.assign(window, {
  handleAudioFileUpload,
  handleDragLeave,
  handleDragOver,
  handleFileDrop,
  selectFilterPreset,
  setVisualizerMode,
  setVolumeQuick,
  startRecording,
  stopRecording,
  switchSourceTab,
  toggleLiveMonitoring,
  toggleMicrophone,
  toggleSpokenDemo,
  toggleUploadedAudioPlay,
  updateInputGain,
  updateMonitorVolume,
});
