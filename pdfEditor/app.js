import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdfjs/pdf.worker.mjs",
  import.meta.url
).href;
const PDFJS_STANDARD_FONT_URL = new URL(
  "./vendor/pdfjs/standard_fonts/",
  import.meta.url
).href;
const PDFJS_CMAP_URL = new URL(
  "./vendor/pdfjs/cmaps/",
  import.meta.url
).href;
const PDFJS_WASM_URL = new URL(
  "./vendor/pdfjs/wasm/",
  import.meta.url
).href;

const { PDFDocument, degrees } = window.PDFLib || {};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const makeId = (prefix) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
const clonePages = (pages) =>
  typeof structuredClone === "function"
    ? structuredClone(pages)
    : JSON.parse(JSON.stringify(pages));
const normalizedRotation = (value) => ((value % 360) + 360) % 360;

class PdfWorkshop {
  constructor() {
    this.sources = new Map();
    this.pages = [];
    this.activePageId = null;
    this.selectedPageIds = new Set();
    this.selectedAnnotationId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.zoom = 1;
    this.dirty = false;
    this.textPlacementArmed = false;
    this.currentViewport = null;
    this.currentRenderedPageId = null;
    this.currentRenderTask = null;
    this.renderToken = 0;
    this.thumbnailGeneration = 0;
    this.draggedPageId = null;
    this.annotationDrag = null;
    this.dragDepth = 0;
    this.resizeTimer = null;
    this.annotationFontBytesPromise = null;

    this.elements = {
      openButton: $("#openButton"),
      emptyOpenButton: $("#emptyOpenButton"),
      mergeButton: $("#mergeButton"),
      shareButton: $("#shareButton"),
      exportButton: $("#exportButton"),
      openFileInput: $("#openFileInput"),
      mergeFileInput: $("#mergeFileInput"),
      sidebar: $("#sidebar"),
      openSidebarButton: $("#openSidebarButton"),
      closeSidebarButton: $("#closeSidebarButton"),
      pageList: $("#pageList"),
      pageCount: $("#pageCount"),
      selectAllCheckbox: $("#selectAllCheckbox"),
      extractButton: $("#extractButton"),
      undoButton: $("#undoButton"),
      redoButton: $("#redoButton"),
      rotateButton: $("#rotateButton"),
      deleteButton: $("#deleteButton"),
      textToolButton: $("#textToolButton"),
      zoomOutButton: $("#zoomOutButton"),
      zoomInButton: $("#zoomInButton"),
      zoomResetButton: $("#zoomResetButton"),
      textControls: $("#textControls"),
      annotationText: $("#annotationText"),
      annotationSize: $("#annotationSize"),
      annotationColor: $("#annotationColor"),
      armTextButton: $("#armTextButton"),
      cancelTextButton: $("#cancelTextButton"),
      textToolHint: $("#textToolHint"),
      viewerScroll: $("#viewerScroll"),
      emptyState: $("#emptyState"),
      documentView: $("#documentView"),
      pageStage: $("#pageStage"),
      pdfCanvas: $("#pdfCanvas"),
      annotationLayer: $("#annotationLayer"),
      dropOverlay: $("#dropOverlay"),
      documentStatus: $("#documentStatus"),
      activePageStatus: $("#activePageStatus"),
      offlineStatus: $("#offlineStatus"),
      busyOverlay: $("#busyOverlay"),
      busyTitle: $("#busyTitle"),
      busyDetail: $("#busyDetail"),
      busyProgress: $("#busyProgress"),
      toastRegion: $("#toastRegion"),
      confirmDialog: $("#confirmDialog"),
      confirmTitle: $("#confirmTitle"),
      confirmMessage: $("#confirmMessage"),
      confirmAcceptButton: $("#confirmAcceptButton"),
    };
  }

  init() {
    if (!PDFDocument) {
      this.toast("PDF 編輯元件載入失敗，請重新整理頁面。", "error", 8000);
      return;
    }

    this.bindEvents();
    this.updateConnectivity();
    this.updateUI();
    this.registerServiceWorker();
    this.registerFileHandler();

    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }

