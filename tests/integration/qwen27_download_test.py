"""Real production downloader/curl and filesystem races; tiny HTTP fixtures, no weights."""
import concurrent.futures
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('qwen27_download', 'scripts/download-qwen27.py')
download = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(download)
PAYLOAD = b'controlled-qwen27-transfer-not-model-weights' * 1024
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
REQUESTS = []
ENTERED, RELEASE = threading.Event(), threading.Event()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        REQUESTS.append((self.path, self.headers.get('Range'), self.headers.get('Authorization')))
        if self.path == '/missing':
            self.send_error(404)
            return
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', 'file:///etc/passwd')
            self.end_headers()
            return
        if self.path == '/blocked':
            ENTERED.set()
            if not RELEASE.wait(10):
                self.send_error(503)
                return
        start = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
        if self.path == '/ignore-range':
            start = 0
        payload = PAYLOAD + b'x' if self.path == '/oversized' else PAYLOAD
        self.send_response(206 if start else 200)
        self.send_header('Content-Length', str(len(payload) - start))
        if start:
            self.send_header('Content-Range', f'bytes {start}-{len(payload)-1}/{len(payload)}')
        self.end_headers()
        try:
            self.wfile.write(payload[start:123] if self.path == '/truncated' else payload[start:])
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def log_message(self, *_):
        pass


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        RELEASE.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dstudio-qwen27-download-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'shared models'
        self.root.mkdir()
        self.name = 'fixture.gguf'
        self.target = self.root / self.name
        self.stage = self.root / '.dstudio-qwen27-downloads' / self.name
        self.stage.mkdir(parents=True, mode=0o700)
        self.stage.parent.chmod(0o700)
        self.partial = self.stage / 'data.part'
        REQUESTS.clear()
        ENTERED.clear()
        RELEASE.clear()

    def run_download(self, route='/model', **extra):
        return download.download(self.root, name=self.name, size=len(PAYLOAD),
                                 expected=DIGEST, url=self.url + route, **extra)

    def test_fresh_transfer_and_verified_reuse(self):
        self.assertEqual(self.run_download().read_bytes(), PAYLOAD)
        self.assertFalse(self.partial.exists())
        requests = list(REQUESTS)
        self.assertEqual(self.run_download(), self.target)
        self.assertEqual(REQUESTS, requests)
        download.verify(self.target, len(PAYLOAD), DIGEST)

    def test_resume_uses_exact_range(self):
        self.partial.write_bytes(PAYLOAD[:137])
        self.assertEqual(self.run_download().read_bytes(), PAYLOAD)
        self.assertEqual(REQUESTS[0][1], 'bytes=137-')

    def test_shared_store_alias_returns_same_verified_file(self):
        alias = self.root.with_name('model store link')
        alias.symlink_to(self.root, target_is_directory=True)
        result = download.download(alias, name=self.name, size=len(PAYLOAD),
                                   expected=DIGEST, url=self.url + '/model')
        self.assertEqual(result, self.target)
        self.assertTrue(result.samefile(alias / self.name))
        self.assertEqual(self.run_download(), result)
        self.assertEqual(len(REQUESTS), 1)

    def test_complete_partial_needs_no_network(self):
        self.partial.write_bytes(PAYLOAD)
        self.assertEqual(self.run_download().read_bytes(), PAYLOAD)
        self.assertEqual(REQUESTS, [])

    def test_progress_distinguishes_transfer_and_verification(self):
        phases = []
        self.run_download(progress=phases.append)
        self.assertEqual(phases, ['D', 'V'])
        self.assertEqual(self.target.read_bytes(), PAYLOAD)
        phases.clear()
        self.run_download(progress=phases.append)
        self.assertEqual(phases, ['V'])
        self.assertEqual(len(REQUESTS), 1)

    def test_full_partial_still_reports_verification_and_rejects_bad_hash(self):
        self.partial.write_bytes(b'x' * len(PAYLOAD))
        phases = []
        with self.assertRaisesRegex(RuntimeError, 'Checksum mismatch'):
            self.run_download(progress=phases.append)
        self.assertEqual(phases, ['V'])
        self.assertFalse(self.target.exists())
        self.assertEqual(REQUESTS, [])

    def test_failed_checksum_is_preserved_never_published(self):
        self.partial.write_bytes(b'x' * len(PAYLOAD))
        with self.assertRaisesRegex(RuntimeError, 'Checksum mismatch'):
            self.run_download()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.partial.read_bytes(), b'x' * len(PAYLOAD))
        self.assertEqual(REQUESTS, [])

    def test_existing_user_file_preserved(self):
        self.target.write_bytes(b'user file')
        with self.assertRaisesRegex(RuntimeError, 'preserved'):
            self.run_download()
        self.assertEqual(self.target.read_bytes(), b'user file')
        self.assertEqual(REQUESTS, [])

    def test_linked_target_partial_and_lock_rejected(self):
        other = self.root / 'user file'
        other.write_bytes(b'preserve me')
        for entry in (self.target, self.partial, self.stage / 'lock'):
            with self.subTest(entry=entry.name):
                if entry.exists():
                    entry.unlink()
                entry.symlink_to(other)
                with self.assertRaises(OSError):
                    self.run_download()
                self.assertEqual(other.read_bytes(), b'preserve me')
                entry.unlink()
        self.assertEqual(REQUESTS, [])

    def test_hardlinked_partial_rejected(self):
        original = self.root / 'user-file'
        original.write_bytes(PAYLOAD[:137])
        os.link(original, self.partial)
        with self.assertRaisesRegex(RuntimeError, 'linked partial'):
            self.run_download()
        self.assertEqual(original.read_bytes(), PAYLOAD[:137])
        self.assertEqual(REQUESTS, [])

    def test_nonprivate_and_linked_stage_rejected(self):
        self.stage.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'not private'):
            self.run_download()
        self.stage.rmdir()
        other = self.root / 'outside'
        other.mkdir()
        self.stage.symlink_to(other, target_is_directory=True)
        with self.assertRaises(OSError):
            self.run_download()
        self.assertEqual(list(other.iterdir()), [])

    def test_oversized_partial_is_untouched(self):
        self.partial.write_bytes(PAYLOAD + b'extra')
        with self.assertRaisesRegex(RuntimeError, 'partial'):
            self.run_download()
        self.assertEqual(self.partial.read_bytes(), PAYLOAD + b'extra')
        self.assertEqual(REQUESTS, [])

    def test_http_errors_and_oversize_never_publish(self):
        for route in ('/missing', '/oversized', '/redirect'):
            with self.subTest(route=route):
                with self.assertRaises(RuntimeError):
                    self.run_download(route)
                self.assertFalse(self.target.exists())
                self.assertLessEqual(self.partial.stat().st_size, len(PAYLOAD))

    def test_interrupted_transfer_can_resume(self):
        with self.assertRaisesRegex(RuntimeError, 'Download failed'):
            self.run_download('/truncated')
        self.assertFalse(self.target.exists())
        self.assertEqual(self.partial.read_bytes(), PAYLOAD[:123])
        self.assertEqual(self.run_download().read_bytes(), PAYLOAD)
        self.assertEqual(REQUESTS[-1][1], 'bytes=123-')

    def test_ignored_range_does_not_corrupt_partial(self):
        self.partial.write_bytes(PAYLOAD[:137])
        with self.assertRaisesRegex(RuntimeError, 'Download failed'):
            self.run_download('/ignore-range')
        self.assertEqual(self.partial.read_bytes(), PAYLOAD[:137])
        self.assertFalse(self.target.exists())

    def test_concurrent_download_has_one_nonwaiting_leader(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.run_download, '/blocked')
            try:
                self.assertTrue(ENTERED.wait(5), 'first real HTTP request never arrived')
                with self.assertRaisesRegex(RuntimeError, 'already active'):
                    self.run_download('/model')
                self.assertEqual(len(REQUESTS), 1)
                self.assertFalse(self.target.exists())
            finally:
                RELEASE.set()
            self.assertEqual(first.result(timeout=5).read_bytes(), PAYLOAD)
        self.assertEqual(self.run_download(), self.target)
        self.assertEqual(len(REQUESTS), 1, 'finished lock file must not block verified reuse')

    def test_target_created_during_preparation_is_never_replaced(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.run_download, '/blocked')
            try:
                self.assertTrue(ENTERED.wait(5))
                self.target.write_bytes(b'concurrent user data')
            finally:
                RELEASE.set()
            with self.assertRaises(FileExistsError):
                first.result(timeout=5)
        self.assertEqual(self.target.read_bytes(), b'concurrent user data')
        self.assertEqual(self.partial.read_bytes(), PAYLOAD)

    def test_sigterm_reaps_only_owned_curl_and_allows_resume(self):
        # The production signal handler interrupts a real blocked curl. The
        # probe adds only child-PID reporting, not a replacement downloader.
        probe = '''
import importlib.util, signal, subprocess, sys
spec = importlib.util.spec_from_file_location('q27', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
real_popen = subprocess.Popen
def observe(*args, **kwargs):
    child = real_popen(*args, **kwargs)
    print('CURL_PID=' + str(child.pid), flush=True)
    return child
module.subprocess.Popen = observe
signal.signal(signal.SIGTERM, module.stop_download)
try:
    module.download(sys.argv[2], name='fixture.gguf', size=int(sys.argv[3]),
                    expected=sys.argv[4], url=sys.argv[5])
except KeyboardInterrupt:
    sys.exit(130)
'''
        child = subprocess.Popen(['python3', '-c', probe,
                                  str(Path('scripts/download-qwen27.py').resolve()),
                                  str(self.root), str(len(PAYLOAD)), DIGEST,
                                  self.url + '/blocked'], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertTrue(ENTERED.wait(5))
            child.send_signal(signal.SIGTERM)
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 130, (stdout, stderr))
            curl_pid = int(re.search(r'CURL_PID=(\d+)', stdout).group(1))
            with self.assertRaises(ProcessLookupError):
                os.kill(curl_pid, 0)
            self.assertFalse(self.target.exists())
            self.assertEqual(self.run_download().read_bytes(), PAYLOAD)
        finally:
            RELEASE.set()
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate(timeout=5)

    def test_moved_model_store_cannot_publish_stale_candidate(self):
        previous = self.root.with_name('previous store')
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.run_download, '/blocked')
            try:
                self.assertTrue(ENTERED.wait(5))
                self.root.rename(previous)
                self.root.mkdir()
                (self.root / 'user.txt').write_bytes(b'keep')
            finally:
                RELEASE.set()
            with self.assertRaisesRegex(RuntimeError, 'store changed'):
                first.result(timeout=5)
        self.assertFalse(self.target.exists())
        self.assertFalse((previous / self.name).exists())
        self.assertEqual((self.root / 'user.txt').read_bytes(), b'keep')

    def test_store_replaced_between_host_admission_and_downloader_is_untouched(self):
        info = self.root.stat()
        expected_store = (info.st_dev, info.st_ino)
        old = self.root.with_name('original store')
        self.root.rename(old)
        self.root.mkdir()
        (self.root / 'user.txt').write_bytes(b'keep')
        with self.assertRaisesRegex(RuntimeError, 'changed since download admission'):
            self.run_download(expected_store=expected_store)
        self.assertEqual([entry.name for entry in self.root.iterdir()], ['user.txt'])
        self.assertEqual((self.root / 'user.txt').read_bytes(), b'keep')
        self.assertEqual(REQUESTS, [])

    def test_admitted_store_identity_allows_transfer_and_reuse(self):
        info = self.root.stat()
        expected_store = (info.st_dev, info.st_ino)
        self.assertEqual(self.run_download(expected_store=expected_store).read_bytes(), PAYLOAD)
        download.verify(self.target, len(PAYLOAD), DIGEST, expected_store)
        self.assertEqual(self.run_download(expected_store=expected_store).read_bytes(), PAYLOAD)
        self.assertEqual(len(REQUESTS), 1)

    def test_changed_partial_identity_rejected_after_hashing(self):
        self.partial.write_bytes(PAYLOAD)
        real_verify = download.verify_fd

        def replace_after_check(fd, size, expected):
            result = real_verify(fd, size, expected)
            self.partial.rename(self.stage / 'original.part')
            self.partial.write_bytes(b'other file')
            return result

        with mock.patch.object(download, 'verify_fd', side_effect=replace_after_check):
            with self.assertRaisesRegex(RuntimeError, 'Partial identity changed'):
                self.run_download()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.partial.read_bytes(), b'other file')

    def test_credentials_go_to_stdin_not_argv(self):
        real_popen = subprocess.Popen
        commands = []

        def capture(argv, **kwargs):
            commands.append(argv)
            return real_popen(argv, **kwargs)

        token = 'fixture_credential_not_a_secret'
        with mock.patch.object(download.subprocess, 'Popen', side_effect=capture):
            self.run_download(token=token)
        self.assertEqual(REQUESTS[0][2], 'Bearer ' + token)
        self.assertTrue(all(token not in str(command) for command in commands))

    def test_invalid_identity_or_token_never_starts_transfer(self):
        for name, token in (('../outside', ''), ('fixture.gguf', 'bad\nheader')):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    download.download(self.root, token, name=name, size=len(PAYLOAD),
                                      expected=DIGEST, url=self.url + '/model')
        self.assertEqual(REQUESTS, [])

    def test_manifest_cli_is_read_only_and_exact(self):
        before = list(self.root.iterdir())
        process = subprocess.run(['python3', str(Path('scripts/download-qwen27.py').resolve()),
                                  '--manifest'], cwd=self.root, capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 0, process.stderr)
        manifest = json.loads(process.stdout)
        self.assertEqual(manifest['revision'], '4ca720788d1e01f1bff70c033e0d0028fd02e502')
        self.assertEqual(set(manifest['files']), {'model', 'vision'})
        self.assertEqual(manifest['files']['model']['bytes'], 25299061664)
        self.assertEqual(manifest['files']['vision']['remote'], 'mmproj-F16.gguf')
        self.assertEqual(list(self.root.iterdir()), before)
        self.assertEqual(REQUESTS, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
