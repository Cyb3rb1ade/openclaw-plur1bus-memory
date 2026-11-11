"""Receipt retries are allowed only over a verified, unchanged safe installation."""
import json
from pathlib import Path
import re

SAFE_STATUSES = {
    'installed-restart-required': 'installed', 'installed-restart-failed': 'installed', 'installed-restored': 'installed',
    'refused-recovery-required': 'prewrite', 'refused-restored': 'prewrite',
    'files-restored-python-unchanged': 'rollback', 'files-restored-pm-selection-unchanged': 'rollback',
    'files-restored-pm-selection-admitted': 'rollback', 'rollback-restored': 'rollback',
}


def engine_fingerprint(api):
    directory = Path(api.__file__).parent
    return {name: api.digest((directory / name).read_bytes()) for name in
            ('installer.py', 'runtime_lifecycle.py', 'runtime_worker.py', 'runtime_clients.py', 'runtime_recovery.py', 'runtime_service_identity.py')}


def snapshot(plan, journal, api):
    home = api.root_path(plan['home'])
    paths = set(journal['files']) | set(plan.get('sharedDesktop', {}))
    for name in plan['profiles']:
        prefix = '' if name == 'default' else 'profiles/' + name + '/'
        paths.update((prefix + 'config.yaml', prefix + (api.DESKTOP_RECEIPT if plan['desktopOnly'] else api.RECEIPT)))
    for name in plan['destinations']:
        profile, relative = name.split('/', 1)
        paths.add(('' if profile == 'default' else 'profiles/' + profile + '/') + relative)
    files = {}
    for relative in sorted(paths):
        path = api.resolve_inside(home, relative)
        files[relative] = api.digest(path.read_bytes()) if path.exists() else None
    environment = None
    if not plan['desktopOnly']:
        python = api.interpreter(home) if plan['pmManaged'] else Path(plan['python'])
        environment = api.environment_state(python)['fingerprint']
    return {'files': files, 'environment': environment, 'engine': engine_fingerprint(api), 'manifest': plan['manifest']}


def available(journal):
    recovery = journal.get('runtimeRecovery', {})
    return bool(journal.get('runtimes') and recovery.get('phase') == SAFE_STATUSES.get(journal.get('status')))


def restore(bundle, home, receipt_id, progress, api):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', receipt_id):
        raise ValueError('invalid runtime receipt identifier')
    home, bundle = api.root_path(home), api.root_path(bundle)
    api.verify_bundle(bundle)
    receipt = api.resolve_inside(home, 'plur1bus-install-backups/' + receipt_id)
    journal_path = api.resolve_inside(receipt, 'journal.json')
    plan = json.loads(api.resolve_inside(receipt, 'plan.json').read_text())
    journal = json.loads(journal_path.read_text())
    if plan.get('home') != str(home) or journal.get('home') != str(home):
        raise ValueError('runtime receipt belongs to another home')
    if api.digest((bundle / api.MANIFEST).read_bytes()) != plan.get('manifest'):
        raise ValueError('runtime recovery requires the original verified installer bundle')
    if not available(journal):
        raise ValueError('no verified safe restart state; a partial installation requires repair or verified rollback')
    lock = api.resolve_inside(home, '.plur1bus-install-lock')
    lock.mkdir()  # Never remove a pre-existing lock, including interrupted installs.
    try:
        if plan.get('pmManaged') and api.resolve_inside(api.pm_install_state_root(home), 'publication.json').exists():
            raise ValueError('Hermes PM publication is unfinished; repair it before runtime recovery')
        if not plan['desktopOnly'] and not plan['pmManaged'] and Path(plan['python']).absolute() != api.interpreter(home).absolute():
            raise ValueError('receipt Python is not the selected Hermes runtime')
        expected = journal['runtimeRecovery']['snapshot']
        if snapshot(plan, journal, api) != expected:
            raise ValueError('installation files/environment changed since the verified safe state')
        def persist(state):
            journal['runtimes'] = state
            api.atomic_write(journal_path, json.dumps(journal, indent=2).encode())
        lifecycle = api.RuntimeLifecycle(home, lambda: api.interpreter(home), persist, progress)
        lifecycle.state = journal['runtimes']
        try:
            lifecycle.restore()
        except BaseException:
            if progress:
                progress({'phase': 'installation-outcome', 'status': journal['status'], 'receipt': str(receipt),
                          'runtimes': journal['runtimes'], 'recoveryAvailable': True})
            raise
        phase = journal['runtimeRecovery']['phase']
        journal['status'] = {'installed': 'installed-restored', 'prewrite': 'refused-restored', 'rollback': 'rollback-restored'}[phase]
        persist(lifecycle.state)
        if progress:
            progress({'phase': 'installation-outcome', 'status': journal['status'], 'receipt': str(receipt),
                      'runtimes': journal['runtimes'], 'recoveryAvailable': False})
        return receipt
    finally:
        lock.rmdir()


def verify_rollback(plan, journal, api):
    """Only intact pre-install packages/files make a file rollback restart-safe."""
    before = journal.get('runtimeRecoveryBefore')
    journal.pop('runtimeRecovery', None)
    if not before or journal.get('pipChanged') or SAFE_STATUSES.get(journal.get('status')) != 'rollback':
        return
    current = snapshot(plan, journal, api)
    if current['environment'] != before['environment']:
        return  # A compatible PM graph is not proof of the original imports.
    expected = dict(before['files'])
    expected.update({path: record['before'] for path, record in journal['files'].items()})
    for path, digest in expected.items():
        if not api.is_pm_native_cache_relative(path) and current['files'].get(path) != digest:
            return
    journal['runtimeRecovery'] = {'phase': 'rollback', 'snapshot': current}
