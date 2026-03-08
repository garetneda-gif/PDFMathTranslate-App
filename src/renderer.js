// ==================== DOM Elements ====================
const $ = (sel) => document.querySelector(sel);
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const fileList = $('#file-list');
const fileEmpty = $('#file-empty');
const btnAddFiles = $('#btn-add-files');
const btnTranslate = $('#btn-translate');
const btnCancel = $('#btn-cancel');
const btnClearLog = $('#btn-clear-log');
const btnCopyLog = $('#btn-copy-log');
const btnAdvanced = $('#btn-advanced');
const btnOutputDir = $('#btn-output-dir');
const advancedArrow = $('#advanced-arrow');
const advancedOptions = $('#advanced-options');
const apiConfig = $('#api-config');
const serviceSelect = $('#service');
let previousService = serviceSelect?.value || '';
const logContent = $('#log-content');
const logContainer = $('#log-container');
const progressSection = $('#progress-section');
const progressBar = $('#progress-bar');
const progressLabel = $('#progress-label');
const progressPercent = $('#progress-percent');
const stageBadge = $('#stage-badge');
const gpuBadge = $('#gpu-badge');
const stageIconEl = $('#stage-icon');
const stageDescEl = $('#stage-desc');
const pageCounter = $('#page-counter');
const elapsedTimeEl = $('#elapsed-time');
const etaTimeEl = $('#eta-time');
const etaAbsoluteEl = $('#eta-absolute');
const dragOverlay = $('#drag-overlay');

// ==================== State ====================
let selectedFiles = [];
let isTranslating = false;
let translationStartTime = null;
let elapsedTimerUI = null;
let pendingEnvStatus = null;

// Services that need API keys
const apiServices = new Set([
  'openai', 'openaicompatible', 'deepl', 'gemini', 'azureopenai',
  'deepseek', 'zhipu', 'siliconflow', 'groq', 'grok',
]);

// ==================== Settings Persistence ====================
const SETTINGS_KEY = 'pmt_settings';
const API_CONFIGS_KEY = 'pmt_api_configs';

const settingFields = [
  { id: 'source-lang', type: 'select' },
  { id: 'target-lang', type: 'select' },
  { id: 'output-format', type: 'select' },
  { id: 'service', type: 'select' },
  { id: 'output-dir', type: 'input' },
  { id: 'pages', type: 'input' },
  { id: 'threads', type: 'input' },
  { id: 'custom-prompt', type: 'textarea' },
  { id: 'compat-mode', type: 'checkbox' },
  { id: 'no-cache', type: 'checkbox' },
  { id: 'auto-batch', type: 'checkbox' },
  { id: 'batch-size', type: 'input' },
];

// 保存当前 service 的 API 配置
function saveApiConfig(service) {
  if (!service) return;
  const configs = JSON.parse(localStorage.getItem(API_CONFIGS_KEY) || '{}');
  configs[service] = {
    'api-key': $('#api-key')?.value || '',
    'api-url': $('#api-url')?.value || '',
    'model-name': $('#model-name')?.value || '',
  };
  localStorage.setItem(API_CONFIGS_KEY, JSON.stringify(configs));
}

// 加载指定 service 的 API 配置到表单
function loadApiConfig(service) {
  const configs = JSON.parse(localStorage.getItem(API_CONFIGS_KEY) || '{}');
  const c = configs[service] || {};
  const apiKey = $('#api-key');
  const apiUrl = $('#api-url');
  const modelName = $('#model-name');
  if (apiKey) apiKey.value = c['api-key'] || '';
  if (apiUrl) apiUrl.value = c['api-url'] || '';
  if (modelName) modelName.value = c['model-name'] || '';
}

function saveSettings() {
  const data = {};
  for (const { id, type } of settingFields) {
    const el = $(`#${id}`);
    if (!el) continue;
    data[id] = type === 'checkbox' ? el.checked : el.value;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  saveApiConfig(serviceSelect.value);
}

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    for (const { id, type } of settingFields) {
      const el = $(`#${id}`);
      if (!el || data[id] === undefined) continue;
      if (type === 'checkbox') {
        el.checked = data[id];
      } else {
        el.value = data[id];
      }
    }
    // 恢复 service 后加载对应 API 配置
    previousService = serviceSelect.value;
    loadApiConfig(serviceSelect.value);
    apiConfig.classList.toggle('hidden', !apiServices.has(serviceSelect.value));
    // 恢复自动分批：同步批次大小行的显示状态
    $('#batch-size-row')?.classList.toggle('hidden', !$('#auto-batch')?.checked);
  } catch {}
}

