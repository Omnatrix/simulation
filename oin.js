
    /**
     * 4-WHEEL DRIVE RC CAR CIRCUIT SIMULATOR
     * Hardware: Arduino UNO R3 + Dual L293D H-Bridge Drivers
     * Steering: Differential / Skid-Tank Steering
     */
    (function () {
      'use strict';

      // --- State Model ---
      const state = {
        command: 'STOP',      // 'STOP', 'FORWARD', 'BACKWARD', 'LEFT', 'RIGHT'
        pwm: 220,             // 0 - 255
        soundEnabled: true,
        activeKeys: new Set(),
        motorStatus: {
          FL: 'STOP', // 'FWD', 'REV', 'STOP'
          FR: 'STOP',
          RL: 'STOP',
          RR: 'STOP'
        }
      };

      // --- DOM Elements ---
      const elements = {
        // D-Pad buttons
        btnForward: document.getElementById('btnForward'),
        btnBackward: document.getElementById('btnBackward'),
        btnLeft: document.getElementById('btnLeft'),
        btnRight: document.getElementById('btnRight'),
        dpadStatusText: document.getElementById('dpadStatusText'),
        driveModeText: document.getElementById('driveModeText'),
        pwmSlider: document.getElementById('pwmSlider'),
        pwmValueText: document.getElementById('pwmValueText'),

        // Motors & Wheels
        hubs: {
          FL: document.getElementById('hubFL'),
          FR: document.getElementById('hubFR'),
          RL: document.getElementById('hubRL'),
          RR: document.getElementById('hubRR')
        },
        treads: {
          FL: document.getElementById('treadFL'),
          FR: document.getElementById('treadFR'),
          RL: document.getElementById('treadRL'),
          RR: document.getElementById('treadRR')
        },
        tags: {
          FL: document.getElementById('tagFL'),
          FR: document.getElementById('tagFR'),
          RL: document.getElementById('tagRL'),
          RR: document.getElementById('tagRR')
        },

        // Vector Arrow
        vectorArrow: document.getElementById('vectorArrow'),
        vectorArrowSvg: document.getElementById('vectorArrowSvg'),

        // Telemetry readouts
        lblCurrent: document.getElementById('lblCurrent'),
        lblRpm: document.getElementById('lblRpm'),
        lblDifferential: document.getElementById('lblDifferential'),

        // L293D Circuit Logic Indicators
        ledEnA: document.getElementById('ledEnA'),
        valEnA: document.getElementById('valEnA'),
        ledIn1: document.getElementById('ledIn1'),
        valIn1: document.getElementById('valIn1'),
        ledIn2: document.getElementById('ledIn2'),
        valIn2: document.getElementById('valIn2'),
        driverAStatus: document.getElementById('driverAStatus'),

        ledEnB: document.getElementById('ledEnB'),
        valEnB: document.getElementById('valEnB'),
        ledIn3: document.getElementById('ledIn3'),
        valIn3: document.getElementById('valIn3'),
        ledIn4: document.getElementById('ledIn4'),
        valIn4: document.getElementById('valIn4'),
        driverBStatus: document.getElementById('driverBStatus'),

        // IC legs
        legA1: document.getElementById('legA1'),
        legA2: document.getElementById('legA2'),
        legB1: document.getElementById('legB1'),
        legB2: document.getElementById('legB2'),

        // Truth table rows
        rowFwd: document.getElementById('rowFwd'),
        rowRev: document.getElementById('rowRev'),
        rowLeft: document.getElementById('rowLeft'),
        rowRight: document.getElementById('rowRight'),

        // Sound Toggle
        btnSoundToggle: document.getElementById('btnSoundToggle'),
        soundIcon: document.getElementById('soundIcon'),
        soundLabel: document.getElementById('soundLabel')
      };

      // --- Sound Synthesizer (Web Audio API) ---
      let audioCtx = null;
      let motorOsc1 = null;
      let motorOsc2 = null;
      let motorGain = null;

      function initAudio() {
        if (!audioCtx) {
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          if (!AudioContext) return;
          audioCtx = new AudioContext();

          // Dual oscillator motor whine
          motorOsc1 = audioCtx.createOscillator();
          motorOsc2 = audioCtx.createOscillator();
          motorGain = audioCtx.createGain();

          motorOsc1.type = 'sawtooth';
          motorOsc2.type = 'triangle';

          motorOsc1.frequency.setValueAtTime(65, audioCtx.currentTime);
          motorOsc2.frequency.setValueAtTime(130, audioCtx.currentTime);

          motorGain.gain.setValueAtTime(0, audioCtx.currentTime);

          motorOsc1.connect(motorGain);
          motorOsc2.connect(motorGain);
          motorGain.connect(audioCtx.destination);

          motorOsc1.start();
          motorOsc2.start();
        }
      }

      function updateSound(isPlaying, pwmVal) {
        if (!state.soundEnabled || !audioCtx || !motorGain) return;

        const now = audioCtx.currentTime;
        if (isPlaying) {
          // Calculate frequency based on PWM
          const baseFreq = 50 + (pwmVal / 255) * 85;
          motorOsc1.frequency.setTargetAtTime(baseFreq, now, 0.05);
          motorOsc2.frequency.setTargetAtTime(baseFreq * 2.1, now, 0.05);
          motorGain.gain.setTargetAtTime(0.08, now, 0.04);
        } else {
          motorGain.gain.setTargetAtTime(0, now, 0.05);
        }
      }

      // --- Dynamic Speed Calculation ---
      function updateSpeedTokens() {
        // Higher PWM = faster rotation = shorter animation duration
        // PWM 100 -> ~1.1s, PWM 255 -> ~0.28s
        const durationSec = (1.55 - (state.pwm / 255) * 1.25).toFixed(3);
        document.documentElement.style.setProperty('--motor-duration', durationSec + 's');
        
        elements.pwmValueText.textContent = `${state.pwm} (${Math.round((state.pwm / 255) * 100)}%)`;
      }

      // --- Clear all motor animations ---
      function resetMotorAnimations() {
        ['FL', 'FR', 'RL', 'RR'].forEach(id => {
          elements.hubs[id].classList.remove('anim-spin-cw', 'anim-spin-ccw');
          elements.treads[id].classList.remove('anim-tread-fwd', 'anim-tread-rev');
          elements.tags[id].className = 'tag-state';
          elements.tags[id].textContent = 'STOP';
        });

        // Reset D-pad active button styles
        [elements.btnForward, elements.btnBackward, elements.btnLeft, elements.btnRight].forEach(btn => {
          btn.classList.remove('active');
        });

        // Reset truth table highlights
        [elements.rowFwd, elements.rowRev, elements.rowLeft, elements.rowRight].forEach(row => {
          row.classList.remove('active-row');
        });

        // Hide vector arrow
        elements.vectorArrow.classList.remove('visible');
      }

      // --- Set Individual Motor Animation State ---
      /**
       * In our 4WD chassis top-down view:
       * - Left-side motors (FL, RL):
       *   Forward rotation spins counter-clockwise on the screen (anim-spin-ccw) with tread rolling forward.
       *   Reverse rotation spins clockwise (anim-spin-cw) with tread rolling backward.
       * - Right-side motors (FR, RR):
       *   Forward rotation spins clockwise (anim-spin-cw) with tread rolling forward.
       *   Reverse rotation spins counter-clockwise (anim-spin-ccw) with tread rolling backward.
       */
      function applyMotorState(motorId, dir) {
        const hub = elements.hubs[motorId];
        const tread = elements.treads[motorId];
        const tag = elements.tags[motorId];
        const isLeftSide = (motorId === 'FL' || motorId === 'RL');

        hub.classList.remove('anim-spin-cw', 'anim-spin-ccw');
        tread.classList.remove('anim-tread-fwd', 'anim-tread-rev');
        tag.className = 'tag-state';

        if (dir === 'FWD') {
          hub.classList.add(isLeftSide ? 'anim-spin-ccw' : 'anim-spin-cw');
          tread.classList.add('anim-tread-fwd');
          tag.classList.add('fwd');
          tag.textContent = 'FWD';
          state.motorStatus[motorId] = 'FWD';
        } else if (dir === 'REV') {
          hub.classList.add(isLeftSide ? 'anim-spin-cw' : 'anim-spin-ccw');
          tread.classList.add('anim-tread-rev');
          tag.classList.add('rev');
          tag.textContent = 'REV';
          state.motorStatus[motorId] = 'REV';
        } else {
          tag.textContent = 'STOP';
          state.motorStatus[motorId] = 'STOP';
        }
      }

      // --- Apply Skid/Tank Steering Rules ---
      function applyCommand(cmd) {
        state.command = cmd;
        resetMotorAnimations();

        let l293A = { in1: 0, in2: 0, status: 'IDLE' };
        let l293B = { in3: 0, in4: 0, status: 'IDLE' };
        let arrowAngle = 0;
        let differential = 0.0;
        let currentDraw = '80 mA (Idle)';
        let approxRpm = 0;

        const maxRpm = Math.round((state.pwm / 255) * 195);

        switch (cmd) {
          case 'FORWARD':
            // Specification: All four motors rotate forward simultaneously
            applyMotorState('FL', 'FWD');
            applyMotorState('FR', 'FWD');
            applyMotorState('RL', 'FWD');
            applyMotorState('RR', 'FWD');

            elements.btnForward.classList.add('active');
            elements.rowFwd.classList.add('active-row');
            elements.driveModeText.textContent = 'FORWARD (ALL 4WD)';
            elements.dpadStatusText.textContent = 'FORWARD';

            // Hardware H-Bridge logic: Left (IN1=1, IN2=0), Right (IN3=1, IN4=0)
            l293A = { in1: 1, in2: 0, status: 'FORWARD' };
            l293B = { in3: 1, in4: 0, status: 'FORWARD' };
            arrowAngle = 0;
            differential = 0.0;
            currentDraw = `${Math.round(480 + (state.pwm / 255) * 220)} mA`;
            approxRpm = maxRpm;
            break;

          case 'BACKWARD':
            // Specification: All four motors rotate in reverse
            applyMotorState('FL', 'REV');
            applyMotorState('FR', 'REV');
            applyMotorState('RL', 'REV');
            applyMotorState('RR', 'REV');

            elements.btnBackward.classList.add('active');
            elements.rowRev.classList.add('active-row');
            elements.driveModeText.textContent = 'REVERSE (ALL 4WD)';
            elements.dpadStatusText.textContent = 'REVERSE';

            // Hardware H-Bridge logic: Left (IN1=0, IN2=1), Right (IN3=0, IN4=1)
            l293A = { in1: 0, in2: 1, status: 'REVERSE' };
            l293B = { in3: 0, in4: 1, status: 'REVERSE' };
            arrowAngle = 180;
            differential = 0.0;
            currentDraw = `${Math.round(500 + (state.pwm / 255) * 230)} mA`;
            approxRpm = -maxRpm;
            break;

          case 'LEFT':
            // Specification: Right-side motors rotate forward; Left-side motors rotate in reverse
            applyMotorState('FL', 'REV');
            applyMotorState('RL', 'REV');
            applyMotorState('FR', 'FWD');
            applyMotorState('RR', 'FWD');

            elements.btnLeft.classList.add('active');
            elements.rowLeft.classList.add('active-row');
            elements.driveModeText.textContent = 'SKID LEFT (PIVOT)';
            elements.dpadStatusText.textContent = 'SKID-L';

            // Hardware H-Bridge logic: Left (IN1=0, IN2=1), Right (IN3=1, IN4=0)
            l293A = { in1: 0, in2: 1, status: 'REVERSE' };
            l293B = { in3: 1, in4: 0, status: 'FORWARD' };
            arrowAngle = -90;
            differential = -2.0;
            currentDraw = `${Math.round(620 + (state.pwm / 255) * 280)} mA (Peak)`;
            approxRpm = maxRpm;
            break;

          case 'RIGHT':
            // Specification: Left-side motors rotate forward; Right-side motors rotate in reverse
            applyMotorState('FL', 'FWD');
            applyMotorState('RL', 'FWD');
            applyMotorState('FR', 'REV');
            applyMotorState('RR', 'REV');

            elements.btnRight.classList.add('active');
            elements.rowRight.classList.add('active-row');
            elements.driveModeText.textContent = 'SKID RIGHT (PIVOT)';
            elements.dpadStatusText.textContent = 'SKID-R';

            // Hardware H-Bridge logic: Left (IN1=1, IN2=0), Right (IN3=0, IN4=1)
            l293A = { in1: 1, in2: 0, status: 'FORWARD' };
            l293B = { in3: 0, in4: 1, status: 'REVERSE' };
            arrowAngle = 90;
            differential = 2.0;
            currentDraw = `${Math.round(620 + (state.pwm / 255) * 280)} mA (Peak)`;
            approxRpm = maxRpm;
            break;

          case 'STOP':
          default:
            applyMotorState('FL', 'STOP');
            applyMotorState('FR', 'STOP');
            applyMotorState('RL', 'STOP');
            applyMotorState('RR', 'STOP');

            elements.driveModeText.textContent = 'NEUTRAL / HALTED';
            elements.dpadStatusText.textContent = 'IDLE';
            l293A = { in1: 0, in2: 0, status: 'OFF' };
            l293B = { in3: 0, in4: 0, status: 'OFF' };
            differential = 0.0;
            currentDraw = '80 mA (Idle)';
            approxRpm = 0;
            break;
        }

        // Update Direction Vector Compass
        if (cmd !== 'STOP') {
          elements.vectorArrow.classList.add('visible');
          elements.vectorArrowSvg.style.transform = `rotate(${arrowAngle}deg)`;
        }

        // Update Dual L293D Hardware Telemetry
        const isMoving = (cmd !== 'STOP');
        const pwmDuty = isMoving ? state.pwm : 0;

        // Driver A (Left)
        elements.valEnA.textContent = pwmDuty;
        elements.ledEnA.className = 'logic-indicator pwm ' + (isMoving ? 'high' : 'low');
        elements.valIn1.textContent = l293A.in1;
        elements.ledIn1.className = 'logic-indicator ' + (l293A.in1 ? 'high' : 'low');
        elements.valIn2.textContent = l293A.in2;
        elements.ledIn2.className = 'logic-indicator ' + (l293A.in2 ? 'high' : 'low');
        elements.driverAStatus.textContent = l293A.status;
        elements.driverAStatus.style.color = (l293A.status === 'FORWARD') ? 'var(--green-logic)' : (l293A.status === 'REVERSE' ? 'var(--red-logic)' : 'var(--text-muted)');

        // Driver B (Right)
        elements.valEnB.textContent = pwmDuty;
        elements.ledEnB.className = 'logic-indicator pwm ' + (isMoving ? 'high' : 'low');
        elements.valIn3.textContent = l293B.in3;
        elements.ledIn3.className = 'logic-indicator ' + (l293B.in3 ? 'high' : 'low');
        elements.valIn4.textContent = l293B.in4;
        elements.ledIn4.className = 'logic-indicator ' + (l293B.in4 ? 'high' : 'low');
        elements.driverBStatus.textContent = l293B.status;
        elements.driverBStatus.style.color = (l293B.status === 'FORWARD') ? 'var(--green-logic)' : (l293B.status === 'REVERSE' ? 'var(--red-logic)' : 'var(--text-muted)');

        // Micro-IC legs illumination
        elements.legA1.className = 'ic-leg ' + (l293A.in1 ? 'hot-fwd' : (l293A.in2 ? 'hot-rev' : ''));
        elements.legA2.className = 'ic-leg ' + (isMoving ? 'hot-fwd' : '');
        elements.legB1.className = 'ic-leg ' + (l293B.in3 ? 'hot-fwd' : (l293B.in4 ? 'hot-rev' : ''));
        elements.legB2.className = 'ic-leg ' + (isMoving ? 'hot-fwd' : '');

        // Telemetry stats
        elements.lblCurrent.textContent = currentDraw;
        elements.lblRpm.textContent = `${approxRpm} RPM`;
        elements.lblDifferential.textContent = differential.toFixed(2);

        // Update synthesized motor audio
        updateSound(isMoving, state.pwm);
      }

      function stopMotors() {
        applyCommand('STOP');
      }

      // --- Bind Mouse & Touch Events for Immediate Response ---
      function setupButtonInteraction(btn, commandName) {
        // Mousedown handler
        btn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          initAudio();
          applyCommand(commandName);
        });

        // Touchstart handler for mobile/tablet
        btn.addEventListener('touchstart', function (e) {
          e.preventDefault();
          initAudio();
          applyCommand(commandName);
        }, { passive: false });

        // Halt on mouseleave or mouseup
        btn.addEventListener('mouseup', function (e) {
          e.preventDefault();
          stopMotors();
        });

        btn.addEventListener('mouseleave', function () {
          if (state.command === commandName) {
            stopMotors();
          }
        });

        btn.addEventListener('touchend', function (e) {
          e.preventDefault();
          stopMotors();
        });

        btn.addEventListener('touchcancel', function (e) {
          e.preventDefault();
          stopMotors();
        });
      }

      setupButtonInteraction(elements.btnForward, 'FORWARD');
      setupButtonInteraction(elements.btnBackward, 'BACKWARD');
      setupButtonInteraction(elements.btnLeft, 'LEFT');
      setupButtonInteraction(elements.btnRight, 'RIGHT');

      // Global safety release if mouse leaves window or releases elsewhere
      window.addEventListener('mouseup', function () {
        if (state.command !== 'STOP' && state.activeKeys.size === 0) {
          stopMotors();
        }
      });

      window.addEventListener('blur', function () {
        state.activeKeys.clear();
        stopMotors();
      });

      // --- Keyboard Controls Handler ---
      const keyMap = {
        'KeyW': 'FORWARD',
        'ArrowUp': 'FORWARD',
        'KeyS': 'BACKWARD',
        'ArrowDown': 'BACKWARD',
        'KeyA': 'LEFT',
        'ArrowLeft': 'LEFT',
        'KeyD': 'RIGHT',
        'ArrowRight': 'RIGHT'
      };

      window.addEventListener('keydown', function (e) {
        if (e.repeat) return;

        if (e.code === 'Space') {
          e.preventDefault();
          state.activeKeys.clear();
          stopMotors();
          return;
        }

        if (keyMap[e.code]) {
          e.preventDefault();
          initAudio();
          state.activeKeys.add(e.code);
          applyCommand(keyMap[e.code]);
        }
      });

      window.addEventListener('keyup', function (e) {
        if (keyMap[e.code]) {
          state.activeKeys.delete(e.code);
          if (state.activeKeys.size === 0) {
            stopMotors();
          } else {
            // Apply last pressed key if multiple keys were pressed
            const remainingKeys = Array.from(state.activeKeys);
            const lastKey = remainingKeys[remainingKeys.length - 1];
            applyCommand(keyMap[lastKey]);
          }
        }
      });

      // --- PWM Slider Event Listener ---
      elements.pwmSlider.addEventListener('input', function (e) {
        state.pwm = parseInt(e.target.value, 10);
        updateSpeedTokens();
        if (state.command !== 'STOP') {
          applyCommand(state.command);
        }
      });

      // --- Audio Toggle Handler ---
      elements.btnSoundToggle.addEventListener('click', function () {
        initAudio();
        state.soundEnabled = !state.soundEnabled;
        if (state.soundEnabled) {
          elements.soundIcon.textContent = '🔊';
          elements.soundLabel.textContent = 'Sound ON';
          if (state.command !== 'STOP') {
            updateSound(true, state.pwm);
          }
        } else {
          elements.soundIcon.textContent = '🔇';
          elements.soundLabel.textContent = 'Muted';
          updateSound(false, 0);
        }
      });

      // --- Initialize Defaults ---
      updateSpeedTokens();
      stopMotors();

    })();
  