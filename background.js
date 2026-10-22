// Chrome allows at most 2 captureVisibleTab calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
// Canvas limits in Chrome: 32767px per side, ~268M pixels total.
const MAX_CANVAS_SIDE = 32767;
const MAX_CANVAS_AREA = 268_000_000;
// Consecutive frames overlap by this much (CSS px) so seams can be trimmed and aligned.
const FRAME_OVERLAP_PX = 64;
// Rows skipped at the top of every frame after the first. Borders/shadows of bars
// sitting on the scroller's edge would otherwise show up as a line at every seam.
const SEAM_TRIM_PX = 4;
// Strip compared to line a frame up with what is already stitched, and the largest
// correction searched (layout shifts from lazy-loaded content and the like).
const ALIGN_BAND_PX = 32;
const ALIGN_MAX_SHIFT_PX = 24;

const QUICK_CAPTURE_MENU = 'quick-capture';

importScripts('storage.js');

const busyTabs = new Set();
let lastCaptureAt = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: QUICK_CAPTURE_MENU,
    title: 'Quick capture (copy + download, no editor)',
    contexts: ['action'],
  });
});

chrome.action.onClicked.addListener((tab) => runCapture(tab, openEditor));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === QUICK_CAPTURE_MENU) runCapture(tab, copyAndDownload);
});

async function runCapture(tab, deliver) {
  if (!tab?.id || busyTabs.has(tab.id)) return;
  if (!tab.url || /^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url)) return;

  busyTabs.add(tab.id);
  setBadge(tab.id, '0%');

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await deliver(tab, await captureFullPage(tab));
    setBadge(tab.id, '');
  } catch (error) {
    console.error('Full page screenshot failed:', error);
    setBadge(tab.id, 'ERR');
  } finally {
    await runInPage(tab.id, () => window.__fullPageShot?.restore()).catch(() => {});
    busyTabs.delete(tab.id);
  }
}

async function openEditor(tab, blob) {
  const id = await saveShot({ blob, filename: buildFilename(tab.url) });
  await chrome.tabs.create({
    url: `editor.html?id=${id}`,
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}

async function copyAndDownload(tab, blob) {
  const dataUrl = await blobToDataUrl(blob);
  // Copy first, while the page still has focus (the download UI may take it).
  const copyError = await copyToClipboard(tab.id, dataUrl);
  if (copyError) console.warn('Copy to clipboard failed:', copyError);
  await chrome.downloads.download({
    url: dataUrl,
    filename: buildFilename(tab.url),
    saveAs: false,
  });
  notify(
    copyError
      ? 'Saved to Downloads, but could not copy to the clipboard (the page lost focus).'
      : 'Copied to clipboard and saved to Downloads.'
  );
}

async function captureFullPage(tab) {
  const page = await runInPage(tab.id, () => window.__fullPageShot.prepare());
  const regions = page.regions.map((region) => ({
    ...region,
    positions: scrollPositions(region.scrollHeight, region.rect.height),
  }));
  const [main, ...panels] = regions;
  const frameCount = Math.max(...regions.map((region) => region.positions.length));
  const bounds = outputBounds(main, panels);

  let output, layers;
  // Per-region alignment correction, accumulated across frames.
  const shifts = regions.map(() => 0);

  for (let index = 0; index < frameCount; index++) {
    const ys = regions.map((r) => r.positions[Math.min(index, r.positions.length - 1)]);
    const actualYs = await runInPage(
      tab.id,
      (ys, i, mainCount) => window.__fullPageShot.scrollTo(ys, i, mainCount),
      [ys, index, main.positions.length]
    );
    const bitmap = await dataUrlToBitmap(await captureVisible(tab.windowId));

    if (index === 0) {
      const pixelRatio = bitmap.width / page.viewportWidth;
      const scale = canvasScale(bounds.width * pixelRatio, bounds.height * pixelRatio);
      output = createLayer(bounds, pixelRatio, scale, page.background);
      layers = panels.map((panel) =>
        createLayer(panelBounds(panel), pixelRatio, scale, panel.background)
      );
      // Base: whatever surrounds the regions (app chrome), as seen in the first frame.
      paste(output, bitmap, { ...bounds, height: page.viewportHeight - bounds.y }, 0);
    }

    const stitch = (layer, i, slice) => {
      if (index === 0) return paste(layer, bitmap, slice, actualYs[i]);
      const trimmed = { ...slice, y: slice.y + SEAM_TRIM_PX, height: slice.height - SEAM_TRIM_PX };
      shifts[i] += findShift(layer, bitmap, trimmed, actualYs[i] + shifts[i]);
      paste(layer, bitmap, trimmed, actualYs[i] + shifts[i]);
    };

    if (index < main.positions.length) stitch(output, 0, main.rect);

    panels.forEach((panel, i) => {
      if (index >= panel.positions.length) return;
      const layer = layers[i];
      // Panel header/chrome once, then its scrolling content, then its footer at the end.
      if (index === 0) paste(layer, bitmap, panel.container, 0);
      // Full panel width so borders/padding beside the scroller continue down too.
      stitch(layer, i + 1, { ...panel.rect, x: panel.container.x, width: panel.container.width });
      if (index === panel.positions.length - 1) {
        paste(layer, bitmap, belowScroller(panel), actualYs[i + 1] + shifts[i + 1]);
      }
    });

    bitmap.close();
    setBadge(tab.id, `${Math.round(((index + 1) / frameCount) * 100)}%`);
  }

  // Panels go on top, with their background continuing down to the bottom of the image.
  panels.forEach((panel, i) => {
    const { canvas } = layers[i];
    const x = Math.round((panel.container.x - bounds.x) * output.toOut);
    const y = Math.round((panel.container.y - bounds.y) * output.toOut);
    output.ctx.fillStyle = panel.background;
    output.ctx.fillRect(x, y, canvas.width, output.canvas.height - y);
    output.ctx.drawImage(canvas, x, y);
  });

  return output.canvas.convertToBlob({ type: 'image/png' });
}

function scrollPositions(scrollHeight, viewHeight) {
  const maxScroll = Math.max(0, scrollHeight - viewHeight);
  const step = Math.max(viewHeight - FRAME_OVERLAP_PX, viewHeight / 2);
  const positions = [];
  for (let y = 0; y < maxScroll; y += step) positions.push(y);
  positions.push(maxScroll);
  return positions;
}

function belowScroller({ rect, container }) {
  const top = rect.y + rect.height;
  return {
    x: container.x,
    y: top,
    width: container.width,
    height: container.y + container.height - top,
  };
}

function panelBounds(panel) {
  const bottom = panel.rect.y + panel.scrollHeight + belowScroller(panel).height;
  return { ...panel.container, height: bottom - panel.container.y };
}

// Union of the main region (fully expanded) and every expanded panel, in viewport CSS px.
function outputBounds(main, panels) {
  const boxes = [
    { ...main.rect, height: main.scrollHeight },
    ...panels.map(panelBounds),
  ];
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

function canvasScale(width, height) {
  return Math.min(
    1,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height))
  );
}

// A canvas covering `origin` (viewport CSS px, extended downwards).
function createLayer(origin, pixelRatio, scale, background) {
  const toOut = pixelRatio * scale;
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(origin.width * toOut)),
    Math.max(1, Math.round(origin.height * toOut))
  );
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); // findShift reads it back every frame.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx, origin, pixelRatio, toOut };
}

