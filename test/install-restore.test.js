'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const asarLib = require('../scripts/asar-lib');
const { install } = require('../scripts/install');
const { restore } = require('../scripts/restore');

function buildSyntheticAsar(destPath, filesMap, { unpackedMap = new Map(), execSet = new Set() } = {}) {
  let offset = 0;
  const chunks = [];
  const root = { files: {} };

  const putNode = (rel, node) => {
    const parts = rel.split('/');
    let dir = root.files;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!dir[parts[i]]) dir[parts[i]] = { files: {} };
      dir = dir[parts[i]].files;
    }
    dir[parts[parts.length - 1]] = node;
  };

  for (const [rel, buf] of filesMap.entries()) {
    const node = {
      size: buf.length,
      offset: String(offset),
      integrity: asarLib.computeAsarIntegrity(buf)
    };
    if (execSet.has(rel)) node.executable = true;
    offset += buf.length;
    chunks.push(buf);
    putNode(rel, node);
  }

  for (const [rel, buf] of unpackedMap.entries()) {
    const node = {
      size: buf.length,
      unpacked: true,
      integrity: asarLib.computeAsarIntegrity(buf)
    };
    putNode(rel, node);
    const uPath = path.join(`${destPath}.unpacked`, rel);
    fs.mkdirSync(path.dirname(uPath), { recursive: true });
    fs.writeFileSync(uPath, buf);
  }

  const jsonBuf = Buffer.from(JSON.stringify(root), 'utf8');
  const padding = (4 - (jsonBuf.length % 4)) % 4;
  const aligned = jsonBuf.length + padding;
  const header = Buffer.alloc(16 + aligned);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + aligned, 4);
  header.writeUInt32LE(4 + aligned, 8);
  header.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(header, 16);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const fd = fs.openSync(destPath, 'w');
  fs.writeFileSync(fd, header);
  for (const c of chunks) fs.writeSync(fd, c);
  fs.closeSync(fd);
}

function makeOfficialFiles() {
  const utilsJs = [
    '"use strict";',
    'function createWindow(url, storageManager, options) {',
    '    const skipBootstrapMint = Boolean(options?.partition);',
    '    void loadHubWindowUrl(win, url, { skipBootstrapMint });',
    '    return win;',
    '}'
  ].join('\n');
  const preloadJs = [
    '"use strict";',
    'const electron_1 = require("electron");',
    'console.log("preload ready");'
  ].join('\n');
  return new Map([
    ['package.json', Buffer.from(JSON.stringify({ name: 'antigravity', version: '2.34.0', main: 'dist/main.js' }), 'utf8')],
    ['dist/utils.js', Buffer.from(utilsJs, 'utf8')],
    ['dist/preload.js', Buffer.from(preloadJs, 'utf8')],
    ['dist/main.js', Buffer.from('console.log("host main");', 'utf8')],
    ['bin/helper', Buffer.from('#!/bin/sh\necho ok\n', 'utf8')]
  ]);
}

test('install & restore: clean backup, unpacked/executable preservation, dirty cleanup, and lossless restore', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vario-asar-'));
  try {
    const targetAsar = path.join(tmpRoot, 'app.asar');
    const cleanSource = path.join(tmpRoot, 'official-2.34.0.asar');
    const stateDir = path.join(tmpRoot, 'state');

    const officialFiles = makeOfficialFiles();
    const unpackedFiles = new Map([['node_modules/mcp/native.node', Buffer.from('binary-payload')]]);
    const execSet = new Set(['bin/helper']);

    buildSyntheticAsar(cleanSource, officialFiles, { unpackedMap: unpackedFiles, execSet });
    const origSha = asarLib.sha256File(cleanSource);
    const origHeaderSha = asarLib.readAsarHeader(cleanSource).headerSha256;

    // Simulate dirty target containing upstream meter-main.js
    const dirtyFiles = new Map(officialFiles);
    dirtyFiles.set('dist/meter-main.js', Buffer.from('// upstream', 'utf8'));
    dirtyFiles.set(
      'dist/utils.js',
      Buffer.from('require("./meter-main").installContextMeter(win);\n    void loadHubWindowUrl(win, url, { skipBootstrapMint });', 'utf8')
    );
    buildSyntheticAsar(targetAsar, dirtyFiles, { unpackedMap: unpackedFiles, execSet });

    // Fail-closed if no clean source given and target is dirty
    assert.throws(
      () => install({ targetAsar, stateDir: path.join(tmpRoot, 'fail-state'), upstreamBackupDir: null }),
      /No clean official Antigravity app\.asar source found/
    );

    // Install using verified cleanSource -> strips upstream traces and preserves flags
    const res1 = install({ targetAsar, stateDir, cleanSourcePath: cleanSource });
    assert.equal(res1.ok, true);
    assert.equal(res1.originalSha256, origSha);

    const installedEntries = new Map(asarLib.listAsarFiles(targetAsar).map((e) => [e.path, e]));
    assert.equal(installedEntries.has('dist/meter-main.js'), false);
    assert.equal(installedEntries.has('dist/ag-vario/main/inject-main.js'), true);
    assert.equal(installedEntries.has('dist/ag-vario/core/pb.js'), true);
    assert.equal(installedEntries.has('dist/ag-vario/renderer/mount.js'), true);
    assert.equal(installedEntries.get('node_modules/mcp/native.node').unpacked, true);
    assert.equal(installedEntries.get('bin/helper').executable, true);

    const patchedUtils = asarLib.extractAsarFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(patchedUtils.includes('./ag-vario/main/inject-main'));
    assert.ok(patchedUtils.includes('void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
    const patchedPreload = asarLib.extractAsarFile(targetAsar, 'dist/preload.js').toString('utf8');
    assert.ok(patchedPreload.includes('agVarioAPI'));

    // Re-install idempotency using own backup
    const res2 = install({ targetAsar, stateDir });
    assert.equal(res2.ok, true);
    assert.equal(res2.originalSha256, origSha);

    // Dry-run restore does not alter target
    const dryRes = restore({ targetAsar, stateDir, dryRun: true });
    assert.equal(dryRes.dryRun, true);
    assert.equal(asarLib.sha256File(targetAsar), res2.patchedSha256);

    // Real restore brings back exact original file & header SHA-256
    const rest1 = restore({ targetAsar, stateDir });
    assert.equal(rest1.ok, true);
    assert.equal(rest1.alreadyRestored, false);
    assert.equal(rest1.sha256, origSha);
    assert.equal(rest1.headerSha256, origHeaderSha);

    // Idempotent second restore
    const rest2 = restore({ targetAsar, stateDir });
    assert.equal(rest2.alreadyRestored, true);

    // Corrupted backup refuses restore
    fs.writeFileSync(res1.backupPath, Buffer.from('corrupted', 'utf8'));
    assert.throws(() => restore({ targetAsar, stateDir }), /Backup checksum mismatch/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
