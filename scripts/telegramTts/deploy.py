#!/usr/bin/env python3
"""Reviewable Telegram artifact installer. Dry-run default; no feature/toggle resets."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent
RUNTIME = Path('/root/.openclaw')
DIST = Path('/usr/lib/node_modules/openclaw/dist')
MARKER = '# PLUR1BUS trusted speech exec context'

def inside(root, *parts):
    root = root.resolve(strict=True)
    target = root.joinpath(*parts)
    resolved = target.resolve()
    if not resolved.is_relative_to(root) or target.is_symlink():
        raise ValueError('unsafe deployment path')
    return resolved

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def mapping(runtime=RUNTIME):
    files = [(SOURCE/'elevenlabs-tts.py', runtime/'tools/elevenlabs-tts.py'),
             (SOURCE/'speech-bridge.py', runtime/'tools/plur1bus-speech-bridge.py'),
             (SOURCE/'patch-exec-speech-context.mjs', runtime/'patches/patch-exec-speech-context.mjs')]
    for agent, workspace in [('main','workspace'),('bernhardine','workspace-bernhardine'),('heisenberg','workspace-heisenberg')]:
        for source in sorted((SOURCE/agent).rglob('*')):
            if source.is_file():
                files.append((source,runtime/workspace/'skills/telegram-tts-toggle'/source.relative_to(SOURCE/agent)))
    return files

def startup_source(text):
    block = MARKER+'\nnode /root/.openclaw/patches/patch-exec-speech-context.mjs "$DIST_DIR" --apply || rc=1\n'
    if block in text:
        return text
    if MARKER in text or text.count('\nexit $rc\n') != 1:
        raise ValueError('unsupported startup entrypoint')
    return text.replace('\nexit $rc\n','\n'+block+'\nexit $rc\n')

def rollback(snapshot, apply):
    manifest=json.loads(inside(snapshot,'manifest.json').read_text())
    for item in manifest['files']:
        target=Path(item['target'])
        roots=[root for root in (RUNTIME,DIST) if target.is_relative_to(root)]
        if not roots:
            raise ValueError('unsafe rollback target')
        inside(roots[0],str(target.relative_to(roots[0])))
        if digest(target) != item['installed']:
            raise ValueError('rollback refuses changed target: '+str(target))
    for item in manifest['files']:
        target=Path(item['target']);print('RESTORE '+str(target))
        if apply:
            if item['backup'] is None:
                target.unlink(missing_ok=True)
            else:
                shutil.copy2(inside(snapshot,item['backup']),inside(target.parent,target.name))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--host-patch',action='store_true',help='also back up/patch all supported host bundles and startup entrypoint')
    parser.add_argument('--rollback',type=Path)
    args=parser.parse_args()
    if args.rollback:
        rollback(args.rollback,args.apply);return
    # Validate full plugin settings through the shipped effective-config contract.
    validator=SOURCE.parents[1]/'lib/telegramSpeech.js'
    subprocess.run(['node','--input-type=module','-e',
                    'const {loadSpeechConfig}=await import(process.argv[1]); for(const id of ["main","bernhardine","heisenberg"]) loadSpeechConfig("/root/.openclaw/openclaw.json",id);',validator.as_uri()],check=True,capture_output=True)
    files=mapping()
    for src,dst in files:
        inside(SOURCE,str(src.relative_to(SOURCE)));inside(RUNTIME,str(dst.relative_to(RUNTIME)))
        print(str(src)+' -> '+str(dst))
    generated=[]
    patcher=SOURCE/'patch-exec-speech-context.mjs'
    if args.host_patch:
        inspected=subprocess.run(['node',str(patcher),str(DIST)],check=True,capture_output=True,text=True)
        report=json.loads(inspected.stdout)
        paths=report.get('files')
        if not isinstance(paths,list) or len(paths)!=3 or len(set(paths))!=3 or report.get('file') not in paths:
            raise ValueError('unsupported host bundle inventory')
        bundles=[]
        for path in paths:
            bundle=Path(path)
            if not bundle.is_relative_to(DIST):
                raise ValueError('unsafe host bundle target')
            bundles.append(inside(DIST,str(bundle.relative_to(DIST))))
        projections={item['file']:item for item in report.get('targets',[])}
        if set(projections)!=set(paths):
            raise ValueError('unsupported host bundle projections')
        for bundle in bundles:
            projection=projections[str(bundle)]
            for key in ['originalSha256','patchedSha256']:
                value=projection.get(key)
                if not isinstance(value,str) or len(value)!=64 or any(char not in '0123456789abcdef' for char in value):
                    raise ValueError('invalid host bundle digest')
            if digest(bundle)!=projection['originalSha256']:
                raise ValueError('host bundle changed during preflight')
        entry=inside(RUNTIME,'patches/apply-media-patch.sh')
        generated.append((entry,startup_source(entry.read_text())))
        for bundle in bundles:print('HOST '+str(bundle))
        print('STARTUP '+str(entry))
    if not args.apply:
        print('DRY RUN: no files changed; existing toggle JSON/config remain untouched.');return
    snapshot=RUNTIME/'.snapshots'/('telegram-speech-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    snapshot.mkdir(mode=0o700,parents=True,exist_ok=False)
    records=[]
    def backup(target):
        name=str(len(records))+'.original' if target.exists() else None
        if name:shutil.copy2(target,inside(snapshot,name))
        record={'target':str(target),'backup':name,'installed':digest(target)};records.append(record);save();return record
    # Read-only snapshots of relevant state/config for evidence; rollback never resets them.
    for name,source in [('openclaw.json',RUNTIME/'openclaw.json')]+[(a+'.json',RUNTIME/'settings/tts-toggle'/(a+'.json')) for a in ['main','bernhardine','heisenberg']]:
        if source.exists():shutil.copy2(inside(source.parent,source.name),inside(snapshot,'state-'+name))
    manifest=inside(snapshot,'manifest.json')
    def save():manifest.write_text(json.dumps({'version':1,'files':records},indent=2));manifest.chmod(0o600)
    save()
    for source,target in files:
        record=backup(target);target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source,target);record['installed']=digest(target);save()
    for target,content in generated:
        record=backup(target);target.write_text(content);record['installed']=digest(target);save()
    if args.host_patch:
        # Every host original is recorded before the patch subprocess can mutate any bundle.
        host_records=[(bundle,backup(bundle)) for bundle in bundles]
        if any(record['installed']!=projections[str(bundle)]['originalSha256'] for bundle,record in host_records):
            raise ValueError('host bundle changed after preflight')
        try:
            subprocess.run(['node',str(patcher),str(DIST),'--apply'],check=True)
        finally:
            # Attribute only exact preflight originals/outputs, never unknown concurrent edits.
            for bundle,record in host_records:
                projection=projections[str(bundle)]
                current=digest(bundle)
                record['installed']=current if current==projection['originalSha256'] else projection['patchedSha256']
            save()
        if any(digest(bundle)!=record['installed'] for bundle,record in host_records):
            raise ValueError('host bundle changed during patch')
        for bundle in bundles:subprocess.run(['node','--check',str(bundle)],check=True)
    print('SNAPSHOT '+str(snapshot))
    print('ROLLBACK dry-run: python3 '+str(SOURCE/'deploy.py')+' --rollback '+str(snapshot))

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,subprocess.SubprocessError,json.JSONDecodeError):
        sys.exit('Telegram deployment refused/failed; inspect snapshot manifest before rollback.')