// ==================== Setup Panel ====================
const setupOverlay = $('#setup-overlay');
const btnSetupInstall = $('#btn-setup-install');
const setupLogWrap = $('#setup-log-wrap');
const setupLogContent = $('#setup-log-content');
const setupErrorEl = $('#setup-error');

const STEP_STYLES = {
  pending: { bg: 'rgba(100,116,139,0.12)', color: 'rgba(100,116,139,0.6)', border: 'rgba(100,116,139,0.2)' },
  active:  { bg: 'rgba(108,92,231,0.2)',  color: 'rgba(162,155,254,1)',   border: 'rgba(108,92,231,0.5)' },
  done:    { bg: 'rgba(52,211,153,0.15)', color: 'rgba(52,211,153,1)',    border: 'rgba(52,211,153,0.4)' },
  error:   { bg: 'rgba(248,113,113,0.15)',color: 'rgba(248,113,113,1)',   border: 'rgba(248,113,113,0.4)' },
};
const STEP_CONTENT = { pending: null, active: null, done: '✓', error: '✗' };

function setSetupStep(stepIndex, state, label) {
  const icon = $(`#setup-step-icon-${stepIndex}`);
  const lbl = $(`#setup-step-label-${stepIndex}`);
  const s = STEP_STYLES[state] || STEP_STYLES.pending;
  if (icon) {
    icon.style.background = s.bg;
    icon.style.color = s.color;
    icon.style.borderColor = s.border;
    const content = STEP_CONTENT[state];
    if (content) icon.textContent = content;
  }
  if (lbl && label) lbl.textContent = label;
}

function appendSetupLog(text) {
  setupLogContent.textContent += text;
  $('#setup-log-container').scrollTop = $('#setup-log-container').scrollHeight;
}

async function showSetupPanel(envStatus = null) {
  pendingEnvStatus = envStatus;
  setupOverlay.style.display = 'block';
  setupLogContent.textContent = '';
  if (envStatus?.venvExists && envStatus?.summary) {
    setupErrorEl.textContent = `检测到现有 pdf2zh 运行环境异常：${envStatus.summary}。将自动重建 ~/.pdf2zh-venv。`;
    setupErrorEl.style.display = 'block';
  } else {
    setupErrorEl.style.display = 'none';
  }
  btnSetupInstall.style.display = 'none';
  setTimeout(runSetup, 400);
}

async function runSetup() {
  window.api.removeAllListeners('setup-log');
  window.api.removeAllListeners('setup-step');

  btnSetupInstall.disabled = true;
  btnSetupInstall.style.opacity = '0.6';
  btnSetupInstall.textContent = '安装中，请勿关闭应用...';

  setupLogWrap.style.display = 'block';
  if (!pendingEnvStatus?.venvExists) setupErrorEl.style.display = 'none';

  setSetupStep(0, 'active', pendingEnvStatus?.venvExists ? '修复中...' : '检测中...');

  // Listen to streaming events
  window.api.onSetupLog((text) => appendSetupLog(text));
  window.api.onSetupStep((step) => {
    // step: 1=venv created, 2=pip upgraded, 3=pdf2zh installed
    if (step === 1) {
      setSetupStep(0, 'done', '');
      setSetupStep(1, 'active', '进行中...');
    } else if (step === 2) {
      setSetupStep(1, 'done', '');
      setSetupStep(2, 'active', '下载中...');
    } else if (step === 3) {
      setSetupStep(2, 'active', '安装中...');
    }
  });

  const result = await window.api.setupEnvironment();

  if (result.success) {
    setSetupStep(0, 'done', '');
    setSetupStep(1, 'done', '');
    setSetupStep(2, 'done', '');
    // Hide overlay and continue normal init
    setTimeout(() => {
      setupOverlay.style.display = 'none';
      initAfterEnvReady();
    }, 1200);
  } else {
    setSetupStep(0, 'error', '');
    if (result.error === 'no-python') {
      setSetupStep(0, 'error', '未找到');
      setupErrorEl.textContent = '未找到 Python 3.10+。请先安装：brew install python@3.12';
    } else {
      setupErrorEl.textContent = `安装失败: ${result.error || '未知错误'}。请查看日志，解决问题后重试。`;
    }
    setupErrorEl.style.display = 'block';
    btnSetupInstall.style.display = 'flex';
    btnSetupInstall.disabled = false;
    btnSetupInstall.style.opacity = '1';
    btnSetupInstall.innerHTML = '<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> 重试';
  }
}

