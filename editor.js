// Screenshot editor: blur (irreversible pixelation) and crop, then copy or download.
// All edits happen on the full-resolution canvas; CSS only scales the view.

// Blurred regions are shrunk by this factor and scaled back up, which destroys
// the underlying text (unlike a light gaussian blur, which can be reversed).
const BLUR_BLOCK_PX = 12;
const MIN_SELECTION_PX = 3;
const MAX_HISTORY = 30;
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_STEP_PX = 24;
const ZOOM_LEVELS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
const WORKSPACE_PADDING_PX = 48;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true }); // Blur reads pixels for undo.
const stage = document.getElementById('stage');
const selectionEl = document.getElementById('selection');
const ui = {
  blur: document.getElementById('tool-blur'),
  crop: document.getElementById('tool-crop'),
  applyCrop: document.getElementById('apply-crop'),
  cancelSelection: document.getElementById('cancel-selection'),
  undo: document.getElementById('undo'),
  zoom: document.getElementById('zoom'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  hint: document.getElementById('hint'),
  size: document.getElementById('size'),
  copy: document.getElementById('copy'),
  download: document.getElementById('download'),
  message: document.getElementById('message'),
  toast: document.getElementById('toast'),
};

const HINTS = {
  blur: 'Drag over the parts you want to hide',
  crop: 'Drag to select the area to keep',
};

let tool = 'blur';
let zoom = null; // null = fit to window width, otherwise 1 = 100%.
let selection = null; // In image pixels.
let dragStart = null;
let filename = 'screenshot.png';
const history = [];

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  const shot = id ? await loadShot(id) : null;
  if (!shot) {
    stage.hidden = true;
    document.querySelector('.toolbar').hidden = true;
    ui.message.hidden = false;
    ui.message.textContent = 'Screenshot not found. Take a new one from the extension icon.';
    return;
  }

  filename = shot.filename;
  document.title = `Edit – ${filename}`;
  const bitmap = await createImageBitmap(shot.blob);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  render();
}

// ---- View ----

function render() {
  const level = currentZoom();
  canvas.style.width = `${naturalWidth() * level}px`;
  const percent = `${Math.round(level * 100)}%`;
  ui.zoom.textContent = zoom === null ? `Fit ${percent}` : percent;
  ui.zoomOut.disabled = level <= ZOOM_LEVELS[0];
  ui.zoomIn.disabled = level >= ZOOM_LEVELS.at(-1);

  ui.blur.classList.toggle('active', tool === 'blur');
  ui.crop.classList.toggle('active', tool === 'crop');
  const pendingCrop = tool === 'crop' && selection && !dragStart;
  ui.applyCrop.hidden = !pendingCrop;
  ui.cancelSelection.hidden = !pendingCrop;
  ui.undo.disabled = history.length === 0;
  ui.hint.textContent = pendingCrop ? 'Adjust by dragging again, or apply' : HINTS[tool];
  ui.size.textContent = `${canvas.width} × ${canvas.height}px`;
  renderSelection();
}

function renderSelection() {
  selectionEl.hidden = !selection;
  if (!selection) return;
  const scale = canvas.getBoundingClientRect().width / canvas.width;
  Object.assign(selectionEl.style, {
    left: `${selection.x * scale}px`,
    top: `${selection.y * scale}px`,
    width: `${selection.width * scale}px`,
    height: `${selection.height * scale}px`,
  });
  selectionEl.className = `selection ${tool}`;
}

function setTool(next) {
  tool = next;
  selection = null;
  render();
}

// 100% means one CSS pixel per page pixel, matching how the page looked.
function naturalWidth() {
  return canvas.width / window.devicePixelRatio;
}

function fitZoom() {
  const available = document.documentElement.clientWidth - WORKSPACE_PADDING_PX;
  return Math.min(1, available / naturalWidth());
}

function currentZoom() {
  return zoom ?? fitZoom();
}

// Changes zoom while keeping the image point under `anchor` (client coords) in place.
function setZoom(next, anchor = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 }) {
  const before = canvas.getBoundingClientRect();
  const fx = (anchor.clientX - before.left) / before.width;
  const fy = (anchor.clientY - before.top) / before.height;
  zoom = next;
  render();
  const after = canvas.getBoundingClientRect();
  window.scrollBy(
    after.left + fx * after.width - anchor.clientX,
    after.top + fy * after.height - anchor.clientY
  );
}

function stepZoom(direction, anchor) {
  const level = currentZoom();
  const next =
    direction > 0
      ? ZOOM_LEVELS.find((z) => z > level + 0.001)
      : ZOOM_LEVELS.findLast((z) => z < level - 0.001);
  if (next) setZoom(next, anchor);
}

function toggleZoom() {
  setZoom(zoom === null ? 1 : null);
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ui.toast.classList.remove('visible'), 2000);
}

