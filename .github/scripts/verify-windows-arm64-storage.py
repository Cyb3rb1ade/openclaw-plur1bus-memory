"""Exercise installed native storage wheels; never use an application database."""
import importlib.metadata
import json
import platform
from pathlib import Path
import struct
import sys
import tempfile


def pe_machine(path):
    """Return a PE file's machine field, rejecting truncated or non-PE files."""
    with Path(path).open('rb') as stream:
        if stream.read(2) != b'MZ':
            raise ValueError(f'Not a PE executable: {path}')
        stream.seek(0x3C)
        pointer = stream.read(4)
        if len(pointer) != 4:
            raise ValueError(f'Truncated DOS header: {path}')
        stream.seek(struct.unpack('<I', pointer)[0])
        header = stream.read(6)
        if len(header) != 6 or header[:4] != b'PE\0\0':
            raise ValueError(f'Invalid PE signature: {path}')
        return struct.unpack('<H', header[4:])[0]


def main():
    if sys.platform != 'win32' or platform.machine().upper() != 'ARM64':
        raise RuntimeError('Native Windows ARM64 Python required')
    import lancedb
    import lancedb._lancedb as native
    import pyarrow as pa
    import pyarrow.lib
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import pyarrow.parquet as pq

    assert importlib.metadata.version('lancedb') == '0.34.0'
    assert importlib.metadata.version('pyarrow') == '25.0.1'
    native_files = [Path(sys.executable), Path(native.__file__)]
    native_files.extend(Path(pa.__file__).parent.glob('*.pyd'))
    native_files.extend(Path(pa.__file__).parent.glob('*.dll'))
    assert len(native_files) >= 3
    for path in native_files:
        assert pe_machine(path) == 0xAA64, f'Not native ARM64: {path}'
    with tempfile.TemporaryDirectory(prefix='plur1bus-arm-storage-') as root:
        schema = pa.schema([('id', pa.string()), ('vector', pa.list_(pa.float32(), 3))])
        db = lancedb.connect(str(Path(root) / 'database'))
        table = db.create_table('memories', schema=schema)
        table.add([{'id': 'first', 'vector': [1., 0., 0.]}])
        table.add_columns({'scopeKey': "cast('' as string)"})
        table.add([{'id': 'second', 'vector': [0., 1., 0.], 'scopeKey': 'private'}])
        assert table.count_rows() == 2
        assert table.search([1., 0., 0.]).limit(1).to_list()[0]['id'] == 'first'
        assert table.search([0., 1., 0.]).where("scopeKey = 'private'").limit(1).to_list()[0]['id'] == 'second'
        reopened = lancedb.connect(str(Path(root) / 'database')).open_table('memories')
        assert reopened.count_rows() == 2
        assert reopened.schema.field('vector').type.list_size == 3
        parquet = Path(root) / 'roundtrip.parquet'
        pq.write_table(pa.table({'number': [1, 2]}), parquet)
        assert ds.dataset(parquet).to_table().num_rows == 2
        assert pc.sum(pq.read_table(parquet)['number']).as_py() == 3
    print(json.dumps({'nativeStorageSmoke': True, 'machine': platform.machine(),
                      'python': platform.python_version(), 'lancedb': '0.34.0',
                      'pyarrow': '25.0.1', 'nativeBinaryCount': len(native_files)}))


if __name__ == '__main__':
    main()
