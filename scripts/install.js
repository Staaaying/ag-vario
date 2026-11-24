'use strict';

/**
 * Safe backup + overlay installer for ag-vario into Antigravity v2.34.0 app.asar.
 *
 * MIT Attribution: The unique `loadHubWindowUrl` window-load anchor regex and
 * post-pack ASAR audit approach reference `antigravity-context-viewer`
 * (Copyright (c) 2026 Antigravity Context Viewer Contributors, MIT License).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const asarLib = require('./asar-lib');
const { PRELOAD_BRIDGE_SNIPPET } = require('../src/main/inject-main');

const DEFAULT_TARGET_ASAR = '/Applications/Antigravity.app/Contents/Resources/app.asar';
const DEFAULT_STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ag-vario');
const PROJECT_ROOT = path.resolve(__dirname, '..');

const UTILS_START = '// [AG-VARIO:UTILS:START]';
const UTILS_END = '// [AG-VARIO:UTILS:END]';
const PRELOAD_START = '// [AG-VARIO:PRELOAD:START]';
const PRELOAD_END = '// [AG-VARIO:PRELOAD:END]';

const HUB_LOAD_RE = /^[ \t]+(?:void\s+)?loadHubWindowUrl\(\s*win\s*,\s*url(?:\s*,[^)\r\n]*)?\);[ \t]*\r?$/gm;
const LEGACY_LOAD_MARKER = '    void win.loadURL(url);';

function validateJsSyntax(code, filename) {
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

function isCleanOfficialAsar(asarPath) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    return { clean: false, version: null, reason: 'missing_file' };
  }
  try {
    const pkg = JSON.parse(asarLib.extractAsarFile(asarPath, 'package.json').toString('utf8'));
    const version = typeof pkg?.version === 'string' ? pkg.version : null;
    const utils = asarLib.extractAsarFile(asarPath, 'dist/utils.js').toString('utf8');
    let preload = '';
    try {
      preload = asarLib.extractAsarFile(asarPath, 'dist/preload.js').toString('utf8');
    } catch {}

    const entries = new Set(asarLib.listAsarFiles(asarPath).map((e) => e.path));
    if (entries.has('dist/meter-main.js') || entries.has('dist/ag-vario/manifest.json')) {
      return { clean: false, version, reason: 'contains_injected_entries' };
    }
    const dirtyTokens = [
      UTILS_START,
      PRELOAD_START,
      'installAgVario',
      'installContextMeter',
      'meter-main',
      'AG-CONTEXT-METER',
      'AG-PROXY'
    ];
    for (const tok of dirtyTokens) {
      if (utils.includes(tok) || preload.includes(tok)) {
        return { clean: false, version, reason: `contains_marker:${tok}` };
      }
    }
    return { clean: true, version, reason: 'ok' };
  } catch (err) {
    return { clean: false, version: null, reason: err?.message || 'invalid_asar' };
  }
}

function findWindowLoadAnchor(utilsSource) {
  const matches = [];
  HUB_LOAD_RE.lastIndex = 0;
  let m;
  while ((m = HUB_LOAD_RE.exec(utilsSource)) !== null) {
    matches.push({ index: m.index, text: m[0] });
  }
  if (matches.length === 0) {
    let idx = utilsSource.indexOf(LEGACY_LOAD_MARKER);
    while (idx !== -1) {
      matches.push({ index: idx, text: LEGACY_LOAD_MARKER });
      idx = utilsSource.indexOf(LEGACY_LOAD_MARKER, idx + LEGACY_LOAD_MARKER.length);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly 1 window load anchor in dist/utils.js, found ${matches.length}`);
  }
  return matches[0];
}

function patchUtilsSource(cleanUtils) {
  const anchor = findWindowLoadAnchor(cleanUtils);
  const snippet = [
    UTILS_START,
    '    try { require("./ag-vario/main/inject-main").installAgVario(win); } catch (_agvErr) {}',
    UTILS_END,
    ''
  ].join('\n');
  const patched = cleanUtils.slice(0, anchor.index) + snippet + cleanUtils.slice(anchor.index);
  if (!validateJsSyntax(patched, 'dist/utils.js')) {
    throw new Error('Patched dist/utils.js failed JS syntax validation');
  }
  return patched;
}

function patchPreloadSource(cleanPreload) {
  const snippet = `\n${PRELOAD_START}\n${PRELOAD_BRIDGE_SNIPPET}\n${PRELOAD_END}\n`;
  const patched = `${cleanPreload}${snippet}`;
  if (!validateJsSyntax(patched, 'dist/preload.js')) {
    throw new Error('Patched dist/preload.js failed JS syntax validation');
  }
  return patched;
}

function collectAgVarioPayload(projectRoot = PROJECT_ROOT, { hostVersion = null } = {}) {
  const additions = new Map();
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

  for (const area of ['core', 'main', 'renderer']) {
    const dir = path.join(projectRoot, 'src', area);
    if (!fs.existsSync(dir)) throw new Error(`Missing source directory: ${dir}`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    for (const file of files) {
      const buf = fs.readFileSync(path.join(dir, file));
      additions.set(`dist/ag-vario/${area}/${file}`, buf);
    }
  }

  const manifestBuf = Buffer.from(
    JSON.stringify(
      {
        name: 'ag-vario',
        version: pkg.version || '0.1.0',
        hostVersion,
        installedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );
  additions.set('dist/ag-vario/manifest.json', manifestBuf);
  return { additions, version: pkg.version || '0.1.0' };
}

function resolveCleanSourceAsar({
  targetAsar,
  targetVersion,
  stateDir,
  cleanSourcePath = null,
  upstreamBackupDir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'AntigravityContextMeter',
    'backups'
  )
}) {
  const plistHash = asarLib.readInfoPlistAsarHash(targetAsar);
  const verifyCandidate = (candidatePath, expectedFileSha = null, requirePlistMatch = false) => {
    if (!candidatePath || !fs.existsSync(candidatePath)) return false;
    if (expectedFileSha && asarLib.sha256File(candidatePath) !== expectedFileSha) return false;
    const check = isCleanOfficialAsar(candidatePath);
    if (!check.clean || (targetVersion && check.version !== targetVersion)) return false;
    if (requirePlistMatch && plistHash) {
      const { headerSha256 } = asarLib.readAsarHeader(candidatePath);
      if (headerSha256 !== plistHash) return false;
    }
    return true;
  };

  if (cleanSourcePath) {
    const resolved = path.resolve(cleanSourcePath);
    if (!verifyCandidate(resolved, null, false)) {
      throw new Error(`Specified clean source ASAR is invalid or dirty: ${resolved}`);
    }
    return resolved;
  }

  const manifestPath = path.join(stateDir, 'installation.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (verifyCandidate(prev?.backupPath, prev?.originalSha256, false)) {
        return prev.backupPath;
      }
    } catch {}
  }

  if (verifyCandidate(targetAsar, null, true)) {
    return targetAsar;
  }

  // Fallback: locate verified official clean backup stored by upstream installer
  if (targetVersion && upstreamBackupDir && fs.existsSync(upstreamBackupDir)) {
    const candidates = fs
      .readdirSync(upstreamBackupDir)
      .filter((f) => f.startsWith(`app-${targetVersion}-`) && f.endsWith('-base.asar'))
      .sort();
    for (const f of candidates) {
      const full = path.join(upstreamBackupDir, f);
      if (verifyCandidate(full, null, true)) {
        return full;
      }
    }
  }

  throw new Error(
    'No clean official Antigravity app.asar source found. Pass --clean-source <path> pointing to an unmodified official archive.'
  );
}

function verifyPackedAgainstSource(sourceAsar, packedAsar, additions) {
  const srcFiles = asarLib.listAsarFiles(sourceAsar);
  const dstList = asarLib.listAsarFiles(packedAsar);
  const dstMap = new Map(dstList.map((e) => [e.path, e]));
  const replaced = new Set(['dist/utils.js', 'dist/preload.js']);

  if (dstMap.has('dist/meter-main.js')) {
    throw new Error('Unexpected leftover dist/meter-main.js in packed ASAR');
  }

  for (const s of srcFiles) {
    const d = dstMap.get(s.path);
    if (!d) throw new Error(`Missing original file in packed ASAR: ${s.path}`);
    if (s.unpacked !== d.unpacked) throw new Error(`Unpacked flag changed: ${s.path}`);
    if (s.executable !== d.executable) throw new Error(`Executable flag changed: ${s.path}`);
    if (s.link !== d.link) throw new Error(`Symlink target changed: ${s.path}`);
    if (!s.unpacked && !s.link && !replaced.has(s.path)) {
      const sHash = asarLib.sha256Buffer(asarLib.extractAsarFile(sourceAsar, s.path));
      const dHash = asarLib.sha256Buffer(asarLib.extractAsarFile(packedAsar, d.path));
      if (sHash !== dHash) throw new Error(`Unexpected content modification in ${s.path}`);
    }
  }

  for (const [rel, buf] of additions.entries()) {
    const d = dstMap.get(rel);
    if (!d) throw new Error(`Missing added file in packed ASAR: ${rel}`);
    const dHash = asarLib.sha256Buffer(asarLib.extractAsarFile(packedAsar, rel));
    if (dHash !== asarLib.sha256Buffer(buf)) {
      throw new Error(`Checksum mismatch on added file ${rel}`);
    }
  }

  return srcFiles.length;
}

function install(options = {}) {
  const targetAsar = path.resolve(options.targetAsar || DEFAULT_TARGET_ASAR);
  const stateDir = path.resolve(options.stateDir || DEFAULT_STATE_DIR);
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);

  if (!fs.existsSync(targetAsar)) {
    throw new Error(`Target app.asar not found: ${targetAsar}`);
  }

  const targetPkg = JSON.parse(asarLib.extractAsarFile(targetAsar, 'package.json').toString('utf8'));
  const hostVersion = typeof targetPkg?.version === 'string' ? targetPkg.version : 'unknown';

  const sourceAsar = resolveCleanSourceAsar({
    targetAsar,
    targetVersion: hostVersion,
    stateDir,
    cleanSourcePath: options.cleanSourcePath || null,
    ...(options.upstreamBackupDir !== undefined ? { upstreamBackupDir: options.upstreamBackupDir } : {})
  });

  // Ensure independent verified backup under ag-vario's own stateDir
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `app-${hostVersion}-original.asar`);
  const sourceSha256 = asarLib.sha256File(sourceAsar);
  const { headerSha256: originalHeaderSha256 } = asarLib.readAsarHeader(sourceAsar);

  if (!fs.existsSync(backupPath) || asarLib.sha256File(backupPath) !== sourceSha256) {
    asarLib.atomicReplaceFile(sourceAsar, backupPath, sourceSha256);
  }

  const cleanUtils = asarLib.extractAsarFile(backupPath, 'dist/utils.js').toString('utf8');
  let cleanPreload = '';
  try {
    cleanPreload = asarLib.extractAsarFile(backupPath, 'dist/preload.js').toString('utf8');
  } catch {
    cleanPreload = '';
  }

  const patchedUtils = patchUtilsSource(cleanUtils);
  const patchedPreload = patchPreloadSource(cleanPreload);
  const replacements = new Map([
    ['dist/utils.js', Buffer.from(patchedUtils, 'utf8')],
    ['dist/preload.js', Buffer.from(patchedPreload, 'utf8')]
  ]);

  const { additions, version } = collectAgVarioPayload(projectRoot, { hostVersion });
  const stagingAsar = path.join(stateDir, `staging-${process.pid}-${Date.now()}.asar`);

  try {
    const packRes = asarLib.repackAsarWithOverlay(backupPath, stagingAsar, { replacements, additions });
    const originalFilesVerified = verifyPackedAgainstSource(backupPath, stagingAsar, additions);
    const finalSha256 = asarLib.atomicReplaceFile(stagingAsar, targetAsar, packRes.fileSha256);

    const manifest = {
      name: 'ag-vario',
      version,
      hostVersion,
      targetAsar,
      backupPath,
      originalSha256: sourceSha256,
      originalHeaderSha256,
      patchedSha256: finalSha256,
      patchedHeaderSha256: packRes.headerSha256,
      originalFilesVerified,
      modifiedFiles: ['dist/utils.js', 'dist/preload.js'],
      addedFiles: Array.from(additions.keys()),
      installedAt: new Date().toISOString()
    };

    const manifestPath = path.join(stateDir, 'installation.json');
    const manifestTmp = path.join(stateDir, `installation.tmp-${process.pid}.json`);
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(manifestTmp, manifestPath);

    return { ok: true, ...manifest };
  } finally {
    try {
      if (fs.existsSync(stagingAsar)) fs.unlinkSync(stagingAsar);
    } catch {}
  }
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) opts.targetAsar = argv[++i];
    else if (argv[i] === '--state-dir' && argv[i + 1]) opts.stateDir = argv[++i];
    else if (argv[i] === '--clean-source' && argv[i + 1]) opts.cleanSourcePath = argv[++i];
  }
  return opts;
}

if (require.main === module) {
  try {
    const res = install(parseCliArgs(process.argv.slice(2)));
    console.log(
      JSON.stringify(
        {
          ok: res.ok,
          hostVersion: res.hostVersion,
          targetAsar: res.targetAsar,
          backupPath: res.backupPath,
          originalSha256: res.originalSha256,
          patchedSha256: res.patchedSha256,
          originalFilesVerified: res.originalFilesVerified,
          addedFilesCount: res.addedFiles.length
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(`[ag-vario install] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_TARGET_ASAR,
  DEFAULT_STATE_DIR,
  UTILS_START,
  UTILS_END,
  PRELOAD_START,
  PRELOAD_END,
  isCleanOfficialAsar,
  findWindowLoadAnchor,
  patchUtilsSource,
  patchPreloadSource,
  collectAgVarioPayload,
  resolveCleanSourceAsar,
  install
};
