// Established Makefile entry point: real curl, loopback HTTP, tiny payloads.
import {spawnSync} from 'node:child_process';
const result = spawnSync('python3', ['tests/integration/ds41_http_download_test.py'], {
  stdio: 'inherit', timeout: 120000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
