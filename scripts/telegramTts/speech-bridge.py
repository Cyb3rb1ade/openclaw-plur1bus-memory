#!/usr/bin/env python3
"""Private stdin adapter; provider identity always comes from the toggle wrapper."""
import json
import os
from pathlib import Path
import subprocess
import sys

PLANNER = '/root/.openclaw/extensions/memory-lancedb-namespaced/scripts/plan-speech.mjs'
HELPER = '/root/.openclaw/tools/elevenlabs-tts.py'

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
        print("speech_shadow_decision:"+("accepted" if payload.get("decision") == "accepted" else "rejected"),file=sys.stderr)
    failed = False
    for item in payload['versions']:
        if item.get('blocked'):
            failed = True
            continue
        if not item.get('text'):
            continue
        path = output if kind == 'single' else output+'-'+item['id']+'.ogg'
        result = subprocess.run(['python3',HELPER,'say-prepared','--voice',voice,'--out',path],input=json.dumps({'version':1,'text':item['text'],'speech':item['speech']}),text=True,capture_output=True,timeout=100)
        if result.returncode == 0 and Path(path).is_file() and Path(path).stat().st_size:
            if kind == 'bilingual':
                print('OK_'+item['id'].upper()+':'+path)
        else:
            failed = True
            print('ERR_'+item['id'].upper()+':generation_failed',file=sys.stderr)
            Path(path).unlink(missing_ok=True)
    if failed:
        sys.exit(1)

if __name__ == '__main__':
    try:
        main()
    except (ValueError,KeyError,TypeError,OSError,subprocess.TimeoutExpired):
        sys.exit('Speech bridge failed')
