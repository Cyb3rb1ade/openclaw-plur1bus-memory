#!/usr/bin/env node
/**
 * Discord Voice STT — joins voice channels automatically and posts transcripts.
 *
 * Modes:
 *  VOICE_AGENT_ENABLED=false (default):
 *    Batch STT: collect Opus → decode PCM → ffmpeg → POST nemotron bridge → post transcript
 *
 *  VOICE_AGENT_ENABLED=true:
 *    Real-time agent: streaming ASR (port 8021) → trigger detection ("bernd") →
 *    OpenClaw gateway LLM → TTS (port 8025) → AudioPlayer voice playback
 */

import {
  Client,
  GatewayIntentBits,
  ChannelType,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
} from "@discordjs/voice";
import prism from "prism-media";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import https from "node:https";
import http from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// ── Config ──────────────────────────────────────────────────────────────────

const VOICE_AGENT_ENABLED = process.env.VOICE_AGENT_ENABLED === "true";
const VOICE_DEBUG = process.env.VOICE_DEBUG === "true";
const VOICE_GUILD_ALLOWLIST = process.env.VOICE_GUILD_ALLOWLIST
  ? process.env.VOICE_GUILD_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const NEMOTRON_URL =
  process.env.NEMOTRON_URL ||
  "http://127.0.0.1:8020/v1/audio/transcriptions";
const ASR_STREAM_URL =
  process.env.ASR_STREAM_URL || "ws://127.0.0.1:8021/stream";
const MAGPIE_URL =
  process.env.MAGPIE_URL || "http://127.0.0.1:8025/v1/audio/speech";

const SILENCE_DURATION_MS = parseInt(process.env.SILENCE_DURATION_MS || "700");
const MIN_AUDIO_MS = parseInt(process.env.MIN_AUDIO_MS || "300");

// Trigger settings
const TRIGGER_COOLDOWN_MS = 2000;
const ASR_SILENCE_FALLBACK_MS = 3000;
const UTTERANCE_MAX_MS = 30000;

// LLM timeouts
const LLM_FIRST_TOKEN_TIMEOUT_MS = 5000;
const LLM_IDLE_TIMEOUT_MS = 3000;
const LLM_TOTAL_TIMEOUT_MS = 30000;

// TTS settings
const TTS_MAX_CHARS = 400;
const LLM_MAX_TEXT_CHARS = 3000;

// ── Load OpenClaw config ─────────────────────────────────────────────────────

let _openClawConfig = null;
function getOpenClawConfig() {
  if (_openClawConfig) return _openClawConfig;
  try {
    _openClawConfig = JSON.parse(readFileSync("/root/.openclaw/openclaw.json", "utf8"));
  } catch {
    _openClawConfig = {};
  }
  return _openClawConfig;
}

function loadTokenFromOpenClaw() {
  try {
    const cfg = getOpenClawConfig();
    return cfg?.channels?.discord?.accounts?.default?.token;
  } catch {
    return null;
  }
}

function getGatewayPort() {
  try {
    const cfg = getOpenClawConfig();
    return cfg?.gateway?.port || 18789;
  } catch {
    return 18789;
  }
}

function getGatewayToken() {
  try {
    const cfg = getOpenClawConfig();
    return cfg?.gateway?.auth?.token || "";
  } catch {
    return "";
  }
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || loadTokenFromOpenClaw();

if (!DISCORD_TOKEN) {
  console.error("[discord-voice-stt] No DISCORD_TOKEN found. Exiting.");
  process.exit(1);
}

// ── Exported pure functions (tested by unit tests) ──────────────────────────

/**
 * Normalise text for trigger detection: lowercase, strip punctuation, collapse whitespace.
 */
export function normaliseTrigger(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true if text contains "bernd" as a whole word.
 */
export function hasTrigger(text) {
  return /\bbernd\b/i.test(normaliseTrigger(text));
}

/**
 * Split text into TTS-safe chunks of at most maxChars each.
 * Order of splits: sentence (.!?) → clause (;:,) → word boundary.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function splitIntoTtsChunks(text, maxChars = TTS_MAX_CHARS) {
  // 1. Normalise
  const normalised = text.replace(/\s+/g, " ").trim();
  if (!normalised) return [];
  if (normalised.length <= maxChars) return [normalised];
  // Hard split for no-space inputs that exceed maxChars
  if (!/\s/.test(normalised)) {
    const out = [];
    let s = normalised;
    while (s.length > maxChars) { out.push(s.slice(0, maxChars)); s = s.slice(maxChars); }
    if (s.length > 0) out.push(s);
    return out;
  }

  const chunks = [];

  /**
   * Split `s` at sentence boundaries keeping delimiters, then recurse into clause, then word.
   */
  function splitAtSentences(s) {
    // Split at .!? — keep the delimiter with the preceding segment
    const parts = s.split(/(?<=[.!?])\s+/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.length <= maxChars) {
        chunks.push(trimmed);
      } else {
        splitAtClauses(trimmed);
      }
    }
  }

  function splitAtClauses(s) {
    const parts = s.split(/(?<=[;:,])\s+/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.length <= maxChars) {
        chunks.push(trimmed);
      } else {
        splitAtWords(trimmed);
      }
    }
  }

  function splitAtWords(s) {
    const words = s.split(" ");
    let current = "";
    const result = [];
    for (const word of words) {
      if (!current) {
        current = word;
      } else if ((current + " " + word).length <= maxChars) {
        current += " " + word;
      } else {
        if (current) result.push(current);
        current = word;
      }
    }
    if (current) result.push(current);

    // Hard fallback: if any piece still exceeds maxChars (e.g. URL, no-space token), slice it
    const hardSplit = [];
    for (const piece of result) {
      if (piece.length <= maxChars) {
        hardSplit.push(piece);
      } else {
        let s = piece;
        while (s.length > maxChars) {
          hardSplit.push(s.slice(0, maxChars));
          s = s.slice(maxChars);
        }
        if (s.length > 0) hardSplit.push(s);
      }
    }
    for (const piece of hardSplit) chunks.push(piece);
  }

  splitAtSentences(normalised);
  return chunks;
}

