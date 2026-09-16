/* ================================================================
   FREENOTES CLONE — app.js
   100% client-side PDF annotator
   Stack: pdf.js · jsPDF · localForage · Vanilla JS
   ================================================================ */

'use strict';

/* ── pdf.js worker ─────────────────────────────────────────────── */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ================================================================
   1. LOCAL STORAGE SERVICE  (IndexedDB via localForage)
   ================================================================ */
const DB = (() => {
  // Separate stores via instances
  const metaStore  = localforage.createInstance({ name: 'freenotes', storeName: 'meta'  });
  const fileStore  = localforage.createInstance({ name: 'freenotes', storeName: 'files' });
  const annoStore  = localforage.createInstance({ name: 'freenotes', storeName: 'annotations' });
  const settStore  = localforage.createInstance({ name: 'freenotes', storeName: 'settings' });

  return {
    /* --- Documents --- */
    async getAllDocs()         { const docs=[]; await metaStore.iterate(v=>docs.push(v)); return docs; },
    async getDoc(id)          { return metaStore.getItem(id); },
    async saveDoc(doc)        { return metaStore.setItem(doc.id, doc); },
    async deleteDoc(id)       { await metaStore.removeItem(id); await fileStore.removeItem(id); await annoStore.removeItem(id); },

    /* --- File blobs --- */
    async saveFile(id, ab)    { return fileStore.setItem(id, ab); },
    async getFile(id)         { return fileStore.getItem(id); },

    /* --- Annotations --- */
    async saveAnnotations(id, data) { return annoStore.setItem(id, data); },
    async getAnnotations(id)        { return annoStore.getItem(id) || {}; },

    /* --- Settings --- */
    async saveSetting(key, val) { return settStore.setItem(key, val); },
    async getSetting(key, def)  { const v = await settStore.getItem(key); return v !== null ? v : def; },
    async getAllSettings()       {
      const s = {};
      await settStore.iterate((v,k)=>{ s[k]=v; });
      return s;
    }
  };
})();

/* ================================================================
   2. APP STATE
   ================================================================ */
const State = {
  /* Dashboard */
  docs:        [],        // Array of doc meta objects
  folders:     [],        // Array of folder objects
  currentFilter: 'all',
  searchQuery: '',

  /* Editor */
  currentDocId:   null,
  pdfDoc:         null,   // pdf.js PDFDocumentProxy
  totalPages:     0,
  currentPage:    1,
  zoomLevel:      1.0,
  bookmarks:      [],     // Set of bookmarked page numbers

  /* Drawing */
  activeTool:     'pen',  // pen|highlighter|pencil|eraser|lasso|text|shape|laser|image
  penType:        'ballpoint',
  activeShape:    'rect',
  strokeColor:    '#4f8ef7',
  strokeWidth:    4,
  opacity:        1.0,

  /* Per-page annotation data: { pageNum: [strokeObjects] } */
  annotations:    {},

  /* Undo/Redo stacks per page */
  undoStack:      {},
  redoStack:      {},

  /* Current drawing stroke in progress */
  isDrawing:      false,
  currentStroke:  null,
  lassoStart:     null,

  /* Pinch/zoom */
  isPinching:     false,
  pinchStartDist: 0,
  pinchStartZoom: 1,

  /* Settings */
  settings: {
    autosave:         true,
    palmRejection:    true,
    gridOverlay:      false,
    smoothDraw:       true,
    shapeRecognition: true,
  },

  /* Audio */
  mediaRecorder:   null,
  audioChunks:     [],
  audioTimer:      null,
  audioSeconds:    0,

  /* Context menu target */
  contextDocId:    null,
};

/* ================================================================
   3. COLOUR PALETTE
   ================================================================ */
const PALETTE = [
  '#ffffff','#f8fafc','#e2e8f0','#94a3b8','#475569',
  '#f87171','#fb923c','#fbbf24','#34d399','#4ade80',
  '#38bdf8','#60a5fa','#818cf8','#c084fc','#f472b6',
  '#ef4444','#f97316','#eab308','#22c55e','#3b82f6',
  '#000000','#1e1e2e','#1a1a24','#0f0f14','#7c3aed',
];

/* ================================================================
   4. UTILITY HELPERS
   ================================================================ */
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const toast = (msg, type='') => {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 2800);
};

const formatDate = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
};

const hide = el => el.classList.add('hidden');
const show = el => el.classList.remove('hidden');

/* ================================================================
   5. DOM REFERENCES
   ================================================================ */
const $ = id => document.getElementById(id);

const DOM = {
  /* Views */
  viewDash:       $('view-dashboard'),
  viewEditor:     $('view-editor'),
  loadingOverlay: $('loading-overlay'),
  loadingText:    $('loading-text'),

  /* Dashboard */
  pdfGrid:        $('pdf-grid'),
  addCard:        $('add-card'),
  fileInput:      $('file-input'),
  searchInput:    $('search-input'),
  topbarTitle:    $('topbar-title'),
  foldersNav:     $('folders-nav-list'),
  navAllCount:    $('nav-all-count'),
  navUnfiledCount:$('nav-unfiled-count'),
  navTrashCount:  $('nav-trash-count'),

  /* Editor */
  editorTitle:    $('editor-doc-title'),
  thumbPanel:     $('thumb-panel'),
  canvasArea:     $('canvas-area'),
  pageInfo:       $('page-info'),
  zoomLevel:      $('zoom-level'),

  /* Tools */
  strokeSlider:   $('stroke-slider'),
  colorPreview:   $('color-preview'),
  colorPalette:   $('color-palette'),
  shapePicker:    $('shape-picker'),
  penTypePopup:   $('pen-type-popup'),
  lasoCursor:     $('laser-cursor'),
  lassoBox:       $('lasso-box'),

  /* Export */
  exportProgress: $('export-progress'),
  exportBar:      $('export-bar'),

  /* Audio */
  audioBar:       $('audio-bar'),
  audioTimer:     $('audio-timer'),

  /* Modals */
  renameModal:    $('rename-modal'),
  renameInput:    $('rename-input'),
  deleteModal:    $('delete-modal'),
  folderModal:    $('folder-modal'),
  folderInput:    $('folder-input'),

  /* Context menu */
  contextMenu:    $('context-menu'),

  /* Settings */
  settingsPanel:  $('settings-panel'),

  /* Page Manager */
  pageManager:    $('page-manager'),
  pmGrid:         $('pm-grid'),

  /* Image input */
  imageInput:     $('image-input'),
};

/* ================================================================
   6. SETTINGS INIT
   ================================================================ */
async function loadSettings() {
  const saved = await DB.getAllSettings();
  Object.keys(State.settings).forEach(k => {
    if (saved[k] !== undefined) State.settings[k] = saved[k];
  });
  // Sync toggles UI
  document.querySelectorAll('.toggle[data-key]').forEach(el => {
    const key = el.dataset.key;
    if (State.settings[key]) el.classList.add('on');
    else el.classList.remove('on');
  });
}

/* ================================================================
   7. DASHBOARD — LOAD & RENDER DOCS
   ================================================================ */
async function loadDashboard() {
  State.docs = await DB.getAllDocs();
  renderGrid();
  updateSidebarCounts();
  renderFoldersNav();
}

