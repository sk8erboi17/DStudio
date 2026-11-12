// A small, task-owned HFS+ volume for disk-space tests (macOS hdiutil). The
// test creates, mounts and removes it itself; nothing ever fills the real
// disk. Free space is read with statfs on the mounted volume.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function scratchVolume(run, megabytes, name = 'DStudioScratch') {
  if (process.platform !== 'darwin') return null;
  const image = path.join(run, `${name}.dmg`), mount = path.join(run, name);
  fs.mkdirSync(mount, {recursive: true});
  const made = spawnSync('hdiutil', ['create', '-quiet', '-size', `${megabytes}m`, '-fs', 'HFS+', '-volname', name,
    '-layout', 'NONE', image], {encoding: 'utf8'});
  if (made.status !== 0) throw new Error(`hdiutil create failed: ${made.stderr}`);
  const attached = spawnSync('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mount, image], {encoding: 'utf8'});
  if (attached.status !== 0) throw new Error(`hdiutil attach failed: ${attached.stderr}`);
  const free = () => {const s = fs.statfsSync(mount); return Number(s.bavail) * Number(s.bsize);};
  // Leave about `bytes` free by writing one filler file; returns its path.
  const fill = (bytes, file = path.join(mount, 'filler.bin')) => {
    const size = Math.max(0, free() - bytes);
    const fd = fs.openSync(file, 'w');
    try {
      const block = Buffer.alloc(1 << 20, 0x5a);
      for (let left = size; left > 0;) {const n = Math.min(left, block.length); fs.writeSync(fd, block, 0, n); left -= n;}
      fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    return file;
  };
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    let out = spawnSync('hdiutil', ['detach', '-quiet', mount], {encoding: 'utf8'});
    if (out.status !== 0) out = spawnSync('hdiutil', ['detach', '-quiet', '-force', mount], {encoding: 'utf8'});
    if (out.status === 0) fs.rmSync(image, {force: true});
  };
  return {mount, image, free, fill, detach};
}