/**
 * ByteAccumulator: accumulates raw PCM chunks and emits 640-byte frames.
 * Performs stereo→mono downmix and 48kHz→16kHz decimation inline.
 */
export class ByteAccumulator {
  constructor(onFrame) {
    this._onFrame = onFrame;
    this._buf = Buffer.alloc(0);
  }

  /**
   * Push a raw PCM chunk (s16le 48kHz stereo = 3840 bytes per 20ms frame).
   * For every 3840 bytes: downmix stereo→mono, decimate 48→16kHz, emit 640-byte frame.
   * @param {Buffer} chunk
   */
  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    const STEREO_FRAME = 3840; // 960 samples/ch * 2ch * 2 bytes
    while (this._buf.length >= STEREO_FRAME) {
      const frame = this._buf.slice(0, STEREO_FRAME);
      this._buf = this._buf.slice(STEREO_FRAME);
      const outFrame = this._downmixAndDecimate(frame);
      this._onFrame(outFrame);
    }
  }

  /**
   * Discard accumulated buffer (e.g. on session end).
   */
  reset() {
    this._buf = Buffer.alloc(0);
  }

  /**
   * Downmix stereo→mono + decimate 48kHz→16kHz.
   * Input: 3840 bytes (960 stereo int16 samples)
   * Output: 640 bytes (320 mono int16 samples)
   */
  _downmixAndDecimate(frame) {
    // 960 stereo samples = 1920 int16 values in the frame (L,R,L,R,...)
    // After mono: 960 mono samples
    // After 3x decimation: 320 mono samples = 640 bytes
    const out = Buffer.allocUnsafe(640);
    let outIdx = 0;

    for (let i = 0; i < 960; i++) {
      // Only keep every 3rd sample (0, 3, 6, ...) for 48kHz→16kHz
      if (i % 3 !== 0) continue;

      const byteOffset = i * 4; // each stereo sample = 2 int16 = 4 bytes
      const left = frame.readInt16LE(byteOffset);
      const right = frame.readInt16LE(byteOffset + 2);
      // Mono mix: (left + right) / 2, clamped to int16 range
      let mono = Math.round((left + right) / 2);
      if (mono > 32767) mono = 32767;
      if (mono < -32768) mono = -32768;
      out.writeInt16LE(mono, outIdx);
      outIdx += 2;
    }

    return out;
  }
}

// ── Audio helpers (batch mode) ───────────────────────────────────────────────

/** Convert raw 16-bit stereo 48kHz PCM → 16kHz mono WAV via ffmpeg (stdin→stdout). */
function pcmToWav(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-f", "s16le", "-ar", "48000", "-ac", "2",
      "-i", "pipe:0",
      "-ar", "16000", "-ac", "1",
      "-acodec", "pcm_s16le",
      "-f", "wav",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stdout.on("end", () => resolve(Buffer.concat(chunks)));
    ff.stderr.on("data", () => {}); // suppress ffmpeg logs
    ff.on("error", reject);
    ff.stdin.write(pcmBuffer);
    ff.stdin.end();
  });
}