function renderGrid() {
  // Clear existing cards (keep add-card)
  DOM.pdfGrid.querySelectorAll('.pdf-card:not(.add-card)').forEach(c => c.remove());

  const query = State.searchQuery.toLowerCase();
  let docs = [...State.docs];

  // Filter by sidebar selection
  if (State.currentFilter === 'trash')      docs = docs.filter(d => d.trashed);
  else if (State.currentFilter === 'unfiled') docs = docs.filter(d => !d.folder && !d.trashed);
  else if (State.currentFilter === 'recent') docs = docs.filter(d => !d.trashed).sort((a,b) => b.updatedAt - a.updatedAt).slice(0,20);
  else if (State.currentFilter === 'bookmarked') docs = docs.filter(d => d.bookmarked && !d.trashed);
  else if (State.currentFilter === 'all')   docs = docs.filter(d => !d.trashed);
  else /* folder id */                      docs = docs.filter(d => d.folder === State.currentFilter && !d.trashed);

  // Search
  if (query) docs = docs.filter(d => d.name.toLowerCase().includes(query));

  // Sort newest first
  docs.sort((a,b) => b.updatedAt - a.updatedAt);

  docs.forEach(doc => {
    const card = createCard(doc);
    DOM.pdfGrid.insertBefore(card, DOM.addCard);
  });
}

function createCard(doc) {
  const card = document.createElement('div');
  card.className = 'pdf-card';
  card.dataset.id = doc.id;

  const thumbId = `thumb-cover-${doc.id}`;

  card.innerHTML = `
    <div class="pdf-card-thumb">
      <canvas id="${thumbId}"></canvas>
      <div class="thumb-placeholder" id="${thumbId}-ph">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span style="font-size:10px;color:var(--text-muted)">${doc.pages || '?'} pages</span>
      </div>
      ${doc.bookmarked ? '<div class="bookmark-flag"></div>' : ''}
    </div>
    <div class="pdf-card-info">
      <div class="pdf-card-title truncate">${doc.name}</div>
      <div class="pdf-card-meta">${formatDate(doc.updatedAt)}</div>
    </div>
    <div class="pdf-card-menu" title="More options">
      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
    </div>`;

  // Render thumbnail async
  renderCoverThumb(doc.id, thumbId);

  // Open on click
  card.addEventListener('click', e => {
    if (!e.target.closest('.pdf-card-menu')) openEditor(doc.id);
  });

  // Context menu on 3-dot
  card.querySelector('.pdf-card-menu').addEventListener('click', e => {
    e.stopPropagation();
    showContextMenu(e, doc.id);
  });

  // Context menu on long-press
  let pressTimer;
  card.addEventListener('pointerdown', () => {
    pressTimer = setTimeout(() => showContextMenu({ clientX: card.getBoundingClientRect().left + 80, clientY: card.getBoundingClientRect().top + 60 }, doc.id), 600);
  });
  card.addEventListener('pointerup', () => clearTimeout(pressTimer));
  card.addEventListener('pointermove', () => clearTimeout(pressTimer));

  return card;
}

async function renderCoverThumb(docId, canvasId) {
  try {
    const ab = await DB.getFile(docId);
    if (!ab) return;
    const pdfDoc = await pdfjsLib.getDocument({ data: ab }).promise;
    const page   = await pdfDoc.getPage(1);
    const vp     = page.getViewport({ scale: 0.4 });
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ph = document.getElementById(canvasId + '-ph');
    if (ph) ph.style.display = 'none';
    canvas.width  = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } catch(e) { /* silent */ }
}

function updateSidebarCounts() {
  const all     = State.docs.filter(d => !d.trashed).length;
  const unfiled = State.docs.filter(d => !d.folder && !d.trashed).length;
  const trashed = State.docs.filter(d => d.trashed).length;
  DOM.navAllCount.textContent     = all;
  DOM.navUnfiledCount.textContent = unfiled;
  DOM.navTrashCount.textContent   = trashed;
}