btnSetupInstall?.addEventListener('click', runSetup);

// ==================== Init ====================
async function init() {
  loadSettings();

  // Check if pdf2zh environment is ready; if not, show setup panel
  const envStatus = await window.api.checkEnvironment();
  if (!envStatus.ready) {
    await showSetupPanel(envStatus);
    return;
  }

  initAfterEnvReady();
}

async function initAfterEnvReady() {
  const result = await window.api.checkPdf2zh();
  if (result.installed) {
    setStatus('ready', `pdf2zh v${result.version || '?'}`);
    // Check for updates in background
    checkForUpdate(result.version);
  } else if (result.reason) {
    setStatus('error', 'pdf2zh 环境异常');
    appendLog(`⚠ pdf2zh 运行环境异常：${result.summary || result.reason}\n`);
    await showSetupPanel({ ready: false, venvExists: true, reason: result.reason, summary: result.summary });
  } else {
    setStatus('error', 'pdf2zh 未安装');
    appendLog('⚠ pdf2zh 未检测到\n请先安装：pip install pdf2zh-next\n');
  }
}

// ==================== Auto-update ====================
async function checkForUpdate(currentVersion) {
  try {
    const info = await window.api.checkPdf2zhUpdate();
    if (info.hasUpdate) {
      setStatus('ready', `pdf2zh v${currentVersion} \u2192 v${info.latest} \u53EF\u66F4\u65B0`);
      showUpdateBanner(info.latest);
    }
  } catch {}
}