/** POST WAV buffer to nemotron-speech bridge, return transcript string. */
async function transcribe(wavBuffer, username) {
  const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
  const filename = `audio-${Date.now()}.wav`;

  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`
  );
  const middle = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nnemotron-speech\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n--${boundary}--\r\n`
  );
  const body = Buffer.concat([header, wavBuffer, middle]);

  const url = new URL(NEMOTRON_URL);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          Authorization: "Bearer local-discord-voice",
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            resolve(json.text || "");
          } catch {
            resolve("");
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("STT request timed out")); });
    req.write(body);
    req.end();
  });
}

// ── OpenClaw Gateway WS Client ───────────────────────────────────────────────

/**
 * Singleton gateway WebSocket connection (shared across all guilds).
 * Reconnects with exponential backoff: 1s, 2s, 4s, 8s (max 4 attempts).
 */
class GatewayClient {
  constructor() {
    this._ws = null;
    this._ready = false;
    this._pendingCallbacks = new Map(); // id → {resolve, reject}
    this._eventListeners = []; // [{filter, callback}]
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 4;
    this._reconnectDelays = [1000, 2000, 4000, 8000];
    this._connecting = false;
    this._destroyed = false;
  }

  get isReady() {
    return this._ready;
  }

  async connect() {
    if (this._connecting || this._ready) return;
    this._connecting = true;

    const port = getGatewayPort();
    const token = getGatewayToken();
    const url = `ws://127.0.0.1:${port}`;

    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        this._connecting = false;
        reject(err);
        return;
      }
      this._ws = ws;

      ws.once("open", () => {
        // Wait for connect.challenge
      });