    if (new URLSearchParams(location.search).get("action") === "open") {
      setTimeout(() => this.elements.openFileInput.click(), 350);
    }
  }

  bindEvents() {
    const {
      openButton,
      emptyOpenButton,
      mergeButton,
      shareButton,
      exportButton,
      openFileInput,
      mergeFileInput,
      openSidebarButton,
      closeSidebarButton,
      selectAllCheckbox,
      extractButton,
      undoButton,
      redoButton,
      rotateButton,
      deleteButton,
      textToolButton,
      zoomOutButton,
      zoomInButton,
      zoomResetButton,
      armTextButton,
      cancelTextButton,
      annotationLayer,
      viewerScroll,
    } = this.elements;

    openButton.addEventListener("click", () => openFileInput.click());
    emptyOpenButton.addEventListener("click", () => openFileInput.click());
    mergeButton.addEventListener("click", () => mergeFileInput.click());
    exportButton.addEventListener("click", () =>
      this.exportPages(this.pages.map((page) => page.id), {
        mode: "download",
        suffix: "edited",
      })
    );
    shareButton.addEventListener("click", () =>
      this.exportPages(this.pages.map((page) => page.id), {
        mode: "share",
        suffix: "edited",
      })
    );

    openFileInput.addEventListener("change", async (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      if (!files.length) return;
      if (this.pages.length) {
        const confirmed = await this.confirmAction({
          title: "開啟新的文件？",
          message: "目前尚未匯出的編輯內容將被新的 PDF 取代。",
          acceptLabel: "開啟新文件",
        });
        if (!confirmed) return;
      }
      await this.loadFiles(files, { replace: true });
    });

    mergeFileInput.addEventListener("change", async (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      if (files.length) await this.loadFiles(files, { replace: false });
    });

    openSidebarButton.addEventListener("click", () =>
      document.body.classList.add("sidebar-visible")
    );
    closeSidebarButton.addEventListener("click", () =>
      document.body.classList.remove("sidebar-visible")
    );

    document.addEventListener("click", (event) => {
      if (
        document.body.classList.contains("sidebar-visible") &&
        !this.elements.sidebar.contains(event.target) &&
        !openSidebarButton.contains(event.target)
      ) {
        document.body.classList.remove("sidebar-visible");
      }
    });

    selectAllCheckbox.addEventListener("change", () => {
      this.selectedPageIds = selectAllCheckbox.checked
        ? new Set(this.pages.map((page) => page.id))
        : new Set();
      this.updateUI();
      this.renderSidebar();
    });

    extractButton.addEventListener("click", () =>
      this.exportPages(
        this.pages
          .filter((page) => this.selectedPageIds.has(page.id))
          .map((page) => page.id),
        { mode: "download", suffix: "selected-pages" }
      )
    );

    undoButton.addEventListener("click", () => this.undo());
    redoButton.addEventListener("click", () => this.redo());
    rotateButton.addEventListener("click", () => this.rotateSelectedPages());
    deleteButton.addEventListener("click", () => this.deleteSelection());
    textToolButton.addEventListener("click", () => this.toggleTextControls());
    armTextButton.addEventListener("click", () => this.toggleTextPlacement());
    cancelTextButton.addEventListener("click", () => this.closeTextControls());

    zoomOutButton.addEventListener("click", () => this.changeZoom(-0.15));
    zoomInButton.addEventListener("click", () => this.changeZoom(0.15));
    zoomResetButton.addEventListener("click", () => {
      this.zoom = 1;
      this.updateUI();
      this.renderActivePage();
    });

    annotationLayer.addEventListener("click", (event) =>
      this.handleAnnotationLayerClick(event)
    );
    annotationLayer.addEventListener("pointerdown", (event) =>
      this.handleAnnotationPointerDown(event)
    );
    window.addEventListener("pointermove", (event) =>
      this.handleAnnotationPointerMove(event)
    );
    window.addEventListener("pointerup", (event) =>
      this.handleAnnotationPointerUp(event)
    );

    window.addEventListener("keydown", (event) => this.handleKeyboard(event));
    window.addEventListener("online", () => this.updateConnectivity());
    window.addEventListener("offline", () => this.updateConnectivity());
    window.addEventListener("beforeunload", (event) => {
      if (!this.dirty || !this.pages.length) return;
      event.preventDefault();
      event.returnValue = "";
    });

    const hasFileDrag = (event) =>
      [...(event.dataTransfer?.types || [])].includes("Files");

    window.addEventListener("dragenter", (event) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      this.dragDepth += 1;
      this.elements.dropOverlay.hidden = false;
    });
    window.addEventListener("dragover", (event) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (event) => {
      if (!hasFileDrag(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (!this.dragDepth) this.elements.dropOverlay.hidden = true;
    });
    window.addEventListener("drop", async (event) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      this.dragDepth = 0;
      this.elements.dropOverlay.hidden = true;
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) {
        await this.loadFiles(files, { replace: !this.pages.length });
      }
    });

    new ResizeObserver(() => {
      if (!this.pages.length) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.renderActivePage(), 120);
    }).observe(viewerScroll);
  }

  async loadFiles(fileList, { replace = false } = {}) {
    const files = fileList.filter(
      (file) =>
        file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    );

    if (!files.length) {
      this.toast("請選擇 PDF 檔案。", "error");
      return;
    }

    this.setBusy(true, "正在讀取 PDF", `準備載入 ${files.length} 個檔案`, 0);
    const loaded = [];
    const errors = [];

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      try {
        this.setBusy(
          true,
          "正在讀取 PDF",
          `${file.name}（${fileIndex + 1}/${files.length}）`,
          Math.round((fileIndex / files.length) * 80)
        );
        loaded.push(await this.loadSource(file));
      } catch (error) {
        console.error("[PDF Editor] Failed to load", file.name, error);
        errors.push({ file, error });
      }
    }

    if (loaded.length) {
      if (replace) {
        for (const source of this.sources.values()) {
          source.loadingTask?.destroy?.().catch?.(() => {});
        }
        this.sources.clear();
        this.pages = [];
        this.undoStack = [];
        this.redoStack = [];
      } else {
        this.pushHistory();
      }

      const newPageIds = [];
      for (const { source, pages } of loaded) {
        this.sources.set(source.id, source);
        this.pages.push(...pages);
        newPageIds.push(...pages.map((page) => page.id));
      }

      this.activePageId = newPageIds[0] || this.activePageId;
      this.selectedPageIds = new Set(newPageIds.slice(0, 1));
      this.selectedAnnotationId = null;
      this.dirty = !replace || loaded.length > 1;
      this.zoom = 1;
      this.closeTextControls();
      this.renderAll();

      const pageTotal = loaded.reduce((sum, item) => sum + item.pages.length, 0);
      this.toast(
        replace
          ? `已開啟 ${pageTotal} 頁 PDF。`
          : `已加入 ${files.length - errors.length} 份文件、${pageTotal} 頁。`,
        "success"
      );
    }

    this.setBusy(false);

    if (errors.length) {
      const passwordProtected = errors.some(
        ({ error }) =>
          error?.name === "PasswordException" ||
          /password|encrypted/i.test(error?.message || "")
      );
      this.toast(
        passwordProtected
          ? `${errors.length} 個檔案無法開啟；目前不支援有密碼或加密的 PDF。`
          : `${errors.length} 個檔案讀取失敗，請確認檔案是否完整。`,
        "error",
        7000
      );
    }
  }

  async loadSource(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      useWorkerFetch: false,
      standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
      cMapUrl: PDFJS_CMAP_URL,
      cMapPacked: true,
      wasmUrl: PDFJS_WASM_URL,
      useSystemFonts: true,
    });

    const pdfjsDoc = await loadingTask.promise;
    let pdfLibDoc;
    try {
      pdfLibDoc = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
    } catch (error) {
      await loadingTask.destroy().catch(() => {});
      throw error;
    }

    const sourceId = makeId("source");
    const pages = [];

    for (let index = 0; index < pdfjsDoc.numPages; index += 1) {
      const pdfPage = await pdfjsDoc.getPage(index + 1);
      pages.push({
        id: makeId("page"),
        sourceId,
        sourcePageIndex: index,
        baseRotation: normalizedRotation(pdfPage.rotate || 0),
        rotation: 0,
        annotations: [],
      });
    }

    return {
      source: {
        id: sourceId,
        name: file.name,
        size: file.size,
        bytes,
        loadingTask,
        pdfjsDoc,
        pdfLibDoc,
      },
      pages,
    };
  }

  renderAll() {
    this.normalizeState();
    this.updateUI();
    this.renderSidebar();
    this.renderActivePage();
  }

  normalizeState() {
    const pageIds = new Set(this.pages.map((page) => page.id));
    this.selectedPageIds = new Set(
      [...this.selectedPageIds].filter((id) => pageIds.has(id))
    );

    if (!pageIds.has(this.activePageId)) {
      this.activePageId = this.pages[0]?.id || null;
    }

    if (!this.pages.length) {
      this.activePageId = null;
      this.selectedPageIds.clear();
      this.selectedAnnotationId = null;
    }
  }

  updateUI() {
    const hasDocument = this.pages.length > 0;
    const activeIndex = this.pages.findIndex(
      (page) => page.id === this.activePageId
    );
    const selectedCount = this.selectedPageIds.size;

    this.elements.mergeButton.disabled = !hasDocument;
    this.elements.exportButton.disabled = !hasDocument;
    this.elements.shareButton.disabled =
      !hasDocument || typeof navigator.share !== "function";
    this.elements.undoButton.disabled = !hasDocument || !this.undoStack.length;
    this.elements.redoButton.disabled = !hasDocument || !this.redoStack.length;
    this.elements.rotateButton.disabled = !hasDocument;
    this.elements.deleteButton.disabled = !hasDocument;
    this.elements.textToolButton.disabled = !hasDocument;
    this.elements.zoomOutButton.disabled = !hasDocument || this.zoom <= 0.5;
    this.elements.zoomInButton.disabled = !hasDocument || this.zoom >= 2.5;
    this.elements.zoomResetButton.disabled = !hasDocument;
    this.elements.extractButton.disabled = !selectedCount;
    this.elements.selectAllCheckbox.disabled = !hasDocument;

    this.elements.zoomResetButton.textContent = `${Math.round(this.zoom * 100)}%`;
    this.elements.pageCount.textContent = hasDocument
      ? `${this.pages.length} 頁${selectedCount ? `・已選 ${selectedCount}` : ""}`
      : "尚未開啟文件";

    this.elements.selectAllCheckbox.checked =
      hasDocument && selectedCount === this.pages.length;
    this.elements.selectAllCheckbox.indeterminate =
      selectedCount > 0 && selectedCount < this.pages.length;

    this.elements.emptyState.hidden = hasDocument;
    this.elements.documentView.hidden = !hasDocument;
    this.elements.activePageStatus.textContent =
      activeIndex >= 0 ? `第 ${activeIndex + 1} / ${this.pages.length} 頁` : "";

    if (hasDocument) {
      const totalSize = [...this.sources.values()].reduce(
        (sum, source) => sum + source.size,
        0
      );
      this.elements.documentStatus.textContent =
        `${this.sources.size} 份文件・${this.formatBytes(totalSize)}` +
        (this.dirty ? "・尚未匯出" : "・已匯出");
    } else {
      this.elements.documentStatus.textContent = "準備就緒";
    }
  }

  renderSidebar() {
    const list = this.elements.pageList;
    this.thumbnailGeneration += 1;
    const generation = this.thumbnailGeneration;
    list.replaceChildren();

    if (!this.pages.length) {
      const placeholder = document.createElement("div");
      placeholder.className = "sidebar-placeholder";
      placeholder.textContent = "開啟 PDF 後，可在這裡拖曳頁面調整順序。";
      list.append(placeholder);
      return;
    }

    const thumbnailJobs = [];

    this.pages.forEach((pageRecord, index) => {
      const source = this.sources.get(pageRecord.sourceId);
      const card = document.createElement("article");
      card.className = `page-card${
        pageRecord.id === this.activePageId ? " active" : ""
      }`;
      card.dataset.pageId = pageRecord.id;
      card.draggable = true;
      card.tabIndex = 0;
      card.setAttribute("aria-label", `第 ${index + 1} 頁，來源 ${source?.name || "PDF"}`);

      const checkboxWrap = document.createElement("label");
      checkboxWrap.className = "page-card-checkbox";
      checkboxWrap.title = "選取此頁";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedPageIds.has(pageRecord.id);
      checkbox.setAttribute("aria-label", `選取第 ${index + 1} 頁`);
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedPageIds.add(pageRecord.id);
        else this.selectedPageIds.delete(pageRecord.id);
        this.updateUI();
      });
      checkboxWrap.append(checkbox);

      const previewColumn = document.createElement("div");
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "thumbnail-wrap";
      const canvas = document.createElement("canvas");
      canvas.dataset.pageId = pageRecord.id;
      thumbWrap.append(canvas);
      thumbnailJobs.push({ canvas, thumbWrap, pageRecord });

      const meta = document.createElement("div");
      meta.className = "page-card-meta";
      const pageLabel = document.createElement("span");
      pageLabel.textContent = `第 ${index + 1} 頁`;
      const sourceLabel = document.createElement("span");
      sourceLabel.textContent = source?.name || "PDF";
      sourceLabel.title = source?.name || "";
      meta.append(pageLabel, sourceLabel);
      previewColumn.append(thumbWrap, meta);

      const moveButtons = document.createElement("div");
      moveButtons.className = "page-move-buttons";
      moveButtons.append(
        this.createMoveButton("up", index === 0, () => this.movePage(pageRecord.id, -1)),
        this.createMoveButton(
          "down",
          index === this.pages.length - 1,
          () => this.movePage(pageRecord.id, 1)
        )
      );

      card.append(checkboxWrap, previewColumn, moveButtons);

      card.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey) {
          if (this.selectedPageIds.has(pageRecord.id)) {
            this.selectedPageIds.delete(pageRecord.id);
          } else {
            this.selectedPageIds.add(pageRecord.id);
          }
        } else {
          this.selectedPageIds = new Set([pageRecord.id]);
        }
        this.selectPage(pageRecord.id);
      });

      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.selectedPageIds = new Set([pageRecord.id]);
          this.selectPage(pageRecord.id);
        }
      });

      card.addEventListener("dragstart", (event) => {
        this.draggedPageId = pageRecord.id;
        card.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", pageRecord.id);
      });
      card.addEventListener("dragend", () => {
        this.draggedPageId = null;
        card.classList.remove("dragging");
        $$(".page-card.drag-over").forEach((item) =>
          item.classList.remove("drag-over")
        );
      });
      card.addEventListener("dragover", (event) => {
        if (!this.draggedPageId || this.draggedPageId === pageRecord.id) return;
        event.preventDefault();
        card.classList.add("drag-over");
        event.dataTransfer.dropEffect = "move";
      });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        card.classList.remove("drag-over");
        const draggedId =
          this.draggedPageId || event.dataTransfer.getData("text/plain");
        if (draggedId && draggedId !== pageRecord.id) {
          this.reorderPage(draggedId, pageRecord.id);
        }
      });

      list.append(card);
    });

    this.queueThumbnails(thumbnailJobs, generation);
  }

  createMoveButton(direction, disabled, handler) {
    const button = document.createElement("button");
    button.className = "mini-button";
    button.type = "button";
    button.disabled = disabled;
    button.title = direction === "up" ? "向前移一頁" : "向後移一頁";
    button.setAttribute("aria-label", button.title);
    button.innerHTML =
      direction === "up"
        ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>'
        : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  }

  async queueThumbnails(jobs, generation) {
    for (const job of jobs) {
      if (
        generation !== this.thumbnailGeneration ||
        !job.canvas.isConnected
      ) {
        return;
      }
      try {
        await this.renderThumbnail(job.canvas, job.pageRecord);
        job.thumbWrap.classList.add("loaded");
      } catch (error) {
        if (error?.name !== "RenderingCancelledException") {
          console.warn("[PDF Editor] Thumbnail failed", error);
        }
      }
      await new Promise((resolve) => {
        if ("requestIdleCallback" in window) {
          window.requestIdleCallback(() => resolve(), { timeout: 80 });
        } else {
          window.setTimeout(resolve, 0);
        }
      });
    }
  }

  async renderThumbnail(canvas, pageRecord) {
    const source = this.sources.get(pageRecord.sourceId);
    if (!source) return;
    const page = await source.pdfjsDoc.getPage(pageRecord.sourcePageIndex + 1);
    const rotation = this.getPageRotation(pageRecord);
    const baseViewport = page.getViewport({ scale: 1, rotation });
    const scale = 122 / baseViewport.width;
    const viewport = page.getViewport({ scale, rotation });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const context = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;

    await page.render({
      canvasContext: context,
      viewport,
      transform:
        outputScale === 1
          ? null
          : [outputScale, 0, 0, outputScale, 0, 0],
    }).promise;
  }

  async renderActivePage() {
    const pageRecord = this.pages.find((page) => page.id === this.activePageId);
    if (!pageRecord) {
      this.currentViewport = null;
      this.currentRenderedPageId = null;
      this.elements.annotationLayer.replaceChildren();
      return;
    }

    const source = this.sources.get(pageRecord.sourceId);
    if (!source) return;

    const token = ++this.renderToken;
    if (this.currentRenderTask) {
      this.currentRenderTask.cancel();
      this.currentRenderTask = null;
    }

    try {
      const page = await source.pdfjsDoc.getPage(pageRecord.sourcePageIndex + 1);
      if (token !== this.renderToken) return;

      const rotation = this.getPageRotation(pageRecord);
      const baseViewport = page.getViewport({ scale: 1, rotation });
      const horizontalPadding = matchMedia("(max-width: 720px)").matches ? 40 : 88;
      const availableWidth = Math.max(
        260,
        this.elements.viewerScroll.clientWidth - horizontalPadding
      );
      const fitScale = Math.min(
        1.5,
        Math.max(0.22, availableWidth / baseViewport.width)
      );
      const viewport = page.getViewport({
        scale: fitScale * this.zoom,
        rotation,
      });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2.5);
      const canvas = this.elements.pdfCanvas;
      const context = canvas.getContext("2d", { alpha: false });

      canvas.width = Math.ceil(viewport.width * outputScale);
      canvas.height = Math.ceil(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      this.elements.pageStage.style.width = `${viewport.width}px`;
      this.elements.pageStage.style.height = `${viewport.height}px`;

      this.currentViewport = viewport;
      this.currentRenderedPageId = pageRecord.id;
      this.renderAnnotations();

      this.currentRenderTask = page.render({
        canvasContext: context,
        viewport,
        transform:
          outputScale === 1
            ? null
            : [outputScale, 0, 0, outputScale, 0, 0],
      });
      await this.currentRenderTask.promise;
      if (token !== this.renderToken) return;
      this.currentRenderTask = null;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") {
        console.error("[PDF Editor] Page render failed", error);
        this.toast("頁面預覽失敗，請嘗試重新開啟文件。", "error");
      }
    }
  }

  renderAnnotations() {
    const layer = this.elements.annotationLayer;
    layer.replaceChildren();
    layer.classList.toggle("placing", this.textPlacementArmed);

    const pageRecord = this.pages.find(
      (page) => page.id === this.currentRenderedPageId
    );
    if (!pageRecord || !this.currentViewport) return;

    for (const annotation of pageRecord.annotations) {
      if (annotation.type !== "text") continue;
      const [left, bottom] = this.currentViewport.convertToViewportPoint(
        annotation.x,
        annotation.y
      );
      const metrics = this.getAnnotationMetrics(annotation);
      const item = document.createElement("div");
      item.className = `annotation-item${
        annotation.id === this.selectedAnnotationId ? " selected" : ""
      }`;
      item.dataset.annotationId = annotation.id;
      item.tabIndex = 0;
      item.textContent = annotation.text;
      item.style.left = `${left}px`;
      item.style.top = `${
        bottom - metrics.height * this.currentViewport.scale
      }px`;
      item.style.fontSize = `${annotation.fontSize * this.currentViewport.scale}px`;
      item.style.color = annotation.color;
      item.style.lineHeight = `${metrics.lineHeight * this.currentViewport.scale}px`;
      layer.append(item);
    }
  }

  getAnnotationMetrics(annotation) {
    const lines = String(annotation.text || "").split(/\r?\n/);
    const lineHeight = annotation.fontSize * 1.22;
    return {
      lines,
      lineHeight,
      height: lineHeight * Math.max(1, lines.length) + 2,
    };
  }

  handleAnnotationLayerClick(event) {
    const annotationItem = event.target.closest(".annotation-item");
    if (annotationItem) {
      this.selectedAnnotationId = annotationItem.dataset.annotationId;
      this.renderAnnotations();
      return;
    }

    this.selectedAnnotationId = null;

    if (
      !this.textPlacementArmed ||
      !this.currentViewport ||
      this.currentRenderedPageId !== this.activePageId
    ) {
      this.renderAnnotations();
      return;
    }

    const text = this.elements.annotationText.value.trim();
    const fontSize = Number(this.elements.annotationSize.value);
    if (!text || !Number.isFinite(fontSize)) {
      this.toast("請先輸入文字內容與有效大小。", "error");
      return;
    }

    const rect = this.elements.annotationLayer.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const draft = {
      id: makeId("annotation"),
      type: "text",
      text,
      fontSize: Math.min(72, Math.max(6, fontSize)),
      color: this.elements.annotationColor.value,
      x: 0,
      y: 0,
    };
    const metrics = this.getAnnotationMetrics(draft);
    const [pdfX, pdfY] = this.currentViewport.convertToPdfPoint(
      clickX,
      clickY + metrics.height * this.currentViewport.scale
    );
    draft.x = pdfX;
    draft.y = pdfY;

    this.mutate(
      () => {
        const page = this.pages.find((item) => item.id === this.activePageId);
        page.annotations.push(draft);
        this.selectedAnnotationId = draft.id;
      },
      { sidebar: false }
    );

    this.textPlacementArmed = false;
    this.elements.armTextButton.textContent = "準備放置";
    this.elements.textToolHint.textContent =
      "文字已加入，可再次準備放置，或直接拖曳文字調整位置。";
    this.renderAnnotations();
    this.toast("文字已加入，可拖曳調整位置。", "success");
  }

  handleAnnotationPointerDown(event) {
    const item = event.target.closest(".annotation-item");
    if (!item || !this.currentViewport) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = item.getBoundingClientRect();
    const layerRect = this.elements.annotationLayer.getBoundingClientRect();
    this.selectedAnnotationId = item.dataset.annotationId;
    this.annotationDrag = {
      annotationId: item.dataset.annotationId,
      pageId: this.activePageId,
      item,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: rect.left - layerRect.left,
      startTop: rect.top - layerRect.top,
      currentLeft: rect.left - layerRect.left,
      currentTop: rect.top - layerRect.top,
      moved: false,
    };
    item.setPointerCapture?.(event.pointerId);
    this.renderAnnotationsSelectionOnly();
  }

  handleAnnotationPointerMove(event) {
    const drag = this.annotationDrag;
    if (!drag || !drag.item?.isConnected) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 3) return;

    if (!drag.moved) {
      this.pushHistory();
      drag.moved = true;
    }

    const layer = this.elements.annotationLayer;
    const maxLeft = Math.max(0, layer.clientWidth - drag.item.offsetWidth);
    const maxTop = Math.max(0, layer.clientHeight - drag.item.offsetHeight);
    drag.currentLeft = Math.min(maxLeft, Math.max(0, drag.startLeft + deltaX));
    drag.currentTop = Math.min(maxTop, Math.max(0, drag.startTop + deltaY));
    drag.item.style.left = `${drag.currentLeft}px`;
    drag.item.style.top = `${drag.currentTop}px`;
  }

  handleAnnotationPointerUp() {
    const drag = this.annotationDrag;
    if (!drag) return;

    if (drag.moved && this.currentViewport && drag.pageId === this.activePageId) {
      const bottom = drag.currentTop + drag.item.offsetHeight;
      const [pdfX, pdfY] = this.currentViewport.convertToPdfPoint(
        drag.currentLeft,
        bottom
      );
      const page = this.pages.find((item) => item.id === drag.pageId);
      const annotation = page?.annotations.find(
        (item) => item.id === drag.annotationId
      );
      if (annotation) {
        annotation.x = pdfX;
        annotation.y = pdfY;
        this.redoStack = [];
        this.dirty = true;
      }
      this.updateUI();
    }

    this.annotationDrag = null;
    this.renderAnnotations();
  }

  renderAnnotationsSelectionOnly() {
    $$(".annotation-item").forEach((item) => {
      item.classList.toggle(
        "selected",
        item.dataset.annotationId === this.selectedAnnotationId
      );
    });
  }

  selectPage(pageId) {
    if (this.activePageId === pageId) {
      this.updateUI();
      this.renderSidebar();
      return;
    }
    this.activePageId = pageId;
    this.selectedAnnotationId = null;
    this.updateUI();
    this.renderSidebar();
    this.renderActivePage();
    this.elements.viewerScroll.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    if (matchMedia("(max-width: 720px)").matches) {
      document.body.classList.remove("sidebar-visible");
    }
  }

  reorderPage(draggedId, targetId) {
    const from = this.pages.findIndex((page) => page.id === draggedId);
    const to = this.pages.findIndex((page) => page.id === targetId);
    if (from < 0 || to < 0 || from === to) return;

    this.mutate(() => {
      const [moved] = this.pages.splice(from, 1);
      const insertionIndex = this.pages.findIndex((page) => page.id === targetId);
      this.pages.splice(insertionIndex, 0, moved);
      this.activePageId = moved.id;
      this.selectedPageIds = new Set([moved.id]);
    });
  }

  movePage(pageId, delta) {
    const index = this.pages.findIndex((page) => page.id === pageId);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= this.pages.length) return;

    this.mutate(() => {
      const [moved] = this.pages.splice(index, 1);
      this.pages.splice(targetIndex, 0, moved);
      this.activePageId = pageId;
      this.selectedPageIds = new Set([pageId]);
    });
  }

  rotateSelectedPages() {
    const targetIds = this.getTargetPageIds();
    if (!targetIds.length) return;
    this.mutate(() => {
      for (const page of this.pages) {
        if (targetIds.includes(page.id)) {
          page.rotation = normalizedRotation(page.rotation + 90);
        }
      }
    });
    this.toast(`${targetIds.length} 頁已旋轉 90 度。`, "success");
  }

  async deleteSelection() {
    if (this.selectedAnnotationId) {
      this.deleteSelectedAnnotation();
      return;
    }

    const targetIds = this.getTargetPageIds();
    if (!targetIds.length) return;
    const confirmed = await this.confirmAction({
      title: `刪除 ${targetIds.length} 頁？`,
      message:
        targetIds.length === this.pages.length
          ? "這會移除目前文件中的所有頁面，仍可使用復原取回。"
          : "選取的頁面會從輸出的 PDF 中移除，仍可使用復原取回。",
      acceptLabel: "刪除頁面",
    });
    if (!confirmed) return;

    const firstIndex = this.pages.findIndex((page) => targetIds.includes(page.id));
    this.mutate(() => {
      this.pages = this.pages.filter((page) => !targetIds.includes(page.id));
      this.selectedPageIds.clear();
      this.selectedAnnotationId = null;
      this.activePageId =
        this.pages[Math.min(firstIndex, this.pages.length - 1)]?.id || null;
    });
    this.toast(`已刪除 ${targetIds.length} 頁。`, "success");
  }

  deleteSelectedAnnotation() {
    const annotationId = this.selectedAnnotationId;
    if (!annotationId) return;
    this.mutate(
      () => {
        const page = this.pages.find((item) => item.id === this.activePageId);
        if (page) {
          page.annotations = page.annotations.filter(
            (annotation) => annotation.id !== annotationId
          );
        }
        this.selectedAnnotationId = null;
      },
      { sidebar: false }
    );
    this.toast("文字標註已刪除。", "success");
  }

  getTargetPageIds() {
    if (this.selectedPageIds.size) return [...this.selectedPageIds];
    return this.activePageId ? [this.activePageId] : [];
  }

  getPageRotation(pageRecord) {
    return normalizedRotation(pageRecord.baseRotation + pageRecord.rotation);
  }

  mutate(mutator, { sidebar = true } = {}) {
    this.pushHistory();
    mutator();
    this.redoStack = [];
    this.dirty = true;
    this.normalizeState();
    this.updateUI();
    if (sidebar) this.renderSidebar();
    this.renderActivePage();
  }

  pushHistory() {
    this.undoStack.push(clonePages(this.pages));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(clonePages(this.pages));
    this.pages = this.undoStack.pop();
    this.dirty = true;
    this.selectedAnnotationId = null;
    this.normalizeState();
    this.renderAll();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(clonePages(this.pages));
    this.pages = this.redoStack.pop();
    this.dirty = true;
    this.selectedAnnotationId = null;
    this.normalizeState();
    this.renderAll();
  }

  changeZoom(delta) {
    this.zoom = Math.min(2.5, Math.max(0.5, this.zoom + delta));
    this.updateUI();
    this.renderActivePage();
  }

  toggleTextControls() {
    const willOpen = this.elements.textControls.hidden;
    this.elements.textControls.hidden = !willOpen;
    this.elements.textToolButton.classList.toggle("active", willOpen);
    if (willOpen) {
      this.elements.annotationText.focus();
    } else {
      this.textPlacementArmed = false;
      this.elements.armTextButton.textContent = "準備放置";
      this.renderAnnotations();
    }
  }

  closeTextControls() {
    this.elements.textControls.hidden = true;
    this.elements.textToolButton.classList.remove("active");
    this.textPlacementArmed = false;
    this.elements.armTextButton.textContent = "準備放置";
    this.elements.textToolHint.textContent =
      "輸入內容後，點選「準備放置」，再點頁面位置。";
    this.renderAnnotations();
  }

  toggleTextPlacement() {
    if (this.textPlacementArmed) {
      this.textPlacementArmed = false;
      this.elements.armTextButton.textContent = "準備放置";
      this.elements.textToolHint.textContent =
        "已取消放置。輸入內容後可再次準備。";
      this.renderAnnotations();
      return;
    }

    const text = this.elements.annotationText.value.trim();
    const size = Number(this.elements.annotationSize.value);
    if (!text) {
      this.elements.annotationText.focus();
      this.toast("請先輸入要加入的文字。", "error");
      return;
    }
    if (!Number.isFinite(size) || size < 6 || size > 72) {
      this.elements.annotationSize.focus();
      this.toast("文字大小請設定在 6 到 72 之間。", "error");
      return;
    }

    this.textPlacementArmed = true;
    this.elements.armTextButton.textContent = "取消放置";
    this.elements.textToolHint.textContent = "現在請點一下頁面上的放置位置。";
    this.renderAnnotations();
    this.elements.viewerScroll.focus();
  }

  async exportPages(pageIds, { mode = "download", suffix = "edited" } = {}) {
    const idSet = new Set(pageIds);
    const records = this.pages.filter((page) => idSet.has(page.id));
    if (!records.length) {
      this.toast("請先選取要輸出的頁面。", "error");
      return;
    }

    const fileName = this.buildOutputFileName(suffix);
    let fileHandle = null;

    if (mode === "download" && "showSaveFilePicker" in window) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: "PDF 文件",
              accept: { "application/pdf": [".pdf"] },
            },
          ],
        });
      } catch (error) {
        if (error?.name === "AbortError") return;
        fileHandle = null;
      }
    }

    this.setBusy(true, "正在建立 PDF", `準備輸出 ${records.length} 頁`, 2);

    try {
      const output = await PDFDocument.create();
      output.setTitle(fileName.replace(/\.pdf$/i, ""));
      output.setCreator("PDF 工坊");
      output.setProducer("PDF 工坊 / pdf-lib");
      output.setModificationDate(new Date());
      await document.fonts?.ready;
      const needsVectorFont = records.some(
        (record) =>
          record.annotations.length > 0 && this.getPageRotation(record) === 0
      );
      const annotationFont = needsVectorFont
        ? await this.loadAnnotationFont(output)
        : null;

      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const source = this.sources.get(record.sourceId);
        if (!source) throw new Error("找不到頁面來源");

        this.setBusy(
          true,
          "正在建立 PDF",
          `處理第 ${index + 1} / ${records.length} 頁`,
          5 + Math.round((index / records.length) * 78)
        );

        const rotation = this.getPageRotation(record);
        const canDrawAsVector =
          record.annotations.length > 0 &&
          rotation === 0 &&
          this.canEncodeAnnotations(record.annotations, annotationFont);

        if (record.annotations.length && !canDrawAsVector) {
          await this.addRasterizedAnnotatedPage(output, record);
        } else {
          const [copiedPage] = await output.copyPages(source.pdfLibDoc, [
            record.sourcePageIndex,
          ]);
          output.addPage(copiedPage);
          copiedPage.setRotation(degrees(rotation));
          if (record.annotations.length) {
            this.drawVectorAnnotations(
              copiedPage,
              record.annotations,
              annotationFont
            );
          }
        }
      }

      this.setBusy(true, "正在建立 PDF", "寫入檔案資料", 88);
      const bytes = await output.save({
        useObjectStreams: true,
        addDefaultPage: false,
      });
      const blob = new Blob([bytes], { type: "application/pdf" });

      if (mode === "share") {
        const file = new File([blob], fileName, { type: "application/pdf" });
        if (!navigator.canShare?.({ files: [file] })) {
          throw new Error("此瀏覽器不支援分享 PDF 檔案");
        }
        this.setBusy(false);
        await navigator.share({
          title: fileName,
          text: "由 PDF 工坊匯出的文件",
          files: [file],
        });
      } else if (fileHandle) {
        this.setBusy(true, "正在儲存 PDF", fileName, 96);
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        this.setBusy(false);
      } else {
        this.downloadBlob(blob, fileName);
        this.setBusy(false);
      }

      this.dirty = false;
      this.updateUI();
      this.toast(
        mode === "share" ? "PDF 已交由系統分享。" : `已輸出 ${records.length} 頁 PDF。`,
        "success"
      );
    } catch (error) {
      this.setBusy(false);
      if (error?.name === "AbortError") return;
      console.error("[PDF Editor] Export failed", error);
      this.toast(
        error?.message === "此瀏覽器不支援分享 PDF 檔案"
          ? error.message
          : "PDF 輸出失敗；請確認文件未損壞並再試一次。",
        "error",
        8000
      );
    }
  }

  async loadAnnotationFont(outputDocument) {
    if (!window.fontkit) {
      throw new Error("中文字型元件載入失敗");
    }
    outputDocument.registerFontkit(window.fontkit);
    if (!this.annotationFontBytesPromise) {
      this.annotationFontBytesPromise = fetch(
        "./vendor/pdf-lib/NotoSansCJKtc-Regular.otf"
      ).then((response) => {
        if (!response.ok) throw new Error("中文字型檔案讀取失敗");
        return response.arrayBuffer();
      });
    }
    const fontBytes = await this.annotationFontBytesPromise;
    return outputDocument.embedFont(fontBytes.slice(0), {
      subset: true,
      features: { liga: false },
    });
  }

  drawVectorAnnotations(page, annotations, font) {
    for (const annotation of annotations) {
      if (annotation.type !== "text") continue;
      const metrics = this.getAnnotationMetrics(annotation);
      const color = this.hexToRgb(annotation.color);
      const firstBaseline =
        annotation.y + metrics.height - annotation.fontSize - 1;
      metrics.lines.forEach((line, index) => {
        page.drawText(line || " ", {
          x: annotation.x,
          y: firstBaseline - index * metrics.lineHeight,
          size: annotation.fontSize,
          font,
          color: window.PDFLib.rgb(color.r, color.g, color.b),
        });
      });
    }
  }

  canEncodeAnnotations(annotations, font) {
    if (!font) return false;
    try {
      annotations
        .filter((annotation) => annotation.type === "text")
        .forEach((annotation) => font.encodeText(annotation.text));
      return true;
    } catch {
      return false;
    }
  }

  async addRasterizedAnnotatedPage(outputDocument, record) {
    const source = this.sources.get(record.sourceId);
    const pdfPage = await source.pdfjsDoc.getPage(record.sourcePageIndex + 1);
    const rotation = this.getPageRotation(record);
    const baseViewport = pdfPage.getViewport({ scale: 1, rotation });
    const renderScale = Math.max(
      0.65,
      Math.min(2.25, 3200 / Math.max(baseViewport.width, baseViewport.height))
    );
    const viewport = pdfPage.getViewport({ scale: renderScale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({
      canvasContext: context,
      viewport,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    }).promise;

    const fontFamily =
      '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", Arial, sans-serif';
    for (const annotation of record.annotations) {
      if (annotation.type !== "text") continue;
      const metrics = this.getAnnotationMetrics(annotation);
      const [left, bottom] = viewport.convertToViewportPoint(
        annotation.x,
        annotation.y
      );
      context.fillStyle = annotation.color;
      context.font = `${annotation.fontSize * renderScale}px ${fontFamily}`;
      context.textBaseline = "top";
      metrics.lines.forEach((line, index) => {
        context.fillText(
          line,
          left,
          bottom -
            metrics.height * renderScale +
            1 +
            index * metrics.lineHeight * renderScale
        );
      });
    }

    const image = await outputDocument.embedJpg(
      canvas.toDataURL("image/jpeg", 0.94)
    );
    const pageWidth = viewport.width / renderScale;
    const pageHeight = viewport.height / renderScale;
    const outputPage = outputDocument.addPage([pageWidth, pageHeight]);
    outputPage.drawImage(image, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });
  }

  hexToRgb(hex) {
    const normalized = String(hex || "#172033")
      .replace("#", "")
      .padEnd(6, "0")
      .slice(0, 6);
    return {
      r: parseInt(normalized.slice(0, 2), 16) / 255,
      g: parseInt(normalized.slice(2, 4), 16) / 255,
      b: parseInt(normalized.slice(4, 6), 16) / 255,
    };
  }

  buildOutputFileName(suffix) {
    const firstPage = this.pages[0];
    const sourceName =
      this.sources.get(firstPage?.sourceId)?.name || "document.pdf";
    const baseName = sourceName.replace(/\.pdf$/i, "").trim() || "document";
    return `${this.sanitizeFileName(baseName)}-${suffix}.pdf`;
  }

  sanitizeFileName(value) {
    return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 90);
  }

  downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  handleKeyboard(event) {
    const isTyping =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target?.isContentEditable;
    const command = event.metaKey || event.ctrlKey;

    if (command && event.key.toLowerCase() === "o") {
      event.preventDefault();
      this.elements.openFileInput.click();
      return;
    }
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (isTyping) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.deleteSelection();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.changeZoom(0.15);
    } else if (event.key === "-") {
      event.preventDefault();
      this.changeZoom(-0.15);
    } else if (event.key.toLowerCase() === "r" && this.pages.length) {
      event.preventDefault();
      this.rotateSelectedPages();
    } else if (event.key === "Escape") {
      this.textPlacementArmed = false;
      this.selectedAnnotationId = null;
      this.elements.armTextButton.textContent = "準備放置";
      this.renderAnnotations();
    }
  }

  setBusy(show, title = "", detail = "", progress = 0) {
    this.elements.busyOverlay.hidden = !show;
    if (!show) return;
    this.elements.busyTitle.textContent = title;
    this.elements.busyDetail.textContent = detail;
    this.elements.busyProgress.style.width = `${Math.min(
      100,
      Math.max(0, progress)
    )}%`;
  }

  toast(message, type = "default", duration = 4200) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const icon = document.createElement("span");
    icon.innerHTML =
      type === "error"
        ? '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg>'
        : '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></svg>';
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(icon, text);
    this.elements.toastRegion.append(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(6px)";
      setTimeout(() => toast.remove(), 180);
    }, duration);
  }

  confirmAction({ title, message, acceptLabel = "確認" }) {
    const dialog = this.elements.confirmDialog;
    if (!dialog?.showModal) return Promise.resolve(window.confirm(message));
    this.elements.confirmTitle.textContent = title;
    this.elements.confirmMessage.textContent = message;
    this.elements.confirmAcceptButton.textContent = acceptLabel;
    dialog.returnValue = "cancel";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener(
        "close",
        () => resolve(dialog.returnValue === "confirm"),
        { once: true }
      );
    });
  }

  formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(
      units.length - 1,
      Math.floor(Math.log(bytes) / Math.log(1024))
    );
    const value = bytes / 1024 ** index;
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  updateConnectivity() {
    const dot = this.elements.offlineStatus.querySelector(".status-dot");
    const text = this.elements.offlineStatus.querySelector("span:last-child");
    const online = navigator.onLine;
    dot.classList.toggle("offline", !online);
    text.textContent = online ? "本機模式" : "離線模式";
  }

  async registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (error) {
      console.warn("[PDF Editor] Service worker registration failed", error);
    }
  }

  registerFileHandler() {
    if (!("launchQueue" in window)) return;
    window.launchQueue.setConsumer(async (launchParams) => {
      const files = [];
      for (const handle of launchParams.files || []) {
        try {
          files.push(await handle.getFile());
        } catch (error) {
          console.warn("[PDF Editor] Could not read launched file", error);
        }
      }
      if (!files.length) return;
      if (this.pages.length) {
        const confirmed = await this.confirmAction({
          title: "開啟外部 PDF？",
          message: "目前尚未匯出的編輯內容將被外部文件取代。",
          acceptLabel: "開啟文件",
        });
        if (!confirmed) return;
      }
      await this.loadFiles(files, { replace: true });
    });
  }
}

const app = new PdfWorkshop();
app.init();
