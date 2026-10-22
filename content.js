// Injected into the page. Exposes helpers the background worker drives step by step:
// prepare() -> scrollTo(ys, index, mainCount) for each frame -> restore().
//
// A capture has one main region (the page or a big inner box) plus optional panel
// regions: other tall scrollers such as side drawers. Every region is scrolled in
// lockstep and stitched into its own column of the final image.
(() => {
  if (window.__fullPageShot) return;

  // Fixed elements taller than this fraction of the capture area are treated as
  // backgrounds/side panels and left visible in every frame.
  const MAX_OVERLAY_RATIO = 0.7;
  // Inner scrollers must cover at least this fraction of the viewport to be the main region.
  const MIN_SCROLLER_AREA_RATIO = 0.2;
  // Panel scrollers must be at least this tall / big relative to the viewport.
  const MIN_PANEL_HEIGHT_RATIO = 0.4;
  const MIN_PANEL_AREA_RATIO = 0.05;
  const SETTLE_MS = 120;

  let state = null;

  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function rootScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function saveProp(el, prop) {
    return [el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
  }

  function restoreProp([el, prop, value, priority]) {
    if (value) el.style.setProperty(prop, value, priority);
    else el.style.removeProperty(prop);
  }

  function visibleArea(rect) {
    const width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return Math.max(0, width) * Math.max(0, height);
  }

  function toRect(r) {
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function isTransparent(color) {
    return !color || color === 'transparent' || /rgba\(.*,\s*0\)$/.test(color);
  }

  function backgroundOf(el) {
    for (let node = el; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (!isTransparent(color)) return color;
    }
    return '#ffffff';
  }

  // All visible inner scrollers, biggest first.
  function findScrollers() {
    const scrollers = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const rect = el.getBoundingClientRect();
      const area = visibleArea(rect);
      if (area > 0) scrollers.push({ el, rect, area });
    }
    return scrollers.sort((a, b) => b.area - a.area);
  }

  function pickMain(scrollers) {
    const root = rootScroller();
    const viewportArea = window.innerWidth * window.innerHeight;
    const best = scrollers[0]?.area >= viewportArea * MIN_SCROLLER_AREA_RATIO ? scrollers[0] : null;
    const rootOverflow = root.scrollHeight - window.innerHeight;
    // A normally scrolling page wins unless an inner box dominates the viewport.
    if (rootOverflow > window.innerHeight * 0.25 && (!best || best.area < viewportArea * 0.5)) {
      return root;
    }
    return best ? best.el : root;
  }

  function hasFixedAncestor(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return true;
    }
    return false;
  }

  // The visual panel around a scroller (e.g. drawer with its header), without
  // climbing into full-screen wrappers or anything containing the main region.
  function panelContainer(el, main) {
    const maxWidth = el.getBoundingClientRect().width * 1.2 + 40;
    let container = el;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.contains(main) || node.getBoundingClientRect().width > maxWidth) break;
      container = node;
      if (getComputedStyle(node).position === 'fixed') break;
    }
    return container;
  }

  function pickPanels(scrollers, main, isRoot) {
    const minHeight = window.innerHeight * MIN_PANEL_HEIGHT_RATIO;
    const minArea = window.innerWidth * window.innerHeight * MIN_PANEL_AREA_RATIO;
    const panels = [];
    for (const { el, rect, area } of scrollers) {
      if (el === main || rect.height < minHeight || area < minArea) continue;
      // With a scrolling page, only scrollers pinned to the viewport are panels;
      // anything else (code blocks, tables) is part of the page content.
      if (isRoot ? !hasFixedAncestor(el) : el.contains(main) || main.contains(el)) continue;
      const container = panelContainer(el, main);
      const clashes = panels.some(
        (panel) => panel.container.contains(el) || container.contains(panel.container)
      );
      if (!clashes) panels.push({ el, container });
    }
    return panels;
  }

  function clientRect(el, isRoot) {
    if (isRoot) {
      return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    }
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + el.clientLeft,
      y: rect.top + el.clientTop,
      width: el.clientWidth,
      height: el.clientHeight,
    };
  }

  function scrollTopOf({ el, isRoot }) {
    return isRoot ? window.scrollY : el.scrollTop;
  }

  // Finds fixed (and, after the first frame, sticky) elements covering the main region.
  // Elements that only show up once the page scrolls (e.g. GitLab's sticky title bar)
  // are found on later scans and get edge 'scrolled', meaning hidden in every frame.
  function scanOverlays(initial) {
    const { decided, panelContainers } = state;
    const rect = state.regions[0].rect;
    for (const el of document.querySelectorAll('body *')) {
      if (decided.has(el)) continue;
      const style = getComputedStyle(el);
      const isOverlayPosition =
        style.position === 'fixed' || (!initial && style.position === 'sticky');
      if (!isOverlayPosition || style.visibility === 'hidden') continue;
      if (panelContainers.some((c) => c.contains(el) || el.contains(c))) continue;

      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const overlaps =
        r.bottom > rect.y &&
        r.top < rect.y + rect.height &&
        r.right > rect.x &&
        r.left < rect.x + rect.width;
      if (!overlaps) continue;

      decided.add(el);
      if (r.height > rect.height * MAX_OVERLAY_RATIO) continue;

      const isTop = r.top + r.height / 2 < rect.y + rect.height / 2;
      const edge = !initial ? 'scrolled' : isTop ? 'top' : 'bottom';
      state.overlays.push({ el, edge, saved: saveProp(el, 'visibility') });
    }
  }

  function applyOverlayVisibility(index, mainCount) {
    for (const overlay of state.overlays) {
      const show =
        (overlay.edge === 'top' && index === 0) ||
        (overlay.edge === 'bottom' && index === mainCount - 1);
      if (show) restoreProp(overlay.saved);
      else overlay.el.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  async function prepare() {
    state = { saved: [], overlays: [], decided: new WeakSet() };

    // No smooth scrolling, no scrollbars in the output.
    state.styleEl = document.createElement('style');
    state.styleEl.textContent = `
      *, *::before, *::after { scroll-behavior: auto !important; scrollbar-width: none !important; }
      ::-webkit-scrollbar { display: none !important; }
    `;
    document.documentElement.appendChild(state.styleEl);

    // Sticky elements would repeat in every frame; pin them to their natural spot.
    for (const el of document.querySelectorAll('body *')) {
      if (getComputedStyle(el).position === 'sticky') {
        state.decided.add(el);
        state.saved.push(saveProp(el, 'position'));
        el.style.setProperty('position', 'relative', 'important');
        state.saved.push(saveProp(el, 'top'), saveProp(el, 'bottom'));
        el.style.setProperty('top', 'auto', 'important');
        el.style.setProperty('bottom', 'auto', 'important');
      }
    }
    await nextFrame();

    const scrollers = findScrollers();
    const main = pickMain(scrollers);
    const isRoot = main === rootScroller();
    const panels = pickPanels(scrollers, main, isRoot);

    state.regions = [
      { el: main, isRoot, rect: clientRect(main, isRoot) },
      ...panels.map(({ el, container }) => ({
        el,
        isRoot: false,
        rect: clientRect(el, false),
        container: toRect(container.getBoundingClientRect()),
        background: backgroundOf(container),
      })),
    ];
    for (const region of state.regions) {
      region.originalTop = scrollTopOf(region);
      region.originalLeft = region.isRoot ? window.scrollX : region.el.scrollLeft;
    }
    state.panelContainers = panels.map((panel) => panel.container);
    scanOverlays(true);

    return {
      regions: state.regions.map(({ el, rect, container, background }) => ({
        rect,
        container,
        background,
        scrollHeight: el.scrollHeight,
      })),
      background: backgroundOf(isRoot ? document.body : main),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  async function scrollTo(ys, index, mainCount) {
    state.regions.forEach((region, i) => {
      if (region.isRoot) window.scrollTo({ top: ys[i], left: 0, behavior: 'instant' });
      else region.el.scrollTop = ys[i];
    });

    // Let scroll-triggered UI (sticky bars, lazy content) render, then catch new overlays.
    await nextFrame();
    await sleep(SETTLE_MS);
    if (index > 0) scanOverlays(false);

    // Top-anchored overlays only in the first frame, bottom-anchored only in the last.
    applyOverlayVisibility(index, mainCount);
    await nextFrame();
    return state.regions.map(scrollTopOf);
  }

  function restore() {
    if (!state) return;
    state.overlays.forEach((overlay) => restoreProp(overlay.saved));
    state.saved.reverse().forEach(restoreProp);
    state.styleEl.remove();
    for (const { el, isRoot, originalTop, originalLeft } of state.regions || []) {
      const position = { top: originalTop, left: originalLeft, behavior: 'instant' };
      if (isRoot) window.scrollTo(position);
      else el.scrollTo(position);
    }
    state = null;
  }

  window.__fullPageShot = { prepare, scrollTo, restore };
})();
