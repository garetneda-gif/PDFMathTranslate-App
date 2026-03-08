const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// Extract a file from asar to a temp location so external processes (Python) can read it.
// Inside asar, Node.js can read files via Electron's virtual fs, but child processes cannot.
function extractFromAsar(asarPath) {
  if (!asarPath.includes('.asar')) return asarPath; // not in asar, return as-is
  const tmpPath = path.join(os.tmpdir(), 'pmt-' + path.basename(asarPath));
  try {
    const content = fs.readFileSync(asarPath);
    fs.writeFileSync(tmpPath, content);
    return tmpPath;
  } catch {
    return asarPath; // fallback
  }
}

// Find pdf2zh binary - macOS GUI apps don't inherit shell PATH
function findPdf2zh() {
  const home = process.env.HOME || os.homedir();

  // 0. Check absolute paths first — bypass all PATH logic
  const absoluteCandidates = [
    path.join(home, '.pdf2zh-venv/bin/pdf2zh'),
  ];
  for (const candidate of absoluteCandidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  // 1. Try getting PATH from login shell
  try {
    const shellPath = execSync('/bin/zsh -ilc "echo \\$PATH"', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (shellPath) {
      process.env.PATH = shellPath;
    }
  } catch {}

  // 2. Ensure common Python bin dirs are in PATH (prefer newer Python for pdf2zh-next)
  const extraDirs = [
    path.join(home, '.pdf2zh-venv/bin'), // pdf2zh-next venv (highest priority)
    path.join(home, 'Library/Python/3.12/bin'),
    path.join(home, 'Library/Python/3.13/bin'),
    path.join(home, 'Library/Python/3.14/bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.local/bin'),
  ];
  for (let v = 11; v >= 9; v--) {
    extraDirs.push(path.join(home, `Library/Python/3.${v}/bin`));
  }
  const currentPath = process.env.PATH || '';
  const missing = extraDirs.filter(
    (d) => !currentPath.includes(d) && fs.existsSync(d)
  );
  if (missing.length) {
    process.env.PATH = missing.join(':') + ':' + currentPath;
  }

  // 3. Find the actual pdf2zh binary
  const dirs = process.env.PATH.split(':');
  for (const dir of dirs) {
    const candidate = path.join(dir, 'pdf2zh');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return 'pdf2zh'; // fallback to bare name
}

let pdf2zhBin = findPdf2zh();

function getVenvPaths(home = os.homedir()) {
  const venvPath = path.join(home, '.pdf2zh-venv');
  return {
    venvPath,
    pythonBin: path.join(venvPath, 'bin/python'),
    pipBin: path.join(venvPath, 'bin/pip'),
    pdf2zhBin: path.join(venvPath, 'bin/pdf2zh'),
  };
}

function summarizeVenvHealth(health) {
  if (!health?.exists) return '未检测到 ~/.pdf2zh-venv';
  switch (health.reason) {
    case 'missing-python':
      return '虚拟环境缺少 python 可执行文件';
    case 'missing-executables':
      return `虚拟环境缺少可执行文件：${(health.missingExecutables || []).join(', ')}`;
    case 'probe-failed':
      return `虚拟环境探测失败：${health.error || '无法启动 venv Python'}`;
    case 'invalid-probe-output':
      return '虚拟环境探测返回了不可解析的结果';
    case 'python-version':
      return `虚拟环境 Python 版本不受支持：${health.version || 'unknown'}`;
    case 'not-venv':
      return '当前 python 未正确激活到 ~/.pdf2zh-venv';
    case 'prefix-mismatch':
      return `虚拟环境前缀异常：${health.prefix || 'unknown'}`;
    case 'missing-packages':
      return `虚拟环境缺少依赖：${(health.missingPackages || []).join(', ')}`;
    default:
      return health.error || '虚拟环境状态异常';
  }
}

async function inspectPdf2zhVenv() {
  const { venvPath, pythonBin, pipBin: venvPip, pdf2zhBin: venvPdf2zh } = getVenvPaths();
  if (!fs.existsSync(venvPath)) {
    return { exists: false, healthy: false, reason: 'missing' };
  }
  if (!fs.existsSync(pythonBin)) {
    return {
      exists: true,
      healthy: false,
      reason: 'missing-python',
      summary: '虚拟环境缺少 python 可执行文件',
    };
  }

  const missingExecutables = [venvPip, venvPdf2zh].filter((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  if (missingExecutables.length > 0) {
    const health = {
      exists: true,
      healthy: false,
      reason: 'missing-executables',
      missingExecutables,
    };
    health.summary = summarizeVenvHealth(health);
    return health;
  }

  const expectedPrefix = (() => {
    try {
      return fs.realpathSync.native(venvPath);
    } catch {
      return path.resolve(venvPath);
    }
  })();

  const probeScript = [
    'import importlib.util, json, pathlib, sys',
    'expected = pathlib.Path(sys.argv[1]).resolve()',
    'prefix = pathlib.Path(sys.prefix).resolve()',
    'base_prefix = pathlib.Path(sys.base_prefix).resolve()',
    'checks = {',
    '  "pdf2zh_next": importlib.util.find_spec("pdf2zh_next") is not None,',
    '  "pypdf": importlib.util.find_spec("pypdf") is not None,',
    '}',
    'version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"',
    'minor = sys.version_info.minor',
    'report = {',
    '  "type": "venv-health",',
    '  "version": version,',
    '  "is_supported": sys.version_info.major == 3 and 10 <= minor <= 12,',
    '  "is_venv": sys.prefix != sys.base_prefix,',
    '  "prefix": str(prefix),',
    '  "base_prefix": str(base_prefix),',
    '  "expected_prefix": str(expected),',
    '  "prefix_matches": prefix == expected,',
    '  "checks": checks,',
    '}',
    'print(json.dumps(report, ensure_ascii=False))',
  ].join('\n');

  return new Promise((resolve) => {
    const proc = spawn(pythonBin, ['-c', probeScript, expectedPrefix], {
      env: process.env,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        const health = {
          exists: true,
          healthy: false,
          reason: 'probe-failed',
          error: stderr.trim() || `退出码 ${code}`,
        };
        health.summary = summarizeVenvHealth(health);
        resolve(health);
        return;
      }

      try {
        const report = JSON.parse(stdout.trim());
        const missingPackages = Object.entries(report.checks || {})
          .filter(([, ok]) => !ok)
          .map(([name]) => name);
        let reason = null;
        if (!report.is_supported) reason = 'python-version';
        else if (!report.is_venv) reason = 'not-venv';
        else if (!report.prefix_matches) reason = 'prefix-mismatch';
        else if (missingPackages.length > 0) reason = 'missing-packages';
        const health = {
          exists: true,
          healthy: reason === null,
          reason: reason || 'ok',
          version: report.version,
          prefix: report.prefix,
          basePrefix: report.base_prefix,
          expectedPrefix: report.expected_prefix,
          missingPackages,
        };
        health.summary = health.healthy ? '虚拟环境健康' : summarizeVenvHealth(health);
        resolve(health);
      } catch {
        const health = {
          exists: true,
          healthy: false,
          reason: 'invalid-probe-output',
          error: stdout.trim() || stderr.trim(),
        };
        health.summary = summarizeVenvHealth(health);
        resolve(health);
      }
    });
    proc.on('error', (err) => {
      const health = {
        exists: true,
        healthy: false,
        reason: 'probe-failed',
        error: err.message,
      };
      health.summary = summarizeVenvHealth(health);
      resolve(health);
    });
  });
}

// Get total page count of a PDF using Python/pypdf
function getPdfPageCount(filePath) {
  return new Promise((resolve) => {
    const pythonBin = path.join(process.env.HOME || os.homedir(), '.pdf2zh-venv/bin/python');
    const proc = spawn(
      pythonBin,
      ['-c', 'import pypdf,sys; r=pypdf.PdfReader(sys.argv[1]); print(len(r.pages))', filePath],
      { env: process.env, shell: false }
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', (code) => {
      const n = parseInt(out.trim());
      resolve(code === 0 && n > 0 ? n : 0);
    });
    proc.on('error', () => resolve(0));
  });
}

// Split a PDF into a subset of pages (startPage/endPage are 1-indexed inclusive)
function splitPdf(inputFile, startPage, endPage, outputFile) {
  return new Promise((resolve, reject) => {
    const pythonBin = path.join(process.env.HOME || os.homedir(), '.pdf2zh-venv/bin/python');
    const script = [
      'import pypdf, sys',
      'start, end = int(sys.argv[1])-1, int(sys.argv[2])-1',
      'r = pypdf.PdfReader(sys.argv[3])',
      'w = pypdf.PdfWriter()',
      'for i in range(start, end+1): w.add_page(r.pages[i])',
      'with open(sys.argv[4], "wb") as f: w.write(f)',
    ].join('\n');
    const proc = spawn(pythonBin, ['-c', script, String(startPage), String(endPage), inputFile, outputFile], {
      env: process.env,
      shell: false,
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || 'PDF split failed'))
    );
    proc.on('error', reject);
  });
}

// Merge multiple PDFs into one output file using Python/pypdf
function mergePdfs(inputFiles, outputFile) {
  return new Promise((resolve, reject) => {
    const pythonBin = path.join(process.env.HOME || os.homedir(), '.pdf2zh-venv/bin/python');
    const script = [
      'import pypdf, sys',
      'w = pypdf.PdfWriter()',
      'for f in sys.argv[1:-1]:',
      '    r = pypdf.PdfReader(f)',
      '    for p in r.pages: w.add_page(p)',
      'with open(sys.argv[-1], "wb") as o: w.write(o)',
    ].join('\n');
    const proc = spawn(pythonBin, ['-c', script, ...inputFiles, outputFile], {
      env: process.env,
      shell: false,
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || 'PDF merge failed'))
    );
    proc.on('error', reject);
  });
}

let mainWindow;
let translationProcess = null;
let translationCancelled = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0c16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createWindow();

  const { pythonBin: venvPython } = getVenvPaths();
  const patchSrc = path.join(__dirname, 'patches', 'apply_coreml.py');
  const venvHealth = await inspectPdf2zhVenv();
  if (venvHealth.exists && !venvHealth.healthy) {
    console.log(`[pdf2zh venv] unhealthy: ${venvHealth.summary}`);
  }
  if (venvHealth.healthy && fs.existsSync(venvPython) && fs.existsSync(patchSrc)) {
    try {
      const patchScript = extractFromAsar(patchSrc);
      await new Promise((resolve) => {
        const proc = spawn(venvPython, [patchScript], { env: process.env, shell: false });
        let output = '';
        proc.stdout.on('data', (d) => (output += d.toString()));
        proc.stderr.on('data', (d) => (output += d.toString()));
        proc.on('close', (code) => {
          console.log(`[CoreML patch] exit=${code} ${output.trim()}`);
          resolve();
        });
        proc.on('error', (err) => {
          console.log(`[CoreML patch] error: ${err.message}`);
          resolve();
        });
      });
    } catch (e) {
      console.log(`[CoreML patch] failed: ${e.message}`);
    }
  }
});