      ws.once("error", (err) => {
        this._connecting = false;
        this._ready = false;
        reject(err);
      });

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Step 2: Handle connect.challenge
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const nonce = msg.payload?.nonce;
          ws.send(JSON.stringify({
            type: "req",
            id: "conn-1",
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client: { id: "cli", version: "1.0.0", platform: "linux", mode: "cli" },
              caps: [],
              role: "operator",
              auth: { token },
              device: { nonce, id: "voice-bot-001" },
            },
          }));
          return;
        }

        // Step 4: Handle connect response
        if (msg.type === "res" && msg.id === "conn-1") {
          this._connecting = false;
          if (msg.ok) {
            this._ready = true;
            this._reconnectAttempts = 0;
            console.log("[gateway] Connected to OpenClaw gateway");
            resolve();
          } else {
            this._ready = false;
            const err = new Error(`Gateway connect failed: ${JSON.stringify(msg.error)}`);
            reject(err);
          }
          return;
        }

        // Handle other responses
        if (msg.type === "res" && msg.id) {
          const cb = this._pendingCallbacks.get(msg.id);
          if (cb) {
            this._pendingCallbacks.delete(msg.id);
            if (msg.ok) {
              cb.resolve(msg);
            } else {
              cb.reject(new Error(`Gateway request failed: ${JSON.stringify(msg.error)}`));
            }
          }
          return;
        }

        // Dispatch events to listeners
        if (msg.type === "event") {
          for (const { filter, callback } of this._eventListeners) {
            if (filter(msg)) callback(msg);
          }
        }
      });

      ws.on("close", () => {
        this._ready = false;
        this._connecting = false;
        if (!this._destroyed) {
          this._scheduleReconnect();
        }
      });
    });
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.warn("[gateway] Max reconnect attempts reached — LLM calls will be skipped");
      return;
    }
    const delay = this._reconnectDelays[this._reconnectAttempts] || 8000;
    this._reconnectAttempts++;
    console.log(`[gateway] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);
    setTimeout(() => {
      this.connect().catch((err) => {
        console.error("[gateway] Reconnect failed:", err.message);
      });
    }, delay);
  }

  /**
   * Send a request and wait for its response.
   */
  _sendRequest(id, payload) {
    return new Promise((resolve, reject) => {
      this._pendingCallbacks.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  /**
   * Add an event listener. Returns a function to remove it.
   */
  addEventListener(filter, callback) {
    const entry = { filter, callback };
    this._eventListeners.push(entry);
    return () => {
      const idx = this._eventListeners.indexOf(entry);
      if (idx !== -1) this._eventListeners.splice(idx, 1);
    };
  }

  /**
   * Send chat.send and stream the response.
   * Returns: {fullText: string, latencyMs: number}
   * onDelta(text) called for each text chunk.
   * signal: AbortSignal for cancellation.
   */
  async sendChat({ sessionKey, message, onDelta, signal }) {
    if (!this._ready) {
      throw new Error("Gateway not connected");
    }

    const reqId = `req-${randomUUID()}`;
    const idempotencyKey = randomUUID();
    const startTime = Date.now();

    let fullText = "";
    let firstTokenMs = null;
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });

    // Timeouts
    let firstTokenTimer = setTimeout(() => {
      reject(new Error("first-token-timeout"));
    }, LLM_FIRST_TOKEN_TIMEOUT_MS);

    let idleTimer = null;
    let totalTimer = setTimeout(() => {
      reject(new Error("total-timeout"));
    }, LLM_TOTAL_TIMEOUT_MS);

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        reject(new Error("idle-timeout"));
      }, LLM_IDLE_TIMEOUT_MS);
    };

    // Handle abort
    if (signal) {
      if (signal.aborted) {
        reject(new Error("aborted"));
      } else {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }
    }

    // Listen for agent events
    const removeListener = this.addEventListener((msg) => {
      // Agent text stream events
      if (msg.event === "agent" && msg.stream === "assistant") return true;
      // Lifecycle end
      if (msg.event === "agent" && msg.stream === "lifecycle") return true;
      // Chat final
      if (msg.event === "chat" && msg.state === "final") return true;
      return false;
    }, (msg) => {
      if (signal?.aborted) return;

      if (msg.event === "agent" && msg.stream === "assistant") {
        const delta = msg.data?.delta ?? msg.data?.text ?? "";
        if (delta) {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - startTime;
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          fullText += delta;
          resetIdleTimer();
          onDelta(delta);
        }
        return;
      }

      if (msg.event === "agent" && msg.stream === "lifecycle" && msg.data?.phase === "end") {
        clearTimeout(firstTokenTimer);
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        removeListener();
        resolve({ fullText, latencyMs: Date.now() - startTime });
        return;
      }

      if (msg.event === "chat" && msg.state === "final") {
        clearTimeout(firstTokenTimer);
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        removeListener();
        resolve({ fullText, latencyMs: Date.now() - startTime });
        return;
      }
    });

    // Send chat.send request
    this._ws.send(JSON.stringify({
      type: "req",
      id: reqId,
      method: "chat.send",
      params: {
        sessionKey,
        agentId: "main",
        message,
        deliver: false,
        idempotencyKey,
      },
    }));

    try {
      return await done;
    } catch (err) {
      removeListener();
      clearTimeout(firstTokenTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);

      // Try to abort the LLM call on the gateway side
      if (this._ready && err.message !== "aborted") {
        try {
          this._ws.send(JSON.stringify({
            type: "req",
            id: `abort-${randomUUID()}`,
            method: "chat.abort",
            params: {
              sessionKey,
              agentId: "main",
              runId: idempotencyKey,
            },
          }));
        } catch {
          // ignore
        }
      }
      throw err;
    }
  }

  /**
   * Run an isolated/stateless reformulation call (no voice session key).
   */
  async reformulateForSpeech(text, signal) {
    const sessionKey = `voice-summarize-${randomUUID()}`;
    const prompt = `Forme folgende Antwort in eine gesprochene Version um, die die Kernaussage vollständig erhält und maximal 3.000 Zeichen hat. Keine Stichpunkte — fließende Sprache.\n\n${text}`;

    let result = "";
    const { fullText } = await this.sendChat({
      sessionKey,
      message: prompt,
      onDelta: (d) => { result += d; },
      signal,
    });
    return fullText || result;
  }

  destroy() {
    this._destroyed = true;
    this._ready = false;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }
}

// ── TTS HTTP client ──────────────────────────────────────────────────────────

/**
 * POST text to TTS bridge, return raw PCM buffer (s16le 48kHz stereo).
 * @param {string} text - max 400 chars
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer>}
 */
function fetchTts(text, signal) {
  const url = new URL(MAGPIE_URL);
  const transport = url.protocol === "https:" ? https : http;
  const body = Buffer.from(JSON.stringify({ input: text }));

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          return reject(new Error(`TTS bridge returned ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("TTS request timed out"));
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("aborted"));
      });
    }

    req.write(body);
    req.end();
  });
}

// ── Bot ──────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

/** Map of guildId → Set of userId currently being recorded (batch mode). */
const activeRecordings = new Map();

/** Singleton gateway client (voice agent mode only). */
let gatewayClient = null;

/**
 * Per-guild state for voice agent mode:
 * guildId → { triggerCooldowns: Map<userId, ts>, activePlayback: object|null, asrSessions: Map<userId, AsrSession> }
 */
const guildAgentState = new Map();

function getGuildAgentState(guildId) {
  if (!guildAgentState.has(guildId)) {
    guildAgentState.set(guildId, {
      triggerCooldowns: new Map(),
      activePlayback: null,
      asrSessions: new Map(),
    });
  }
  return guildAgentState.get(guildId);
}

/**
 * Check if guild is in allowlist (or allowlist is empty = all allowed).
 */
function isGuildAllowed(guildId) {
  if (VOICE_GUILD_ALLOWLIST.length === 0) return true;
  return VOICE_GUILD_ALLOWLIST.includes(guildId);
}