function showUpdateBanner(latestVersion) {
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'animate-fade-in flex items-center justify-between gap-3 px-4 py-2 mx-5 mb-2 rounded-xl text-xs border';
  banner.style.cssText = 'background: linear-gradient(135deg, rgba(108,92,231,0.08), rgba(0,206,201,0.05)); border-color: rgba(108,92,231,0.2);';
  banner.innerHTML = `
    <span class="text-surface-300">\u{1F4E6} pdf2zh-next <strong class="text-accent-light">v${latestVersion}</strong> \u53EF\u7528</span>
    <div class="flex items-center gap-2 no-drag">
      <button id="btn-update" class="px-3 py-1 rounded-lg text-xs font-medium text-white transition-all duration-200" style="background: linear-gradient(135deg, #6c5ce7, #a29bfe);">\u7ACB\u5373\u66F4\u65B0</button>
      <button id="btn-dismiss-update" class="text-surface-500 hover:text-surface-300 transition-colors">\u2715</button>
    </div>
  `;

  const mainContent = document.querySelector('.relative.z-10.px-5');
  mainContent.parentNode.insertBefore(banner, mainContent);

  document.getElementById('btn-dismiss-update').addEventListener('click', () => {
    banner.remove();
  });

  document.getElementById('btn-update').addEventListener('click', async () => {
    const btn = document.getElementById('btn-update');
    btn.textContent = '\u66F4\u65B0\u4E2D...';
    btn.disabled = true;
    btn.style.opacity = '0.6';
    appendLog('\n\u{1F504} \u6B63\u5728\u66F4\u65B0 pdf2zh-next...\n');
    try {
      const result = await window.api.updatePdf2zh();
      if (result.success) {
        appendLog(`\u2705 \u66F4\u65B0\u5B8C\u6210${result.newVersion ? ' (v' + result.newVersion + ')' : ''}\n`);
        setStatus('ready', `pdf2zh v${result.newVersion || latestVersion}`);
        banner.remove();
      } else {
        appendLog(`\u274C \u66F4\u65B0\u5931\u8D25: ${result.error || '\u672A\u77E5\u9519\u8BEF'}\n`);
        btn.textContent = '\u91CD\u8BD5';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    } catch (err) {
      appendLog(`\u274C \u66F4\u65B0\u5931\u8D25: ${err.message}\n`);
      btn.textContent = '\u91CD\u8BD5';
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  });
}

function setStatus(state, text) {
  statusText.textContent = text;
  const styles = {
    ready: 'bg-emerald-400 ring-emerald-400/20',
    error: 'bg-red-400 ring-red-400/20',
    busy: 'bg-amber-400 ring-amber-400/20 animate-pulse',
    idle: 'bg-surface-600 ring-surface-600/20',
  };
  statusDot.className = 'w-2 h-2 rounded-full ring-2 ' + (styles[state] || styles.idle);
}

// ==================== File Management ====================
function updateFileList() {
  if (selectedFiles.length === 0) {
    fileEmpty.classList.remove('hidden');
    btnTranslate.disabled = true;
    return;
  }
  fileEmpty.classList.add('hidden');
  btnTranslate.disabled = isTranslating;

  // Remove existing file items
  fileList.querySelectorAll('.file-item').forEach((el) => el.remove());

  selectedFiles.forEach((filePath, index) => {
    const name = filePath.split('/').pop();
    const item = document.createElement('div');
    item.className = 'file-item animate-slide-up';
    item.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style="background: linear-gradient(135deg, rgba(239,68,68,0.12), rgba(239,68,68,0.05))">
          <svg class="w-3.5 h-3.5 text-red-400/80" fill="currentColor" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>
        </div>
        <span class="text-xs text-surface-200 truncate">${name}</span>
      </div>
      <button class="remove-file text-surface-600 hover:text-red-400 transition-all duration-200 shrink-0 p-1 rounded-lg hover:bg-red-400/10" data-index="${index}">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    `;
    fileList.appendChild(item);
  });
}

// ==================== Logging ====================
function appendLog(text) {
  logContent.textContent += text;
  logContainer.scrollTop = logContainer.scrollHeight;
}

function clearLog() {
  logContent.textContent = '';
}

// ==================== Helpers ====================
function formatSeconds(s) {
  if (s == null || s < 0) return '--';
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return sec > 0 ? `${m} 分 ${sec} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min > 0 ? `${h} 小时 ${min} 分` : `${h} 小时`;
}

function formatAbsoluteTime(etaSeconds) {
  const d = new Date(Date.now() + etaSeconds * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

// Stage order for step numbering
const STAGE_ORDER = [
  'counting-pages', 'splitting',
  'Parse PDF and Create IR', 'DetectScannedFile',
  'Parse Page Layout', 'Parse Table', 'Parse Paragraphs',
  'Parse Formulas and Styles', 'Extract Terms',
  'Translate Paragraphs',
  'Typesetting', 'Add Fonts', 'Generate drawing instructions',
  'Subset font', 'Save PDF',
  'merging',
];

const STAGE_LABELS = {
  'counting-pages': '\u68C0\u6D4B\u9875\u6570',
  'splitting': '\u5207\u5272\u6279\u6B21',
  'merging': '\u5408\u5E76\u8F93\u51FA',
  'Parse PDF and Create IR': '\u89E3\u6790 PDF',
  'DetectScannedFile': '\u626B\u63CF\u68C0\u6D4B',
  'Parse Page Layout': '\u7248\u9762\u5206\u6790',
  'Parse Table': '\u8868\u683C\u89E3\u6790',
  'Parse Paragraphs': '\u6BB5\u843D\u89E3\u6790',
  'Parse Formulas and Styles': '\u516C\u5F0F\u89E3\u6790',
  'Extract Terms': '\u672F\u8BED\u63D0\u53D6',
  'Translate Paragraphs': '\u7FFB\u8BD1\u6BB5\u843D',
  'Typesetting': '\u8BD1\u6587\u6392\u7248',
  'Add Fonts': '\u5B57\u4F53\u5904\u7406',
  'Generate drawing instructions': '\u751F\u6210\u6307\u4EE4',
  'Subset font': '\u5B57\u4F53\u5B50\u96C6\u5316',
  'Save PDF': '\u4FDD\u5B58 PDF',
};

const STAGE_ICONS = {
  'counting-pages': '\uD83D\uDCCA',
  'splitting': '\u2702\uFE0F',
  'merging': '\uD83D\uDD17',
  'Parse PDF and Create IR': '\uD83D\uDCC4',
  'DetectScannedFile': '\uD83D\uDD0D',
  'Parse Page Layout': '\uD83D\uDCCF',
  'Parse Table': '\uD83D\uDCCA',
  'Parse Paragraphs': '\uD83D\uDCDD',
  'Parse Formulas and Styles': '\u03A3',
  'Extract Terms': '\uD83D\uDD24',
  'Translate Paragraphs': '\uD83C\uDF10',
  'Typesetting': '\u270F\uFE0F',
  'Add Fonts': '\uD83D\uDD20',
  'Generate drawing instructions': '\uD83C\uDFA8',
  'Subset font': '\uD83D\uDD21',
  'Save PDF': '\uD83D\uDCBE',
};

const STAGE_DESCS = {
  'counting-pages': '\u8BFB\u53D6 PDF \u6587\u4EF6\u4FE1\u606F\uFF0C\u7EDF\u8BA1\u603B\u9875\u6570\u4EE5\u786E\u5B9A\u5206\u6279\u7B56\u7565',
  'splitting': '\u5C06\u5927\u6587\u4EF6\u6309\u6279\u6B21\u5927\u5C0F\u5207\u5272\u4E3A\u591A\u4E2A\u5C0F PDF\uFF0C\u964D\u4F4E\u5185\u5B58\u5360\u7528',
  'merging': '\u5C06\u5404\u6279\u6B21\u7FFB\u8BD1\u7ED3\u679C\u5408\u5E76\u4E3A\u5B8C\u6574\u7684\u8F93\u51FA\u6587\u4EF6',
  'Parse PDF and Create IR': '\u8BFB\u53D6 PDF \u5185\u90E8\u7ED3\u6784\uFF0C\u63D0\u53D6\u6587\u5B57\u3001\u56FE\u7247\u3001\u5411\u91CF\u7B49\u5143\u7D20\uFF0C\u6784\u5EFA\u4E2D\u95F4\u8868\u793A',
  'DetectScannedFile': '\u68C0\u6D4B\u662F\u5426\u4E3A\u626B\u63CF\u4EF6\uFF08\u56FE\u7247 PDF\uFF09\uFF0C\u626B\u63CF\u4EF6\u9700\u8981 OCR \u9884\u5904\u7406',
  'Parse Page Layout': '\u4F7F\u7528 AI \u6A21\u578B\u8BC6\u522B\u9875\u9762\u7248\u9762\u5E03\u5C40\uFF1A\u6B63\u6587\u3001\u6807\u9898\u3001\u56FE\u8868\u3001\u9875\u7709\u9875\u811A\u7B49\u533A\u57DF',
  'Parse Table': '\u8BC6\u522B\u5E76\u63D0\u53D6\u8868\u683C\u7ED3\u6784\uFF0C\u4FDD\u7559\u8868\u683C\u5185\u5BB9\u7684\u884C\u5217\u5173\u7CFB',
  'Parse Paragraphs': '\u5C06\u7248\u9762\u5143\u7D20\u7EC4\u7EC7\u4E3A\u8BED\u4E49\u6BB5\u843D\uFF0C\u5904\u7406\u8DE8\u9875\u3001\u8DE8\u680F\u7684\u8FDE\u7EED\u6587\u672C',
  'Parse Formulas and Styles': '\u8BC6\u522B\u6570\u5B66\u516C\u5F0F\uFF08LaTeX\uFF09\u53CA\u6587\u672C\u6837\u5F0F\uFF08\u52A0\u7C97\u3001\u659C\u4F53\u3001\u4E0A\u4E0B\u6807\u7B49\uFF09',
  'Extract Terms': '\u81EA\u52A8\u63D0\u53D6\u4E13\u4E1A\u672F\u8BED\u548C\u9AD8\u9891\u8BCD\u6C47\uFF0C\u786E\u4FDD\u7FFB\u8BD1\u4E00\u81F4\u6027',
  'Translate Paragraphs': '\u8C03\u7528\u7FFB\u8BD1\u5F15\u64CE\u9010\u6BB5\u7FFB\u8BD1\uFF0C\u8FD9\u662F\u6700\u8017\u65F6\u7684\u6B65\u9AA4\uFF0C\u8BF7\u8010\u5FC3\u7B49\u5F85',
  'Typesetting': '\u5C06\u8BD1\u6587\u6392\u5165\u539F\u59CB\u7248\u9762\uFF0C\u8C03\u6574\u5B57\u53F7\u3001\u884C\u8DDD\u3001\u5BF9\u9F50\u4EE5\u5339\u914D\u539F\u6587\u6392\u7248',
  'Add Fonts': '\u5D4C\u5165\u8BD1\u6587\u6240\u9700\u7684\u5B57\u4F53\u6587\u4EF6\uFF0C\u786E\u4FDD\u5728\u4EFB\u4F55\u8BBE\u5907\u4E0A\u6B63\u786E\u663E\u793A',
  'Generate drawing instructions': '\u751F\u6210 PDF \u7ED8\u5236\u6307\u4EE4\uFF0C\u5C06\u8BD1\u6587\u548C\u539F\u6587\u5143\u7D20\u5408\u6210\u4E3A\u6700\u7EC8\u9875\u9762',
  'Subset font': '\u7CBE\u7B80\u5B57\u4F53\u6587\u4EF6\uFF0C\u4EC5\u4FDD\u7559\u5B9E\u9645\u4F7F\u7528\u7684\u5B57\u7B26\uFF0C\u51CF\u5C0F\u8F93\u51FA\u6587\u4EF6\u4F53\u79EF',
  'Save PDF': '\u5199\u5165\u6700\u7EC8 PDF \u6587\u4EF6\u5E76\u4FDD\u5B58\u5230\u8F93\u51FA\u76EE\u5F55',
};

function setStageUI(stageName) {
  if (!stageName) return;
  const label = STAGE_LABELS[stageName] || stageName;
  const icon = STAGE_ICONS[stageName] || '\u2699\uFE0F';
  const desc = STAGE_DESCS[stageName] || '';
  // Show step number (e.g. "3/15 · 版面分析")
  const stepIdx = STAGE_ORDER.indexOf(stageName);
  const stepLabel = stepIdx >= 0
    ? `${stepIdx + 1}/${STAGE_ORDER.length} \u00B7 ${label}`
    : label;
  stageBadge.textContent = stepLabel;
  stageIconEl.textContent = icon;
  if (stageDescEl) stageDescEl.textContent = desc;
}

function setProgressIndeterminate(on) {
  if (on) {
    progressBar.classList.add('progress-indeterminate');
  } else {
    progressBar.classList.remove('progress-indeterminate');
  }
}

// ==================== Elapsed timer (local, 1s) ====================
function startElapsedTimer() {
  translationStartTime = Date.now();
  elapsedTimerUI = setInterval(() => {
    if (!translationStartTime) return;
    const elapsed = Math.round((Date.now() - translationStartTime) / 1000);
    elapsedTimeEl.textContent = `已用 ${formatSeconds(elapsed)}`;
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimerUI) {
    clearInterval(elapsedTimerUI);
    elapsedTimerUI = null;
  }
  translationStartTime = null;
}

// ==================== Translation ====================
async function startTranslation() {
  if (selectedFiles.length === 0 || isTranslating) return;

  isTranslating = true;
  btnTranslate.disabled = true;
  btnCancel.classList.remove('hidden');
  progressSection.classList.remove('hidden');

  // Reset progress UI to initial state
  progressBar.style.width = '0%';
  progressPercent.textContent = '--';
  progressLabel.textContent = '';
  stageBadge.textContent = '初始化中';
  stageIconEl.textContent = '\u2699\uFE0F';
  if (stageDescEl) stageDescEl.textContent = '正在启动翻译进程...';
  pageCounter.classList.add('hidden');
  gpuBadge?.classList.add('hidden');
  elapsedTimeEl.textContent = '--';
  etaTimeEl.classList.add('hidden');
  if (etaAbsoluteEl) etaAbsoluteEl.classList.add('hidden');
  setProgressIndeterminate(true);

  setStatus('busy', '翻译中...');
  clearLog();
  startElapsedTimer();

  const options = {
    files: selectedFiles,
    sourceLang: $('#source-lang').value,
    targetLang: $('#target-lang').value,
    outputFormat: $('#output-format').value,
    service: serviceSelect.value,
    apiKey: $('#api-key').value,
    apiUrl: $('#api-url').value,
    modelName: $('#model-name').value,
    outputDir: $('#output-dir').value,
    pages: $('#pages').value,
    threads: parseInt($('#threads').value) || 4,
    compatMode: $('#compat-mode').checked,
    customPrompt: $('#custom-prompt').value,
    noCache: $('#no-cache').checked,
    autoBatch: $('#auto-batch').checked,
    batchSize: parseInt($('#batch-size').value) || 50,
  };

  try {
    const result = await window.api.startTranslation(options);
    setStatus('ready', `翻译完成 — ${result.completedFiles} 个文件`);
    setProgressIndeterminate(false);
    progressBar.style.width = '100%';
    progressPercent.textContent = '100%';
    progressLabel.textContent = '翻译完成';
    stageBadge.textContent = '完成';
    stageIconEl.textContent = '\u2705';
    if (stageDescEl) stageDescEl.textContent = '所有文件翻译完成';
    etaTimeEl.classList.add('hidden');
    if (etaAbsoluteEl) etaAbsoluteEl.classList.add('hidden');
    appendLog('\n✅ 全部翻译完成！\n');
  } catch (err) {
    if (err.message === 'CANCELLED') {
      setStatus('ready', '已取消');
      progressSection.classList.add('hidden');
    } else {
      setStatus('error', '翻译失败');
      appendLog(`\n❌ 错误: ${err.message}\n`);
      if (err.message.includes('pdf2zh 运行环境异常')) {
        const envStatus = await window.api.checkEnvironment();
        if (!envStatus.ready) await showSetupPanel(envStatus);
      }
    }
    setProgressIndeterminate(false);
  } finally {
    stopElapsedTimer();
    isTranslating = false;
    btnTranslate.disabled = selectedFiles.length === 0;
    btnCancel.classList.add('hidden');
  }
}

async function cancelTranslation() {
  await window.api.cancelTranslation();
  stopElapsedTimer();
  isTranslating = false;
  btnTranslate.disabled = selectedFiles.length === 0;
  btnCancel.classList.add('hidden');
  progressSection.classList.add('hidden');
  setStatus('ready', '已取消');
  appendLog('\n⚠ 翻译已取消\n');
}

// ==================== Event Listeners ====================
btnAddFiles.addEventListener('click', async () => {
  const paths = await window.api.selectFiles();
  if (paths.length > 0) {
    const newPaths = paths.filter((p) => !selectedFiles.includes(p));
    selectedFiles.push(...newPaths);
    updateFileList();
  }
});

fileList.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove-file');
  if (btn) {
    const index = parseInt(btn.dataset.index);
    selectedFiles.splice(index, 1);
    updateFileList();
  }
});

btnTranslate.addEventListener('click', startTranslation);
btnCancel.addEventListener('click', cancelTranslation);
btnClearLog.addEventListener('click', clearLog);
btnCopyLog.addEventListener('click', () => {
  const text = logContent.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btnCopyLog.textContent;
    btnCopyLog.textContent = '已复制';
    setTimeout(() => { btnCopyLog.textContent = orig; }, 1500);
  });
});

btnAdvanced.addEventListener('click', () => {
  const hidden = advancedOptions.classList.toggle('hidden');
  advancedArrow.style.transform = hidden ? '' : 'rotate(90deg)';
});

btnOutputDir.addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) $('#output-dir').value = dir;
});