app.on('window-all-closed', () => {
  if (translationProcess) {
    translationProcess.kill();
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ==================== IPC Handlers ====================

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  return result.filePaths;
});

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('check-pdf2zh', async () => {
  const venvHealth = await inspectPdf2zhVenv();
  if (!venvHealth.healthy) {
    return { installed: false, version: '', bin: pdf2zhBin, reason: venvHealth.reason, summary: venvHealth.summary };
  }
  return new Promise((resolve) => {
    const proc = spawn(pdf2zhBin, ['--version'], {
      env: process.env,
      shell: false,
    });
    let output = '';
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.stderr.on('data', (d) => (output += d.toString()));
    proc.on('close', (code) => {
      // Extract only the version number from noisy output
      const versionMatch = output.match(/version:\s*([\d.]+)/);
      const version = versionMatch ? versionMatch[1] : '';
      resolve({ installed: code === 0, version, bin: pdf2zhBin });
    });
    proc.on('error', () => {
      resolve({ installed: false, version: '', bin: pdf2zhBin });
    });
  });
});

// Check for pdf2zh-next updates via pip
const pipBin = getVenvPaths().pipBin;

ipcMain.handle('check-pdf2zh-update', async () => {
  const venvHealth = await inspectPdf2zhVenv();
  if (!venvHealth.healthy) {
    return { latest: null, installed: null, hasUpdate: false, reason: venvHealth.reason, summary: venvHealth.summary };
  }
  return new Promise((resolve) => {
    const proc = spawn(pipBin, ['index', 'versions', 'pdf2zh-next'], {
      env: process.env,
      shell: false,
    });
    let output = '';
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.stderr.on('data', (d) => (output += d.toString()));
    proc.on('close', () => {
      // First line: "pdf2zh-next (x.y.z)" = latest version
      const latestMatch = output.match(/^pdf2zh-next\s+\(([\d.]+)\)/m);
      const installedMatch = output.match(/INSTALLED:\s*([\d.]+)/);
      const latest = latestMatch ? latestMatch[1] : null;
      const installed = installedMatch ? installedMatch[1] : null;
      const hasUpdate = latest && installed && latest !== installed;
      resolve({ latest, installed, hasUpdate });
    });
    proc.on('error', () => {
      resolve({ latest: null, installed: null, hasUpdate: false });
    });
  });
});

ipcMain.handle('update-pdf2zh', async () => {
  const venvHealth = await inspectPdf2zhVenv();
  if (!venvHealth.healthy) {
    return { success: false, error: venvHealth.summary, reason: venvHealth.reason };
  }
  const upgradeResult = await new Promise((resolve) => {
    const proc = spawn(pipBin, ['install', '--upgrade', 'pdf2zh-next'], {
      env: process.env,
      shell: false,
    });
    let output = '';
    proc.stdout.on('data', (d) => {
      output += d.toString();
      mainWindow?.webContents.send('translation-log', d.toString());
    });
    proc.stderr.on('data', (d) => {
      output += d.toString();
      mainWindow?.webContents.send('translation-log', d.toString());
    });
    proc.on('close', (code) => {
      const versionMatch = output.match(/Successfully installed.*pdf2zh-next-([\d.]+)/);
      const newVersion = versionMatch ? versionMatch[1] : null;
      resolve({ success: code === 0, newVersion });
    });
    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });

  // Re-apply CoreML patch after upgrade (pip overwrites patched files)
  if (upgradeResult.success) {
    const home = os.homedir();
    const venvPython = path.join(home, '.pdf2zh-venv/bin/python');
    const patchScript = extractFromAsar(path.join(__dirname, 'patches', 'apply_coreml.py'));
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(venvPython, [patchScript], { env: process.env, shell: false });
        proc.stdout.on('data', (d) => mainWindow?.webContents.send('translation-log', d.toString()));
        proc.stderr.on('data', (d) => mainWindow?.webContents.send('translation-log', d.toString()));
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
      mainWindow?.webContents.send('translation-log', '✓ CoreML GPU 加速补丁已重新应用\n');
    } catch {
      mainWindow?.webContents.send('translation-log', '⚠ CoreML 补丁重新应用失败（不影响基本功能）\n');
    }
  }

  return upgradeResult;
});

