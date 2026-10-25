#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, readdirSync, realpathSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const original = '\t\t\tagentId: context?.hookContext?.agentId ?? params.agentId,\n\t\t\tsessionKey: context?.hookContext?.sessionKey ?? params.defaults?.sessionKey,\n\t\t\t...sessionId ? { sessionId } : {},\n\t\t\tmessageProvider: params.defaults?.messageProvider,';
const forwarded = original.replace('\n\t\t\tmessageProvider:', '\n\t\t\t...(context?.hookContext?.runId ?? params.defaults?.runId ? { runId: context?.hookContext?.runId ?? params.defaults?.runId } : {}),\n\t\t\t...(context?.hookContext?.workspaceDir ? { workspaceDir: context.hookContext.workspaceDir } : {}),\n\t\t\tmessageProvider:');

/** Project only trusted wrapper/default identity into the exact supported host caller.
 * @param {string} source Copied or installed bash-tools bundle source.
 * @returns {string} Idempotently patched source; unsupported/ambiguous shapes throw.
 */
export function patchExecContextSource(source) {
  if (source.split(forwarded).length===2 && !source.includes(original)) return source;
  if (source.split(original).length!==2 || !source.includes('const sessionId = context?.hookContext?.sessionId ?? params.defaults?.sessionId;') || !source.includes('hookRunner.runResolveExecEnv(')) throw new Error('unsupported_or_ambiguous_exec_context');
  return source.replace(original,forwarded);
}
function resolveInside(root,name) {
  const base=realpathSync(root),target=resolve(base,name);
  if (!target.startsWith(base+sep) || realpathSync(target)!==target) throw new Error('unsafe_patch_target');
  return target;
}

const nativeAssembly = 'async function prepareEmbeddedAttemptPromptAssembly(input) {';
const admittedProjection = `// PLUR1BUS: authored input comes only from the host-admitted transcript message.
function plur1busAdmittedUserFields(message) {
	if (!message || message.role !== "user" || message.excludeFromContext) return {};
	if (message.provenance && (message.provenance.kind !== "external_user" || message.provenance.sourceRole === "subagent")) return {};
	const id = message.idempotencyKey;
	if (typeof id !== "string" || !id || id.trim() !== id || id.length > 512) return {};
	let text = message.content;
	if (Array.isArray(text)) {
		if (text.some((block) => block?.type === "text" && typeof block.text !== "string")) return {};
		text = text.filter((block) => block?.type === "text").map((block) => block.text).join("");
	}
	if (typeof text !== "string" || !text.trim()) return {};
	return { currentUserMessage: text, currentUserMessageId: id };
}
`;
const nativeChanges = [
  [nativeAssembly, admittedProjection + nativeAssembly],
  ['\tconst promptEvent = {\n\t\tprompt: effectivePrompt,\n\t\tmessages: promptBuildMessages\n\t};',
   '\tconst currentUserFields = plur1busAdmittedUserFields(attempt.skipPreparedUserTurnMessage ? void 0 : input.preparedUserTurnMessage);\n\tconst promptEvent = {\n\t\tprompt: effectivePrompt,\n\t\tmessages: promptBuildMessages,\n\t\t...currentUserFields\n\t};'],
  ['\t\tmessages: promptBuildMessages,\n\t\thookCtx,\n\t\thookRunner: input.hookRunner',
   '\t\tmessages: promptBuildMessages,\n\t\t...currentUserFields,\n\t\thookCtx,\n\t\thookRunner: input.hookRunner'],
  ['\t\tconst promptAssembly = await prepareEmbeddedAttemptPromptAssembly({\n\t\t\tattempt,\n\t\t\tactiveSession,',
   '\t\tconst promptAssembly = await prepareEmbeddedAttemptPromptAssembly({\n\t\t\tattempt,\n\t\t\t...preparedUserTurnMessage ? { preparedUserTurnMessage } : {},\n\t\t\tactiveSession,'],
];
const helperOriginal = '\tconst promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build") ? await params.hookRunner.runBeforePromptBuild({\n\t\tprompt: params.prompt,\n\t\tmessages: params.messages\n\t}, params.hookCtx)';
const helperForwarded = helperOriginal.replace('messages: params.messages\n', 'messages: params.messages,\n\t\t...(typeof params.currentUserMessage === "string" && typeof params.currentUserMessageId === "string" ? { currentUserMessage: params.currentUserMessage, currentUserMessageId: params.currentUserMessageId } : {})\n');