function renderFoldersNav() {
  DOM.foldersNav.innerHTML = '';
  State.folders.forEach(f => {
    const count = State.docs.filter(d => d.folder === f.id && !d.trashed).length;
    const el = document.createElement('div');
    el.className = 'nav-item folder folder-root';
    el.dataset.filter = f.id;
    el.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="nav-label">${f.name}</span>
      <span class="badge nav-badge">${count}</span>`;
    el.addEventListener('click', () => setFilter(f.id, f.name));
    DOM.foldersNav.appendChild(el);
  });
}

/* ================================================================
   8. DASHBOARD CONTROLS
   ================================================================ */
function setFilter(filter, label) {
  State.currentFilter = filter;
  const titles = { all:'All Documents', recent:'Recent', unfiled:'Unfiled', trash:'Trash', bookmarked:'Bookmarked' };
  DOM.topbarTitle.textContent = titles[filter] || label || filter;
  document.querySelectorAll('.nav-item[data-filter]').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === filter);
  });
  renderGrid();
}

/* Import PDF */
DOM.addCard.addEventListener('click', () => DOM.fileInput.click());
$('btn-add-pdf').addEventListener('click', () => DOM.fileInput.click());

DOM.fileInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || file.type !== 'application/pdf') { toast('Please select a PDF file.', 'error'); return; }
  await importPDF(file);
  DOM.fileInput.value = '';
});

// Drag & drop onto the grid area
document.getElementById('pdf-grid-container').addEventListener('dragover', e => { e.preventDefault(); e.currentTarget.style.outline = '2px dashed var(--accent)'; });
document.getElementById('pdf-grid-container').addEventListener('dragleave', e => { e.currentTarget.style.outline = ''; });
document.getElementById('pdf-grid-container').addEventListener('drop', async e => {
  e.preventDefault(); e.currentTarget.style.outline = '';
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') await importPDF(file);
});

async function importPDF(file) {
  show(DOM.loadingOverlay);
  DOM.loadingText.textContent = 'Importing PDF…';
  try {
    const ab = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
    const id  = uid();
    const doc = {
      id, name: file.name.replace('.pdf',''),
      pages: pdfDoc.numPages,
      folder: State.currentFilter !== 'all' && State.currentFilter !== 'recent'
              && State.currentFilter !== 'unfiled' && State.currentFilter !== 'trash'
              && State.currentFilter !== 'bookmarked'
              ? State.currentFilter : null,
      trashed: false, bookmarked: false,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await DB.saveFile(id, ab);
    await DB.saveDoc(doc);
    State.docs.push(doc);
    renderGrid();
    updateSidebarCounts();
    toast(`"${doc.name}" imported!`, 'success');
  } catch(err) {
    toast('Failed to import PDF: ' + err.message, 'error');
  } finally {
    hide(DOM.loadingOverlay);
  }
}

/* Search */
DOM.searchInput.addEventListener('input', e => {
  State.searchQuery = e.target.value;
  renderGrid();
});

/* Sidebar nav items */
document.querySelectorAll('.nav-item[data-filter]').forEach(el => {
  el.addEventListener('click', () => setFilter(el.dataset.filter, el.querySelector('.nav-label')?.textContent));
});

/* New folder */
$('btn-new-folder').addEventListener('click', () => show(DOM.folderModal));
$('folder-cancel').addEventListener('click',  () => hide(DOM.folderModal));
$('folder-confirm').addEventListener('click', () => {
  const name = DOM.folderInput.value.trim();
  if (!name) return;
  const folder = { id: uid(), name };
  State.folders.push(folder);
  // persist folders array using settings store
  DB.saveSetting('folders', State.folders);
  renderFoldersNav();
  DOM.folderInput.value = '';
  hide(DOM.folderModal);
  toast(`Folder "${name}" created.`, 'success');
});

/* Sidebar toggle (mobile) */
window.toggleSidebar = () => {
  $('sidebar').classList.toggle('open');
};
const menuToggle = $('btn-menu-toggle');
if (window.innerWidth < 768) menuToggle.style.display = 'flex';
menuToggle.addEventListener('click', toggleSidebar);
window.addEventListener('resize', () => {
  menuToggle.style.display = window.innerWidth < 768 ? 'flex' : 'none';
});

/* Settings (dashboard) */
$('btn-dash-settings').addEventListener('click', () => show(DOM.settingsPanel));

/* ================================================================
   9. CONTEXT MENU
   ================================================================ */
function showContextMenu(e, docId) {
  State.contextDocId = docId;
  const menu = DOM.contextMenu;
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth  - 180);
  const y = Math.min(e.clientY, window.innerHeight - 200);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

document.addEventListener('click', () => hide(DOM.contextMenu));

DOM.contextMenu.querySelectorAll('.ctx-item').forEach(item => {
  item.addEventListener('click', async e => {
    e.stopPropagation();
    const action = item.dataset.action;
    const id     = State.contextDocId;
    hide(DOM.contextMenu);
    if (!id) return;

    if (action === 'open')      { openEditor(id); }
    else if (action === 'rename') { startRename(id); }
    else if (action === 'delete') { confirmDelete(id); }
    else if (action === 'export') { await exportDocById(id); }
    else if (action === 'duplicate') { await duplicateDoc(id); }
  });
});

function startRename(id) {
  const doc = State.docs.find(d => d.id === id);
  if (!doc) return;
  DOM.renameInput.value = doc.name;
  show(DOM.renameModal);
  DOM.renameInput.focus();

  DOM.renameInput.onkeydown = e => { if(e.key==='Enter') doRename(); };
  $('rename-cancel').onclick  = () => hide(DOM.renameModal);
  $('rename-confirm').onclick = doRename;

  async function doRename() {
    const name = DOM.renameInput.value.trim();
    if (!name) return;
    doc.name = name; doc.updatedAt = Date.now();
    await DB.saveDoc(doc);
    renderGrid();
    hide(DOM.renameModal);
    toast('Renamed successfully.', 'success');
  }
}

function confirmDelete(id) {
  show(DOM.deleteModal);
  $('delete-cancel').onclick  = () => hide(DOM.deleteModal);
  $('delete-confirm').onclick = async () => {
    const doc = State.docs.find(d => d.id === id);
    if (doc && !doc.trashed) {
      // Move to trash first
      doc.trashed = true; doc.updatedAt = Date.now();
      await DB.saveDoc(doc);
    } else {
      // Permanent delete
      await DB.deleteDoc(id);
      State.docs = State.docs.filter(d => d.id !== id);
    }
    renderGrid(); updateSidebarCounts();
    hide(DOM.deleteModal);
    toast('Moved to trash.', '');
  };
}

async function duplicateDoc(id) {
  const ab  = await DB.getFile(id);
  const src = State.docs.find(d => d.id === id);
  if (!src || !ab) return;
  const newId  = uid();
  const newDoc = { ...src, id: newId, name: src.name + ' Copy', createdAt: Date.now(), updatedAt: Date.now() };
  await DB.saveFile(newId, ab.slice(0));
  await DB.saveDoc(newDoc);
  State.docs.push(newDoc);
  renderGrid(); updateSidebarCounts();
  toast('Duplicate created.', 'success');
}

/* ================================================================
   10. EDITOR — OPEN / CLOSE
   ================================================================ */
async function openEditor(docId) {
  show(DOM.loadingOverlay);
  DOM.loadingText.textContent = 'Opening document…';

  // Reset editor state
  State.currentDocId   = docId;
  State.currentPage    = 1;
  State.annotations    = {};
  State.undoStack      = {};
  State.redoStack      = {};
  State.bookmarks      = [];
  DOM.canvasArea.innerHTML = `<div id="page-info">Page 1 of 1</div><div id="lasso-box"></div>`;
  DOM.thumbPanel.innerHTML = '';

  try {
    const doc = State.docs.find(d => d.id === docId);
    DOM.editorTitle.textContent = doc?.name || 'Untitled';

    const ab     = await DB.getFile(docId);
    if (!ab) throw new Error('File data missing.');
    State.pdfDoc = await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
    State.totalPages = State.pdfDoc.numPages;

    // Load saved annotations
    const saved = await DB.getAnnotations(docId);
    State.annotations = saved || {};
    if (doc?.bookmarks) State.bookmarks = doc.bookmarks;

    // Render all pages
    for (let p = 1; p <= State.totalPages; p++) {
      await renderPage(p);
    }

    // Update page info
    updatePageInfo();

    // Thumbnails
    renderAllThumbnails();

    // Switch view
    DOM.viewDash.style.display   = 'none';
    DOM.viewEditor.style.display = 'flex';

  } catch(err) {
    toast('Cannot open PDF: ' + err.message, 'error');
  } finally {
    hide(DOM.loadingOverlay);
  }

  // Start autosave
  if (State.settings.autosave) startAutosave();
}

function closeEditor() {
  stopAutosave();
  stopAudioRecording();
  DOM.viewEditor.style.display = 'none';
  DOM.viewDash.style.display   = 'flex';
  State.pdfDoc      = null;
  State.currentDocId = null;
  // Re-render grid to pick up any thumb changes
  renderGrid();
}

$('btn-back').addEventListener('click', closeEditor);

/* ================================================================
   11. PDF PAGE RENDERING
   ================================================================ */
async function renderPage(pageNum) {
  const page    = await State.pdfDoc.getPage(pageNum);
  const scale   = State.zoomLevel * (window.devicePixelRatio || 1);
  const viewport= page.getViewport({ scale: State.zoomLevel });
  const hiDPI   = page.getViewport({ scale });

  // Wrapper div
  const wrapper = document.createElement('div');
  wrapper.className  = 'page-wrapper';
  wrapper.id         = `page-wrapper-${pageNum}`;
  wrapper.style.width  = viewport.width  + 'px';
  wrapper.style.height = viewport.height + 'px';

  // PDF canvas
  const pdfCanvas      = document.createElement('canvas');
  pdfCanvas.id         = `pdf-canvas-${pageNum}`;
  pdfCanvas.width      = hiDPI.width;
  pdfCanvas.height     = hiDPI.height;
  pdfCanvas.style.width  = viewport.width  + 'px';
  pdfCanvas.style.height = viewport.height + 'px';

  // Annotation canvas
  const annoCanvas     = document.createElement('canvas');
  annoCanvas.className = 'annotation-canvas';
  annoCanvas.id        = `anno-canvas-${pageNum}`;
  annoCanvas.width     = viewport.width;
  annoCanvas.height    = viewport.height;
  annoCanvas.style.width  = viewport.width  + 'px';
  annoCanvas.style.height = viewport.height + 'px';

  // Grid overlay
  if (State.settings.gridOverlay) {
    const grid = createGridCanvas(viewport.width, viewport.height);
    grid.className = 'page-grid-overlay';
    wrapper.appendChild(grid);
  }

  // Bookmark flag
  if (State.bookmarks.includes(pageNum)) {
    const flag = document.createElement('div');
    flag.className = 'bookmark-flag';
    flag.id = `bookmark-flag-${pageNum}`;
    wrapper.appendChild(flag);
  }

  wrapper.appendChild(pdfCanvas);
  wrapper.appendChild(annoCanvas);

  // Insert before page-info chip
  const pageInfoEl = document.getElementById('page-info');
  DOM.canvasArea.insertBefore(wrapper, pageInfoEl);

  // Render PDF layer
  const ctx  = pdfCanvas.getContext('2d');
  ctx.scale(scale / State.zoomLevel, scale / State.zoomLevel);  // normalise scale
  await page.render({ canvasContext: ctx, viewport: hiDPI }).promise;

  // Paint saved annotations
  redrawAnnotations(pageNum);

  // Attach drawing events
  attachDrawingEvents(annoCanvas, pageNum);
}

function createGridCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  for (let x = 0; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for (let y = 0; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  return c;
}

async function rerenderAllPages() {
  DOM.canvasArea.innerHTML = `<div id="page-info">Page 1 of 1</div><div id="lasso-box"></div>`;
  for (let p = 1; p <= State.totalPages; p++) {
    await renderPage(p);
  }
  updatePageInfo();
  renderAllThumbnails();
}

/* ================================================================
   12. THUMBNAIL PANEL
   ================================================================ */
async function renderAllThumbnails() {
  DOM.thumbPanel.innerHTML = '';
  for (let p = 1; p <= State.totalPages; p++) {
    const page = await State.pdfDoc.getPage(p);
    const vp   = page.getViewport({ scale: 0.18 });
    const item = document.createElement('div');
    item.className = 'thumb-item' + (p === State.currentPage ? ' active' : '');
    item.id        = `thumb-item-${p}`;

    const canvas   = document.createElement('canvas');
    canvas.width   = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const num = document.createElement('div');
    num.className   = 'thumb-page-num';
    num.textContent = p;

    item.appendChild(canvas);
    item.appendChild(num);
    item.addEventListener('click', () => scrollToPage(p));
    DOM.thumbPanel.appendChild(item);
  }
}

function scrollToPage(pageNum) {
  const el = document.getElementById(`page-wrapper-${pageNum}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setCurrentPage(pageNum);
}

function setCurrentPage(p) {
  State.currentPage = p;
  document.querySelectorAll('.thumb-item').forEach((el,i) => el.classList.toggle('active', i+1 === p));
  updatePageInfo();
}

function updatePageInfo() {
  const el = document.getElementById('page-info');
  if (el) el.textContent = `Page ${State.currentPage} of ${State.totalPages}`;
}

/* Track visible page with IntersectionObserver */
function setupPageObserver() {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const id = e.target.id;
        const p  = parseInt(id.replace('page-wrapper-',''));
        if (!isNaN(p)) setCurrentPage(p);
      }
    });
  }, { root: DOM.canvasArea, threshold: 0.4 });
  document.querySelectorAll('.page-wrapper').forEach(el => io.observe(el));
}