serviceSelect.addEventListener('change', () => {
  // 先保存上一个 service 的 API 配置，再加载新的
  saveApiConfig(previousService);
  previousService = serviceSelect.value;
  loadApiConfig(serviceSelect.value);
  const needsApi = apiServices.has(serviceSelect.value);
  apiConfig.classList.toggle('hidden', !needsApi);
  saveSettings();
});

$('#auto-batch').addEventListener('change', () => {
  $('#batch-size-row').classList.toggle('hidden', !$('#auto-batch').checked);
  saveSettings();
});

// 所有通用配置项变更时自动保存
for (const { id } of settingFields) {
  const el = $(`#${id}`);
  if (el) el.addEventListener('change', saveSettings);
}

// API 配置字段变更时单独保存（按 service 分开存）
for (const id of ['api-key', 'api-url', 'model-name']) {
  const el = $(`#${id}`);
  if (el) el.addEventListener('input', () => saveApiConfig(serviceSelect.value));
}

// Drag and drop with overlay
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragOverlay) {
    dragOverlay.classList.remove('hidden');
    dragOverlay.classList.add('flex');
  }
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    if (dragOverlay) {
      dragOverlay.classList.add('hidden');
      dragOverlay.classList.remove('flex');
    }
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter = 0;
  if (dragOverlay) {
    dragOverlay.classList.add('hidden');
    dragOverlay.classList.remove('flex');
  }
  const files = Array.from(e.dataTransfer.files)
    .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    .map((f) => window.api.getPathForFile(f))
    .filter(Boolean);
  if (files.length > 0) {
    const newPaths = files.filter((p) => !selectedFiles.includes(p));
    selectedFiles.push(...newPaths);
    updateFileList();
  }
});