// ── ASR Session (voice agent mode) ──────────────────────────────────────────

/**
 * Per-user ASR streaming session.
 */
class AsrSession {
  constructor({ userId, guildId, channelId, voiceChannel, displayName }) {
    this.userId = userId;
    this.guildId = guildId;
    this.channelId = channelId;
    this.voiceChannel = voiceChannel;
    this.displayName = displayName;

    this._ws = null;
    this._wsReady = false;
    this._accumulator = new ByteAccumulator((frame) => this._sendFrame(frame));
    this._lastFrameTime = null;
    this._silenceFallbackTimer = null;
    this._utteranceStartTime = null;
    this._utteranceMaxTimer = null;
    this._closed = false;
    this._partialTranscript = "";

    this._open();
  }

  _open() {
    this._ws = new WebSocket(ASR_STREAM_URL);
    this._ws.on("open", () => {
      this._wsReady = true;
      // Send config
      this._ws.send(JSON.stringify({
        type: "config",
        lang: "de",
        sample_rate: 16000,
        frame_bytes: 640,
      }));
    });

    this._ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.is_final === false) {
        this._partialTranscript = msg.transcript || "";
        if (VOICE_DEBUG) {
          console.log(`[asr] [${this.displayName}] interim: ${msg.transcript}`);
        }
      } else if (msg.is_final === true) {
        const transcript = (msg.transcript || "").trim();
        if (VOICE_DEBUG) {
          console.log(`[asr] [${this.displayName}] final: ${transcript}`);
        }
        this._onFinalTranscript(transcript);
      }
    });

    this._ws.on("error", (err) => {
      console.error(`[asr] WS error for ${this.displayName}:`, err.message);
    });

    this._ws.on("close", () => {
      this._wsReady = false;
    });
  }

  /**
   * Push raw PCM data from prism decoder.
   */
  pushPcm(chunk) {
    if (this._closed) return;

    this._lastFrameTime = Date.now();

    // Start utterance max timer on first chunk
    if (!this._utteranceStartTime) {
      this._utteranceStartTime = Date.now();
      this._utteranceMaxTimer = setTimeout(() => {
        this._onUtteranceOverflow();
      }, UTTERANCE_MAX_MS);
    }

    this._accumulator.push(chunk);

    // Reset silence fallback timer
    if (this._silenceFallbackTimer) clearTimeout(this._silenceFallbackTimer);
    this._silenceFallbackTimer = setTimeout(() => {
      this._sendEnd();
    }, ASR_SILENCE_FALLBACK_MS);
  }

  _sendFrame(frame) {
    if (this._wsReady && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(frame);
    }
  }

  _sendEnd() {
    if (this._wsReady && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: "end" }));
    }
    this._resetUtteranceTimers();
    this._accumulator.reset();
    this._utteranceStartTime = null;
  }

  _resetUtteranceTimers() {
    if (this._silenceFallbackTimer) {
      clearTimeout(this._silenceFallbackTimer);
      this._silenceFallbackTimer = null;
    }
    if (this._utteranceMaxTimer) {
      clearTimeout(this._utteranceMaxTimer);
      this._utteranceMaxTimer = null;
    }
  }

  _onUtteranceOverflow() {
    console.log(`[asr] [${this.displayName}] utterance overflow — sending end`);
    this._sendEnd();
    // Post note in channel
    const channel = this.voiceChannel;
    channel.send("_(Bernd: Bitte kürzer sprechen — nur ein Teil wurde gehört.)_").catch(() => {});
  }

  async _onFinalTranscript(transcript) {
    this._resetUtteranceTimers();
    this._accumulator.reset();
    this._utteranceStartTime = null;

    if (!transcript) return;

    // Check transcript length
    if (transcript.length > 2000) {
      this.voiceChannel.send("_(Eingabe zu lang — bitte kürzer sprechen.)_").catch(() => {});
      return;
    }

    // Trigger detection
    if (!hasTrigger(transcript)) return;

    // Cooldown check
    const state = getGuildAgentState(this.guildId);
    const lastTrigger = state.triggerCooldowns.get(this.userId) || 0;
    const now = Date.now();
    if (now - lastTrigger < TRIGGER_COOLDOWN_MS) return;
    state.triggerCooldowns.set(this.userId, now);

    console.log(`Trigger: user=${this.userId} ts=${new Date().toISOString()}`);

    // Run voice agent pipeline
    await runVoiceAgentPipeline({
      transcript,
      guildId: this.guildId,
      channelId: this.channelId,
      voiceChannel: this.voiceChannel,
      asrFinalTime: Date.now(),
    });
  }

  close() {
    this._closed = true;
    this._resetUtteranceTimers();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }
}

