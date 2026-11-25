'use strict';

/**
 * Minimal pure-Node ASAR archive reader, overlay repacker, and integrity helper.
 *
 * MIT Attribution: Pickle 16-byte ASAR header layout and per-file 4MB SHA-256
 * block integrity calculation reference `antigravity-context-viewer`
 * (Copyright (c) 2026 Antigravity Context Viewer Contributors, MIT License).
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;
const IO_CHUNK_SIZE = 1024 * 1024;

function writeAllSync(fd, buf, offset = 0, length = buf.length) {
  let written = 0;
  while (written < length) {
    const n = fs.writeSync(fd, buf, offset + written, length - written);
    if (n <= 0) throw new Error('Short write to ASAR archive');
    written += n;
  }
}

function readExactSync(fd, buf, offset, length, position) {
  let readTotal = 0;
  while (readTotal < length) {
    const n = fs.readSync(fd, buf, offset + readTotal, length - readTotal, position + readTotal);
    if (n <= 0) throw new Error('Unexpected EOF reading ASAR archive');
    readTotal += n;
  }
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(IO_CHUNK_SIZE);
  let pos = 0;
  try {
    while (true) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n));
      pos += n;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function sha256FdSlice(fd, startOffset, size, chunkBuf = null) {
  const total = Number(size) || 0;
  const hash = crypto.createHash('sha256');
  if (total === 0) return hash.digest('hex');
  const buf = chunkBuf || Buffer.allocUnsafe(Math.min(IO_CHUNK_SIZE, total));
  let remaining = total;
  let pos = Number(startOffset) || 0;
  while (remaining > 0) {
    const toRead = Math.min(buf.length, remaining);
    readExactSync(fd, buf, 0, toRead, pos);
    hash.update(buf.subarray(0, toRead));
    pos += toRead;
    remaining -= toRead;
  }
  return hash.digest('hex');
}

function computeAsarIntegrityFromFd(fd, startOffset, size, chunkBuf = null) {
  const total = Number(size) || 0;
  if (total === 0) {
    const emptyHex = sha256Buffer(Buffer.alloc(0));
    return {
      algorithm: 'SHA256',
      hash: emptyHex,
      blockSize: INTEGRITY_BLOCK_SIZE,
      blocks: [emptyHex]
    };
  }
  const fileHash = crypto.createHash('sha256');
  const blocks = [];
  const buf = chunkBuf || Buffer.allocUnsafe(Math.min(IO_CHUNK_SIZE, total));
  let remaining = total;
  let pos = Number(startOffset) || 0;
  let blockHash = crypto.createHash('sha256');
  let blockFilled = 0;
  while (remaining > 0) {
    const toRead = Math.min(buf.length, remaining, INTEGRITY_BLOCK_SIZE - blockFilled);
    readExactSync(fd, buf, 0, toRead, pos);
    const slice = buf.subarray(0, toRead);
    fileHash.update(slice);
    blockHash.update(slice);
    pos += toRead;
    remaining -= toRead;
    blockFilled += toRead;
    if (blockFilled === INTEGRITY_BLOCK_SIZE) {
      blocks.push(blockHash.digest('hex'));
      blockHash = crypto.createHash('sha256');
      blockFilled = 0;
    }
  }
  if (blockFilled > 0) {
    blocks.push(blockHash.digest('hex'));
  }
  return {
    algorithm: 'SHA256',
    hash: fileHash.digest('hex'),
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks
  };
}

function readAsarHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const pre = Buffer.alloc(16);
    if (fs.readSync(fd, pre, 0, 16, 0) !== 16) {
      throw new Error(`Invalid ASAR header: ${archivePath}`);
    }
    const jsonSize = pre.readUInt32LE(12);
    const padding = (4 - (jsonSize % 4)) % 4;
    const jsonBuf = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, jsonBuf, 0, jsonSize, 16) !== jsonSize) {
      throw new Error(`Truncated ASAR JSON header: ${archivePath}`);
    }
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return {
      header,
      headerJsonBuf: jsonBuf,
      headerSha256: sha256Buffer(jsonBuf),
      baseOffset: 16 + jsonSize + padding
    };
  } finally {
    fs.closeSync(fd);
  }
}

function getAsarNode(header, relPath) {
  const parts = String(relPath || '')
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      return null;
    }
    cur = cur.files[part];
  }
  return cur;
}

function extractAsarFile(archivePath, relPath) {
  const { header, baseOffset } = readAsarHeader(archivePath);
  const node = getAsarNode(header, relPath);
  if (!node || node.files) {
    throw new Error(`File not found in ASAR: ${relPath}`);
  }
  if (node.unpacked) {
    const unpackedPath = path.join(`${archivePath}.unpacked`, relPath);
    return fs.readFileSync(unpackedPath);
  }
  const size = Number(node.size) || 0;
  const offset = Number(node.offset) || 0;
  const buf = Buffer.alloc(size);
  if (size === 0) return buf;
  const fd = fs.openSync(archivePath, 'r');
  try {
    readExactSync(fd, buf, 0, size, baseOffset + offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function collectAsarEntries(header) {
  const entries = [];
  function walk(tree, prefix) {
    for (const [name, info] of Object.entries(tree.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (info.files) {
        walk(info, rel);
      } else {
        entries.push({
          path: rel,
          size: Number(info.size) || 0,
          offset: Number(info.offset) || 0,
          unpacked: Boolean(info.unpacked),
          executable: Boolean(info.executable),
          link: info.link || null,
          integrity: info.integrity || null
        });
      }
    }
  }
  walk(header, '');
  return entries;
}

function listAsarFiles(archivePath) {
  const { header } = readAsarHeader(archivePath);
  return collectAsarEntries(header);
}

function computeAsarIntegrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += INTEGRITY_BLOCK_SIZE) {
    blocks.push(sha256Buffer(buf.subarray(i, i + INTEGRITY_BLOCK_SIZE)));
  }
  if (blocks.length === 0) {
    blocks.push(sha256Buffer(Buffer.alloc(0)));
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Buffer(buf),
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks
  };
}

function insertAdditionNode(rootFiles, relPosix, buf) {
  const parts = relPosix.split('/').filter(Boolean);
  let dir = rootFiles;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (!dir[seg]) dir[seg] = { files: {} };
    if (!dir[seg].files) throw new Error(`Path conflict in ASAR at ${parts.slice(0, i + 1).join('/')}`);
    dir = dir[seg].files;
  }
  const leaf = parts[parts.length - 1];
  dir[leaf] = { __overlayBuffer: buf };
}

/**
 * Rebuild an ASAR archive from `sourceAsar` into `destAsar`, applying `replacements`
 * and `additions` (Map<posixRelPath, Buffer>) while preserving every untouched
 * packed file, unpacked entry, symlink, and executable flag verbatim.
 */
