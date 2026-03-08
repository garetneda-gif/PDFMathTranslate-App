# PDF Math Translate

> 一款专为学术 PDF 设计的本地翻译工具，完整保留数学公式、图表和排版结构。基于 [pdf2zh-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next) 引擎，提供原生 macOS GUI。
>
> A local translation tool designed for academic PDFs, preserving mathematical formulas, figures, and layout. Native macOS GUI powered by [pdf2zh-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next).

![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey)
![Electron](https://img.shields.io/badge/Electron-33-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## 功能特性 / Features

| 中文 | English |
|------|---------|
| **公式保留**：翻译正文，不碰 LaTeX / MathML 公式 | **Formula preservation**: translates body text, leaves LaTeX / MathML untouched |
| **双语输出**：原文 + 译文双栏对照 PDF，或纯译文 PDF | **Bilingual output**: side-by-side original + translation, or translation-only PDF |
| **多引擎支持**：OpenAI、Gemini、DeepL、DeepSeek、智谱、SiliconFlow、Groq、Grok、Azure OpenAI 及任意 OpenAI 兼容接口 | **10+ engines**: OpenAI, Gemini, DeepL, DeepSeek, Zhipu, SiliconFlow, Groq, Grok, Azure OpenAI, and any OpenAI-compatible endpoint |
| **自动分批**：大文档自动按页拆分，逐批翻译后无缝合并，显著降低内存占用 | **Auto-batch**: large documents are split by page, translated in chunks, and seamlessly merged — peak RAM drops from >12 GB to ~2 GB |
| **Apple Silicon GPU 加速**：CoreML 推理加速，版面解析速度提升 3–8 倍 | **Apple Silicon GPU acceleration**: CoreML inference, layout parsing 3–8× faster than CPU |
| **实时进度**：阶段级进度条 + ETA 倒计时 | **Real-time progress**: per-stage progress bar with ETA countdown |
| **多文件队列**：拖拽多个 PDF 批量处理 | **Multi-file queue**: drag and drop multiple PDFs for batch processing |
| **零依赖安装**：首次启动自动创建 Python venv 并安装 pdf2zh-next | **Zero-config setup**: Python venv and pdf2zh-next are installed automatically on first launch |

---

## 安装 / Installation

### 下载 DMG（推荐）/ Download DMG (recommended)

从 [Releases](../../releases) 页面下载最新的 `PDF Math Translate-*-arm64.dmg`，拖入 Applications 即可。

Download the latest `PDF Math Translate-*-arm64.dmg` from the [Releases](../../releases) page and drag it into Applications.

> **注意 / Note**：首次打开时 macOS 会提示"无法验证开发者"，在系统设置 → 隐私与安全性中点击"仍然打开"即可。
> On first launch macOS may warn "cannot verify developer" — go to System Settings → Privacy & Security and click "Open Anyway".

### 从源码运行 / Run from source

```bash
git clone https://github.com/garetneda-gif/PDFMathTranslate-App.git
cd PDFMathTranslate-App
npm install
npm start
```

**运行时依赖（首次启动自动安装）/ Runtime dependencies (auto-installed on first launch)**

| 路径 / Path | 说明 / Description | 大小 / Size |
|---|---|---|
| `~/.pdf2zh-venv/` | Python 3.12 venv + pdf2zh-next | ~1.1 GB |
| `~/.cache/babeldoc/` | 字体、ONNX 模型、CMap 缓存 / fonts, ONNX models, CMap cache | ~341 MB |

---

## 使用方法 / Usage

1. 拖拽 PDF 文件到窗口（支持多文件）/ Drag PDF files onto the window (multiple files supported)
2. 选择目标语言和翻译引擎 / Select target language and translation engine
3. 填写对应引擎的 API Key（各引擎配置独立保存）/ Enter the API Key for the selected engine (each engine saves its own config)
4. 点击翻译，实时查看阶段进度 / Click Translate and watch per-stage progress in real time

---

## 技术实现 / Technical Deep Dive

### 内存管理：自动分批翻译 / Memory Management: Auto-batch Translation

处理大型学术 PDF（100 页以上）时，pdf2zh 引擎会将整份文档加载进内存，容易触发 OOM 或系统换页。

When processing large academic PDFs (100+ pages), pdf2zh loads the entire document into memory, which can trigger OOM or heavy swapping.

本应用在主进程实现了一套**分批翻译 + 合并**机制 / The main process implements a **batch-translate + merge** pipeline:

```
Input PDF (300 pages)
    │
    ├─► getPdfPageCount()     ← pypdf reads page count without loading content
    │
    ├─► Split into batches    [1-50] [51-100] [101-150] ...
    │
    ├─► splitPdf()            ← pypdf physically writes each batch to a temp PDF
    │     /tmp/pdf2zh-batch-xxx-0/batch.pdf
    │     /tmp/pdf2zh-batch-xxx-1/batch.pdf
    │
    ├─► spawnPdf2zh() × N     ← one process per batch; exits and frees RAM before next
    │
    ├─► mergePdfs()           ← merge all batch outputs once complete
    │
    └─► finally: rmSync()     ← temp dirs cleaned up on success, failure, or cancel
```

**关键代码 / Key code** ([main.js:727](main.js#L727)):

```js
// Physically split into a small temp PDF — never hold all pages in memory at once
const splitFile = path.join(batchTmpDir, 'batch.pdf');
await splitPdf(filePath, start, end, splitFile);

const batchArgs = buildArgs(splitFile, undefined, batchTmpDir);
await spawnPdf2zh(batchArgs, ...);
// spawnPdf2zh returns → subprocess exits → batch RAM fully released
```

每批进程退出时清除引用，确保 GC 可回收 / Process handle cleared on close to allow GC:

```js
proc.on('close', (code) => {
  clearInterval(elapsedTimer);  // stop timer — prevents closure holding reference
  translationProcess = null;    // release process handle
  ...
});
```

**实际效果 / Results**: 300-page PDF on a 16 GB MacBook — without batching peak RAM exceeds 12 GB; with 50-page batches it stays under 2 GB.

---

### 流式管道缓冲 / Streaming Pipe Buffer

pdf2zh 通过 tqdm 将进度输出到 stderr。Pipe 缓冲区可能将一行切成多个 `data` 事件，也可能将多行合并。

pdf2zh emits progress via tqdm to stderr. Pipe buffering can split one line across multiple `data` events or merge several lines into one.

应用维护 `incompleteLine` 缓冲区，保证只对完整行调用 `parseLine()` / An `incompleteLine` buffer ensures `parseLine()` only receives complete lines:

```js
let incompleteLine = '';

function handleOutput(text) {
  const combined = incompleteLine + text;
  const lines = combined.split(/[\r\n]+/);
  incompleteLine = lines.pop() || '';  // stash incomplete trailing fragment
  for (const line of lines) {
    parseLine(line);
  }
}
```

同时设置 `PYTHONUNBUFFERED: '1'`，禁用 Python 侧缓冲，确保进度实时推送。

`PYTHONUNBUFFERED: '1'` is also set to disable Python-side stdout buffering, so progress arrives in real time rather than in batches.

---

### GPU 加速：Apple Silicon CoreML / GPU Acceleration: Apple Silicon CoreML

在 Apple Silicon 设备上，ONNX Runtime 可通过 CoreML Execution Provider 将推理卸载到 Neural Engine，比纯 CPU 快 3–8 倍。

On Apple Silicon, ONNX Runtime can offload inference to the Neural Engine via the CoreML Execution Provider, achieving 3–8× speedup over CPU.

**默认启用 / Enabled by default** — injected automatically on every translation:

```js
const procEnv = {
  ...process.env,
  PYTHONUNBUFFERED: '1',
  PDF2ZH_USE_COREML: '1',   // always on — Neural Engine activates automatically
};
```

`PDF2ZH_USE_COREML=1` instructs pdf2zh-next to prefer `CoreMLExecutionProvider` when creating ONNX InferenceSessions. Fallback order is `CoreML → CPU`, so it never crashes on unsupported hardware.

> **背景 / Background**: BabelDOC [temporarily disabled CoreML](https://github.com/funstory-ai/BabelDOC/issues/170) due to environment-specific initialization errors. This app re-enables it at the process environment level, where the fallback behavior is reliable on Apple Silicon.

**状态检测 / Detection** — main process watches subprocess output for the CoreML activation marker:

```js
if (text.includes('CoreMLExecutionProvider')) {
  mainWindow?.webContents.send('translation-gpu', { enabled: true });
}
```

A GPU badge appears in the progress area to confirm acceleration is active.

**性能对比 / Benchmark** (MacBook Pro M3 Pro, 100-page academic PDF, OpenAI gpt-4o-mini):

| 模式 / Mode | 版面解析 / Layout parsing | 峰值 CPU / Peak CPU |
|---|---|---|
| CPU only | ~45 s | 380% |
| CoreML | ~12 s | 95% |

---

### 进程生命周期管理 / Process Lifecycle Management

全局只持有一个 `translationProcess` 引用，任意时刻最多一个活跃子进程。

A single global `translationProcess` reference ensures at most one active subprocess at any time.

```
start-translation IPC
    │
    ├─ existing process? → kill() → wait for close → start new
    │
    └─ new process → translationProcess = proc
                           │
                       close / error
                           │
                    translationProcess = null
```

这避免了两个常见问题 / This prevents two common issues:
1. 快速重复点击"翻译"导致多进程并发 / Multiple concurrent processes from rapid re-clicks
2. 进程异常退出后句柄泄漏 / Handle leak when a process exits unexpectedly

---

### 每供应商独立 API 配置 / Per-provider API Config Storage

不同翻译引擎的 API Key、Base URL、模型名称独立存储，切换时自动保存旧的、加载新的。

Each engine's API Key, Base URL, and model name are stored independently. Switching engines saves the current config and loads the target engine's config.

```js
serviceSelect.addEventListener('change', () => {
  saveApiConfig(previousService);     // persist config for the engine being left
  previousService = serviceSelect.value;
  loadApiConfig(serviceSelect.value); // restore config for the newly selected engine
});
```

Stored under `pmt_api_configs` in localStorage, keyed by provider name:

```json
{
  "openai":           { "api-key": "sk-...",  "api-url": "", "model-name": "gpt-4o" },
  "openaicompatible": { "api-key": "...",     "api-url": "https://...", "model-name": "glm-4-flash" },
  "deepseek":         { "api-key": "sk-...",  "api-url": "", "model-name": "" }
}
```

---

## 架构 / Architecture

```
main.js          ← Electron main process: window management, IPC handlers, spawns pdf2zh
preload.js       ← Bridge: exposes IPC as window.api via contextBridge
src/renderer.js  ← Renderer: UI logic, state management, progress parsing
src/index.html   ← UI (Tailwind CSS)
```

### IPC 事件 / IPC Events

| 事件 / Event | 方向 / Direction | 说明 / Description |
|---|---|---|
| `start-translation` | Renderer → Main | Start translation with all parameters |
| `cancel-translation` | Renderer → Main | Cancel current translation (SIGTERM) |
| `translation-progress` | Main → Renderer | Progress data (stage, percent, ETA) |
| `translation-log` | Main → Renderer | Raw log text stream |
| `translation-tick` | Main → Renderer | Elapsed time update every 2s |
| `translation-gpu` | Main → Renderer | CoreML activation notification |
| `setup-environment` | Renderer → Main | Trigger first-run environment install |
| `setup-log` / `setup-step` | Main → Renderer | Install progress stream |

---

## 开发 / Development

```bash
npm run watch:css   # watch Tailwind CSS changes
npm start           # launch Electron (dev mode)
```

### 打包 / Build

```bash
npm run build:css

APP="dist/mac-arm64/PDF Math Translate.app"
TMP=/tmp/dmg-build && rm -rf $TMP && mkdir $TMP
cp -R "$APP" $TMP/ && ln -s /Applications $TMP/Applications
hdiutil create -volname "PDF Math Translate" -srcfolder $TMP \
  -ov -format UDZO "dist/PDF Math Translate-1.0.0-arm64.dmg"
```

### 快速更新 app.asar / Quick asar update (no full rebuild)

```bash
TMP=/tmp/app-src && rm -rf $TMP && mkdir $TMP
cp main.js preload.js package.json $TMP/
cp -R src assets $TMP/
node_modules/.bin/asar pack $TMP \
  "dist/mac-arm64/PDF Math Translate.app/Contents/Resources/app.asar"
```

---

## License

MIT
