/**
 * scripts/dist/installer/licence.mjs — the NC embedding licence gate (ADR-006, spec A.9).
 *
 * Interactive: the use-class question ("personal, non-commercial?"); yes leads
 * to an explicit CC BY-NC 4.0 confirmation for Jina v5 Text Nano, anything else
 * gives E5-small (MIT). Non-interactive: E5-small unless `--accept-nc-licence`
 * or PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1 (C11). Never a silent acceptance:
 * an acceptance always carries who (OS user), when, model, revision and licence.
 *
 * `useClass` (ruling F2, HM2-R18) is the harness setup's `--use-class`: `commercial` when the
 * personal-use question is answered no, else `general` (non-interactive, declined or accepted NC
 * licence). The Hermes installer passes its own licence question (`ncQuestion`) because the harness
 * sidecar, not this plugin, chooses the model.
 */

import { userInfo } from "node:os";
import { E5_EMBEDDING_PROFILE, JINA_V5_NANO_EMBEDDING_PROFILE } from "../../../lib/providers/local-model-artifacts.js";

export const E5_PROFILE_ID = "e5-multilingual-384";
export const JINA_V5_PROFILE_ID = "jina-v5-nano-768";
export const NC_LICENCE = "CC-BY-NC-4.0";

/** Model per preparation profile id (the embedding.model value written when none is configured). */
export const PROFILE_MODELS = Object.freeze({
  [E5_PROFILE_ID]: { model: E5_EMBEDDING_PROFILE.model, revision: E5_EMBEDDING_PROFILE.revision, licence: "MIT" },
  [JINA_V5_PROFILE_ID]: { model: JINA_V5_NANO_EMBEDDING_PROFILE.model, revision: JINA_V5_NANO_EMBEDDING_PROFILE.revision, licence: JINA_V5_NANO_EMBEDDING_PROFILE.license },
});

const yes = (a) => /^\s*(y|yes|j|ja)\s*$/i.test(String(a ?? ""));

function osUser(env) {
  const fromEnv = env.USER || env.USERNAME || env.LOGNAME;
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function accept(env, now) {
  const p = PROFILE_MODELS[JINA_V5_PROFILE_ID];
  return {
    profile: JINA_V5_PROFILE_ID,
    acceptNonCommercialLicense: true,
    useClass: "general",
    accepted: { by: osUser(env), at: new Date(now()).toISOString(), model: p.model, revision: p.revision, licence: NC_LICENCE },
  };
}

const E5 = (useClass = "general") => ({ profile: E5_PROFILE_ID, acceptNonCommercialLicense: false, useClass });

/**
 * @param {{ interactive: boolean, acceptNc: boolean, env: Record<string,string|undefined>, prompt: ((q: string) => Promise<string>) | null, now?: () => number, ncQuestion?: string }} a
 * @returns {Promise<{ profile: string, acceptNonCommercialLicense: boolean, useClass: "general"|"commercial", accepted?: { by: string, at: string, model: string, revision: string, licence: "CC-BY-NC-4.0" } }>}
 */
export async function resolveLicence({ interactive, acceptNc, env, prompt, now = Date.now, ncQuestion }) {
  if (acceptNc || env.PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE === "1") return accept(env, now);
  if (!interactive || typeof prompt !== "function") return E5();
  const personal = await prompt("Is this installation for personal, non-commercial use? [y/N] ");
  if (!yes(personal)) return E5("commercial");
  const p = PROFILE_MODELS[JINA_V5_PROFILE_ID];
  const ok = await prompt(
    ncQuestion ?? `The recommended model ${p.model} (revision ${p.revision.slice(0, 12)}) is licensed ${NC_LICENCE} (non-commercial use only). Accept this licence? [y/N] `,
  );
  return yes(ok) ? accept(env, now) : E5();
}