function repackAsarWithOverlay(sourceAsar, destAsar, { replacements = new Map(), additions = new Map() } = {}) {
  const { header, baseOffset } = readAsarHeader(sourceAsar);
  const srcFd = fs.openSync(sourceAsar, 'r');

  try {
    // Deep clone header tree structure and overlay replacements/additions
    function cloneTree(tree, prefix) {
      const files = {};
      for (const [name, info] of Object.entries(tree.files || {})) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (info.files) {
          const dirNode = { files: cloneTree(info, rel) };
          if (info.unpacked) dirNode.unpacked = true;
          files[name] = dirNode;
        } else if (replacements.has(rel)) {
          const buf = replacements.get(rel);
          const cloned = { __overlayBuffer: buf };
          if (info.executable) cloned.executable = true;
          files[name] = cloned;
        } else {
          files[name] = { ...info, __srcRel: rel };
        }
      }
      return files;
    }

    const nextTree = { files: cloneTree(header, '') };
    for (const [rel, buf] of additions.entries()) {
      const normRel = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
      insertAdditionNode(nextTree.files, normRel, buf);
    }

    let offset = 0;
    const writePlan = [];
    const chunkBuf = Buffer.allocUnsafe(IO_CHUNK_SIZE);

    function finalizeTree(node) {
      const outFiles = {};
      for (const [name, info] of Object.entries(node.files || {})) {
        if (info.files) {
          const dirObj = { files: finalizeTree(info) };
          if (info.unpacked) dirObj.unpacked = true;
          outFiles[name] = dirObj;
        } else if (info.__overlayBuffer) {
          const buf = info.__overlayBuffer;
          const fileObj = {
            size: buf.length,
            offset: String(offset),
            integrity: computeAsarIntegrity(buf)
          };
          if (info.executable) fileObj.executable = true;
          offset += buf.length;
          if (buf.length > 0) writePlan.push({ type: 'buffer', buf });
          outFiles[name] = fileObj;
        } else if (info.link) {
          outFiles[name] = { link: info.link };
        } else if (info.unpacked) {
          const obj = { size: info.size, unpacked: true };
          if (info.executable) obj.executable = true;
          if (info.integrity) obj.integrity = info.integrity;
          outFiles[name] = obj;
        } else {
          const size = Number(info.size) || 0;
          const absSrcOffset = baseOffset + (Number(info.offset) || 0);
          const fileObj = {
            size,
            offset: String(offset),
            integrity: info.integrity || computeAsarIntegrityFromFd(srcFd, absSrcOffset, size, chunkBuf)
          };
          if (info.executable) fileObj.executable = true;
          offset += size;
          if (size > 0) writePlan.push({ type: 'src', srcOffset: absSrcOffset, size });
          outFiles[name] = fileObj;
        }
      }
      return outFiles;
    }

    const finalHeader = { files: finalizeTree(nextTree) };
    const jsonBuf = Buffer.from(JSON.stringify(finalHeader), 'utf8');
    const jsonSize = jsonBuf.length;
    const padding = (4 - (jsonSize % 4)) % 4;
    const alignedSize = jsonSize + padding;
    const headerBuf = Buffer.alloc(16 + alignedSize);
    headerBuf.writeUInt32LE(4, 0);
    headerBuf.writeUInt32LE(8 + alignedSize, 4);
    headerBuf.writeUInt32LE(4 + alignedSize, 8);
    headerBuf.writeUInt32LE(jsonSize, 12);
    jsonBuf.copy(headerBuf, 16);

    const fileHash = crypto.createHash('sha256');
    fs.mkdirSync(path.dirname(destAsar), { recursive: true });
    const outFd = fs.openSync(destAsar, 'w');
    try {
      writeAllSync(outFd, headerBuf);
      fileHash.update(headerBuf);
      for (const item of writePlan) {
        if (item.type === 'buffer') {
          writeAllSync(outFd, item.buf);
          fileHash.update(item.buf);
        } else {
          let remaining = item.size;
          let pos = item.srcOffset;
          while (remaining > 0) {
            const toCopy = Math.min(chunkBuf.length, remaining);
            readExactSync(srcFd, chunkBuf, 0, toCopy, pos);
            const slice = chunkBuf.subarray(0, toCopy);
            writeAllSync(outFd, slice);
            fileHash.update(slice);
            pos += toCopy;
            remaining -= toCopy;
          }
        }
      }
    } finally {
      fs.closeSync(outFd);
    }

    return {
      fileSha256: fileHash.digest('hex'),
      headerSha256: sha256Buffer(jsonBuf)
    };
  } finally {
    fs.closeSync(srcFd);
  }
}