// ── Voice Agent Pipeline ─────────────────────────────────────────────────────

/**
 * Run: barge-in → LLM → TTS → AudioPlayer
 */
async function runVoiceAgentPipeline({ transcript, guildId, channelId, voiceChannel, asrFinalTime }) {
  const state = getGuildAgentState(guildId);

  // Barge-in: stop ongoing playback
  if (state.activePlayback) {
    const { player, ttsAbortController, llmAbortController } = state.activePlayback;
    if (player) player.stop(true);
    if (ttsAbortController) ttsAbortController.abort();
    if (llmAbortController) llmAbortController.abort();
    state.activePlayback = null;
  }

  // Create abort controllers for this pipeline
  const llmAbortController = new AbortController();
  const ttsAbortController = new AbortController();
  const player = new AudioPlayer();

  state.activePlayback = { player, ttsAbortController, llmAbortController };

  // Subscribe player to voice connection
  const connection = getVoiceConnection(guildId);
  if (connection) {
    connection.subscribe(player);
  }

  const sessionKey = `voice-${guildId}-${channelId}`;

  try {
    // Collect LLM response
    let fullText = "";
    let firstAudioPlayed = false;
    const ttsQueue = [];
    let ttsQueueRunning = false;

    // TTS queue processor
    async function processTtsQueue() {
      if (ttsQueueRunning) return;
      ttsQueueRunning = true;

      while (ttsQueue.length > 0) {
        if (ttsAbortController.signal.aborted) break;
        const chunk = ttsQueue.shift();
        try {
          const pcmBuffer = await fetchTts(chunk, ttsAbortController.signal);
          if (ttsAbortController.signal.aborted) break;

          // Record time to first audio
          if (!firstAudioPlayed) {
            firstAudioPlayed = true;
            const elapsed = Date.now() - asrFinalTime;
            console.log(`final_asr_to_first_audio_ms=${elapsed}`);
          }

          // Create audio resource from raw PCM
          const readable = Readable.from(pcmBuffer);
          const resource = createAudioResource(readable, { inputType: StreamType.Raw });
          player.play(resource);

          // Wait for player to finish this chunk
          await new Promise((resolve, reject) => {
            const onIdle = () => { player.off("error", onError); resolve(); };
            const onError = (err) => { player.off(AudioPlayerStatus.Idle, onIdle); reject(err); };
            player.once(AudioPlayerStatus.Idle, onIdle);
            player.once("error", onError);

            // Abort listener
            if (ttsAbortController.signal.aborted) resolve();
            ttsAbortController.signal.addEventListener("abort", resolve);
          });

        } catch (err) {
          if (err.message !== "aborted") {
            console.error("[tts] Error fetching TTS chunk:", err.message);
          }
          break;
        }
      }

      ttsQueueRunning = false;
    }

    let pendingChunkBuffer = "";

    function flushPendingChunk(force = false) {
      // Attempt to extract complete chunks from pendingChunkBuffer
      const chunks = splitIntoTtsChunks(pendingChunkBuffer, TTS_MAX_CHARS);
      if (chunks.length === 0) return;

      if (!force && chunks.length === 1) {
        // Only one chunk — may be incomplete, wait for more
        return;
      }

      // If force, flush all; otherwise flush all but the last (may be incomplete)
      const toFlush = force ? chunks : chunks.slice(0, -1);
      const remaining = force ? "" : chunks[chunks.length - 1];

      for (const c of toFlush) {
        ttsQueue.push(c);
      }
      pendingChunkBuffer = remaining;

      processTtsQueue().catch(() => {});
    }

    let { fullText: llmText, latencyMs } = await gatewayClient.sendChat({
      sessionKey,
      message: transcript,
      signal: llmAbortController.signal,
      onDelta: (delta) => {
        pendingChunkBuffer += delta;
        fullText += delta;
        flushPendingChunk(false);
      },
    });

    // LLM done — flush remaining
    flushPendingChunk(true);

    // If text > 3000 chars, reformulate
    if (fullText.length > LLM_MAX_TEXT_CHARS) {
      console.log(`[llm] Response too long (${fullText.length} chars) — reformulating`);
      // Stop current TTS and clear queue
      ttsAbortController.abort();
      ttsQueue.length = 0;
      player.stop(true);

      const reformAbort = new AbortController();
      state.activePlayback = { ...state.activePlayback, ttsAbortController: reformAbort };

      try {
        fullText = await gatewayClient.reformulateForSpeech(fullText, reformAbort.signal);
        const chunks = splitIntoTtsChunks(fullText, TTS_MAX_CHARS);
        for (const c of chunks) ttsQueue.push(c);
        await processTtsQueue();
      } catch (err) {
        if (err.message !== "aborted") {
          console.error("[llm] Reformulation error:", err.message);
        }
      }
    } else {
      // Wait for TTS queue to drain
      await new Promise((resolve) => {
        const check = () => {
          if (ttsQueue.length === 0 && !ttsQueueRunning) return resolve();
          setTimeout(check, 100);
        };
        check();
      });
    }

    const ttsChunks = splitIntoTtsChunks(fullText, TTS_MAX_CHARS);
    console.log(`LLM: session=${sessionKey} chars=${fullText.length} latency_ms=${latencyMs}`);
    console.log(`TTS: chunks=${ttsChunks.length} total_chars=${fullText.length}`);

  } catch (err) {
    if (err.message === "first-token-timeout") {
      voiceChannel.send("_(Bernd antwortet nicht rechtzeitig.)_").catch(() => {});
    } else if (err.message === "total-timeout" || err.message === "idle-timeout") {
      // Stop TTS queue
      ttsAbortController.abort();
      player.stop(true);
      voiceChannel.send("_(Bernd hat zu lange gebraucht.)_").catch(() => {});
    } else if (err.message !== "aborted") {
      console.error("[voice-agent] Pipeline error:", err.message);
    }
  } finally {
    if (state.activePlayback?.player === player) {
      state.activePlayback = null;
    }
  }
}

