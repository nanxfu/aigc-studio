type DemoCase = {
  id: string; title: string; description: string; request: string; proposal: string;
  prompt: string; model: string; compute: string; size: string; ratio: string;
  seed: number; steps: number; source: string; output: string; alt: string;
  operation: string; operationHint: string; engine: string; folder: string;
  files: string[]; evidence: string; stageTitles: string[]; stageDescriptions: string[];
};
type DemoData = {
  cases: DemoCase[]; stages: number[]; duration: number;
  timeline: { typingStart: number; typingDuration: number; cursorStart: number; cursorDuration: number; confirmPress: number; generationStart: number; generationDuration: number; imageArrival: number; processingStart: number; processingDuration: number; channels: number[]; seek: number[] };
  channels: { id: string; label: string; image: string }[]; ui: Record<string, string>;
};

export function initProductDemo() {
  const root = document.querySelector<HTMLElement>('[data-product-demo]');
  const payload = document.getElementById('pd-demo-data');
  if (!root || !payload || root.dataset.ready === 'true') return;
  let data: DemoData;
  try { data = JSON.parse(payload.textContent || ''); } catch { return; }
  if (!Array.isArray(data.cases) || data.cases.length === 0) return;
  const t = (text: string) => data.ui?.[text] || text;
  const timeline = data.timeline;

  const find = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const all = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(root.querySelectorAll<T>(selector));
  const caseButtons = all<HTMLButtonElement>('[data-demo-case]');
  const stageButtons = all<HTMLButtonElement>('[data-demo-stage]');
  const channelButtons = all<HTMLButtonElement>('[data-demo-channel]');
  const playButton = find<HTMLButtonElement>('[data-demo-play]');
  const playLabel = find('[data-demo-play-label]');
  const confirmButton = find<HTMLButtonElement>('[data-demo-confirm]');
  const compare = find<HTMLInputElement>('[data-demo-compare]');
  const request = find('[data-demo-request]');
  const resultImage = find<HTMLImageElement>('[data-demo-result]');
  const detailImage = find<HTMLImageElement>('[data-demo-detail-result]');
  const detailLoupe = find<HTMLElement>('.pd-detail-loupe');
  const zoomButton = find<HTMLButtonElement>('[data-demo-zoom]');
  const mapLabel = find('[data-demo-map-label]');
  const cursor = find<SVGElement & HTMLElement>('.pd-cursor');
  const canvas = find('.pd-canvas');
  const workspace = find('.pd-workspace');
  const panel = find('#pd-demo-panel');
  const announcement = find('[data-demo-announcement]');
  const stageTitle = find('[data-demo-stage-title]');
  const stageDescription = find('[data-demo-stage-description]');
  const sequenceNote = find('[data-demo-sequence-note]');
  const story = find('[data-demo-story]');
  const canvasLabel = find('[data-demo-canvas-label]');
  const canvasMeta = find('[data-demo-canvas-meta]');
  const sourceViews = all<HTMLElement>('.pd-sidebar-view');
  const nav = all('[data-demo-nav]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scrollViewport = window.matchMedia('(min-width: 1060px) and (min-height: 800px)');
  const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
  const ramp = (t: number, start: number, length: number) => clamp((t - start) / length);
  const easeOut = (n: number) => 1 - Math.pow(1 - n, 4);

  let caseIndex = 0;
  let elapsed = motion.matches ? data.duration : 0;
  let playing = !motion.matches;
  let visible = false;
  let previousFrame = 0;
  let frame = 0;
  let lastStage = -1;
  let lastTyped = '';
  let lastImage = '';
  let manualChannel: number | null = null;
  let manualCompare: number | null = null;
  let lastAnnounced = '';
  let destroyed = false;
  let reducedMotion = motion.matches;
  let scrollEnabled = false;
  let driver: 'scroll' | 'auto' | 'manual' = motion.matches ? 'manual' : 'auto';
  let scrollFrame = 0;
  let lastScrollY = window.scrollY;
  let scrollOriginY = window.scrollY;
  let scrollOriginElapsed = elapsed;
  let cursorTarget = { x: 0, y: 0 };

  const setText = (selector: string, value: string | number) => {
    const element = find(selector);
    if (element) element.textContent = String(value);
  };
  const setImage = (selector: string, url: string, alt?: string) => {
    const image = find<HTMLImageElement>(selector);
    if (!image) return;
    if (image.getAttribute('src') !== url) image.src = url;
    if (alt !== undefined) image.alt = alt;
  };

  function loadCase() {
    const item = data.cases[caseIndex];
    root.dataset.case = item.id;
    root.dataset.channel = 'normal';
    const copy: Record<string, string | number> = {
      title: item.title, description: item.description, proposal: item.proposal,
      prompt: item.prompt, model: item.model, compute: item.compute, ratio: item.ratio,
      size: item.size, steps: item.steps, seed: item.seed,
      'workshop-title': item.title, operation: item.operation,
      'operation-hint': item.operationHint, engine: item.engine,
      'gallery-title': item.title, 'gallery-model': item.model,
      'gallery-size': item.size, 'gallery-seed': item.seed,
      'generation-label': `${item.model} · ${t('演示中')}`,
      'art-title': item.title, 'art-size': item.size,
      'film-title': item.title, 'film-model': item.model,
      evidence: item.evidence, folder: `outputs/${item.folder}/`,
    };
    for (const [key, value] of Object.entries(copy)) setText(`[data-demo-${key}]`, value);
    for (const selector of ['source', 'thumb', 'film-source']) setImage(`[data-demo-${selector}]`, item.source, selector === 'source' ? item.alt : '');
    for (const selector of ['result', 'detail-result', 'gallery-image', 'film-result']) setImage(`[data-demo-${selector}]`, item.output, selector === 'gallery-image' ? item.alt : '');
    resultImage.alt = item.alt;
    find<HTMLAnchorElement>('[data-demo-open-sample]').href = item.output;
    const files = find('[data-demo-files]');
    const template = files.querySelector('li')?.cloneNode(true) as HTMLElement;
    if (template) {
      files.replaceChildren(...item.files.map(name => {
        const row = template.cloneNode(true) as HTMLElement;
        row.querySelector('span')!.textContent = name;
        return row;
      }));
    }
    caseButtons.forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === caseIndex));
      button.tabIndex = i === caseIndex ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', caseButtons[caseIndex].id);
    lastStage = -1;
    lastTyped = '';
    lastImage = '';
    manualChannel = null;
    manualCompare = null;
    compare.value = '100';
  }

  function measureCursor() {
    const target = confirmButton.getBoundingClientRect();
    const bounds = workspace.getBoundingClientRect();
    cursorTarget = { x: target.left + target.width * .68 - bounds.left, y: target.top + target.height * .66 - bounds.top };
  }
  function replayDetailScan() {
    detailLoupe.classList.remove('is-replaying');
    void detailLoupe.offsetWidth;
    detailLoupe.classList.add('is-replaying');
  }

  function render() {
    // Check the preference during active playback too: some browsers defer
    // MediaQueryList change events while pages or contexts are being switched.
    if (motion.matches !== reducedMotion) {
      reducedMotion = motion.matches;
      if (reducedMotion) elapsed = data.duration;
      playing = false;
      driver = 'manual';
      manualCompare = null;
    }
    const item = data.cases[caseIndex];
    const stage = data.stages.reduce((index, start, i) => elapsed >= start ? i : index, 0);
    const hasImage = elapsed >= timeline.imageArrival;
    const generating = stage === 2 && !hasImage;
    const view = stage === 4 ? 'gallery' : stage === 3 ? item.id === 'poster' ? 'inspect' : 'workshop' : 'studio';
    const effectivePlaying = playing && visible && !document.hidden;
    root.dataset.stage = String(stage);
    root.dataset.view = view;
    root.dataset.hasImage = String(hasImage);
    root.dataset.generating = String(generating);
    root.dataset.playing = String(playing);
    root.dataset.effectivePlaying = String(effectivePlaying);
    root.dataset.driver = driver;
    root.dataset.processing = String(stage === 3 && elapsed < timeline.processingStart + timeline.processingDuration);
    root.style.setProperty('--generation-progress', String(ramp(elapsed, timeline.generationStart, timeline.generationDuration)));
    confirmButton.disabled = stage !== 1;
    confirmButton.classList.toggle('is-clicked', !motion.matches && elapsed >= timeline.confirmPress && elapsed < timeline.generationStart);
    const typed = motion.matches || stage > 0 ? item.request : item.request.slice(0, Math.ceil(item.request.length * ramp(elapsed, timeline.typingStart, timeline.typingDuration)));
    if (typed !== lastTyped) { request.textContent = typed || ' '; lastTyped = typed; }

    if (stage !== lastStage) {
      stageTitle.textContent = item.stageTitles[stage];
      stageDescription.textContent = item.stageDescriptions[stage];
      canvasLabel.textContent = view === 'gallery' ? t('本地作品库') : view === 'workshop' ? item.operation : generating ? t('生成队列') : hasImage ? t('创作画布') : t('新建创作');
      canvasMeta.textContent = view === 'gallery' ? `${item.files.length} ${t('个文件 · 本地目录示意')}` : item.size;
      nav.forEach(el => el.classList.toggle('is-active', el.dataset.demoNav === (view === 'inspect' ? 'studio' : view)));
      sourceViews.forEach(el => { el.inert = view === 'gallery' ? !el.classList.contains('pd-gallery-sidebar') : view === 'workshop' ? !el.classList.contains('pd-workshop-sidebar') : !el.classList.contains('pd-assistant'); });
      // Only stage changes enter the live region, never each typed character.
      const message = `${item.title}：${item.stageTitles[stage]}`;
      if (message !== lastAnnounced) { announcement.textContent = message; lastAnnounced = message; }
      if (stage === 3) replayDetailScan();
      lastStage = stage;
    }
    if (stage === 1 && elapsed >= timeline.cursorStart && elapsed < timeline.generationStart + 200) {
      measureCursor();
    }
    if (stage === 2) canvasLabel.textContent = generating ? t('生成队列') : t('创作画布');
    const playText = playing ? '暂停' : elapsed >= data.duration ? '重播' : scrollEnabled ? '自动播放' : '播放';
    if (playLabel.textContent !== t(playText)) playLabel.textContent = t(playText);
    playButton.setAttribute('aria-label', `${t(playText)}${root.dataset.lang === 'en' ? ' demonstration' : '演示'}`);
    sequenceNote.textContent = t(scrollEnabled && driver !== 'auto' ? '滚动推进 · 也可点击步骤' : '交互演示 · 等待时间已压缩');
    stageButtons.forEach((button, i) => {
      if (i === stage) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
      const end = data.stages[i + 1] ?? data.duration;
      button.style.setProperty('--stage-progress', String(clamp((elapsed - data.stages[i]) / (end - data.stages[i]))));
    });

    let result = item.output;
    if (item.id === 'material' && stage === 3) {
      const channelIndex = manualChannel ?? (elapsed < timeline.channels[0] ? 1 : elapsed < timeline.channels[1] ? 0 : elapsed < timeline.channels[2] ? 2 : 3);
      const channel = data.channels[channelIndex];
      result = channel.image;
      mapLabel.textContent = root.dataset.lang === 'en' ? channel.label : `${channel.label} / ${channel.id.charAt(0).toUpperCase() + channel.id.slice(1)}`;
      resultImage.alt = root.dataset.lang === 'en' ? `Actual Marigold ${channel.label} output from the same shield` : `同一盾牌经 Marigold 实际拆解的${channel.label}通道`;
      channelButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === channelIndex)));
      root.dataset.channel = channel.id;
    }
    if (result !== lastImage) {
      resultImage.src = result;
      detailImage.src = result;
      lastImage = result;
    }
    const reveal = stage < 3 ? 0 : item.id === 'cutout' ? manualCompare ?? (motion.matches ? 100 : easeOut(ramp(elapsed, timeline.processingStart, timeline.processingDuration)) * 100) : item.id === 'material' ? 100 : 0;
    root.style.setProperty('--result-reveal', `${reveal}%`);
    if (manualCompare === null) compare.value = String(Math.round(reveal));

    if (!motion.matches && view === 'studio' && elapsed >= timeline.cursorStart && elapsed < timeline.generationStart + 200 && window.innerWidth > 760) {
      const progress = easeOut(ramp(elapsed, timeline.cursorStart, timeline.cursorDuration));
      const from = { x: workspace.clientWidth * .66, y: workspace.clientHeight * .54 };
      const x = from.x + (cursorTarget.x - from.x) * progress;
      const y = from.y + (cursorTarget.y - from.y) * progress;
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      cursor.style.opacity = String(elapsed > timeline.generationStart ? 1 - ramp(elapsed, timeline.generationStart, 200) : ramp(elapsed, timeline.cursorStart, 120));
    } else cursor.style.opacity = '0';
  }

  function animate(now: number) {
    frame = 0;
    if (!playing || !visible || document.hidden || destroyed) return;
    const delta = previousFrame ? Math.min(now - previousFrame, 160) : 0;
    previousFrame = now;
    elapsed = Math.min(data.duration, elapsed + delta);
    if (elapsed >= data.duration) playing = false;
    render();
    if (playing) frame = requestAnimationFrame(animate);
  }
  function syncClock() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousFrame = 0;
    render();
    if (playing && visible && !document.hidden && !destroyed) frame = requestAnimationFrame(animate);
  }
  function selectCase(index: number) {
    caseIndex = index;
    elapsed = motion.matches ? data.duration : 0;
    driver = scrollEnabled ? 'scroll' : motion.matches ? 'manual' : 'auto';
    playing = driver === 'auto';
    loadCase();
    measureCursor();
    if (scrollEnabled) { render(); alignScroll(0); }
    syncClock();
  }
  function seekStage(index: number) {
    elapsed = timeline.seek[index];
    playing = false;
    driver = scrollEnabled ? 'scroll' : 'manual';
    manualChannel = null;
    manualCompare = null;
    if (scrollEnabled) { render(); alignScroll(elapsed); }
    syncClock();
  }

  function scrollGeometry() {
    const top = story.getBoundingClientRect().top + window.scrollY - 80;
    const travel = parseFloat(getComputedStyle(story, '::after').height) || 1;
    return { top, travel };
  }
  function alignScroll(time: number) {
    const { top, travel } = scrollGeometry();
    const target = top + travel * time / data.duration;
    lastScrollY = target;
    window.scrollTo({ top: target, behavior: 'instant' });
    lastScrollY = window.scrollY;
    scrollOriginY = lastScrollY;
    scrollOriginElapsed = time;
  }
  function readScroll() {
    const { top, travel } = scrollGeometry();
    elapsed = clamp((window.scrollY - top) / travel) * data.duration;
  }
  function configureScroll() {
    const next = scrollViewport.matches && !motion.matches;
    if (next === scrollEnabled) return;
    scrollEnabled = next;
    root.dataset.scrollEnabled = String(next);
    lastScrollY = window.scrollY;
    if (next) {
      driver = 'scroll';
      playing = false;
      readScroll();
      scrollOriginY = window.scrollY;
      scrollOriginElapsed = elapsed;
    }
    else { driver = motion.matches ? 'manual' : 'auto'; playing = !motion.matches; }
  }
  const onScroll = () => {
    const nextScrollY = window.scrollY;
    if (!scrollEnabled || scrollFrame || Math.abs(nextScrollY - lastScrollY) < 1) return;
    const handoffDriver = driver;
    const handoffScrollY = lastScrollY;
    const handoffElapsed = elapsed;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const currentScrollY = window.scrollY;
      const { travel } = scrollGeometry();
      if (handoffDriver !== 'scroll') {
        scrollOriginY = handoffScrollY;
        scrollOriginElapsed = handoffElapsed;
      }
      driver = 'scroll'; playing = false;
      manualChannel = null; manualCompare = null;
      elapsed = clamp(scrollOriginElapsed + (currentScrollY - scrollOriginY) / travel * data.duration, 0, data.duration);
      lastScrollY = currentScrollY;
      syncClock();
    });
  };

  caseButtons.forEach((button, i) => {
    button.addEventListener('click', () => selectCase(i));
    button.addEventListener('keydown', event => {
      let next: number | null = null;
      if (event.key === 'ArrowRight') next = (i + 1) % caseButtons.length;
      if (event.key === 'ArrowLeft') next = (i - 1 + caseButtons.length) % caseButtons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = caseButtons.length - 1;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      selectCase(next);
      caseButtons[next].focus();
    });
  });
  stageButtons.forEach((button, i) => button.addEventListener('click', () => seekStage(i)));
  channelButtons.forEach((button, i) => button.addEventListener('click', () => { manualChannel = i; playing = false; driver = 'manual'; syncClock(); }));
  compare.addEventListener('input', () => { manualCompare = Number(compare.value); playing = false; driver = 'manual'; syncClock(); });
  zoomButton.addEventListener('click', () => {
    playing = false;
    driver = 'manual';
    replayDetailScan();
    announcement.textContent = t(root.dataset.lang === 'en' ? 'Magnifying artwork detail' : '正在放大作品细节');
    syncClock();
  });
  detailLoupe.addEventListener('animationend', event => {
    if (event.animationName === 'pd-detail-scan') detailLoupe.classList.remove('is-replaying');
  });
  playButton.addEventListener('click', () => {
    if (elapsed >= data.duration) { elapsed = 0; manualChannel = null; manualCompare = null; }
    playing = !playing;
    driver = playing ? 'auto' : 'manual';
    syncClock();
  });
  find('[data-demo-replay]').addEventListener('click', () => {
    manualChannel = null;
    manualCompare = null;
    elapsed = motion.matches ? data.duration : 0;
    driver = scrollEnabled ? 'scroll' : motion.matches ? 'manual' : 'auto';
    playing = driver === 'auto';
    if (scrollEnabled) alignScroll(0);
    syncClock();
  });
  confirmButton.addEventListener('click', () => {
    elapsed = data.stages[2] + 100;
    playing = true;
    driver = 'auto';
    syncClock();
  });
  root.addEventListener('keydown', event => {
    // The existing hero listens globally to arrows. Demo controls own theirs.
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) event.stopPropagation();
  });
  const onVisibility = () => syncClock();
  document.addEventListener('visibilitychange', onVisibility);
  const onMotion = () => {
    reducedMotion = motion.matches;
    elapsed = motion.matches ? data.duration : elapsed;
    playing = false;
    driver = 'manual';
    manualCompare = null;
    configureScroll();
    syncClock();
  };
  motion.addEventListener('change', onMotion);
  const resize = new ResizeObserver(() => { configureScroll(); measureCursor(); render(); });
  resize.observe(canvas);
  const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncClock(); }, { threshold: .12 });
  observer.observe(find('.pd-window'));
  window.addEventListener('scroll', onScroll, { passive: true });
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    destroyed = true;
    if (frame) cancelAnimationFrame(frame);
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    observer.disconnect(); resize.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    motion.removeEventListener('change', onMotion);
    window.removeEventListener('scroll', onScroll);
  };
  window.addEventListener('pagehide', onPageHide, { once: true });
  loadCase();
  workspace.append(cursor);
  root.dataset.ready = 'true';
  configureScroll();
  measureCursor();
  syncClock();
}