function readInfoPlistAsarHash(targetAsar) {
  try {
    const plistPath = path.resolve(path.dirname(targetAsar), '..', 'Info.plist');
    if (!fs.existsSync(plistPath)) return null;
    const jsonStr = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(jsonStr);
    const entry = parsed?.ElectronAsarIntegrity?.['Resources/app.asar'];
    return typeof entry?.hash === 'string' && entry.hash.length === 64 ? entry.hash : null;
  } catch {
    return null;
  }
}

function atomicReplaceFile(srcPath, targetPath, expectedSha256) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `${path.basename(targetPath)}.agv-tmp-${process.pid}-${Date.now()}`);
  try {
    fs.copyFileSync(srcPath, tmpPath);
    const actualSha = sha256File(tmpPath);
    if (expectedSha256 && actualSha !== expectedSha256) {
      throw new Error(`Staging checksum mismatch (${actualSha} !== ${expectedSha256})`);
    }
    fs.renameSync(tmpPath, targetPath);
    return actualSha;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

module.exports = {
  sha256Buffer,
  sha256File,
  sha256FdSlice,
  readAsarHeader,
  getAsarNode,
  extractAsarFile,
  collectAsarEntries,
  listAsarFiles,
  computeAsarIntegrity,
  repackAsarWithOverlay,
  readInfoPlistAsarHash,
  atomicReplaceFile
};
