#!/usr/bin/env python3
"""Private stdin adapter; provider identity always comes from the toggle wrapper."""
import json
import os
from pathlib import Path
import subprocess
import sys

PLANNER = '/root/.openclaw/extensions/memory-lancedb-namespaced/scripts/plan-speech.mjs'
HELPER = '/root/.openclaw/tools/elevenlabs-tts.py'

# A second closed projection at the logging boundary prevents arbitrary fields or
# planner/source strings from becoming stderr, even if the JSON contract changes.
INTENTS = {"neutral", "inform", "praise", "criticism", "empathy", "humor", "irony", "celebration", "warning", "comfort", "question", "boundary"}
DELIVERIES = {"neutral", "warm", "serious", "firm", "cheerful", "soft", "thoughtful", "playful", "excited", "sad", "whispering", "shouting"}
ACTIONS = {"none", "laugh", "chuckle", "sigh", "gasp"}

def shadow_summary(payload):
    versions = []
    for item in payload['versions'][:2]:
        if item.get('id') not in ('default', 'de', 'pl'):
            continue
        proposed = []
        for section, decision in enumerate(item.get('proposed', [])[:12]):
            if (isinstance(decision, dict) and decision.get('intent') in INTENTS
                    and decision.get('delivery') in DELIVERIES and decision.get('action') in ACTIONS):
                proposed.append({'section': section, 'intent': decision['intent'],
                                 'delivery': decision['delivery'], 'action': decision['action']})
        versions.append({'id': item['id'], 'proposed': proposed})
    return {'decision': 'accepted' if payload.get('decision') == 'accepted' else 'rejected', 'versions': versions}

def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ('single', 'bilingual') or sys.argv[2] not in ('main','bernhardine','heisenberg'):
        sys.exit('Invalid speech invocation')
    kind, agent, voice, output = sys.argv[1:]
    raw = sys.stdin.read(500001)
    if len(raw) > 500000:
        sys.exit('Speech input too large')
    versions = [{'id':'default','text':raw}] if kind == 'single' else json.loads(raw)
    planned = subprocess.run(['node', PLANNER],input=json.dumps({'version':1,'agentId':agent,'versions':versions}),text=True,capture_output=True,timeout=5)
    if planned.returncode:
        sys.exit('Speech preparation failed')
    payload = json.loads(planned.stdout)
    if payload.get('version') != 1 or payload.get('agentId') != agent or len(payload.get('versions',[])) != len(versions):
        sys.exit('Invalid speech plan')
    if payload.get("mode") == "shadow":
        print("speech_shadow_decision:"+json.dumps(shadow_summary(payload),separators=(",", ":")),file=sys.stderr)
    failed = False
    for item in payload['versions']:
        if item.get('blocked'):
            failed = True
            continue
        if not item.get('text'):
            continue
        path = output if kind == 'single' else output+'-'+item['id']+'.ogg'
        error = None
        try:
            result = subprocess.run(['python3',HELPER,'say-prepared','--voice',voice,'--out',path],input=json.dumps({'version':1,'text':item['text'],'speech':item['speech']}),text=True,capture_output=True,timeout=100)
            if result.returncode != 0 or not Path(path).is_file() or not Path(path).stat().st_size:
                error = 'generation_failed'
        except subprocess.TimeoutExpired:
            error = 'timeout'
        except OSError:
            error = 'spawn_failed'
        if error is None:
            if kind == 'bilingual':
                print('OK_'+item['id'].upper()+':'+path)
        else:
            failed = True
            print('ERR_'+item['id'].upper()+':'+error,file=sys.stderr)
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                print('ERR_'+item['id'].upper()+':cleanup_failed',file=sys.stderr)
    if failed:
        sys.exit(1)

if __name__ == '__main__':
    try:
        main()
    except (ValueError,KeyError,TypeError,OSError,subprocess.TimeoutExpired):
        sys.exit('Speech bridge failed')