// ── subscribeUser: batch mode ────────────────────────────────────────────────

function subscribeUserBatch(connection, channel, userId, member) {
  const guildId = channel.guild.id;
  const recordings = activeRecordings.get(guildId) ?? new Set();
  if (recordings.has(userId)) return;
  recordings.add(userId);
  activeRecordings.set(guildId, recordings);

  const displayName = member?.displayName || `User-${userId.slice(-4)}`;

  const audioStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: SILENCE_DURATION_MS,
    },
  });

  const opusDecoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  const pcmChunks = [];
  let totalBytes = 0;

  opusDecoder.on("data", (chunk) => {
    pcmChunks.push(chunk);
    totalBytes += chunk.length;
  });

  opusDecoder.on("end", async () => {
    recordings.delete(userId);

    const minBytes = MIN_AUDIO_MS * 192;
    if (totalBytes < minBytes) return;

    try {
      const pcm = Buffer.concat(pcmChunks);
      const wav = await pcmToWav(pcm);
      const text = await transcribe(wav, displayName);
      if (text && text.trim()) {
        await channel.send(`**${displayName}:** ${text.trim()}`).catch(() => {});
        if (VOICE_DEBUG) console.log(`[discord-voice-stt] [${channel.guild.name}#${channel.name}] ${displayName}: ${text.trim()}`);
      }
    } catch (err) {
      console.error(`[discord-voice-stt] transcription error for ${displayName}:`, err.message);
    }
  });

  opusDecoder.on("error", (err) => {
    recordings.delete(userId);
    console.error(`[discord-voice-stt] opus decoder error for ${displayName}:`, err.message);
  });

  audioStream.pipe(opusDecoder);
  audioStream.on("error", () => {
    if (!audioStream.destroyed) audioStream.destroy();
    if (!opusDecoder.destroyed) opusDecoder.destroy();
    recordings.delete(userId);
  });
}

// ── subscribeUser: voice agent mode ─────────────────────────────────────────

function subscribeUserAgent(connection, voiceChannel, userId, member) {
  const guildId = voiceChannel.guild.id;
  const state = getGuildAgentState(guildId);

  if (state.asrSessions.has(userId)) return;

  const displayName = member?.displayName || `User-${userId.slice(-4)}`;

  // Subscribe audio stream (continuous — we manage silence ourselves via ASR)
  const audioStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: SILENCE_DURATION_MS,
    },
  });

  const opusDecoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  const session = new AsrSession({
    userId,
    guildId,
    channelId: voiceChannel.id,
    voiceChannel,
    displayName,
  });
  state.asrSessions.set(userId, session);

  opusDecoder.on("data", (chunk) => {
    session.pushPcm(chunk);
  });

  opusDecoder.on("end", () => {
    state.asrSessions.delete(userId);
    session.close();
  });

  opusDecoder.on("error", (err) => {
    state.asrSessions.delete(userId);
    session.close();
    console.error(`[voice-agent] opus decoder error for ${displayName}:`, err.message);
  });

  audioStream.pipe(opusDecoder);
  audioStream.on("error", () => {
    if (!audioStream.destroyed) audioStream.destroy();
    if (!opusDecoder.destroyed) opusDecoder.destroy();
    state.asrSessions.delete(userId);
    session.close();
  });
}

// ── subscribeUser: dispatcher ────────────────────────────────────────────────

