"""DB-free regressions for the native wheel architecture acceptance guard."""
from pathlib import Path
import runpy
import struct
import tempfile
import unittest

_storage = runpy.run_path(str(Path(__file__).with_name('verify-windows-arm64-storage.py')))
pe_machine = _storage['pe_machine']
cpython_wheel_tag = _storage['cpython_wheel_tag']


class NativeMachineGuardTests(unittest.TestCase):
    def probe(self, content):
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'candidate.pyd'
            binary.write_bytes(content)
            return pe_machine(binary)

    def header(self, machine):
        data = bytearray(134)
        data[:2] = b'MZ'
        struct.pack_into('<I', data, 0x3C, 128)
        data[128:132] = b'PE\0\0'
        struct.pack_into('<H', data, 132, machine)
        return data

    def test_native_arm_is_not_confused_with_emulated_x64(self):
        self.assertEqual(self.probe(self.header(0xAA64)), 0xAA64)
        self.assertEqual(self.probe(self.header(0x8664)), 0x8664)
        self.assertNotEqual(self.probe(self.header(0x8664)), 0xAA64)

    def test_invalid_and_truncated_headers_fail_closed(self):
        for data in (b'', b'ELF', b'MZ', self.header(0xAA64)[:130]):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                self.probe(data)

    def test_corrupt_signature_and_out_of_file_pointer_fail_closed(self):
        signature = self.header(0xAA64)
        signature[128] = 0
        pointer = self.header(0xAA64)
        struct.pack_into('<I', pointer, 0x3C, 0xFFFFFFFF)
        for data in (signature, pointer):
            with self.assertRaises(ValueError):
                self.probe(data)

    def test_candidate_python_tags_cover_legacy_and_current_pm(self):
        self.assertEqual(cpython_wheel_tag((3, 13, 15)), 'cp313')
        self.assertEqual(cpython_wheel_tag((3, 14, 6)), 'cp314')
        for version in ((3, 12, 10), (3, 15, 0), (2, 7, 18)):
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                cpython_wheel_tag(version)


if __name__ == '__main__':
    unittest.main()