function patchExactGroup(source, changes, guards, label) {
  if (!guards.every(guard => source.split(guard).length === 2)) throw new Error(`unsupported_or_ambiguous_${label}`);
  const applied = changes.every(([, next]) => source.split(next).length === 2);
  // Remove each recognized whole replacement before checking for duplicates/partial shapes.
  const stripped = changes.reduce((value, [, next]) => value.replace(next, ''), source);
  if (applied && changes.every(([old]) => !stripped.includes(old))) return source;
  if (changes.some(([, next]) => source.includes(next)) || !changes.every(([old]) => source.split(old).length === 2)) throw new Error(`unsupported_or_partial_${label}`);
  return changes.reduce((value, [old, next]) => value.replace(old, next), source);
}

/** Forward the already admitted native user message across phase and assembly boundaries.
 * @param {string} source Supported native bundle source.
 * @returns {string} Idempotently patched source; partial or ambiguous shapes throw.
 */
export function patchNativePromptSource(source) {
  return patchExactGroup(source, nativeChanges, [
    'async function runEmbeddedAttemptPromptPhase(input, promptState) {',
    'const { sessionRuntime, promptToolPolicy } = prepared;',
    'contextGuards, preparedUserTurnMessage, sessionManager,',
    'modelId: attempt.model.id,\n\t\tinputProvenance: attempt.inputProvenance',
    'const hookResult = preserveExactPrompt ? void 0 : await resolvePromptBuildHookResult({',
  ], 'native_prompt');
}

/** Forward typed admitted input through the native before_prompt_build helper projection.
 * @param {string} source Supported context-engine-maintenance bundle source.
 * @returns {string} Idempotently patched source; unsupported shapes throw.
 */
export function patchPromptHelperSource(source) {
  return patchExactGroup(source, [[helperOriginal, helperForwarded]], ['async function resolvePromptBuildHookResult(params) {'], 'prompt_helper');
}

/** Preflight every supported host target before optionally applying atomic per-file patches.
 * @param {string} directory Host dist directory.
 * @param {boolean} apply Explicit write mode; false reports the complete dry-run mapping.
 * @returns {{file:string,files:string[],targets:object[],changed:boolean,applied:boolean}} Legacy exec file plus every affected bundle.
 */
export function patchExecContextDirectory(directory,apply=false) {
  const root = realpathSync(directory);
  const names = readdirSync(root);
  const specifications = [
    [/^bash-tools-.*\.mjs$/, 'hookRunner.runResolveExecEnv(', patchExecContextSource],
    [/^builtin-openclaw-.*\.mjs$/, 'prepareEmbeddedAttemptPromptAssembly', patchNativePromptSource],
    [/^context-engine-maintenance-.*\.mjs$/, 'resolvePromptBuildHookResult', patchPromptHelperSource],
  ];
  const targets = specifications.map(([pattern, marker, patch]) => {
    const matches = names.filter(name => pattern.test(name)).map(name => {
      const file = resolveInside(root, name);
      if (!statSync(file).isFile()) throw new Error('unsafe_patch_target');
      return { file, source: readFileSync(file, 'utf8') };
    }).filter(({source}) => source.includes(marker));
    if (matches.length !== 1) throw new Error('unsupported_or_ambiguous_bundle');
    const {file,source} = matches[0];
    return { file, source, next: patch(source) };
  });
  // All shape validation above completes before the first write. Each rename is atomic.
  if (apply) for (const { file, source, next } of targets) {
    if (source === next) continue;
    const temporary = resolveInside(root, file) + `.speech-context-${process.pid}.tmp`;
    let created = false;
    try {
      writeFileSync(temporary, next, { mode: statSync(file).mode, flag: 'wx' });
      created = true;
      renameSync(temporary, file);
    } finally {
      if (created && existsSync(temporary)) unlinkSync(temporary);
    }
  }
  const digest = source => createHash('sha256').update(source).digest('hex');
  return { file: targets[0].file, files: targets.map(target => target.file), targets: targets.map(({file,source,next}) => ({file,changed:source!==next,originalSha256:digest(source),patchedSha256:digest(next)})), changed: targets.some(({source,next}) => source!==next), applied: apply };
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(patchExecContextDirectory(process.argv[2]||'/usr/lib/node_modules/openclaw/dist',process.argv.includes('--apply')))); }
  catch { console.error('speech_context_patch_refused');process.exitCode=1; }
}
