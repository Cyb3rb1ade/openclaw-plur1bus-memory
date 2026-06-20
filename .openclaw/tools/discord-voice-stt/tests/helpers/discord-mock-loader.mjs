/**
 * ESM loader hook that replaces discord.js and related packages with minimal mocks
 * so tests can import discord-voice-stt.mjs without triggering an actual Discord
 * login or process.exit(1).
 *
 * Usage: node --loader /abs/path/to/discord-mock-loader.mjs --test tests/...
 */

const MOCK_DISCORD_JS = `
export class Client {
  constructor() { this.user = null; this.guilds = { cache: new Map() }; }
  on() { return this; }
  once() { return this; }
  login() { return Promise.resolve('mock-token'); }
  destroy() {}
}
export const GatewayIntentBits = {
  Guilds: 1, GuildVoiceStates: 2, GuildMessages: 4
};
export const ChannelType = { GuildVoice: 2 };
`;

const MOCK_DISCORDJS_VOICE = `
export function joinVoiceChannel() { return {}; }
export function getVoiceConnection() { return null; }
export const EndBehaviorType = { AfterSilence: 1 };
export const VoiceConnectionStatus = { Ready: 1 };
export async function entersState() {}
export class AudioPlayer {
  play() {} stop() {} on() { return this; } once() { return this; } off() { return this; }
}
export const AudioPlayerStatus = { Idle: 'idle' };
export const StreamType = { Raw: 'raw' };
export function createAudioResource() { return {}; }
`;

const MOCK_PRISM = `
class Decoder {
  on() { return this; }
}
const prism = { opus: { Decoder } };
export default prism;
`;

const MOCK_WS = `
class WebSocket {
  constructor() { this.readyState = 0; }
  on() { return this; }
  once() { return this; }
  send() {}
  close() {}
  static get OPEN() { return 1; }
}
export default WebSocket;
`;

const MOCK_EMPTY = `export default {};`;

// Map: specifier substring → mock source
const MOCKS = new Map([
  ["discord.js", MOCK_DISCORD_JS],
  ["@discordjs/voice", MOCK_DISCORDJS_VOICE],
  ["@discordjs/opus", MOCK_EMPTY],
  ["prism-media", MOCK_PRISM],
  ["ws", MOCK_WS],
]);

// Stable base URL for mock virtual modules
const MOCK_BASE = "mock://discord-test/";

export async function resolve(specifier, context, nextResolve) {
  for (const [key] of MOCKS) {
    if (specifier === key || specifier.startsWith(key + "/")) {
      return {
        shortCircuit: true,
        url: `${MOCK_BASE}${encodeURIComponent(key)}`,
      };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(MOCK_BASE)) {
    const key = decodeURIComponent(url.slice(MOCK_BASE.length));
    const source = MOCKS.get(key) ?? MOCK_EMPTY;
    return {
      shortCircuit: true,
      format: "module",
      source,
    };
  }
  return nextLoad(url, context);
}
