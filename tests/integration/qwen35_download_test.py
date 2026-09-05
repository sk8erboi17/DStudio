"""Production downloader + real curl against a tiny local HTTP fixture, no weights."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location('qwen35_download', 'scripts/download-qwen35.py')
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)
PAYLOAD = b'controlled-download-fixture-not-model-weights' * 128
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
REQUESTS = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        REQUESTS.append((self.path, self.headers.get('Range')))
        if self.path != '/model':
            self.send_error(404)
            return
        start = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
        self.send_response(206 if start else 200)
        self.send_header('Content-Length', str(len(PAYLOAD) - start))
        if start:
            self.send_header('Content-Range', f'bytes {start}-{len(PAYLOAD)-1}/{len(PAYLOAD)}')
        self.end_headers()
        self.wfile.write(PAYLOAD[start:])

    def log_message(self, *_args):
        pass


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/model'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dstudio-qwen35-download-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'fixture.gguf'
        self.partial = self.root / 'fixture.gguf.part'
        REQUESTS.clear()

    def download(self, **kwargs):
        return downloader.download(self.root, name='fixture.gguf', size=len(PAYLOAD),
                                   expected=DIGEST, url=kwargs.get('url', self.url))

    def test_fresh_transfer_and_verified_reuse(self):
        self.assertEqual(self.download().read_bytes(), PAYLOAD)
        self.assertFalse(self.partial.exists())
        requests = list(REQUESTS)
        self.assertEqual(self.download().read_bytes(), PAYLOAD)
        self.assertEqual(REQUESTS, requests, 'verified existing file must not be downloaded again')

    def test_resume_uses_range_and_verifies_complete_bytes(self):
        self.partial.write_bytes(PAYLOAD[:137])
        self.assertEqual(self.download().read_bytes(), PAYLOAD)
        self.assertEqual(REQUESTS, [('/model', 'bytes=137-')])
        self.assertFalse(self.partial.exists())

    def test_bad_checksum_is_preserved_but_never_published(self):
        corrupted = b'x' * len(PAYLOAD)
        self.partial.write_bytes(corrupted)
        with self.assertRaisesRegex(RuntimeError, 'Checksum mismatch'):
            self.download()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.partial.read_bytes(), corrupted)
        self.assertEqual(REQUESTS, [])

    def test_existing_user_file_is_never_overwritten(self):
        self.target.write_bytes(b'user file')
        with self.assertRaisesRegex(RuntimeError, 'preserved'):
            self.download()
        self.assertEqual(self.target.read_bytes(), b'user file')
        self.assertEqual(REQUESTS, [])

    def test_symlink_is_not_followed(self):
        other = self.root / 'user-file'
        other.write_bytes(b'do not touch')
        for entry in (self.partial, self.target):
            entry.symlink_to(other)
            with self.assertRaisesRegex(RuntimeError, 'preserved'):
                self.download()
            self.assertEqual(other.read_bytes(), b'do not touch')
            entry.unlink()
        self.assertEqual(REQUESTS, [])

    def test_http_error_never_publishes_a_model(self):
        with self.assertRaisesRegex(RuntimeError, 'Download failed'):
            self.download(url=self.url + '-missing')
        self.assertFalse(self.target.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
