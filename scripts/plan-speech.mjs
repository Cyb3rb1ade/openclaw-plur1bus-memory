#!/usr/bin/env node
import { planTelegramSpeech, loadSpeechConfig } from '../lib/telegramSpeech.js';
try {
  let data='';
  for await (const chunk of process.stdin) { data+=chunk; if (Buffer.byteLength(data)>500000) throw new Error('input_too_large'); }
  const input=JSON.parse(data);
  const options=loadSpeechConfig('/root/.openclaw/openclaw.json',input.agentId);
  process.stdout.write(JSON.stringify(await planTelegramSpeech(input,options))+'\n');
} catch { process.stderr.write('speech_plan_failed\n'); process.exitCode=1; }
