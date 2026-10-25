import { openSync, closeSync, fstatSync, readFileSync, lstatSync, constants, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { safeAgentId, resolveInside } from './sql-safety.js';
import { validJevText } from './jevEmotion.js';
import { prepareSpeechText } from './speechText.js';
import { createJevSpeechPlanner, renderSpeechPlan } from './speechRegie.js';
import { resolveJevApiKey } from './jev-chunk-decider.js';
import { resolveEffectiveConfig } from './setup/config-contract.js';
const AGENTS = ['main','bernhardine','heisenberg'];

function readPrivateJson(file, maxBytes = 262144) {
  const path = resolveInside(dirname(file), basename(file));
  if (lstatSync(file).isSymbolicLink() || path !== resolve(file)) throw new Error('unsafe_path');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > maxBytes) throw new Error('unsafe_file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

/** Read only an exact private, live run snapshot; invalid context yields null.
 * @param {object} options Trusted workspace, explicit agent/run/file and current time.
 * @returns {object|null} Bounded runtime snapshot.
 */
export function readSpeechContext({workspace,agentId,runId,file,now=Date.now()} = {}) {
  try {
    safeAgentId(agentId);
    if (!AGENTS.includes(agentId) || !workspace || !runId || !file) return null;
    const root = realpathSync(workspace);
    const directory = resolveInside(root,'.plur1bus','speech-context');
    if (dirname(file) !== directory || !/^[a-f0-9]{64}\.json$/.test(basename(file))) return null;
    for (const dir of [resolveInside(root,'.plur1bus'),directory]) {
      const info=lstatSync(dir);
      if (!info.isDirectory() || info.uid!==process.getuid() || (info.mode & 0o077)) return null;
    }
    const value=readPrivateJson(resolveInside(directory,basename(file)),262144);
    if (value.version!==1 || value.agentId!==agentId || value.runId!==runId || typeof value.sessionId!=='string' || !value.sessionId
      || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.createdAt>now || value.expiresAt<=now
      || value.expiresAt-value.createdAt>900000 || value.expiresAt<=value.createdAt
      || typeof value.persona!=='string' || value.persona.length>2400 || !value.mood || typeof value.mood!=='object'
      || !Array.isArray(value.context) || value.context.length>2 || value.context.some(c=>!['user','assistant'].includes(c?.role) || typeof c.content!=='string' || !validJevText(c.content))) return null;
    return value;
  } catch { return null; /* Rejected optional context is an explicit conservative result. */ }
}

/** Load validated effective plugin settings and trusted workspace from the host config.
 * @param {string} file Fixed host configuration file.
 * @param {string} agentId Explicit allowlisted agent.
 * @returns {{config:object,workspace:string}} Effective plugin configuration and workspace.
 */
export function loadSpeechConfig(file,agentId) {
  safeAgentId(agentId);
  if (!AGENTS.includes(agentId)) throw new Error('invalid_agent');
  const host=readPrivateJson(file);
  const config=resolveEffectiveConfig(host.plugins?.entries?.['memory-lancedb-namespaced']?.config || {});
  const workspace=host.agents?.list?.find(a=>a.id===agentId)?.workspace || `/root/.openclaw/${agentId==='main'?'workspace':`workspace-${agentId}`}`;
  return {config,workspace};
}

/** Reuse the existing credential resolver, optionally reading one selected EnvironmentFile assignment.
 * @param {object} options Existing captureChunkingJev options.
 * @param {object} env Inherited environment.
 * @param {string} file Existing gateway EnvironmentFile.
 * @returns {string} Selected credential only; never imported into process environment.
 */
export function resolveSpeechJevKey(options={},env=process.env,file='/root/.openclaw/gateway.systemd.env') {
  const inherited=resolveJevApiKey(options,env);
  if (inherited) return inherited;
  const name=typeof options.apiKeyEnv==='string' && options.apiKeyEnv.trim() ? options.apiKeyEnv.trim() : 'TYPESAFE_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return '';
  try {
    const path=resolveInside(dirname(file),basename(file));
    const info=lstatSync(path);
    if (!info.isFile() || info.uid!==process.getuid() || (info.mode&0o077) || info.size>262144 || lstatSync(file).isSymbolicLink()) return '';
    let selected='';
    for (const line of readFileSync(path,'utf8').split(/\r?\n/)) {
      const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match?.[1]!==name) continue;
      let value=match[2].trim();
      if ((value.startsWith('"')&&value.endsWith('"')) || (value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
      if (/[$`\\\r\n]/.test(value)) return '';
      selected=value;
    }
    return resolveJevApiKey(options,{[name]:selected});
  } catch { return ''; /* Missing credential is an explicit fail-open result. */ }
}

/** Prepare canonical text once, batch outgoing semantics and render closed metadata.
 * @param {object} input Versioned request with explicit agentId and one/two versions.
 * @param {object} options Trusted effective config/context/transport dependencies.
 * @returns {Promise<object>} Versioned prepared provider payload, with no source or secrets logged.
 */
export async function planTelegramSpeech(input,{config={},workspace,env=process.env,planner,now=Date.now()}={}) {
  const agentId=safeAgentId(input?.agentId);
  if (!AGENTS.includes(agentId) || (input.version!==undefined && input.version!==1) || !Array.isArray(input.versions) || !input.versions.length || input.versions.length>2) throw new Error('invalid_request');
  const ids=new Set();
  const versions=input.versions.map(v=>{
    if (!v || !['de','pl','default'].includes(v.id) || ids.has(v.id) || typeof v.text!=='string') throw new Error('invalid_version');
    ids.add(v.id);return {id:v.id,...prepareSpeechText(v.text)};
  });
  const settings=config.emotion?.jev;
  const mode=settings?.enabled===true && settings.agents?.[agentId]===true ? settings.mode : 'disabled';
  const context=readSpeechContext({workspace,agentId,runId:env.PLUR1BUS_SPEECH_RUN_ID,file:env.PLUR1BUS_SPEECH_CONTEXT_FILE,now});
  const eligible=versions.filter(v=>!v.blocked && v.text).map(({id,text})=>({id,text}));
  let plan={ok:false,reason:'disabled'};
  if (['active','shadow'].includes(mode) && eligible.length) {
    const options=config.captureChunkingJev||{};
    const assess=planner || createJevSpeechPlanner({...options,apiKey:resolveSpeechJevKey(options,env),timeoutMs:settings.timeoutMs});
    try { plan=await assess({versions:eligible,context:context?.context||[],persona:context?.persona||'',mood:context?.mood||{}}); }
    catch { plan={ok:false,reason:'planner_failed'}; }
  }
  return {version:1,agentId,mode,context:context?'run':'final-text-only',decision:plan.ok?'accepted':(plan.reason||'rejected'),versions:versions.map(v=>{
    const planned=plan.ok && plan.versions?.find(p=>p.id===v.id && p.text===v.text);
    return {id:v.id,text:v.text,blocked:v.blocked,speech:v.blocked?'':mode==='active' && planned?renderSpeechPlan(planned):v.text};
  })};
}
