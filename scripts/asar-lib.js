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

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
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
    fs.readSync(fd, buf, 0, size, baseOffset + offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function listAsarFiles(archivePath) {
  const { header } = readAsarHeader(archivePath);
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
    const chunks = [];

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
          chunks.push(buf);
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
          const srcOffset = Number(info.offset) || 0;
          const buf = Buffer.alloc(size);
          if (size > 0) {
            fs.readSync(srcFd, buf, 0, size, baseOffset + srcOffset);
          }
          const fileObj = {
            size,
            offset: String(offset),
            integrity: info.integrity || computeAsarIntegrity(buf)
          };
          if (info.executable) fileObj.executable = true;
          offset += size;
          chunks.push(buf);
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

    fs.mkdirSync(path.dirname(destAsar), { recursive: true });
    const outFd = fs.openSync(destAsar, 'w');
    try {
      fs.writeSync(outFd, headerBuf);
      for (const chunk of chunks) {
        if (chunk.length > 0) fs.writeSync(outFd, chunk);
      }
    } finally {
      fs.closeSync(outFd);
    }

    return {
      fileSha256: sha256File(destAsar),
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
  readAsarHeader,
  getAsarNode,
  extractAsarFile,
  listAsarFiles,
  computeAsarIntegrity,
  repackAsarWithOverlay,
  readInfoPlistAsarHash,
  atomicReplaceFile
};