// ==================== Environment Setup ====================

// Find Python 3.10–3.12 interpreter for venv creation
// pdf2zh-next does NOT support Python 3.13+; prefer 3.12 explicitly
function findPython3() {
  const home = process.env.HOME || os.homedir();

  // Try explicit versioned binaries first (prefer 3.12, then 3.11, then 3.10)
  const versionedCandidates = [
    '/opt/homebrew/opt/python@3.12/bin/python3.12',
    '/opt/homebrew/opt/python@3.12/bin/python3',
    '/usr/local/opt/python@3.12/bin/python3.12',
    '/opt/homebrew/opt/python@3.11/bin/python3.11',
    '/opt/homebrew/opt/python@3.11/bin/python3',
    '/opt/homebrew/opt/python@3.10/bin/python3.10',
    '/opt/homebrew/opt/python@3.10/bin/python3',
    path.join(home, '.pyenv/shims/python3.12'),
    path.join(home, '.pyenv/shims/python3.11'),
    path.join(home, '.pyenv/shims/python3.10'),
    // Generic fallbacks (may be 3.13+ — validated below)
    '/opt/homebrew/bin/python3',
    path.join(home, '.pyenv/shims/python3'),
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ];

  // Also probe login shell for python3.12 / python3.11
  for (const cmd of ['python3.12', 'python3.11', 'python3.10', 'python3']) {
    try {
      const found = execSync(`/bin/zsh -ilc "which ${cmd}"`, {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n')[0];
      if (found && !versionedCandidates.includes(found)) {
        versionedCandidates.unshift(found);
      }
    } catch {}
  }

  for (const candidate of versionedCandidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const ver = execSync(`"${candidate}" -c "import sys; print(sys.version)"`, {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const match = ver.match(/^3\.(\d+)/);
      const minor = match ? parseInt(match[1]) : 0;
      // pdf2zh-next supports Python 3.10–3.12 only
      if (minor >= 10 && minor <= 12) return candidate;
    } catch {}
  }
  return null;
}

ipcMain.handle('check-environment', async () => {
  const pythonBin = findPython3();
  const venvHealth = await inspectPdf2zhVenv();
  return {
    ready: venvHealth.healthy,
    venvExists: venvHealth.exists,
    reason: venvHealth.reason,
    summary: venvHealth.summary || null,
    hasPython: !!pythonBin,
    pythonBin: pythonBin || null,
  };
});

ipcMain.handle('setup-environment', async () => {
  const { venvPath } = getVenvPaths();

  const log = (text) => mainWindow?.webContents.send('setup-log', text);
  const setStep = (step) => mainWindow?.webContents.send('setup-step', step);

  const pythonBin = findPython3();
  if (!pythonBin) {
    log('❌ 未找到兼容的 Python（需要 3.10–3.12）\n\npdf2zh-next 暂不支持 Python 3.13+。\n请安装 Python 3.12：\n  brew install python@3.12\n\n安装后重试。\n');
    return { success: false, error: 'no-python' };
  }

  log(`✓ Python: ${pythonBin}\n`);
  setStep(1);

  function runStep(cmd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { env: process.env, shell: false });
      proc.stdout.on('data', (d) => log(d.toString()));
      proc.stderr.on('data', (d) => log(d.toString()));
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`退出码 ${code}`)));
      proc.on('error', reject);
    });
  }

  try {
    const currentHealth = await inspectPdf2zhVenv();
    if (currentHealth.exists && !currentHealth.healthy) {
      log(`⚠ 检测到已损坏的 pdf2zh 虚拟环境：${currentHealth.summary}\n`);
      log('正在删除旧环境并重建 ~/.pdf2zh-venv ...\n');
      fs.rmSync(venvPath, { recursive: true, force: true });
    }

    log('\n[1/3] 创建 Python 虚拟环境 ~/.pdf2zh-venv ...\n');
    await runStep(pythonBin, ['-m', 'venv', venvPath]);
    log('✓ 虚拟环境就绪\n');
    setStep(2);

    const pip = path.join(venvPath, 'bin/pip');

    // Mirrors tried in order; null = official PyPI (no -i flag)
    const mirrors = [
      { name: '官方 PyPI', url: null },
      { name: '阿里云',  url: 'https://mirrors.aliyun.com/pypi/simple/' },
      { name: '清华',    url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
      { name: 'USTC',   url: 'https://pypi.mirrors.ustc.edu.cn/simple/' },
      { name: '腾讯云',  url: 'https://mirrors.cloud.tencent.com/pypi/simple' },
    ];

    // Try each mirror; stop on first success
    async function pipInstallWithFallback(packages) {
      for (const { name, url } of mirrors) {
        const args = ['install', ...packages];
        if (url) args.push('-i', url, '--trusted-host', new URL(url).hostname);
        log(`\n正在尝试 ${name} 镜像...\n`);
        try {
          await runStep(pip, args);
          return; // success
        } catch {
          log(`${name} 镜像失败，切换下一个...\n`);
        }
      }
      throw new Error('所有镜像均安装失败，请检查网络连接后重试');
    }

    log('\n[2/3] 更新 pip...\n');
    await pipInstallWithFallback(['--upgrade', 'pip']);

    log('\n[3/3] 安装 pdf2zh-next + pypdf（约需 3–10 分钟）...\n');
    setStep(3);
    await pipInstallWithFallback(['pdf2zh-next', 'pypdf']);

    // Apply CoreML GPU acceleration patch to babeldoc
    log('\n正在应用 CoreML GPU 加速补丁...\n');
    const patchScript = extractFromAsar(path.join(__dirname, 'patches', 'apply_coreml.py'));
    const venvPython = path.join(venvPath, 'bin/python');
    try {
      await runStep(venvPython, [patchScript]);
    } catch (e) {
      log(`⚠ CoreML 补丁应用失败（不影响基本功能）: ${e.message}\n`);
    }

    // Refresh pdf2zh binary path now that venv exists
    pdf2zhBin = findPdf2zh();

    const finalHealth = await inspectPdf2zhVenv();
    if (!finalHealth.healthy) {
      throw new Error(finalHealth.summary || '虚拟环境校验失败');
    }

    log('\n✅ 安装完成！即将启动...\n');

    return { success: true };
  } catch (err) {
    log(`\n❌ 安装失败: ${err.message}\n`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-translation', async (event, options) => {
  const venvHealth = await inspectPdf2zhVenv();
  if (!venvHealth.healthy) {
    throw new Error(`pdf2zh 运行环境异常：${venvHealth.summary || '请重新安装'}`);
  }

  const {
    files,
    sourceLang,
    targetLang,
    outputFormat,
    service,
    apiKey,
    apiUrl,
    modelName,
    outputDir,
    pages,
    threads,
    compatMode,
    customPrompt,
    noCache,
    autoBatch,
    batchSize,
  } = options;

  if (translationProcess) {
    translationProcess.kill();
    translationProcess = null;
  }
  translationCancelled = false;

  // pdf2zh-next 2.x CLI argument maps
  const serviceFlagMap = {
    siliconflowfree: '--siliconflowfree',
    google: '--google',
    bing: '--bing',
    deepl: '--deepl',
    openai: '--openai',
    ollama: '--ollama',
    gemini: '--gemini',
    azureopenai: '--azureopenai',
    deepseek: '--deepseek',
    zhipu: '--zhipu',
    siliconflow: '--siliconflow',
    groq: '--groq',
    grok: '--grok',
    openaicompatible: '--openaicompatible',
  };
  const apiKeyArgMap = {
    openai: '--openai-api-key',
    deepl: '--deepl-auth-key',
    gemini: '--gemini-api-key',
    azureopenai: '--azure-openai-api-key',
    deepseek: '--deepseek-api-key',
    zhipu: '--zhipu-api-key',
    siliconflow: '--siliconflow-api-key',
    groq: '--groq-api-key',
    grok: '--grok-api-key',
    openaicompatible: '--openai-compatible-api-key',
  };
  const apiUrlArgMap = {
    openai: '--openai-base-url',
    ollama: '--ollama-host',
    azureopenai: '--azure-openai-base-url',
    siliconflow: '--siliconflow-base-url',
    openaicompatible: '--openai-compatible-base-url',
  };
  const modelArgMap = {
    openai: '--openai-model',
    gemini: '--gemini-model',
    zhipu: '--zhipu-model',
    siliconflow: '--siliconflow-model',
    ollama: '--ollama-model',
    deepseek: '--deepseek-model',
    azureopenai: '--azure-openai-model',
    openaicompatible: '--openai-compatible-model',
    grok: '--grok-model',
    groq: '--groq-model',
  };

  const procEnv = { ...process.env, PYTHONUNBUFFERED: '1', PDF2ZH_USE_COREML: '1' };

  // Build CLI args for a single pdf2zh invocation
  function buildArgs(filePath, overridePages, overrideOutputDir) {
    const args = [filePath];
    if (sourceLang) args.push('--lang-in', sourceLang);
    if (targetLang) args.push('--lang-out', targetLang);
    args.push('--output', overrideOutputDir || outputDir || path.dirname(filePath));
    const p = overridePages !== undefined ? overridePages : pages;
    if (p) args.push('--pages', p);
    if (threads) args.push('--pool-max-workers', String(threads));
    if (outputFormat === 'mono') args.push('--no-dual');
    else if (outputFormat === 'dual') args.push('--no-mono');
    if (compatMode) args.push('--enhance-compatibility');
    if (noCache) args.push('--ignore-cache');
    args.push('--watermark-output-mode', 'no_watermark');
    args.push('--no-auto-extract-glossary');
    if (customPrompt) args.push('--custom-system-prompt', customPrompt);
    if (serviceFlagMap[service]) args.push(serviceFlagMap[service]);
    if (apiKey && apiKeyArgMap[service]) args.push(apiKeyArgMap[service], apiKey);
    if (apiUrl && apiUrlArgMap[service]) args.push(apiUrlArgMap[service], apiUrl);
    if (modelName && modelArgMap[service]) args.push(modelArgMap[service], modelName);
    return args;
  }

  function getExpectedOutputs(baseName, outDir) {
    const outputs = [];
    if (outputFormat !== 'dual') outputs.push(path.join(outDir, `${baseName}.zh.mono.pdf`));
    if (outputFormat !== 'mono') outputs.push(path.join(outDir, `${baseName}.zh.dual.pdf`));
    return outputs;
  }

  // Resolve wrapper script path (works both in dev and inside asar)
  const wrapperScript = (() => {
    const src = path.join(__dirname, 'patches', 'translate_wrapper.py');
    return fs.existsSync(src) ? extractFromAsar(src) : null;
  })();
  const venvPython = path.join(os.homedir(), '.pdf2zh-venv/bin/python');

  // Spawn a single pdf2zh process.
  // batchProgressBase (0-100): progress offset for this batch
  // batchProgressScale (0-1): fraction of total progress this batch represents
  function spawnPdf2zh(args, startTime, filePath, completedFiles, totalFiles, batchProgressBase, batchProgressScale, batchContext = {}) {
    // Try wrapper first, fall back to CLI if wrapper fails
    function attempt(mode) {
      return new Promise((resolve, reject) => {
        let proc;
        const isWrapper = mode === 'wrapper';
        if (isWrapper) {
          proc = spawn(venvPython, [wrapperScript, ...args], { env: procEnv, shell: false });
        } else {
          proc = spawn(pdf2zhBin, args, { env: procEnv, shell: false });
        }
        translationProcess = proc;

        let currentStage = null;
        let lastProgress = 0;
        let lineBuffer = ''; // buffer for line splitting

        function sendProgress(data) {
          mainWindow?.webContents.send('translation-progress', { ...data, ...batchContext });
        }

        const stageNameNormalize = {
          'Parse PDF and Create Intermediate Representation': 'Parse PDF and Create IR',
        };
        function normalizeStage(name) {
          return name ? (stageNameNormalize[name] || name) : name;
        }

        const elapsedTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          mainWindow?.webContents.send('translation-tick', {
            elapsedSeconds: elapsed,
            stageName: currentStage,
          });
          // In CLI mode, flush buffered tqdm line periodically
          if (!isWrapper && lineBuffer) {
            parseTqdmLine(lineBuffer);
            lineBuffer = '';
          }
        }, 2000);

        // --- JSON progress event handler (wrapper mode) ---
        function handleJsonEvent(event) {
          const type = event.type;
          const elapsed = (Date.now() - startTime) / 1000;
          if (type === 'progress_start' || type === 'progress_update' || type === 'progress_end') {
            const stageName = normalizeStage(event.stage);
            const rawPct = Math.min(event.overall_progress || 0, 100);
            const scaledPct = Math.round(batchProgressBase + rawPct * batchProgressScale);
            const eta = rawPct > 1 ? Math.round(elapsed * (100 - rawPct) / rawPct) : null;
            currentStage = stageName;
            lastProgress = rawPct;
            sendProgress({
              progress: scaledPct,
              currentFile: path.basename(filePath),
              completedFiles, totalFiles,
              stageName,
              stageCur: event.part_index || null,
              stageTotal: event.total_parts || null,
              etaSeconds: eta,
              elapsedSeconds: Math.round(elapsed),
            });
          }
        }

        // --- tqdm line parser (CLI fallback mode) ---
        const tqdmStageRegex = /^(.+?)\s+\((\d+)\/(\d+)\):\s+(\d+(?:\.\d+)?)%/;
        const tqdmCompleteRegex = /^(.+?)\s+\(Complete\):\s+(\d+(?:\.\d+)?)%/;
        const tqdmOverallRegex = /^translate:\s+(\d+(?:\.\d+)?)%/;

        function sanitizeTqdmLine(line) {
          return line
            .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        }

        function parseTqdmLine(line) {
          const trimmed = sanitizeTqdmLine(line).trim();
          if (!trimmed) return;
          const elapsed = (Date.now() - startTime) / 1000;

          const sm = tqdmStageRegex.exec(trimmed);
          if (sm) {
            const stageName = normalizeStage(sm[1].trim());
            const rawPct = Math.min(parseFloat(sm[4]), 100);
            currentStage = stageName;
            lastProgress = rawPct;
            sendProgress({
              progress: Math.round(batchProgressBase + rawPct * batchProgressScale),
              currentFile: path.basename(filePath),
              completedFiles, totalFiles,
              stageName, stageCur: parseInt(sm[2]), stageTotal: parseInt(sm[3]),
              etaSeconds: rawPct > 1 ? Math.round(elapsed * (100 - rawPct) / rawPct) : null,
              elapsedSeconds: Math.round(elapsed),
            });
            return;
          }
          const cm = tqdmCompleteRegex.exec(trimmed);
          if (cm) {
            const stageName = normalizeStage(cm[1].trim());
            const rawPct = Math.min(parseFloat(cm[2]), 100);
            currentStage = stageName;
            lastProgress = rawPct;
            sendProgress({
              progress: Math.round(batchProgressBase + rawPct * batchProgressScale),
              currentFile: path.basename(filePath),
              completedFiles, totalFiles,
              stageName, stageCur: null, stageTotal: null,
              etaSeconds: rawPct > 1 ? Math.round(elapsed * (100 - rawPct) / rawPct) : null,
              elapsedSeconds: Math.round(elapsed),
            });
            return;
          }
          const om = tqdmOverallRegex.exec(trimmed);
          if (om) {
            const rawPct = Math.min(parseFloat(om[1]), 100);
            lastProgress = rawPct;
            sendProgress({
              progress: Math.round(batchProgressBase + rawPct * batchProgressScale),
              currentFile: path.basename(filePath),
              completedFiles, totalFiles,
              stageName: currentStage, stageCur: null, stageTotal: null,
              etaSeconds: rawPct > 1 ? Math.round(elapsed * (100 - rawPct) / rawPct) : null,
              elapsedSeconds: Math.round(elapsed),
            });
          }
        }

        // Common: detect CoreML and forward as log
        function forwardLog(text) {
          if (text.includes('CoreMLExecutionProvider')) {
            mainWindow?.webContents.send('translation-gpu', { enabled: true });
          }
          mainWindow?.webContents.send('translation-log', text);
        }

        // CLI mode: parse tqdm from mixed stdout/stderr
        function handleMixedOutput(text) {
          const combined = lineBuffer + text;
          const lines = combined.split(/[\r\n]+/);
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            parseTqdmLine(line);
          }
        }

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          if (isWrapper) {
            // Wrapper mode: parse JSON progress from stdout
            lineBuffer += text;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                handleJsonEvent(JSON.parse(trimmed));
              } catch {
                forwardLog(trimmed + '\n');
              }
            }
          } else {
            // CLI mode: forward as log + parse tqdm
            forwardLog(text);
            handleMixedOutput(text);
          }
        });
        proc.stderr.on('data', (data) => {
          const text = data.toString();
          forwardLog(text);
          if (!isWrapper) {
            handleMixedOutput(text);
          }
        });

        proc.on('close', (code) => {
          clearInterval(elapsedTimer);
          if (lineBuffer.trim()) {
            if (isWrapper) {
              try { handleJsonEvent(JSON.parse(lineBuffer.trim())); } catch {}
            } else {
              parseTqdmLine(lineBuffer);
            }
          }
          lineBuffer = '';
          translationProcess = null;
          if (code === 0) {
            resolve();
          } else if (code === null) {
            reject(new Error('CANCELLED'));
          } else {
            reject(new Error(`exit:${code}`));
          }
        });

        proc.on('error', (err) => {
          clearInterval(elapsedTimer);
          translationProcess = null;
          reject(err);
        });
      });
    }

    // Try wrapper first; on failure, retry with CLI
    const canWrapper = wrapperScript && fs.existsSync(venvPython);
    if (canWrapper) {
      return attempt('wrapper').catch((err) => {
        if (err.message === 'CANCELLED') throw err;
        console.log(`[wrapper failed: ${err.message}] falling back to pdf2zh CLI`);
        mainWindow?.webContents.send('translation-log', '[进度包装器失败，回退到 CLI 模式]\n');
        return attempt('cli');
      });
    }
    return attempt('cli');
  }

  const totalFiles = files.length;
  let completedFiles = 0;

  for (const filePath of files) {
    const startTime = Date.now();
    const finalOutputDir = outputDir || path.dirname(filePath);
    const baseName = path.basename(filePath, '.pdf');

    // ── Auto-batch mode ──
    // If user specified a page range, skip auto-batching (the scope is already limited)
    if (autoBatch && batchSize > 0 && !pages) {
      // Show "counting pages" status immediately
      mainWindow?.webContents.send('translation-progress', {
        progress: 0,
        currentFile: path.basename(filePath),
        completedFiles, totalFiles,
        stageName: 'counting-pages',
        stageCur: null, stageTotal: null,
        etaSeconds: null,
        elapsedSeconds: 0,
      });

      const pageCount = await getPdfPageCount(filePath);

      if (pageCount > batchSize) {
        const batches = [];
        for (let start = 1; start <= pageCount; start += batchSize) {
          batches.push({ start, end: Math.min(start + batchSize - 1, pageCount) });
        }

        mainWindow?.webContents.send('translation-log',
          `\n[自动分批] 检测到 ${pageCount} 页，分为 ${batches.length} 批（每批最多 ${batchSize} 页）\n\n`);

        const batchTmpDirs = [];
        const monoOutputs = [];
        const dualOutputs = [];

        let batchSuccess = false;
        try {
          for (let i = 0; i < batches.length; i++) {
            if (translationCancelled) throw new Error('CANCELLED');

            const { start, end } = batches[i];
            const batchTmpDir = path.join(os.tmpdir(), `pdf2zh-batch-${Date.now()}-${i}`);
            fs.mkdirSync(batchTmpDir, { recursive: true });
            batchTmpDirs.push(batchTmpDir);

            mainWindow?.webContents.send('translation-log',
              `\n--- 第 ${i + 1}/${batches.length} 批（第 ${start}~${end} 页）---\n`);

            const batchProgressBase = (i / batches.length) * 100;
            const batchProgressScale = 1 / batches.length;

            // Show "splitting PDF" status
            mainWindow?.webContents.send('translation-progress', {
              progress: Math.round(batchProgressBase),
              currentFile: path.basename(filePath),
              completedFiles, totalFiles,
              stageName: 'splitting',
              batchIndex: i, batchTotal: batches.length,
              batchStart: start, batchEnd: end, totalPageCount: pageCount,
              stageCur: null, stageTotal: null,
              etaSeconds: null,
              elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
            });

            // Physically split pages into a small temp PDF to reduce memory usage
            const splitFile = path.join(batchTmpDir, 'batch.pdf');
            await splitPdf(filePath, start, end, splitFile);

            const batchArgs = buildArgs(splitFile, undefined, batchTmpDir);
            await spawnPdf2zh(batchArgs, startTime, filePath, completedFiles, totalFiles, batchProgressBase, batchProgressScale,
              { batchIndex: i, batchTotal: batches.length, batchStart: start, batchEnd: end, totalPageCount: pageCount });

            // Collect output files from this batch (pdf2zh-next 2.x naming: batch.zh.mono.pdf / batch.zh.dual.pdf)
            const expectedBatchOutputs = [];
            if (outputFormat !== 'dual') expectedBatchOutputs.push(path.join(batchTmpDir, 'batch.zh.mono.pdf'));
            if (outputFormat !== 'mono') expectedBatchOutputs.push(path.join(batchTmpDir, 'batch.zh.dual.pdf'));
            const missingBatchOutputs = expectedBatchOutputs.filter((f) => !fs.existsSync(f));
            if (missingBatchOutputs.length > 0) {
              throw new Error(`分批输出缺失: ${missingBatchOutputs.map((f) => path.basename(f)).join(', ')}`);
            }

            if (outputFormat !== 'dual') {
              monoOutputs.push(path.join(batchTmpDir, 'batch.zh.mono.pdf'));
            }
            if (outputFormat !== 'mono') {
              dualOutputs.push(path.join(batchTmpDir, 'batch.zh.dual.pdf'));
            }
          }

          // Merge all batch outputs
          mainWindow?.webContents.send('translation-log', '\n[合并] 正在合并批次输出...\n');
          mainWindow?.webContents.send('translation-progress', {
            progress: 99,
            currentFile: path.basename(filePath),
            completedFiles, totalFiles,
            stageName: 'merging',
            batchIndex: batches.length - 1, batchTotal: batches.length,
            batchStart: 1, batchEnd: pageCount, totalPageCount: pageCount,
            stageCur: null, stageTotal: null,
            etaSeconds: null,
            elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
          });
          if (monoOutputs.length > 0) {
            const finalFile = path.join(finalOutputDir, `${baseName}-zh.pdf`);
            await mergePdfs(monoOutputs, finalFile);
            mainWindow?.webContents.send('translation-log', `-> 已保存: ${finalFile}\n`);
          }
          if (dualOutputs.length > 0) {
            const finalFile = path.join(finalOutputDir, `${baseName}-dual.pdf`);
            await mergePdfs(dualOutputs, finalFile);
            mainWindow?.webContents.send('translation-log', `-> 已保存: ${finalFile}\n`);
          }
          batchSuccess = true;
        } finally {
          for (const dir of batchTmpDirs) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          }
          // Clean up partial merged output files on cancel or error
          if (!batchSuccess) {
            for (const f of [
              path.join(finalOutputDir, `${baseName}-zh.pdf`),
              path.join(finalOutputDir, `${baseName}-dual.pdf`),
            ]) { try { fs.unlinkSync(f); } catch {} }
          }
        }

        completedFiles++;
        mainWindow?.webContents.send('translation-progress', {
          progress: Math.round((completedFiles / totalFiles) * 100),
          currentFile: path.basename(filePath),
          completedFiles, totalFiles,
          stageName: null, stageCur: null, stageTotal: null,
          etaSeconds: 0,
          elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
        });
        continue; // next file
      }
      // pageCount <= batchSize: fall through to normal single-pass translation
    }

    // ── Normal (non-batch) mode ──
    const args = buildArgs(filePath, undefined, finalOutputDir);
    const expectedOutputs = getExpectedOutputs(baseName, finalOutputDir);
    try {
      await spawnPdf2zh(args, startTime, filePath, completedFiles, totalFiles, 0, 1);
      const missingOutputs = expectedOutputs.filter((f) => !fs.existsSync(f));
      if (missingOutputs.length > 0) {
        throw new Error(`翻译未生成输出文件: ${missingOutputs.map((f) => path.basename(f)).join(', ')}`);
      }
    } catch (err) {
      for (const f of expectedOutputs) { try { fs.unlinkSync(f); } catch {} }
      throw err;
    }

    completedFiles++;
    mainWindow?.webContents.send('translation-progress', {
      progress: Math.round((completedFiles / totalFiles) * 100),
      currentFile: path.basename(filePath),
      completedFiles, totalFiles,
      stageName: null, stageCur: null, stageTotal: null,
      etaSeconds: 0,
      elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
    });
  }

  return { success: true, completedFiles };
});

ipcMain.handle('cancel-translation', async () => {
  translationCancelled = true;
  if (translationProcess) {
    translationProcess.kill('SIGTERM');
    translationProcess = null;
    return true;
  }
  return false;
});

ipcMain.handle('open-file', async (event, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('get-file-info', async (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size,
      dir: path.dirname(filePath),
    };
  } catch {
    return null;
  }
});