// ==================== IPC listeners ====================
window.api.onTranslationLog((data) => appendLog(data));

window.api.onTranslationGpu(({ enabled }) => {
  if (enabled && gpuBadge) {
    gpuBadge.classList.remove('hidden');
    gpuBadge.classList.add('flex');
  }
});

window.api.onTranslationTick(({ elapsedSeconds, stageName }) => {
  if (!isTranslating) return;
  // 本地计时器已在 1s 间隔更新 elapsed，这里仅补充阶段名
  if (stageName) setStageUI(stageName);
});

window.api.onTranslationProgress(({ progress, currentFile, completedFiles, totalFiles, stageName, stageCur, stageTotal, etaSeconds, elapsedSeconds, batchIndex, batchTotal, batchStart, batchEnd, totalPageCount }) => {
  // Progress bar
  const pct = Math.round(progress);
  if (pct > 0) {
    setProgressIndeterminate(false);
    progressBar.style.width = `${pct}%`;
    progressPercent.textContent = `${pct}%`;
  } else {
    setProgressIndeterminate(true);
    progressPercent.textContent = '--';
  }

  // File label — show batch context when applicable
  if (currentFile) {
    let label = totalFiles > 1
      ? `${currentFile}（第 ${completedFiles + 1} / ${totalFiles} 个文件）`
      : currentFile;
    if (batchTotal > 1) {
      label += `　·　第 ${batchIndex + 1}/${batchTotal} 批（第 ${batchStart}~${batchEnd} 页 / 共 ${totalPageCount} 页）`;
    }
    progressLabel.textContent = label;
  }

  // Stage
  if (stageName) setStageUI(stageName);

  // Page counter
  if (stageCur != null && stageTotal != null && stageTotal > 0) {
    pageCounter.textContent = `${stageCur} / ${stageTotal}`;
    pageCounter.classList.remove('hidden');
  }

  // ETA：显示剩余时间 + 预计完成的绝对时钟时间
  if (etaSeconds != null && etaSeconds > 0) {
    etaTimeEl.textContent = `剩余约 ${formatSeconds(etaSeconds)}`;
    etaTimeEl.classList.remove('hidden');
    if (etaAbsoluteEl) {
      etaAbsoluteEl.textContent = `预计 ${formatAbsoluteTime(etaSeconds)} 完成`;
      etaAbsoluteEl.classList.remove('hidden');
    }
  } else if (etaSeconds === 0) {
    etaTimeEl.classList.add('hidden');
    if (etaAbsoluteEl) etaAbsoluteEl.classList.add('hidden');
  }
});

// ==================== Start ====================
init();
