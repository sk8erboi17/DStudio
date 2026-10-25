"""Generic Qwen variant downloader, catalog and download-model.sh routing.

Executes the production scripts (and their real curl transfers) against a
loopback HTTP fixture serving tiny payloads under a test catalog. No weights,
no network. The shipped catalog is checked against the original downloaders
by running their --manifest commands.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
DOWNLOADER = SCRIPTS / 'download-qwen-variant.py'
spec = importlib.util.spec_from_file_location('download_qwen_variant', DOWNLOADER)
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)
SHIPPED = (SCRIPTS / 'qwen-variants.json').read_text(encoding='utf-8')
EDITS = json.loads((ROOT / 'tests/fixtures/qwen-variants/invalid-edits.json').read_text())
R36, R27 = 'a483e9e6cbd595906af30beda3187c2663a1118c', '4ca720788d1e01f1bff70c033e0d0028fd02e502'
RMLX = '10c35caafbb80f7dc6a7a432cdd11af10a6d4818'
PAYLOADS, REQUESTS, OVERSIZED = {}, [], set()


def payload(remote, size):
    seed = hashlib.sha256(remote.encode()).digest()
    return (seed * (size // len(seed) + 1))[:size]


def entry(repository, revision, remote, size, local=None, digest=None):
    data = payload(remote, size)
    PAYLOADS[f'/{repository}/resolve/{revision}/{remote}'] = data
    return {'remote': remote, 'file': local or remote.rsplit('/', 1)[-1], 'bytes': size,
            'sha256': digest or hashlib.sha256(data).hexdigest()}


def gguf(identifier, family, quant, files, repository, revision, requires=(), extra=0):
    return {'id': identifier, 'family': family, 'engine': 'llama', 'quant': quant, 'repository': repository,
            'revision': revision, 'path': 'gguf/' + files[0]['file'], 'requires': list(requires),
            'bytes': sum(f['bytes'] for f in files) + extra, 'files': files}


def mlx(identifier, family, repository, revision, sizes):
    files = [entry(repository, revision, name, size) for name, size in sizes]
    return {'id': identifier, 'family': family, 'engine': 'mlx', 'quant': repository.rsplit('-', 1)[1],
            'repository': repository, 'revision': revision, 'path': 'mlx/' + repository.split('/')[1],
            'requires': [], 'bytes': sum(f['bytes'] for f in files), 'files': files}


Q36, Q27, M27 = 'unsloth/Qwen3.6-35B-A3B-GGUF', 'unsloth/Qwen3.8-27B-GGUF', 'mlx-community/Qwen3.8-27B-4bit'
PROJECTOR = entry(Q27, R27, 'mmproj-F16.gguf', 3001, 'Qwen3.8-27B-mmproj-F16.gguf')
TEST_CATALOG = {
    'schema': catalog.SCHEMA, 'version': catalog.VERSION,
    'components': [{'id': 'qwen27-mmproj-f16', 'role': 'projector', 'family': 'qwen27', 'repository': Q27,
                    'revision': R27, 'files': [PROJECTOR]}],
    'variants': [
        gguf('qwen36-q4_k_m', 'qwen36', 'UD-Q4_K_M', [entry(Q36, R36, 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', 70001)], Q36, R36),
        gguf('qwen27-q4_k_m', 'qwen27', 'UD-Q4_K_M', [entry(Q27, R27, 'Qwen3.8-27B-UD-Q4_K_M.gguf', 50003)], Q27, R27,
             ['qwen27-mmproj-f16'], PROJECTOR['bytes']),
        gguf('qwen36-bf16', 'qwen36', 'BF16', [entry(Q36, R36, 'BF16/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf', 40009),
                                               entry(Q36, R36, 'BF16/Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf', 9007)], Q36, R36),
        gguf('qwen36-q8_0', 'qwen36', 'Q8_0', [entry(Q36, R36, 'Qwen3.6-35B-A3B-Q8_0.gguf', 20011)], Q36, R36),
        gguf('qwen36-mxfp4_moe', 'qwen36', 'MXFP4_MOE', [entry(Q36, R36, 'Qwen3.6-35B-A3B-MXFP4_MOE.gguf', 10007,
                                                               digest='0' * 64)], Q36, R36),
        mlx('qwen27-mlx-4bit', 'qwen27', M27, RMLX, [('config.json', 101), ('model-00001-of-00001.safetensors', 30011),
                                                     ('model.safetensors.index.json', 211), ('tokenizer.json', 4099)]),
    ],
}
# The server sends three more bytes than this variant's pinned size.
OVERSIZED.add(f'/{Q36}/resolve/{R36}/Qwen3.6-35B-A3B-Q8_0.gguf')


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        REQUESTS.append(self.path)
        data = PAYLOADS.get(self.path)
        if data is None:
            self.send_error(404)
            return
        if self.path in OVERSIZED:
            data = data + b'xyz'
        start = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
        self.send_response(206 if start else 200)
        self.send_header('Content-Length', str(len(data) - start))
        if start:
            self.send_header('Content-Range', f'bytes {start}-{len(data) - 1}/{len(data)}')
        self.end_headers()
        try:
            self.wfile.write(data[start:])
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_):
        pass


def edited(text, case):
    for find, replace in case['edits']:
        assert find in text, (case['name'], find)
        text = text.replace(find, replace) if case.get('all') else text.replace(find, replace, 1)
    return text


class CatalogTests(unittest.TestCase):
    def test_shipped_catalog_validates_with_expected_variants(self):
        document = catalog.load()
        counts = {}
        for variant in document['variants']:
            key = (variant['family'], variant['engine'])
            counts[key] = counts.get(key, 0) + 1
        self.assertEqual(counts, {('qwen36', 'llama'): 24, ('qwen36', 'mlx'): 8,
                                  ('qwen27', 'llama'): 25, ('qwen27', 'mlx'): 6})
        quants = {v['quant'] for v in document['variants'] if v['family'] == 'qwen27' and v['engine'] == 'mlx'}
        self.assertEqual(quants, {'4bit', '8bit', 'bf16', 'mxfp4', 'mxfp8', 'nvfp4'})
        quants = {v['quant'] for v in document['variants'] if v['family'] == 'qwen36' and v['engine'] == 'mlx'}
        self.assertEqual(quants, {'4bit', '5bit', '6bit', '8bit', 'bf16', 'mxfp4', 'mxfp8', 'nvfp4'})
        names = [f['file'] for v in document['variants'] for f in v['files'] if v['engine'] == 'llama']
        self.assertFalse([n for n in names if 'mmproj' in n or 'imatrix' in n or 'mtp' in n.lower()])
        # Every 27B GGUF needs the one pinned F16 projector; nothing else needs a component.
        for variant in document['variants']:
            self.assertEqual(variant['requires'], ['qwen27-mmproj-f16'] if
                             (variant['family'], variant['engine']) == ('qwen27', 'llama') else [], variant['id'])
        split = {v['id']: [f['file'] for f in v['files']] for v in document['variants'] if len(v['files']) > 1 and v['engine'] == 'llama'}
        self.assertEqual(sorted(split), ['qwen27-bf16', 'qwen36-bf16'])
        self.assertTrue(all(f[0].endswith('-00001-of-00002.gguf') and f[1].endswith('-00002-of-00002.gguf') for f in split.values()))

    def test_original_pins_equal_their_original_downloaders(self):
        document = catalog.load()
        by_id = {v['id']: v for v in document['variants']}
        projector = document['components'][0]['files'][0]

        def manifest(script):
            result = subprocess.run([sys.executable, str(SCRIPTS / script), '--manifest'], capture_output=True,
                                    text=True, timeout=20, cwd=tempfile.gettempdir())
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        q35 = manifest('download-qwen35.py')
        self.assertEqual((q35['repository'], q35['revision']), (by_id['qwen36-q6']['repository'], by_id['qwen36-q6']['revision']))
        self.assertEqual({k: q35['files']['model'][k] for k in ('file', 'bytes', 'sha256')},
                         {k: by_id['qwen36-q6']['files'][0][k] for k in ('file', 'bytes', 'sha256')})
        q27 = manifest('download-qwen27.py')
        self.assertEqual(q27['revision'], by_id['qwen27-q6']['revision'])
        self.assertEqual(q27['files']['model']['sha256'], by_id['qwen27-q6']['files'][0]['sha256'])
        self.assertEqual((q27['files']['vision']['remote'], q27['files']['vision']['file'], q27['files']['vision']['sha256']),
                         (projector['remote'], projector['file'], projector['sha256']))
        self.assertEqual(by_id['qwen27-q6']['bytes'], q27['files']['model']['bytes'] + q27['files']['vision']['bytes'])
        q36mlx = manifest('download-mlx-qwen36.py')
        self.assertEqual(q36mlx['revision'], by_id['qwen36-mlx']['revision'])
        self.assertEqual('mlx/' + q36mlx['folder'], by_id['qwen36-mlx']['path'])
        self.assertEqual(q36mlx['files'], {f['file']: {'bytes': f['bytes'], 'sha256': f['sha256']} for f in by_id['qwen36-mlx']['files']})
        self.assertEqual(q36mlx['bytes'], by_id['qwen36-mlx']['bytes'])

    def test_the_five_planned_real_weight_checks_are_pinned(self):
        by_id = {v['id']: v for v in catalog.load()['variants']}
        planned = {'qwen36-q4_k_m': 22.1, 'qwen36-iq4_xs': 17.7, 'qwen36-mxfp4_moe': 21.7,
                   'qwen36-mlx-nvfp4': 20.4, 'qwen27-mlx-4bit': 16.1}
        self.assertEqual({k: round(by_id[k]['bytes'] / 1e9, 1) for k in planned}, planned)
        self.assertEqual(round(sum(by_id[k]['bytes'] for k in planned) / 1e9), 98)

    def test_invalid_catalog_edits_are_rejected(self):
        catalog.parse(SHIPPED.encode(), legacy=True)
        for case in EDITS['cases']:
            with self.subTest(case=case['name']):
                with self.assertRaises(ValueError):
                    catalog.parse(edited(SHIPPED, case).encode(), legacy=True)

    def test_oversized_catalog_is_rejected_before_parsing(self):
        with self.assertRaisesRegex(ValueError, 'size limit'):
            catalog.parse(b' ' * (catalog.CATALOG_MAX_BYTES + 1))


class DownloaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dstudio-qwen-variant-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.catalog = self.root / 'test catalog.json'
        self.catalog.write_text(json.dumps(TEST_CATALOG))
        self.ds4 = self.root / 'ds4'
        self.gguf = self.ds4 / 'gguf'
        self.gguf.mkdir(parents=True)
        REQUESTS.clear()

    def run_cli(self, *args, catalog_path=True, **kwargs):
        command = [sys.executable, str(DOWNLOADER), *(['--catalog', str(self.catalog)] if catalog_path else []), *args]
        return subprocess.run(command, capture_output=True, text=True, timeout=60, **kwargs)

    def fetch(self, variant, *extra, **kwargs):
        return self.run_cli('--base-url', self.url, '--variant', variant, *extra, **kwargs)

    def test_single_file_gguf_is_published_verified_and_reused(self):
        result = self.fetch('qwen36-q4_k_m', '--directory', str(self.gguf))
        self.assertEqual(result.returncode, 0, result.stderr)
        target = self.gguf / 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'
        self.assertEqual(target.read_bytes(), payload('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', 70001))
        self.assertEqual(REQUESTS, [f'/{Q36}/resolve/{R36}/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'])
        self.assertFalse((self.gguf / '.dstudio-qwen27-downloads/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf/data.part').exists())
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])['verifiedFiles'][0]['bytes'], 70001)
        again = self.fetch('qwen36-q4_k_m', '--root', str(self.ds4))
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(len(REQUESTS), 1, 'a verified file is reused, never fetched again')

    def test_27b_gguf_brings_its_projector_from_its_own_pin(self):
        result = self.fetch('qwen27-q4_k_m', '--root', str(self.ds4))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.gguf / 'Qwen3.8-27B-UD-Q4_K_M.gguf').stat().st_size, 50003)
        self.assertEqual((self.gguf / 'Qwen3.8-27B-mmproj-F16.gguf').read_bytes(), payload('mmproj-F16.gguf', 3001))
        self.assertEqual(REQUESTS, [f'/{Q27}/resolve/{R27}/Qwen3.8-27B-UD-Q4_K_M.gguf', f'/{Q27}/resolve/{R27}/mmproj-F16.gguf'])

    def test_split_bf16_parts_land_in_gguf_under_their_own_names(self):
        result = self.fetch('qwen36-bf16', '--directory', str(self.gguf))
        self.assertEqual(result.returncode, 0, result.stderr)
        for part, size in ((1, 40009), (2, 9007)):
            name = f'Qwen3.6-35B-A3B-BF16-0000{part}-of-00002.gguf'
            self.assertEqual((self.gguf / name).read_bytes(), payload('BF16/' + name, size))
        self.assertEqual(REQUESTS, [f'/{Q36}/resolve/{R36}/BF16/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf',
                                    f'/{Q36}/resolve/{R36}/BF16/Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf'])
        self.assertFalse((self.gguf / 'BF16').exists())

    def test_mlx_folder_publishes_config_last_with_progress_phases(self):
        read, write = os.pipe()
        try:
            result = self.fetch('qwen27-mlx-4bit', '--root', str(self.ds4), '--progress-fd', str(write), pass_fds=(write,))
        finally:
            os.close(write)
        phases = os.read(read, 64).decode()
        os.close(read)
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = self.ds4 / 'mlx/Qwen3.8-27B-4bit'
        self.assertEqual(sorted(p.name for p in folder.iterdir() if not p.name.startswith('.')),
                         ['config.json', 'model-00001-of-00001.safetensors', 'model.safetensors.index.json', 'tokenizer.json'])
        self.assertTrue(REQUESTS[-1].endswith('/config.json'), REQUESTS)
        self.assertEqual(phases, 'DV' * 4)

    def test_size_mismatch_is_refused_without_publication(self):
        result = self.fetch('qwen36-q8_0', '--directory', str(self.gguf))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.gguf / 'Qwen3.6-35B-A3B-Q8_0.gguf').exists())
        partial = self.gguf / '.dstudio-qwen27-downloads/Qwen3.6-35B-A3B-Q8_0.gguf/data.part'
        self.assertLessEqual(partial.stat().st_size, 20011)

    def test_digest_mismatch_is_refused_and_the_partial_kept(self):
        result = self.fetch('qwen36-mxfp4_moe', '--directory', str(self.gguf))
        self.assertEqual(result.returncode, 1)
        self.assertIn('Checksum mismatch', result.stderr)
        self.assertFalse((self.gguf / 'Qwen3.6-35B-A3B-MXFP4_MOE.gguf').exists())
        partial = self.gguf / '.dstudio-qwen27-downloads/Qwen3.6-35B-A3B-MXFP4_MOE.gguf/data.part'
        self.assertEqual(partial.read_bytes(), payload('Qwen3.6-35B-A3B-MXFP4_MOE.gguf', 10007))

    def test_replaced_store_is_never_written(self):
        info = self.gguf.stat()
        self.gguf.rename(self.ds4 / 'old gguf')
        self.gguf.mkdir()
        result = self.fetch('qwen36-q4_k_m', '--directory', str(self.gguf), '--directory-identity', f'{info.st_dev}:{info.st_ino}')
        self.assertEqual(result.returncode, 1)
        self.assertIn('changed since download admission', result.stderr)
        self.assertEqual(list(self.gguf.iterdir()), [])
        self.assertEqual(REQUESTS, [])

    def test_verify_only_never_downloads(self):
        result = self.fetch('qwen36-q4_k_m', '--directory', str(self.gguf), '--verify-only')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(REQUESTS, [])

    def test_remote_hosts_other_than_the_hub_are_refused(self):
        result = self.run_cli('--base-url', 'http://example.com', '--variant', 'qwen36-q4_k_m', '--directory', str(self.gguf))
        self.assertEqual(result.returncode, 1)
        self.assertIn('--base-url', result.stderr)
        self.assertEqual(REQUESTS, [])

    def test_read_only_commands_touch_neither_disk_nor_network(self):
        before = sorted(self.root.rglob('*'))
        listing = self.run_cli('--list')
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn('qwen27-mlx-4bit', listing.stdout)
        field = self.run_cli('--variant', 'qwen27-mlx-4bit', '--field', 'store')
        self.assertEqual(field.stdout.strip(), 'mlx/Qwen3.8-27B-4bit')
        manifest = json.loads(self.run_cli('--variant', 'qwen27-q4_k_m', '--manifest').stdout)
        self.assertEqual([f['file'] for f in manifest['files']], ['Qwen3.8-27B-UD-Q4_K_M.gguf', 'Qwen3.8-27B-mmproj-F16.gguf'])
        self.assertEqual(sorted(self.root.rglob('*')), before)
        self.assertEqual(REQUESTS, [])

    def test_unknown_original_and_invalid_inputs_are_refused(self):
        self.assertEqual(self.run_cli('--variant', 'qwen36-q2_k', '--field', 'engine').returncode, 2)
        original = self.run_cli('--variant', 'qwen36-q6', '--root', str(self.ds4), catalog_path=False)
        self.assertEqual(original.returncode, 2)
        self.assertIn('download-qwen35.py', original.stderr)
        self.catalog.write_text(edited(json.dumps(TEST_CATALOG), {'edits': [['"version": 1', '"version": 3']]}))
        invalid = self.run_cli('--variant', 'qwen36-q4_k_m', '--root', str(self.ds4))
        self.assertEqual(invalid.returncode, 2)
        self.assertIn('Invalid Qwen variant catalog', invalid.stderr)
        self.assertEqual(REQUESTS, [])


class DownloadModelRoutingTests(unittest.TestCase):
    """The repository CLI with stub make/dstudio; downloads use the loopback fixture."""

    @classmethod
    def setUpClass(cls):
        DownloaderTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        DownloaderTests.tearDownClass.__func__(cls)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dstudio-download-model-')
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name).resolve() / 'project root'
        (self.project / 'scripts').mkdir(parents=True)
        (self.project / 'ds4/gguf').mkdir(parents=True)
        (self.project / 'ds4/ds4.c').write_text('')
        (self.project / 'llama.cpp').mkdir()  # what the (stubbed) llama.cpp installer creates
        shutil.copy(ROOT / 'download-model.sh', self.project)
        for name in ('download-qwen-variant.py', 'download-qwen27.py', 'download-qwen35.py', 'download-mlx-qwen36.py'):
            shutil.copy(SCRIPTS / name, self.project / 'scripts')
        # The shipped original pins plus two tiny test variants, at the default
        # location: the downloader checks the original pins as in production.
        shipped = json.loads(SHIPPED)
        originals = [v for v in shipped['variants'] if v['id'] in catalog.LEGACY]
        tiny = [v for v in TEST_CATALOG['variants'] if v['id'] in ('qwen36-q4_k_m', 'qwen27-mlx-4bit')]
        (self.project / 'scripts/qwen-variants.json').write_text(json.dumps(
            {**shipped, 'variants': originals + tiny}))
        self.bin = Path(self.temp.name) / 'bin'
        self.bin.mkdir()
        self.calls = Path(self.temp.name) / 'calls.txt'
        for stub, path in (('make', self.bin / 'make'), ('dstudio', self.project / 'dstudio')):
            path.write_text(f'#!/bin/sh\nprintf "%s %s\\n" {stub} "$*" >> "{self.calls}"\n')
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        REQUESTS.clear()

    def cli(self, *args):
        env = {**os.environ, 'PATH': f'{self.bin}{os.pathsep}{os.environ["PATH"]}', 'HF_TOKEN': ''}
        return subprocess.run(['sh', str(self.project / 'download-model.sh'), *args], capture_output=True,
                              text=True, timeout=60, env=env)

    def calls_made(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_gguf_and_mlx_variants_install_their_engine_and_land_in_the_store(self):
        result = self.cli('qwen36-q4_k_m', '--base-url', self.url)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(self.calls_made(), ['make dstudio', f'dstudio --install-engine llama {self.project}'])
        self.assertEqual((self.project / 'ds4/gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf').stat().st_size, 70001)
        result = self.cli('qwen27-mlx-4bit', '--base-url', self.url)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(self.calls_made()[-1], f'dstudio --install-engine mlx {self.project}')
        self.assertEqual(len(list((self.project / 'ds4/mlx/Qwen3.8-27B-4bit').glob('*.json'))), 3)

    def test_unknown_qwen_target_stops_before_building(self):
        result = self.cli('qwen36-q2_k', '--base-url', self.url)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Unknown Qwen variant', result.stderr)
        self.assertEqual(self.calls_made(), [])

    def test_original_targets_keep_their_original_downloaders(self):
        for target, key, expected in (('qwen36-q6', 'revision', R36), ('qwen27-q6', 'revision', R27),
                                      ('qwen36-mlx', 'folder', 'Qwen3.6-35B-A3B-mxfp8')):
            with self.subTest(target=target):
                result = self.cli(target, '--manifest')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1])[key], expected)
        self.assertEqual([c.split('--install-engine ')[1].split()[0] for c in self.calls_made() if 'install-engine' in c],
                         ['llama', 'llama', 'mlx'])

    def test_help_and_listing(self):
        help_text = self.cli('--help').stdout
        self.assertIn('qwen36-*, qwen27-*', help_text)
        self.assertIn('--list-qwen', help_text)
        listing = self.cli('--list-qwen')
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertEqual([line.split()[0] for line in listing.stdout.splitlines()],
                         ['qwen36-q6', 'qwen36-mlx', 'qwen27-q6', 'qwen36-q4_k_m', 'qwen27-mlx-4bit'])
        self.assertEqual(self.calls_made(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