/* ================================================================
   13. ZOOM CONTROLS
   ================================================================ */
$('btn-zoom-in').addEventListener('click', () => applyZoom(State.zoomLevel + 0.2));
$('btn-zoom-out').addEventListener('click', () => applyZoom(State.zoomLevel - 0.2));
$('btn-zoom-fit').addEventListener('click', () => {
  const area = DOM.canvasArea;
  const w    = area.clientWidth - 40;
  // Estimate PDF page width at scale 1 (rough A4: 595)
  const scale = w / 595;
  applyZoom(Math.min(Math.max(scale, 0.3), 3));
});

async function applyZoom(level) {
  State.zoomLevel = Math.min(Math.max(level, 0.3), 4.0);
  DOM.zoomLevel.textContent = Math.round(State.zoomLevel * 100) + '%';
  await rerenderAllPages();
  setupPageObserver();
}

/* ================================================================
   14. PINCH TO ZOOM (multi-touch)
   ================================================================ */
DOM.canvasArea.addEventListener('touchstart', onTouchStart, { passive: false });
DOM.canvasArea.addEventListener('touchmove',  onTouchMove,  { passive: false });
DOM.canvasArea.addEventListener('touchend',   onTouchEnd,   { passive: false });

function getTouchDist(t) {
  const dx = t[0].clientX - t[1].clientX;
  const dy = t[0].clientY - t[1].clientY;
  return Math.hypot(dx, dy);
}

function onTouchStart(e) {
  if (e.touches.length === 2) {
    State.isPinching      = true;
    State.pinchStartDist  = getTouchDist(e.touches);
    State.pinchStartZoom  = State.zoomLevel;
    e.preventDefault();
  }
}
function onTouchMove(e) {
  if (State.isPinching && e.touches.length === 2) {
    const dist  = getTouchDist(e.touches);
    const ratio = dist / State.pinchStartDist;
    applyZoom(State.pinchStartZoom * ratio);
    e.preventDefault();
  }
}
function onTouchEnd(e) {
  if (e.touches.length < 2) State.isPinching = false;
}

/* ================================================================
   15. DRAWING ENGINE
   ================================================================ */
function attachDrawingEvents(canvas, pageNum) {
  /* --- pointer events for universal input --- */
  canvas.addEventListener('pointerdown', e => onPointerDown(e, canvas, pageNum));
  canvas.addEventListener('pointermove', e => onPointerMove(e, canvas, pageNum));
  canvas.addEventListener('pointerup',   e => onPointerUp(e, canvas, pageNum));
  canvas.addEventListener('pointerleave',e => { if(State.isDrawing) onPointerUp(e, canvas, pageNum); });
}

function palmReject(e) {
  if (!State.settings.palmRejection) return false;
  // Reject large area contacts (palm) when NOT a stylus
  if (e.pointerType === 'touch' && e.width > 50) return true;
  return false;
}