function subscribeUser(connection, channel, userId, member) {
  if (VOICE_AGENT_ENABLED) {
    subscribeUserAgent(connection, channel, userId, member);
  } else {
    subscribeUserBatch(connection, channel, userId, member);
  }
}

// ── Join and listen ──────────────────────────────────────────────────────────

async function joinAndListen(voiceChannel) {
  const existing = getVoiceConnection(voiceChannel.guild.id);
  if (existing) return;

  if (!isGuildAllowed(voiceChannel.guild.id)) return;

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch (err) {
    console.error(`[discord-voice-stt] Failed to join ${voiceChannel.name}:`, err.message);
    connection?.destroy();
    return;
  }

  console.log(`[discord-voice-stt] Joined: ${voiceChannel.guild.name} / ${voiceChannel.name}`);

  connection.on("error", (err) => {
    console.error(`[discord-voice-stt] Connection error:`, err.message);
    connection.destroy();
  });

  for (const [memberId, member] of voiceChannel.members) {
    if (memberId === client.user.id) continue;
    subscribeUser(connection, voiceChannel, memberId, member);
  }

  connection.receiver.speaking.on("start", (userId) => {
    const member = voiceChannel.guild.members.cache.get(userId);
    subscribeUser(connection, voiceChannel, userId, member);
  });
}

function maybeLeave(guild, voiceChannel) {
  const nonBots = voiceChannel.members.filter((m) => !m.user.bot);
  if (nonBots.size === 0) {
    const conn = getVoiceConnection(guild.id);
    if (conn) {
      conn.destroy();
      activeRecordings.delete(guild.id);
      if (VOICE_AGENT_ENABLED) {
        // Close all ASR sessions for this guild
        const state = guildAgentState.get(guild.id);
        if (state) {
          for (const session of state.asrSessions.values()) session.close();
          state.asrSessions.clear();
          if (state.activePlayback) {
            state.activePlayback.llmAbortController?.abort();
            state.activePlayback.ttsAbortController?.abort();
            state.activePlayback.player?.stop(true);
            state.activePlayback = null;
          }
        }
      }
      console.log(`[discord-voice-stt] Left empty channel: ${guild.name} / ${voiceChannel.name}`);
    }
  }
}

// ── Discord events ───────────────────────────────────────────────────────────

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (newState.member?.user.bot) return;

  if (newState.channel && newState.channelId !== oldState.channelId) {
    await joinAndListen(newState.channel);
    const conn = getVoiceConnection(newState.guild.id);
    if (conn) {
      subscribeUser(conn, newState.channel, newState.id, newState.member);
    }
  }

  if (oldState.channel) {
    maybeLeave(oldState.guild, oldState.channel);
  }
});

client.once("clientReady", async () => {
  console.log(`[discord-voice-stt] Logged in as ${client.user.tag}`);
  console.log(`[discord-voice-stt] Mode: ${VOICE_AGENT_ENABLED ? "VOICE AGENT" : "batch STT"}`);
  if (!VOICE_AGENT_ENABLED) {
    console.log(`[discord-voice-stt] STT bridge: ${NEMOTRON_URL}`);
    console.log(`[discord-voice-stt] Silence threshold: ${SILENCE_DURATION_MS}ms | Min audio: ${MIN_AUDIO_MS}ms`);
  } else {
    console.log(`[discord-voice-stt] ASR stream: ${ASR_STREAM_URL}`);
    console.log(`[discord-voice-stt] TTS bridge: ${MAGPIE_URL}`);
    console.log(`[discord-voice-stt] Gateway: ws://127.0.0.1:${getGatewayPort()}`);
    if (VOICE_GUILD_ALLOWLIST.length > 0) {
      console.log(`[discord-voice-stt] Guild allowlist: ${VOICE_GUILD_ALLOWLIST.join(", ")}`);
    }

    // Connect gateway
    gatewayClient = new GatewayClient();
    try {
      await gatewayClient.connect();
    } catch (err) {
      console.warn(`[gateway] Initial connect failed: ${err.message} — will retry`);
      // Schedule retry
      gatewayClient._scheduleReconnect();
    }
  }

  for (const guild of client.guilds.cache.values()) {
    if (!isGuildAllowed(guild.id)) continue;
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice) continue;
      const nonBots = channel.members.filter((m) => !m.user.bot);
      if (nonBots.size > 0) {
        await joinAndListen(channel);
      }
    }
  }
});

process.on("SIGTERM", () => {
  console.log("[discord-voice-stt] SIGTERM — disconnecting...");
  if (gatewayClient) gatewayClient.destroy();
  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[discord-voice-stt] Login failed:", err.message);
  process.exit(1);
});
