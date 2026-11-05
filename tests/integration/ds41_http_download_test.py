"""Production shell/curl on tiny loopback HTTP fixtures; no weights or inference."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/download-ds41-1017.sh'
ARTIFACTS = ROOT / 'tests/.artifacts/ds41-1017-download'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
RUN = Path(tempfile.mkdtemp(prefix='run-', dir=ARTIFACTS))
PINS = [
    ('ds41f-q2', 'antirez/deepseek-v4.1-flash-gguf', '9dcee51692e6540f697141fc98b097e3c96492a3',
     'DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf', 365713686528,
     '5296e85ff64b42ecb62c8d0c0c54e1caa07e3df8e93112f2365ebbaed62ce93a'),
    ('ds41f-1017-vision', 'nazeshinjite/DeepSeek-V4.1-Flash-1017-ds4-GGUF', '796f58533a0e4b7a89cb006b22aeb44e783f0323',
     'DeepSeek-V4.1-Flash-1017-Vision.gguf', 970555552,
     '861f1097e8686111fa23dc4a6bf139fd0c4cc114db2f1b4090a267f7683c0dbf'),
    ('ds41f-q2-original', 'antirez/deepseek-v4.1-flash-gguf', '9dcee51692e6540f697141fc98b097e3c96492a3',
     'DeepSeek-V4.1-Flash-Q2.gguf', 365713686528,
     '1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42'),
]
BODY = bytes(range(251)) * 12000
SHA = hashlib.sha256(BODY).hexdigest()
RECEIPTS = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        server = self.server
        server.requests.append({'path': self.path, 'range': self.headers.get('Range'),
                                'authorization': self.headers.get('Authorization')})
        mode = server.mode
        if mode == 'fail':
            self.send_error(503)
            return
        start = int((self.headers.get('Range') or 'bytes=0-').split('=')[1].split('-')[0])
        payload = BODY[start:]
        if mode == 'corrupt':
            payload = bytes([payload[0] ^ 1]) + payload[1:]
        if mode == 'ignore-range':
            start, payload = 0, BODY
        self.send_response(206 if start else 200)
        self.send_header('Content-Length', str(len(payload)))
        if start:
            self.send_header('Content-Range', f'bytes {start}-{len(BODY)-1}/{len(BODY)}')
        self.end_headers()
        if mode == 'hold':
            self.wfile.write(payload[:1024 * 1024])
            self.wfile.flush()
            server.release.wait(15)
            return
        if mode == 'interrupt-once':
            server.mode = 'normal'
            payload = payload[:1024 * 1024 + 17]
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix=self._testMethodName + '-', dir=RUN))
        self.out = self.directory / 'gguf'
        self.cache = self.out / '.cache/huggingface/download'
        self.cache.mkdir(parents=True)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.requests, self.server.mode = [], 'normal'
        self.server.release = threading.Event()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = {**os.environ, 'HOME': str(self.directory), 'HF_TOKEN': '',
                    'DS4_GGUF_DIR': str(self.out), 'DSTUDIO_DS41_1017_TEST_MODE': '1',
                    'DSTUDIO_DS41_1017_TEST_BYTES': str(len(BODY)), 'DSTUDIO_DS41_1017_TEST_SHA': SHA,
                    'DSTUDIO_DS41_1017_TEST_URL': f'http://127.0.0.1:{self.server.server_port}'}
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                child.communicate(timeout=5)
        self.server.release.set()
        self.server.shutdown()
        self.server.server_close()

    def launch(self, pin=PINS[0], args=(), script=SCRIPT, env=None):
        child = subprocess.Popen(['sh', str(script), pin[0], *args], cwd=self.directory,
                                 env=env or self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True)
        self.children.append(child)
        return child

    def download(self, pin=PINS[0], ok=True, **kwargs):
        child = self.launch(pin, **kwargs)
        stdout, stderr = child.communicate(timeout=15)
        RECEIPTS.append({'test': self._testMethodName, 'target': pin[0], 'code': child.returncode,
                         'stdout': stdout, 'stderr': stderr})
        self.assertEqual(child.returncode == 0, ok, stdout + stderr)
        return stdout + stderr

    def partial(self, name='legacy', count=1234567):
        p = self.cache / f'{name}.{SHA}.retry.incomplete'
        p.write_bytes(BODY[:count])
        return p

    def test_pins_and_each_target(self):
        for pin in PINS:
            with self.subTest(pin=pin[0]):
                result = subprocess.run(['sh', str(SCRIPT), pin[0], '--print-pin'],
                                        capture_output=True, text=True, check=True)
                self.assertEqual(result.stdout, ' '.join(map(str, pin[1:])) + '\n')
                self.download(pin)
                self.assertEqual((self.out / pin[3]).read_bytes(), BODY)
                self.assertEqual(self.server.requests[-1]['path'], f'/{pin[1]}/resolve/{pin[2]}/{pin[3]}')
                count = len(self.server.requests)
                self.download(pin)
                self.assertEqual(len(self.server.requests), count)

    def test_resume_largest_hf_partial_in_place(self):
        chosen = self.partial()
        smaller = self.partial('smaller', 99)
        neighbour = self.cache / ('other.' + 'a' * 64 + '.incomplete')
        neighbour.write_bytes(b'other model')
        inode = chosen.stat().st_ino
        self.download()
        final = self.out / PINS[0][3]
        self.assertEqual(final.read_bytes(), BODY)
        self.assertEqual(final.stat().st_ino, inode)
        self.assertEqual(self.server.requests[0]['range'], 'bytes=1234567-')
        self.assertFalse(chosen.exists())
        self.assertEqual(smaller.read_bytes(), BODY[:99])
        self.assertEqual(neighbour.read_bytes(), b'other model')

    def test_interrupted_connection_retries_from_actual_size(self):
        self.server.mode = 'interrupt-once'
        self.download()
        self.assertEqual(self.server.requests[1]['range'], f'bytes={1024 * 1024 + 17}-')
        self.assertEqual((self.out / PINS[0][3]).read_bytes(), BODY)

    def test_stop_retains_partial_and_concurrent_download_is_refused(self):
        self.server.mode = 'hold'
        child = self.launch()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            partials = list(self.cache.glob('*.incomplete'))
            if partials and partials[0].stat().st_size >= 512 * 1024:
                break
            time.sleep(0.02)
        else:
            self.fail('download did not reach the controlled barrier')
        self.assertIn('already active', self.download(ok=False))
        os.killpg(child.pid, signal.SIGTERM)
        child.communicate(timeout=5)
        self.assertNotEqual(child.returncode, 0)
        count = partials[0].stat().st_size
        self.assertGreaterEqual(count, 512 * 1024)
        self.assertFalse((self.out / PINS[0][3]).exists())
        self.server.release.set()
        self.server.mode = 'normal'
        self.download()
        self.assertEqual(self.server.requests[-1]['range'], f'bytes={count}-')
        self.assertEqual((self.out / PINS[0][3]).read_bytes(), BODY)

    def test_ignored_range_does_not_append_wrong_bytes(self):
        partial = self.partial()
        self.server.mode = 'ignore-range'
        self.download(ok=False)
        self.assertEqual(partial.read_bytes(), BODY[:1234567])
        self.assertFalse((self.out / PINS[0][3]).exists())

    def test_bad_hash_is_preserved_but_never_published(self):
        self.server.mode = 'corrupt'
        self.assertIn('Checksum mismatch', self.download(ok=False))
        self.assertFalse((self.out / PINS[0][3]).exists())
        self.assertEqual(len(list(self.cache.glob('*.incomplete'))), 1)

    def test_existing_bad_weights_are_untouched(self):
        final = self.out / PINS[0][3]
        for body in (b'short', b'x' * len(BODY)):
            final.write_bytes(body)
            self.download(ok=False)
            self.assertEqual(final.read_bytes(), body)
        self.assertEqual(self.server.requests, [])

    def test_symlink_and_oversized_partial_are_refused(self):
        neighbour = self.directory / 'neighbour'
        neighbour.write_bytes(b'untouched')
        partial = self.cache / f'linked.{SHA}.x.incomplete'
        partial.symlink_to(neighbour)
        self.download(ok=False)
        self.assertEqual(neighbour.read_bytes(), b'untouched')
        partial.unlink()
        partial.write_bytes(BODY + b'oversized')
        self.download(ok=False)
        self.assertEqual(partial.read_bytes(), BODY + b'oversized')
        self.assertEqual(self.server.requests, [])

    def test_transport_failure_retains_old_partial(self):
        partial = self.partial()
        self.server.mode = 'fail'
        self.download(ok=False)
        self.assertEqual(partial.read_bytes(), BODY[:1234567])

    def test_tokens_reach_http(self):
        self.download(args=('--token', 'fixture-token'))
        self.assertEqual(self.server.requests[-1]['authorization'], 'Bearer fixture-token')
        (self.out / PINS[0][3]).unlink()
        self.env['HF_TOKEN'] = 'environment-token'
        self.download()
        self.assertEqual(self.server.requests[-1]['authorization'], 'Bearer environment-token')
        (self.out / PINS[0][3]).unlink()
        self.env['HF_TOKEN'] = ''
        token_file = self.directory / '.cache/huggingface/token'
        token_file.parent.mkdir(parents=True)
        token_file.write_text('cached-token')
        self.download()
        self.assertEqual(self.server.requests[-1]['authorization'], 'Bearer cached-token')

    def test_production_oracle_ignores_test_values(self):
        final = self.out / PINS[0][3]
        final.write_bytes(BODY)
        self.env.pop('DSTUDIO_DS41_1017_TEST_MODE')
        self.assertIn('Incorrect file size', self.download(ok=False))
        self.assertEqual(self.server.requests, [])

    def test_existing_verified_hard_link_is_reusable(self):
        final = self.out / PINS[0][3]
        final.write_bytes(BODY)
        os.link(final, self.directory / 'existing-link')
        self.download()
        self.assertEqual(final.read_bytes(), BODY)
        self.assertEqual(self.server.requests, [])

    def test_unknown_targets_are_refused_without_network(self):
        for target in ('ds41f-1017-q2', 'ds41f-q4', 'ds41f-vision'):
            self.assertIn('Unknown target', self.download((target,), ok=False))
        self.assertEqual(self.server.requests, [])

    def test_root_cli_routes_and_help(self):
        project = self.directory / 'project with spaces'
        (project / 'scripts').mkdir(parents=True)
        (project / 'ds4/gguf').mkdir(parents=True)
        (project / 'ds4/ds4.c').touch()
        shutil.copyfile(ROOT / 'download-model.sh', project / 'download-model.sh')
        shutil.copyfile(SCRIPT, project / 'scripts/download-ds41-1017.sh')
        bin_dir = self.directory / 'bin'
        bin_dir.mkdir()
        for dest in (bin_dir / 'make', project / 'dstudio'):
            dest.write_text('#!/bin/sh\nexit 0\n')
            dest.chmod(0o755)
        (project / 'ds4/download_model.sh').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> routed.txt\n')
        env = {**self.env, 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH']}
        env.pop('DS4_GGUF_DIR')
        for pin in PINS:
            self.download(pin, script=project / 'download-model.sh', env=env)
            self.assertEqual((project / 'ds4/gguf' / pin[3]).read_bytes(), BODY)
        for target in ('ds41f-q4', 'ds41f-vision'):
            self.download((target,), script=project / 'download-model.sh', env=env)
        self.assertEqual((project / 'ds4/routed.txt').read_text(), 'ds41f-q4\nds41f-vision\n')
        help_text = subprocess.check_output(['sh', str(project / 'download-model.sh'), '--help'], text=True)
        self.assertIn('DeepSeek V4.1 Flash 1017', help_text)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DownloadTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    (RUN / 'results.json').write_text(json.dumps({'passed': result.wasSuccessful(), 'tests': result.testsRun,
                                                 'scope': 'real curl, loopback HTTP, tiny payloads; no weights',
                                                 'cases': RECEIPTS}, indent=2))
    print(RUN)
    raise SystemExit(not result.wasSuccessful())
