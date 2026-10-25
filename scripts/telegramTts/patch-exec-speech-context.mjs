#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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

/** Find and optionally atomically patch the uniquely supported installed mjs bundle.
 * @param {string} directory Host dist directory.
 * @param {boolean} apply Explicit write mode; false reports dry-run mapping.
 * @returns {object} Concrete target and change status.
 */
export function patchExecContextDirectory(directory,apply=false) {
  const candidates=[];
  for (const name of readdirSync(realpathSync(directory)).filter(n=>/^bash-tools-.*\.mjs$/.test(n))) {
    const file=resolveInside(directory,name),source=readFileSync(file,'utf8');
    if (source.includes('hookRunner.runResolveExecEnv(')) candidates.push({file,source});
  }
  if (candidates.length!==1) throw new Error('unsupported_or_ambiguous_bundle');
  const {file,source}=candidates[0],next=patchExecContextSource(source);
  if (apply && next!==source) {
    const temporary=resolve(directory,`.speech-context-${process.pid}.tmp`);
    writeFileSync(temporary,next,{mode:statSync(file).mode,flag:'wx'});
    renameSync(temporary,file);
  }
  return {file,changed:next!==source,applied:apply};
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(patchExecContextDirectory(process.argv[2]||'/usr/lib/node_modules/openclaw/dist',process.argv.includes('--apply')))); }
  catch { console.error('speech_context_patch_refused');process.exitCode=1; }
}
