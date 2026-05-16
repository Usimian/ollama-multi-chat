// Avatar renderer + audio queue + push-to-talk recorder.
// Drives a ReadyPlayerMe avatar's mouth/jaw blendshapes from the playing-audio RMS.

import * as THREE from "/static/vendor/three.module.min.js";
import { GLTFLoader } from "/static/vendor/GLTFLoader.js";

const DEFAULT_AVATAR_URL = "/static/avatar.glb";

const MOUTH_MORPHS = [
  "jawOpen", "mouthOpen", "viseme_aa", "viseme_O", "viseme_E",
];

export class Avatar {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    this.camera.position.set(0, 1.55, 1.3);
    this.camera.lookAt(0, 1.55, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x404060, 0.8);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, 2, 2);
    this.scene.add(dir);

    this.mouthTargets = []; // { mesh, indices: number[] }
    this.blinkTargets = [];
    this.currentMouth = 0;  // 0..1, smoothed
    this.targetMouth = 0;
    this.blinkTimer = 0;
    this.blinkPhase = 0;

    this._resize();
    window.addEventListener("resize", () => this._resize());
    this._animate();
  }

  _resize() {
    const w = this.canvas.clientWidth || 400;
    const h = this.canvas.clientHeight || 500;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async load(url = DEFAULT_AVATAR_URL) {
    if (this.avatar) this.scene.remove(this.avatar);
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    this.avatar = gltf.scene;
    this.scene.add(this.avatar);

    this.mouthTargets = [];
    this.blinkTargets = [];
    this.avatar.traverse((node) => {
      if (!node.isMesh || !node.morphTargetDictionary) return;
      const dict = node.morphTargetDictionary;
      const mouthIdx = MOUTH_MORPHS.map((n) => dict[n]).filter((i) => i !== undefined);
      if (mouthIdx.length) this.mouthTargets.push({ mesh: node, indices: mouthIdx });
      const blinkL = dict["eyeBlinkLeft"] ?? dict["eyesClosed"];
      const blinkR = dict["eyeBlinkRight"] ?? dict["eyesClosed"];
      const blinkIdx = [blinkL, blinkR].filter((i) => i !== undefined);
      if (blinkIdx.length) this.blinkTargets.push({ mesh: node, indices: blinkIdx });
    });
  }

  setMouth(level) {
    // level in [0,1]
    this.targetMouth = Math.max(0, Math.min(1, level));
  }

  _animate() {
    const tick = () => {
      // smooth mouth
      this.currentMouth += (this.targetMouth - this.currentMouth) * 0.35;
      for (const { mesh, indices } of this.mouthTargets) {
        for (const i of indices) mesh.morphTargetInfluences[i] = this.currentMouth;
      }

      // simple blink ~ every 4s
      this.blinkTimer += 1 / 60;
      let blink = 0;
      if (this.blinkTimer > 4) {
        this.blinkPhase += 1 / 60;
        const t = this.blinkPhase / 0.18;
        blink = t < 1 ? Math.sin(t * Math.PI) : 0;
        if (this.blinkPhase > 0.18) {
          this.blinkPhase = 0;
          this.blinkTimer = 0;
        }
      }
      for (const { mesh, indices } of this.blinkTargets) {
        for (const i of indices) mesh.morphTargetInfluences[i] = blink;
      }

      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(tick);
    };
    tick();
  }
}


// ---------- Audio queue + RMS-driven mouth ----------

export class AudioQueue {
  constructor(avatar) {
    this.avatar = avatar;
    this.ctx = null;
    this.analyser = null;
    this.nextTime = 0;
    this.queue = Promise.resolve();
    this._rmsLoop();
  }

  _ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
    this.rmsBuf = new Float32Array(this.analyser.fftSize);
  }

  _rmsLoop() {
    const tick = () => {
      if (this.analyser) {
        this.analyser.getFloatTimeDomainData(this.rmsBuf);
        let sum = 0;
        for (let i = 0; i < this.rmsBuf.length; i++) sum += this.rmsBuf[i] * this.rmsBuf[i];
        const rms = Math.sqrt(sum / this.rmsBuf.length);
        // map ~0.005..0.25 RMS → 0..1 mouth
        const level = Math.max(0, Math.min(1, (rms - 0.005) * 6));
        this.avatar.setMouth(level);
      } else {
        this.avatar.setMouth(0);
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  enqueueWavBase64(b64) {
    this.queue = this.queue.then(() => this._playOne(b64));
  }

  async _playOne(b64) {
    this._ensureCtx();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buffer = await this.ctx.decodeAudioData(bytes.buffer);
    const start = Math.max(this.ctx.currentTime, this.nextTime);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    src.start(start);
    this.nextTime = start + buffer.duration;
    await new Promise((res) => { src.onended = res; });
  }

  reset() {
    if (this.ctx) this.nextTime = this.ctx.currentTime;
  }
}


// ---------- Push-to-talk recorder ----------

export class PushToTalk {
  constructor({ onTranscript, button, sttUrl = "/api/stt" }) {
    this.onTranscript = onTranscript;
    this.button = button;
    this.sttUrl = sttUrl;
    this.recorder = null;
    this.chunks = [];
    this.recording = false;

    const begin = (e) => { e.preventDefault(); this.start(); };
    const end = (e) => { e.preventDefault(); this.stop(); };

    button.addEventListener("mousedown", begin);
    button.addEventListener("mouseup", end);
    button.addEventListener("mouseleave", () => { if (this.recording) this.stop(); });
    button.addEventListener("touchstart", begin);
    button.addEventListener("touchend", end);

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !e.repeat && !this._isTyping(e.target)) {
        e.preventDefault();
        this.start();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space" && !this._isTyping(e.target)) {
        e.preventDefault();
        this.stop();
      }
    });
  }

  _isTyping(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  _status(s) {
    const el = document.getElementById("mic-status");
    if (el) el.textContent = s;
    console.log("[ptt]", s);
  }

  async start() {
    if (this.recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
      this.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      this.mime = this.recorder.mimeType || "audio/webm";
      this.chunks = [];
      this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      this.recorder.onstop = () => this._finish(stream);
      this.recorder.start();
      this.recording = true;
      this.button.classList.add("recording");
      this._status("recording…");
    } catch (e) {
      console.error("mic error", e);
      this._status(`mic error: ${e.message}`);
    }
  }

  stop() {
    if (!this.recording || !this.recorder) return;
    this.recording = false;
    this.button.classList.remove("recording");
    this.recorder.stop();
  }

  async _finish(stream) {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
    this._status(`uploading ${(blob.size/1024).toFixed(1)} KB…`);
    if (blob.size < 800) { this._status("too short — try again"); return; }
    const form = new FormData();
    const ext = (this.mime || "").includes("webm") ? "webm" : "ogg";
    form.append("file", blob, `speech.${ext}`);
    try {
      const r = await fetch(this.sttUrl, { method: "POST", body: form });
      const data = await r.json();
      if (data.error) { this._status(`stt error: ${data.error}`); return; }
      if (!data.text) { this._status("stt: (no speech detected)"); return; }
      this._status(`you: ${data.text}`);
      if (this.onTranscript) this.onTranscript(data.text);
    } catch (e) {
      console.error("stt error", e);
      this._status(`stt error: ${e.message}`);
    }
  }
}
