#!/usr/bin/env python3
"""Create or verify a release checksum manifest without self or missing entries."""
import argparse
import hashlib
from pathlib import Path


def digest(path):
    """Hash a release asset without loading native installers into memory."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_manifest(directory, names, output='SHA256SUMS'):
    """Cover exactly the explicitly selected existing assets, excluding the manifest."""
    directory = Path(directory)
    if not names or len(set(names)) != len(names):
        raise ValueError('empty or duplicate release asset selection')
    if Path(output).name != output:
        raise ValueError('manifest must be a basename')
    rows = []
    for name in sorted(names):
        path = directory / name
        if name == output or Path(name).name != name or '\n' in name or '\r' in name:
            raise ValueError('invalid asset name or checksum self reference')
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'missing or linked release asset: {name}')
        rows.append(f'{digest(path)}  {name}\n')
    (directory / output).write_text(''.join(rows), encoding='utf-8')


def verify_manifest(directory, manifest='SHA256SUMS'):
    """Reject duplicate entries, self references, missing files and altered bytes."""
    directory = Path(directory)
    seen = set()
    for line in (directory / manifest).read_text(encoding='utf-8').splitlines():
        checksum, name = line.split('  ', 1)
        if name in seen or name == manifest or Path(name).name != name:
            raise ValueError(f'invalid manifest entry: {name}')
        seen.add(name)
        path = directory / name
        if path.is_symlink() or not path.is_file() or digest(path) != checksum:
            raise ValueError(f'asset verification failed: {name}')
    if not seen:
        raise ValueError('empty manifest')
    return sorted(seen)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--manifest', default='SHA256SUMS')
    parser.add_argument('--write', nargs='+', metavar='ASSET')
    args = parser.parse_args()
    if args.write:
        write_manifest(args.directory, args.write, args.manifest)
    print(f'Verified {len(verify_manifest(args.directory, args.manifest))} assets')