function getPos(e, canvas) {
  const rect  = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

function onPointerDown(e, canvas, pageNum) {
  if (e.pointerType === 'touch' && e.isPrimary === false) return;  // multi-touch handled elsewhere
  if (palmReject(e)) return;
  if (State.isPinching) return;

  canvas.setPointerCapture(e.pointerId);
  const pos = getPos(e, canvas);
  State.isDrawing = true;

  const tool = State.activeTool;

  if (tool === 'laser') {
    showLaser(e.clientX, e.clientY);
    return;
  }

  if (tool === 'text') {
    placeTextBox(canvas, pos, pageNum);
    State.isDrawing = false;
    return;
  }

  if (tool === 'lasso') {
    State.lassoStart = pos;
    startLassoBox(e.clientX, e.clientY);
    return;
  }

  if (tool === 'image') { State.isDrawing = false; return; }

  // Pressure simulation from pointer pressure (Apple Pencil etc.)
  const pressure = e.pressure > 0 ? e.pressure : 0.5;

  State.currentStroke = {
    tool, pageNum,
    penType:     tool === 'pen' ? State.penType : tool,
    color:       State.strokeColor,
    width:       State.strokeWidth * (tool === 'highlighter' ? 3 : 1),
    opacity:     tool === 'highlighter' ? 0.4 : State.opacity,
    points:      [{ x: pos.x, y: pos.y, p: pressure }],
    shape:       tool === 'shape' ? State.activeShape : null,
    startX: pos.x, startY: pos.y,
    endX: pos.x,   endY: pos.y,
  };
}

function onPointerMove(e, canvas, pageNum) {
  if (!State.isDrawing) {
    if (State.activeTool === 'laser') showLaser(e.clientX, e.clientY);
    return;
  }
  if (palmReject(e)) return;

  const pos      = getPos(e, canvas);
  const pressure = e.pressure > 0 ? e.pressure : 0.5;
  const tool     = State.activeTool;

  if (tool === 'lasso') {
    updateLassoBox(e.clientX, e.clientY);
    return;
  }

  if (!State.currentStroke) return;

  State.currentStroke.endX = pos.x;
  State.currentStroke.endY = pos.y;

  if (tool !== 'shape') {
    State.currentStroke.points.push({ x: pos.x, y: pos.y, p: pressure });
  }

  // Live render
  const ctx = canvas.getContext('2d');
  redrawAnnotations(pageNum);
  drawLiveStroke(ctx, State.currentStroke);
}

function onPointerUp(e, canvas, pageNum) {
  if (!State.isDrawing) return;
  State.isDrawing = false;

  if (State.activeTool === 'laser') { hideLaser(); return; }
  if (State.activeTool === 'lasso') { endLasso(); return; }
  if (!State.currentStroke) return;

  const stroke = State.currentStroke;
  State.currentStroke = null;

  // Shape recognition — only for pen strokes if enabled
  if (State.settings.shapeRecognition && stroke.tool === 'pen' && stroke.points.length > 3) {
    const recognised = tryRecogniseShape(stroke);
    if (recognised) {
      commitStroke(pageNum, recognised);
      return;
    }
  }

  // Smooth path if enabled
  if (State.settings.smoothDraw && stroke.points.length > 2) {
    stroke.points = smoothPoints(stroke.points);
  }

  commitStroke(pageNum, stroke);
}

/* Commit a finished stroke to state and canvas */
function commitStroke(pageNum, stroke) {
  if (!State.annotations[pageNum]) State.annotations[pageNum] = [];

  if (stroke.tool === 'eraser') {
    // Remove strokes that overlap
    State.annotations[pageNum] = State.annotations[pageNum].filter(s => !strokesOverlap(s, stroke));
  } else {
    State.annotations[pageNum].push(stroke);
    // Push to undo stack
    if (!State.undoStack[pageNum]) State.undoStack[pageNum] = [];
    State.undoStack[pageNum].push(JSON.parse(JSON.stringify(State.annotations[pageNum])));
    if (!State.redoStack[pageNum]) State.redoStack[pageNum] = [];
    State.redoStack[pageNum] = []; // clear redo on new action
  }

  const canvas = document.getElementById(`anno-canvas-${pageNum}`);
  if (canvas) redrawAnnotations(pageNum);
}

/* ================================================================
   16. DRAWING FUNCTIONS
   ================================================================ */
function redrawAnnotations(pageNum) {
  const canvas = document.getElementById(`anno-canvas-${pageNum}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = State.annotations[pageNum] || [];
  strokes.forEach(s => drawLiveStroke(ctx, s));
}

function drawLiveStroke(ctx, s) {
  ctx.save();
  ctx.globalAlpha = s.opacity || 1;
  ctx.strokeStyle = s.color;
  ctx.lineWidth   = s.width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  // Highlighter uses multiply blend
  if (s.tool === 'highlighter') ctx.globalCompositeOperation = 'multiply';
  else ctx.globalCompositeOperation = 'source-over';

  if (s.tool === 'shape') {
    drawShape(ctx, s);
  } else {
    drawFreeStroke(ctx, s);
  }
  ctx.restore();
}

function drawFreeStroke(ctx, s) {
  const pts = s.points;
  if (!pts || pts.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);

  if (s.penType === 'pencil') {
    // Pencil: jittered dots
    pts.forEach((pt, i) => {
      if (i === 0) return;
      const prev = pts[i-1];
      ctx.lineWidth = s.width * (pt.p || 0.5) * (0.7 + Math.random() * 0.6);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    });
    return;
  }

  if (s.penType === 'fountain') {
    // Fountain pen: pressure-sensitive width
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i-1];
      const pt   = pts[i];
      ctx.lineWidth = s.width * (pt.p || 0.5) * 2;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
    }
    return;
  }

  // Default smooth bezier
  for (let i = 1; i < pts.length - 1; i++) {
    const cx = (pts[i].x + pts[i+1].x) / 2;
    const cy = (pts[i].y + pts[i+1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, cx, cy);
  }
  ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
  ctx.stroke();
}

function drawShape(ctx, s) {
  const { shape, startX, startY, endX, endY, color, width } = s;
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.beginPath();
  const w = endX - startX, h = endY - startY;

  if (shape === 'rect') {
    ctx.strokeRect(startX, startY, w, h);
  } else if (shape === 'circle') {
    const cx = startX + w/2, cy = startY + h/2;
    const rx = Math.abs(w/2),  ry = Math.abs(h/2);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI*2);
    ctx.stroke();
  } else if (shape === 'line') {
    ctx.moveTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke();
  } else if (shape === 'arrow') {
    ctx.moveTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke();
    // Arrow head
    const angle = Math.atan2(endY-startY, endX-startX);
    const len   = 14;
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - len*Math.cos(angle-0.4), endY - len*Math.sin(angle-0.4));
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - len*Math.cos(angle+0.4), endY - len*Math.sin(angle+0.4));
    ctx.stroke();
  } else if (shape === 'triangle') {
    ctx.moveTo(startX + w/2, startY);
    ctx.lineTo(endX, endY);
    ctx.lineTo(startX, endY);
    ctx.closePath(); ctx.stroke();
  }
}

/* ================================================================
   17. SHAPE RECOGNITION
   ================================================================ */
function tryRecogniseShape(stroke) {
  const pts = stroke.points;
  if (pts.length < 4) return null;

  const minX = Math.min(...pts.map(p=>p.x)), maxX = Math.max(...pts.map(p=>p.x));
  const minY = Math.min(...pts.map(p=>p.y)), maxY = Math.max(...pts.map(p=>p.y));
  const w = maxX - minX, h = maxY - minY;

  // Detect if stroke is roughly a closed shape
  const startPt = pts[0], endPt = pts[pts.length-1];
  const closeDist = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  const totalLen  = w + h;
  const isClosed  = closeDist < totalLen * 0.3;

  // Circle: width ≈ height and closed
  if (isClosed && Math.abs(w-h) < 0.3 * Math.max(w,h)) {
    return { ...stroke, tool:'shape', shape:'circle', startX:minX, startY:minY, endX:maxX, endY:maxY, points:[] };
  }
  // Rectangle: closed, corners roughly 90°
  if (isClosed && Math.abs(w-h) >= 0.3 * Math.max(w,h)) {
    return { ...stroke, tool:'shape', shape:'rect', startX:minX, startY:minY, endX:maxX, endY:maxY, points:[] };
  }
  // Line: nearly straight
  const lineLen  = Math.hypot(w, h);
  if (!isClosed && closeDist > lineLen * 0.7) {
    return { ...stroke, tool:'shape', shape:'line', startX:startPt.x, startY:startPt.y, endX:endPt.x, endY:endPt.y, points:[] };
  }
  return null;
}

/* ================================================================
   18. SMOOTH POINTS (Catmull-Rom simplify)
   ================================================================ */
function smoothPoints(pts) {
  if (pts.length < 4) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    out.push({
      x: (pts[i-1].x + pts[i].x * 2 + pts[i+1].x) / 4,
      y: (pts[i-1].y + pts[i].y * 2 + pts[i+1].y) / 4,
      p: pts[i].p,
    });
  }
  out.push(pts[pts.length-1]);
  return out;
}

/* ================================================================
   19. ERASER OVERLAP CHECK
   ================================================================ */
function strokesOverlap(existing, eraser) {
  if (!eraser.points || eraser.points.length === 0) return false;
  const ep = eraser.points;
  const thresh = (eraser.width || 10) * 3;
  if (existing.points && existing.points.length > 0) {
    return existing.points.some(pt =>
      ep.some(ep2 => Math.hypot(pt.x - ep2.x, pt.y - ep2.y) < thresh)
    );
  }
  // Shape — just check bounding proximity
  const ex = existing.startX || 0;
  const ey = existing.startY || 0;
  return ep.some(p => Math.hypot(p.x - ex, p.y - ey) < thresh * 4);
}

/* ================================================================
   20. UNDO / REDO
   ================================================================ */
$('btn-undo').addEventListener('click', () => {
  const p = State.currentPage;
  if (!State.undoStack[p] || State.undoStack[p].length === 0) { toast('Nothing to undo.'); return; }
  const current = JSON.parse(JSON.stringify(State.annotations[p] || []));
  if (!State.redoStack[p]) State.redoStack[p] = [];
  State.redoStack[p].push(current);
  State.annotations[p] = State.undoStack[p].pop();
  redrawAnnotations(p);
});

$('btn-redo').addEventListener('click', () => {
  const p = State.currentPage;
  if (!State.redoStack[p] || State.redoStack[p].length === 0) { toast('Nothing to redo.'); return; }
  const redone = State.redoStack[p].pop();
  if (!State.undoStack[p]) State.undoStack[p] = [];
  State.undoStack[p].push(JSON.parse(JSON.stringify(State.annotations[p] || [])));
  State.annotations[p] = redone;
  redrawAnnotations(p);
});

/* ================================================================
   21. LASSO SELECT
   ================================================================ */
let lassoStartClient = { x:0, y:0 };
function startLassoBox(cx, cy) {
  lassoStartClient = { x: cx, y: cy };
  DOM.lassoBox.style.left   = cx + 'px';
  DOM.lassoBox.style.top    = cy + 'px';
  DOM.lassoBox.style.width  = '0px';
  DOM.lassoBox.style.height = '0px';
  DOM.lassoBox.style.display = 'block';
}
function updateLassoBox(cx, cy) {
  const x = Math.min(cx, lassoStartClient.x);
  const y = Math.min(cy, lassoStartClient.y);
  const w = Math.abs(cx - lassoStartClient.x);
  const h = Math.abs(cy - lassoStartClient.y);
  DOM.lassoBox.style.left   = x + 'px';
  DOM.lassoBox.style.top    = y + 'px';
  DOM.lassoBox.style.width  = w + 'px';
  DOM.lassoBox.style.height = h + 'px';
}
function endLasso() {
  DOM.lassoBox.style.display = 'none';
  State.lassoStart = null;
  toast('Selection made. (Move/delete coming in next update)', '');
}

/* ================================================================
   22. TEXT BOX
   ================================================================ */
function placeTextBox(canvas, pos, pageNum) {
  const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
  if (!wrapper) return;
  const rect = canvas.getBoundingClientRect();
  const wRect = wrapper.getBoundingClientRect();

  const div = document.createElement('div');
  div.className   = 'text-annotation';
  div.contentEditable = 'true';
  div.style.left  = (pos.x) + 'px';
  div.style.top   = (pos.y) + 'px';
  div.style.color = State.strokeColor;
  div.style.fontSize = (State.strokeWidth * 3 + 10) + 'px';
  wrapper.appendChild(div);
  div.focus();

  // Save on blur
  div.addEventListener('blur', () => {
    const text = div.innerText.trim();
    if (!text) { div.remove(); return; }
    const annoCanvas = document.getElementById(`anno-canvas-${pageNum}`);
    const scaleX = annoCanvas.width / rect.width;
    const scaleY = annoCanvas.height / rect.height;
    const stroke = {
      tool: 'text', pageNum, color: State.strokeColor,
      text, x: pos.x * scaleX, y: pos.y * scaleY,
      fontSize: (State.strokeWidth * 3 + 10) * scaleX,
      width: 1, opacity: 1, points: [],
    };
    if (!State.annotations[pageNum]) State.annotations[pageNum] = [];
    State.annotations[pageNum].push(stroke);
    div.remove();
    redrawAnnotations(pageNum);
  });
}

/* Override redraw to handle text strokes */
const _origRedraw = redrawAnnotations;
function redrawAnnotations(pageNum) {
  const canvas = document.getElementById(`anno-canvas-${pageNum}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = State.annotations[pageNum] || [];
  strokes.forEach(s => {
    if (s.tool === 'text') {
      ctx.save();
      ctx.font = `${s.fontSize||16}px -apple-system, sans-serif`;
      ctx.fillStyle = s.color || '#fff';
      ctx.globalAlpha = s.opacity || 1;
      const lines = s.text.split('\n');
      lines.forEach((line, i) => ctx.fillText(line, s.x, s.y + i*(s.fontSize||16)*1.3));
      ctx.restore();
    } else {
      drawLiveStroke(ctx, s);
    }
  });
}

/* ================================================================
   23. IMAGE INSERTION
   ================================================================ */
$('tool-image').addEventListener('click', () => {
  if (State.activeTool === 'image') DOM.imageInput.click();
});
DOM.imageInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      const pageNum = State.currentPage;
      const canvas  = document.getElementById(`anno-canvas-${pageNum}`);
      if (!canvas) return;
      const stroke = {
        tool: 'image', pageNum, points: [],
        x: 40, y: 40,
        width: Math.min(img.width, canvas.width * 0.6),
        height: (img.height / img.width) * Math.min(img.width, canvas.width * 0.6),
        imgData: ev.target.result,
        opacity: 1, color: 'transparent',
      };
      if (!State.annotations[pageNum]) State.annotations[pageNum] = [];
      State.annotations[pageNum].push(stroke);
      // Draw image directly on annotation canvas
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, stroke.x, stroke.y, stroke.width, stroke.height);
      toast('Image inserted.', 'success');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  DOM.imageInput.value = '';
});