// ---- Selecting ----

function toImagePoint(event) {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  const clamp = (value, max) => Math.round(Math.min(Math.max(value, 0), max));
  return {
    x: clamp((event.clientX - rect.left) * scale, canvas.width),
    y: clamp((event.clientY - rect.top) * scale, canvas.height),
  };
}

function rectBetween(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

// Screenshots are often taller than the window; scroll while dragging near the edges.
function autoScroll(event) {
  const toolbarHeight = document.querySelector('.toolbar').offsetHeight;
  if (event.clientY > window.innerHeight - AUTO_SCROLL_EDGE_PX) {
    window.scrollBy(0, AUTO_SCROLL_STEP_PX);
  } else if (event.clientY < toolbarHeight + AUTO_SCROLL_EDGE_PX) {
    window.scrollBy(0, -AUTO_SCROLL_STEP_PX);
  }
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  dragStart = toImagePoint(event);
  selection = rectBetween(dragStart, dragStart);
  render();
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragStart) return;
  autoScroll(event);
  selection = rectBetween(dragStart, toImagePoint(event));
  renderSelection();
});

canvas.addEventListener('pointerup', () => {
  if (!dragStart) return;
  dragStart = null;
  if (!selection || selection.width < MIN_SELECTION_PX || selection.height < MIN_SELECTION_PX) {
    selection = null;
  } else if (tool === 'blur') {
    blurRegion(selection);
    selection = null;
  }
  render();
});

// ---- Edits ----

function pushHistory(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
}

function blurRegion({ x, y, width, height }) {
  pushHistory({ type: 'patch', x, y, data: ctx.getImageData(x, y, width, height) });

  const small = new OffscreenCanvas(
    Math.max(1, Math.round(width / BLUR_BLOCK_PX)),
    Math.max(1, Math.round(height / BLUR_BLOCK_PX))
  );
  const smallCtx = small.getContext('2d');
  smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(canvas, x, y, width, height, 0, 0, small.width, small.height);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, width, height);
  ctx.restore();
}

function applyCrop() {
  if (tool !== 'crop' || !selection) return;
  const { x, y, width, height } = selection;

  const previous = new OffscreenCanvas(canvas.width, canvas.height);
  previous.getContext('2d').drawImage(canvas, 0, 0);
  pushHistory({ type: 'canvas', canvas: previous });

  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(previous, x, y, width, height, 0, 0, width, height);
  selection = null;
  window.scrollTo(0, 0);
  render();
}

function undo() {
  const entry = history.pop();
  if (!entry) return;
  if (entry.type === 'patch') {
    ctx.putImageData(entry.data, entry.x, entry.y);
  } else {
    canvas.width = entry.canvas.width;
    canvas.height = entry.canvas.height;
    ctx.drawImage(entry.canvas, 0, 0);
  }
  selection = null;
  render();
}

function cancelSelection() {
  selection = null;
  render();
}

// ---- Export ----

function canvasBlob() {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function copyImage() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob() })]);
    toast('Copied to clipboard');
  } catch (error) {
    console.error('Copy failed:', error);
    toast('Could not copy to clipboard');
  }
}

async function downloadImage() {
  const url = URL.createObjectURL(await canvasBlob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Downloaded');
}

// ---- Wiring ----

ui.blur.addEventListener('click', () => setTool('blur'));
ui.crop.addEventListener('click', () => setTool('crop'));
ui.applyCrop.addEventListener('click', applyCrop);
ui.cancelSelection.addEventListener('click', cancelSelection);
ui.undo.addEventListener('click', undo);
ui.zoom.addEventListener('click', toggleZoom);
ui.zoomIn.addEventListener('click', () => stepZoom(1));
ui.zoomOut.addEventListener('click', () => stepZoom(-1));

// Ctrl/Cmd + wheel (and trackpad pinch) zooms the image instead of the page.
window.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    stepZoom(event.deltaY < 0 ? 1 : -1, event);
  },
  { passive: false }
);
ui.copy.addEventListener('click', copyImage);
ui.download.addEventListener('click', downloadImage);

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && key === 'z') undo();
  else if (mod && key === 'c') copyImage();
  else if (mod && key === 's') downloadImage();
  else if (mod) return;
  else if (key === 'b') setTool('blur');
  else if (key === 'c') setTool('crop');
  else if (key === 'z') toggleZoom();
  else if (key === '+' || key === '=') stepZoom(1);
  else if (key === '-') stepZoom(-1);
  else if (key === '0') setZoom(null);
  else if (key === 'enter') applyCrop();
  else if (key === 'escape') cancelSelection();
  else return;
  event.preventDefault();
});

window.addEventListener('resize', render);

init().catch((error) => {
  console.error(error);
  ui.message.hidden = false;
  ui.message.textContent = `Could not open the screenshot: ${error.message}`;
});