// Copies `src` (viewport CSS px) from a frame into the layer, shifted down by offsetY.
function paste({ ctx, origin, pixelRatio, toOut }, bitmap, src, offsetY) {
  if (src.width <= 0 || src.height <= 0) return;
  ctx.drawImage(
    bitmap,
    src.x * pixelRatio,
    src.y * pixelRatio,
    src.width * pixelRatio,
    src.height * pixelRatio,
    Math.round((src.x - origin.x) * toOut),
    Math.round((src.y + offsetY - origin.y) * toOut),
    Math.round(src.width * toOut),
    Math.round(src.height * toOut)
  );
}

// Returns how far (CSS px) the frame's slice must move to line up with the rows
// already stitched from the previous, overlapping frame. Normally 0; non-zero when
// the page layout shifted between frames.
function findShift({ ctx, origin, pixelRatio, toOut }, bitmap, src, offsetY) {
  const width = Math.round(src.width * toOut);
  const band = Math.round(ALIGN_BAND_PX * toOut);
  const maxShift = Math.round(ALIGN_MAX_SHIFT_PX * toOut);
  const top = Math.round((src.y + offsetY - origin.y) * toOut) - maxShift;
  if (width < 1 || band < 1 || src.height < ALIGN_BAND_PX || top < 0) return 0;

  const probe = new OffscreenCanvas(width, band);
  const probeCtx = probe.getContext('2d');
  probeCtx.drawImage(
    bitmap,
    src.x * pixelRatio,
    src.y * pixelRatio,
    src.width * pixelRatio,
    ALIGN_BAND_PX * pixelRatio,
    0,
    0,
    width,
    band
  );
  const fresh = probeCtx.getImageData(0, 0, width, band).data;
  const left = Math.round((src.x - origin.x) * toOut);
  const stitched = ctx.getImageData(left, top, width, band + 2 * maxShift).data;

  const COLUMN_STEP = 3;
  const score = (shift) => {
    let sum = 0;
    for (let row = 0; row < band; row++) {
      const a = row * width * 4;
      const b = (row + shift + maxShift) * width * 4;
      for (let col = 0; col < width; col += COLUMN_STEP) {
        const i = col * 4;
        sum +=
          Math.abs(fresh[a + i] - stitched[b + i]) +
          Math.abs(fresh[a + i + 1] - stitched[b + i + 1]) +
          Math.abs(fresh[a + i + 2] - stitched[b + i + 2]);
      }
    }
    return sum;
  };

  const unshifted = score(0);
  const samples = band * Math.ceil(width / COLUMN_STEP);
  if (unshifted / samples < 4) return 0; // Already lines up.

  let best = 0;
  let bestScore = unshifted;
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    if (shift === 0) continue;
    const candidate = score(shift);
    if (candidate < bestScore) {
      best = shift;
      bestScore = candidate;
    }
  }
  // Only move when clearly better: flat or repetitive content matches almost anywhere.
  return bestScore < unshifted * 0.5 ? best / toOut : 0;
}

// Service workers have no clipboard access, so the image is written from the page.
// Returns an error message, or null on success.
async function copyToClipboard(tabId, dataUrl) {
  return runInPage(
    tabId,
    async (url) => {
      try {
        // Decode by hand: fetching a data: URL can be blocked by the page's CSP.
        const binary = atob(url.slice(url.indexOf(',') + 1));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/png' });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return null;
      } catch (error) {
        return String(error);
      }
    },
    [dataUrl]
  );
}

async function runInPage(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result;
}

async function captureVisible(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// Service workers have no URL.createObjectURL, so downloads need a data URL.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function buildFilename(url) {
  const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `screenshot-${host}-${stamp}.png`;
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Full Screenshot',
    message,
  });
}

function setBadge(tabId, text) {
  chrome.action.setBadgeText({ tabId, text });
}