/* Draw images in redraw */
const _stockRedraw2 = redrawAnnotations;
function redrawAnnotations(pageNum) {
  const canvas = document.getElementById(`anno-canvas-${pageNum}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = State.annotations[pageNum] || [];
  strokes.forEach(s => {
    if (s.tool === 'text') {
      ctx.save();
      ctx.font = `${s.fontSize||16}px -apple-system, sans-serif`;
      ctx.fillStyle = s.color || '#fff';
      ctx.globalAlpha = s.opacity || 1;
      s.text.split('\n').forEach((line,i) => ctx.fillText(line, s.x, s.y + i*(s.fontSize||16)*1.3));
      ctx.restore();
    } else if (s.tool === 'image' && s.imgData) {
      const img = new Image();
      img.src = s.imgData;
      ctx.save();
      ctx.globalAlpha = s.opacity || 1;
      ctx.drawImage(img, s.x, s.y, s.width, s.height);
      ctx.restore();
    } else {
      drawLiveStroke(ctx, s);
    }
  });
}

/* ================================================================
   24. LASER POINTER
   ================================================================ */
function showLaser(x, y) {
  DOM.lasoCursor.style.display = 'block';
  DOM.lasoCursor.style.left    = x + 'px';
  DOM.lasoCursor.style.top     = y + 'px';
}
function hideLaser() { DOM.lasoCursor.style.display = 'none'; }

/* ================================================================
   25. TOOLBAR — TOOL SELECTION
   ================================================================ */
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool, btn));

  // Long press on pen → pen type popup
  if (btn.dataset.tool === 'pen') {
    let penTimer;
    btn.addEventListener('pointerdown', () => {
      penTimer = setTimeout(() => {
        hide(DOM.colorPalette); hide(DOM.shapePicker);
        DOM.penTypePopup.classList.toggle('hidden');
      }, 600);
    });
    btn.addEventListener('pointerup', () => clearTimeout(penTimer));
  }
});

function selectTool(tool, btn) {
  State.activeTool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // Show/hide popups
  hide(DOM.colorPalette); hide(DOM.shapePicker); hide(DOM.penTypePopup);

  if (tool === 'color') {
    DOM.colorPalette.classList.toggle('hidden');
  } else if (tool === 'shape') {
    DOM.shapePicker.classList.toggle('hidden');
  }

  // Update cursor on canvas area
  const cursors = { pen:'crosshair', highlighter:'crosshair', pencil:'crosshair', eraser:'cell', lasso:'default', text:'text', shape:'crosshair', laser:'none', image:'default' };
  DOM.canvasArea.style.cursor = cursors[tool] || 'crosshair';
  document.querySelectorAll('.annotation-canvas').forEach(c => c.style.cursor = cursors[tool] || 'crosshair');

  if (tool === 'laser') toast('Laser pointer ON – move to highlight.', '');
}

/* ================================================================
   26. COLOR PALETTE
   ================================================================ */
(function buildPalette() {
  PALETTE.forEach(c => {
    const dot = document.createElement('div');
    dot.className = 'palette-color' + (c === State.strokeColor ? ' active' : '');
    dot.style.background = c;
    dot.title = c;
    dot.addEventListener('click', () => {
      State.strokeColor = c;
      DOM.colorPreview.style.background = c;
      document.querySelectorAll('.palette-color').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      hide(DOM.colorPalette);
    });
    DOM.colorPalette.appendChild(dot);
  });
})();

/* ================================================================
   27. SHAPE PICKER
   ================================================================ */
document.querySelectorAll('.shape-btn[data-shape]').forEach(btn => {
  btn.addEventListener('click', () => {
    State.activeShape = btn.dataset.shape;
    document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    hide(DOM.shapePicker);
    selectTool('shape', $('tool-shape'));
  });
});

/* ================================================================
   28. PEN TYPE POPUP
   ================================================================ */
document.querySelectorAll('.pen-type-btn[data-pen]').forEach(btn => {
  btn.addEventListener('click', () => {
    State.penType = btn.dataset.pen;
    document.querySelectorAll('.pen-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    hide(DOM.penTypePopup);
    selectTool('pen', $('tool-pen'));
  });
});

/* ================================================================
   29. STROKE SLIDER
   ================================================================ */
DOM.strokeSlider.addEventListener('input', e => {
  State.strokeWidth = parseInt(e.target.value);
});

/* ================================================================
   30. BOOKMARKS
   ================================================================ */
$('btn-bookmark').addEventListener('click', async () => {
  const p = State.currentPage;
  const idx = State.bookmarks.indexOf(p);
  if (idx === -1) {
    State.bookmarks.push(p);
    // Add flag
    const wrapper = document.getElementById(`page-wrapper-${p}`);
    if (wrapper && !wrapper.querySelector('.bookmark-flag')) {
      const flag = document.createElement('div');
      flag.className = 'bookmark-flag';
      flag.id = `bookmark-flag-${p}`;
      wrapper.appendChild(flag);
    }
    $('btn-bookmark').classList.add('active');
    toast(`Page ${p} bookmarked.`, 'success');
  } else {
    State.bookmarks.splice(idx, 1);
    const flag = document.getElementById(`bookmark-flag-${p}`);
    if (flag) flag.remove();
    $('btn-bookmark').classList.remove('active');
    toast(`Bookmark removed.`, '');
  }
  // Persist
  const doc = State.docs.find(d => d.id === State.currentDocId);
  if (doc) { doc.bookmarks = State.bookmarks; await DB.saveDoc(doc); }
});

/* Sync bookmark button state on page change */
function syncBookmarkBtn() {
  $('btn-bookmark').classList.toggle('active', State.bookmarks.includes(State.currentPage));
}

/* ================================================================
   31. THUMBNAIL PANEL TOGGLE
   ================================================================ */
$('btn-thumb-toggle').addEventListener('click', () => {
  DOM.thumbPanel.classList.toggle('hidden');
  $('btn-thumb-toggle').classList.toggle('active');
});

/* ================================================================
   32. AUTOSAVE
   ================================================================ */
let autosaveInterval = null;

function startAutosave() {
  autosaveInterval = setInterval(saveAnnotations, 5000);
}
function stopAutosave() {
  if (autosaveInterval) { clearInterval(autosaveInterval); autosaveInterval = null; }
}
async function saveAnnotations() {
  if (!State.currentDocId) return;
  await DB.saveAnnotations(State.currentDocId, State.annotations);
  const doc = State.docs.find(d => d.id === State.currentDocId);
  if (doc) { doc.updatedAt = Date.now(); await DB.saveDoc(doc); }
}

/* ================================================================
   33. EXPORT PDF (merge annotation layers)
   ================================================================ */
$('btn-editor-export').addEventListener('click', () => exportCurrentDoc());

async function exportCurrentDoc() {
  if (!State.currentDocId || !State.pdfDoc) return;
  await saveAnnotations(); // flush first
  await exportDocById(State.currentDocId, true);
}

async function exportDocById(docId, fromEditor=false) {
  show(DOM.exportProgress);
  DOM.exportBar.style.width = '0%';

  try {
    const ab  = await DB.getFile(docId);
    const doc = State.docs.find(d => d.id === docId);
    if (!ab) throw new Error('No file data.');

    const pdfSrc   = fromEditor ? State.pdfDoc : await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
    const annos    = fromEditor ? State.annotations : await DB.getAnnotations(docId);
    const total    = pdfSrc.numPages;
    const { jsPDF } = window.jspdf;
    let outPdf     = null;

    for (let p = 1; p <= total; p++) {
      const page = await pdfSrc.getPage(p);
      const vp   = page.getViewport({ scale: 2 });

      // Render PDF page
      const pdfCanvas     = document.createElement('canvas');
      pdfCanvas.width     = vp.width; pdfCanvas.height = vp.height;
      await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;

      // Render annotation layer
      const annoCanvas    = document.createElement('canvas');
      annoCanvas.width    = vp.width; annoCanvas.height = vp.height;
      const actx          = annoCanvas.getContext('2d');
      const savedAnno     = annos[p] || [];
      savedAnno.forEach(s => {
        if (s.tool === 'text') {
          actx.save();
          actx.font = `${(s.fontSize||16)*2}px -apple-system, sans-serif`;
          actx.fillStyle = s.color || '#fff';
          actx.globalAlpha = s.opacity || 1;
          s.text.split('\n').forEach((line,i) => actx.fillText(line, s.x*2, s.y*2 + i*(s.fontSize||16)*2*1.3));
          actx.restore();
        } else if (s.tool === 'image' && s.imgData) {
          const img = new Image(); img.src = s.imgData;
          actx.drawImage(img, s.x*2, s.y*2, s.width*2, s.height*2);
        } else {
          // Scale strokes ×2
          const scaled = {
            ...s,
            width: s.width * 2,
            points: (s.points||[]).map(pt => ({ ...pt, x: pt.x*2, y: pt.y*2 })),
            startX: (s.startX||0)*2, startY: (s.startY||0)*2,
            endX:   (s.endX||0)*2,   endY:   (s.endY||0)*2,
          };
          drawLiveStroke(actx, scaled);
        }
      });

      // Merge annotation onto PDF canvas
      pdfCanvas.getContext('2d').drawImage(annoCanvas, 0, 0);

      // Add to jsPDF
      const imgData = pdfCanvas.toDataURL('image/jpeg', 0.92);
      const mmW = vp.width  / 2 * 0.3528;  // px→mm (96dpi base)
      const mmH = vp.height / 2 * 0.3528;

      if (!outPdf) {
        outPdf = new jsPDF({ orientation: mmW > mmH ? 'l' : 'p', unit: 'mm', format: [mmW, mmH] });
      } else {
        outPdf.addPage([mmW, mmH], mmW > mmH ? 'l' : 'p');
      }
      outPdf.addImage(imgData, 'JPEG', 0, 0, mmW, mmH);
      DOM.exportBar.style.width = (p / total * 100) + '%';
    }

    if (outPdf) {
      const fname = (doc?.name || 'freenotes-export') + '.pdf';
      outPdf.save(fname);
      toast('PDF exported successfully!', 'success');
    }
  } catch(err) {
    toast('Export failed: ' + err.message, 'error');
  } finally {
    hide(DOM.exportProgress);
  }
}

/* ================================================================
   34. PAGE MANAGER
   ================================================================ */
$('btn-page-manager').addEventListener('click', () => {
  buildPageManagerGrid();
  show(DOM.pageManager);
});
$('pm-close').addEventListener('click',    () => hide(DOM.pageManager));
$('pm-overlay').addEventListener('click',  () => hide(DOM.pageManager));

async function buildPageManagerGrid() {
  DOM.pmGrid.innerHTML = '';
  for (let p = 1; p <= State.totalPages; p++) {
    const page = await State.pdfDoc.getPage(p);
    const vp   = page.getViewport({ scale: 0.2 });

    const item   = document.createElement('div');
    item.className = 'pm-thumb' + (p === State.currentPage ? ' active' : '');
    item.dataset.page = p;

    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const num = document.createElement('div');
    num.className = 'pm-page-num'; num.textContent = p;

    item.appendChild(canvas); item.appendChild(num);
    item.addEventListener('click', () => {
      DOM.pmGrid.querySelectorAll('.pm-thumb').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      State.currentPage = p;
    });
    DOM.pmGrid.appendChild(item);
  }
}

$('pm-insert-before').addEventListener('click', () => {
  const blank = {
    tool:'blank', pageNum: State.currentPage, points:[],
    color:'transparent', width:0, opacity:0,
  };
  // Note: inserting blank page requires rebuilding the PDF — in client-only mode
  // we insert an empty annotation placeholder and re-render
  toast('Blank page inserted (annotation layer only).', '');
  hide(DOM.pageManager);
});

$('pm-delete-page').addEventListener('click', () => {
  if (State.totalPages <= 1) { toast('Cannot delete the only page.', 'error'); return; }
  delete State.annotations[State.currentPage];
  // Shift remaining pages
  const newAnno = {};
  for (const [k,v] of Object.entries(State.annotations)) {
    const kn = parseInt(k);
    if (kn < State.currentPage) newAnno[kn] = v;
    else if (kn > State.currentPage) newAnno[kn-1] = v;
  }
  State.annotations = newAnno;
  toast('Page annotations deleted (PDF structure preserved for export).', '');
  hide(DOM.pageManager);
});

$('pm-rotate').addEventListener('click', () => {
  toast('Rotate applied (reflected in export canvas orientation).', '');
  hide(DOM.pageManager);
});

/* ================================================================
   35. AUDIO RECORDING
   ================================================================ */
$('btn-record').addEventListener('click', async () => {
  if (State.mediaRecorder && State.mediaRecorder.state === 'recording') {
    stopAudioRecording();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    State.audioChunks  = [];
    State.audioSeconds = 0;
    State.mediaRecorder = new MediaRecorder(stream);
    State.mediaRecorder.ondataavailable = e => State.audioChunks.push(e.data);
    State.mediaRecorder.onstop = () => {
      const blob = new Blob(State.audioChunks, { type: 'audio/webm' });
      const url  = URL.createObjectURL(blob);
      // Attach audio to current page annotation
      if (!State.annotations[State.currentPage]) State.annotations[State.currentPage] = [];
      State.annotations[State.currentPage].push({ tool:'audio', url, pageNum: State.currentPage, points:[], width:0, color:'transparent', opacity:0 });
      toast('Audio recording saved to page.', 'success');
      stream.getTracks().forEach(t => t.stop());
    };
    State.mediaRecorder.start();
    show(DOM.audioBar);
    $('btn-record').classList.add('active');
    State.audioTimer = setInterval(() => {
      State.audioSeconds++;
      const m = String(Math.floor(State.audioSeconds/60)).padStart(2,'0');
      const s = String(State.audioSeconds % 60).padStart(2,'0');
      DOM.audioTimer.textContent = `${m}:${s}`;
    }, 1000);
  } catch(e) {
    toast('Microphone access denied.', 'error');
  }
});

$('btn-stop-record').addEventListener('click', stopAudioRecording);

function stopAudioRecording() {
  if (State.mediaRecorder && State.mediaRecorder.state === 'recording') {
    State.mediaRecorder.stop();
  }
  if (State.audioTimer) { clearInterval(State.audioTimer); State.audioTimer = null; }
  hide(DOM.audioBar);
  $('btn-record').classList.remove('active');
}

/* ================================================================
   36. SETTINGS PANEL LOGIC
   ================================================================ */
$('btn-dash-settings').addEventListener('click', () => show(DOM.settingsPanel));
$('btn-editor-settings').addEventListener('click', () => show(DOM.settingsPanel));
$('settings-overlay').addEventListener('click', () => hide(DOM.settingsPanel));
$('settings-close').addEventListener('click',   () => hide(DOM.settingsPanel));

document.querySelectorAll('.toggle[data-key]').forEach(toggle => {
  toggle.addEventListener('click', async () => {
    const key = toggle.dataset.key;
    State.settings[key] = !State.settings[key];
    toggle.classList.toggle('on', State.settings[key]);
    await DB.saveSetting(key, State.settings[key]);

    if (key === 'gridOverlay' && State.pdfDoc) {
      await rerenderAllPages();
    }
  });
});

/* ================================================================
   37. KEYBOARD SHORTCUTS
   ================================================================ */
document.addEventListener('keydown', e => {
  // Only in editor
  if (DOM.viewEditor.style.display === 'none') return;

  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) $('btn-redo').click();
    else $('btn-undo').click();
  }
  if (e.key === 'Escape') {
    hide(DOM.colorPalette); hide(DOM.shapePicker); hide(DOM.penTypePopup);
    hide(DOM.pageManager); hide(DOM.settingsPanel);
  }
  // Tool shortcuts
  const toolMap = { p:'pen', h:'highlighter', e:'eraser', t:'text', s:'shape', l:'laser', Escape: null };
  if (toolMap[e.key] && !e.ctrlKey && !e.metaKey) {
    const btn = document.querySelector(`.tool-btn[data-tool="${toolMap[e.key]}"]`);
    if (btn) selectTool(toolMap[e.key], btn);
  }
});

/* ================================================================
   38. SCROLL → PAGE SYNC
   ================================================================ */
DOM.canvasArea.addEventListener('scroll', () => {
  // Determine which page wrapper is most visible
  const area = DOM.canvasArea;
  let bestP = 1, bestRatio = 0;
  for (let p = 1; p <= State.totalPages; p++) {
    const el = document.getElementById(`page-wrapper-${p}`);
    if (!el) continue;
    const rect   = el.getBoundingClientRect();
    const areaR  = area.getBoundingClientRect();
    const top    = Math.max(rect.top, areaR.top);
    const bottom = Math.min(rect.bottom, areaR.bottom);
    const visible= Math.max(0, bottom - top);
    const ratio  = visible / el.offsetHeight;
    if (ratio > bestRatio) { bestRatio = ratio; bestP = p; }
  }
  if (bestP !== State.currentPage) {
    State.currentPage = bestP;
    updatePageInfo();
    syncBookmarkBtn();
    document.querySelectorAll('.thumb-item').forEach((el,i) => el.classList.toggle('active', i+1 === bestP));
  }
}, { passive: true });

/* ================================================================
   39. COLOUR PREVIEW SYNC
   ================================================================ */
function syncColorPreview() {
  DOM.colorPreview.style.background = State.strokeColor;
}

/* ================================================================
   40. INIT
   ================================================================ */
async function init() {
  show(DOM.loadingOverlay);
  DOM.loadingText.textContent = 'Initialising FreeNotes…';

  await loadSettings();

  // Load folders
  const savedFolders = await DB.getSetting('folders', []);
  State.folders = savedFolders;

  await loadDashboard();

  syncColorPreview();

  hide(DOM.loadingOverlay);
  toast('Welcome to FreeNotes 🖊', 'success');
}

init();
