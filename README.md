# PDF Math Translate

> A local translation tool designed for academic PDFs, preserving mathematical formulas, figures, and layout. Native macOS GUI powered by [pdf2zh-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next).

**[中文文档 README\_zh.md](README_zh.md)**

![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey)
![Electron](https://img.shields.io/badge/Electron-33-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **Formula preservation**: translates body text, leaves LaTeX / MathML untouched
- **Bilingual output**: side-by-side original + translation PDF, or translation-only PDF
- **10+ engines**: OpenAI, Gemini, DeepL, DeepSeek, Zhipu, SiliconFlow, Groq, Grok, Azure OpenAI, and any OpenAI-compatible endpoint
- **Auto-batch**: large documents are split by page, translated in chunks, and seamlessly merged — peak RAM drops from >12 GB to ~2 GB
- **Apple Silicon GPU acceleration**: CoreML inference enabled by default, layout parsing 3–8× faster than CPU
- **Real-time progress**: per-stage progress bar with ETA countdown
- **Multi-file queue**: drag and drop multiple PDFs for batch processing
- **Zero-config setup**: Python venv and pdf2zh-next are installed automatically on first launch

---

## Installation

### Download DMG (recommended)

Download the latest `PDF Math Translate-*-arm64.dmg` from the [Releases](../../releases) page and drag it into Applications.

> On first launch macOS may warn "cannot verify developer" — go to **System Settings → Privacy & Security** and click **Open Anyway**.

### Run from source

```bash
git clone https://github.com/garetneda-gif/PDFMathTranslate-App.git
cd PDFMathTranslate-App
npm install
npm start
```

**Runtime dependencies (auto-installed on first launch)**

| Path | Description | Size |
|------|-------------|------|
| `~/.pdf2zh-venv/` | Python 3.12 venv + pdf2zh-next | ~1.1 GB |
| `~/.cache/babeldoc/` | Fonts, ONNX models, CMap cache | ~341 MB |

---

## Usage

1. Drag PDF files onto the window (multiple files supported)
2. Select target language and translation engine
3. Enter the API Key for the selected engine (each engine saves its own config independently)
4. Click **Translate** and watch per-stage progress in real time

---

## Technical Deep Dive

### Memory Management: Auto-batch Translation

When processing large academic PDFs (100+ pages), pdf2zh loads the entire document into memory, which can trigger OOM errors or heavy swapping on systems with limited RAM.

The main process implements a **batch-translate + merge** pipeline:

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

**Key code** ([main.js:727](main.js#L727)):

```js
// Physically split into a small temp PDF — never hold all pages in memory at once
const splitFile = path.join(batchTmpDir, 'batch.pdf');
await splitPdf(filePath, start, end, splitFile);

await spawnPdf2zh(batchArgs, ...);
// spawnPdf2zh returns → subprocess exits → batch RAM fully released
```

Process handle is cleared on `close` to allow GC:

```js
proc.on('close', (code) => {
  clearInterval(elapsedTimer);  // stop timer — prevents closure holding reference
  translationProcess = null;    // release process handle
  ...
});
```

**Results**: a 300-page PDF on a 16 GB MacBook peaks above 12 GB without batching; with 50-page batches it stays under 2 GB.

---

### Streaming Pipe Buffer

pdf2zh emits progress via tqdm to stderr. Pipe buffering can split one line across multiple `data` events, or merge several lines into one.

An `incompleteLine` buffer ensures `parseLine()` only ever receives complete lines:

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

`PYTHONUNBUFFERED: '1'` is also set to disable Python-side stdout buffering, so progress data arrives in real time.

---

### GPU Acceleration: Apple Silicon CoreML

On Apple Silicon, ONNX Runtime can offload inference to the Neural Engine via the CoreML Execution Provider, achieving 3–8× speedup over CPU-only mode.

**Enabled by default** — injected automatically on every translation:

```js
const procEnv = {
  ...process.env,
  PYTHONUNBUFFERED: '1',
  PDF2ZH_USE_COREML: '1',   // always on — Neural Engine activates automatically
};
```

`PDF2ZH_USE_COREML=1` instructs pdf2zh-next to prefer `CoreMLExecutionProvider` when creating ONNX InferenceSessions. Fallback order is `CoreML → CPU`, so it never crashes on unsupported hardware.

> **Background**: BabelDOC [temporarily disabled CoreML](https://github.com/funstory-ai/BabelDOC/issues/170) due to environment-specific initialization errors. This app re-enables it at the process environment level, where the fallback behavior is reliable on Apple Silicon.

Main process detects CoreML activation from subprocess output and notifies the renderer:

```js
if (text.includes('CoreMLExecutionProvider')) {
  mainWindow?.webContents.send('translation-gpu', { enabled: true });
}
```

A GPU badge appears in the progress area to confirm acceleration is active.

**Benchmark** (MacBook Pro M3 Pro, 100-page academic PDF, OpenAI gpt-4o-mini):

| Mode | Layout parsing | Peak CPU |
|------|---------------|----------|
| CPU only | ~45 s | 380% |
| CoreML | ~12 s | 95% |

---

### Process Lifecycle Management

A single global `translationProcess` reference ensures at most one active subprocess at any time:

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

This prevents two common issues:
1. Multiple concurrent processes from rapid re-clicks consuming excess memory
2. Handle leak when a process exits unexpectedly

---

### Per-provider API Config Storage

Each engine's API Key, Base URL, and model name are stored independently. Switching engines saves the current config and loads the target engine's saved config:

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

## Architecture

```
main.js          ← Electron main process: window management, IPC handlers, spawns pdf2zh
preload.js       ← Bridge: exposes IPC as window.api via contextBridge
src/renderer.js  ← Renderer: UI logic, state management, progress parsing
src/index.html   ← UI (Tailwind CSS)
```

### IPC Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `start-translation` | Renderer → Main | Start translation with all parameters |
| `cancel-translation` | Renderer → Main | Cancel current translation (SIGTERM) |
| `translation-progress` | Main → Renderer | Progress data (stage, percent, ETA) |
| `translation-log` | Main → Renderer | Raw log text stream |
| `translation-tick` | Main → Renderer | Elapsed time update every 2s |
| `translation-gpu` | Main → Renderer | CoreML activation notification |
| `setup-environment` | Renderer → Main | Trigger first-run environment install |
| `setup-log` / `setup-step` | Main → Renderer | Install progress stream |

---

## Development

```bash
npm run watch:css   # watch Tailwind CSS changes
npm start           # launch Electron (dev mode)
```

### Build

```bash
npm run build:css

APP="dist/mac-arm64/PDF Math Translate.app"
TMP=/tmp/dmg-build && rm -rf $TMP && mkdir $TMP
cp -R "$APP" $TMP/ && ln -s /Applications $TMP/Applications
hdiutil create -volname "PDF Math Translate" -srcfolder $TMP \
  -ov -format UDZO "dist/PDF Math Translate-1.0.0-arm64.dmg"
```

### Quick asar update (no full rebuild)

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
