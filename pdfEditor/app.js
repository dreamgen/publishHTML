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
const EDITOR_DB_NAME = "pdfEditor-db";
const EDITOR_DB_VERSION = 1;
const AUTOSAVE_KEY = "autosave";
const SHARE_CACHE_NAME = "pdfEditor-share-inbox";

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
    this.currentTextLayerTask = null;
    this.renderToken = 0;
    this.thumbnailGeneration = 0;
    this.draggedPageId = null;
    this.annotationDrag = null;
    this.activeTool = "select";
    this.drawingDraft = null;
    this.drawingFrame = null;
    this.dragDepth = 0;
    this.resizeTimer = null;
    this.autosaveTimer = null;
    this.dbPromise = null;
    this.restoringAutosave = false;
    this.annotationFontBytesPromise = null;
    this.signatureDrawing = false;
    this.signatureHasInk = false;
    this.textIndex = new Map();
    this.searchMatches = [];
    this.searchCursor = -1;
    this.searchBuildToken = 0;
    this.searchDebounceTimer = null;
    this.ocrWorker = null;
    this.ocrRunning = false;
    this.ocrCancelled = false;
    this.ocrPageNumber = 0;
    this.ocrPageTotal = 0;
    this.selectedPageText = "";

    this.elements = {
      openButton: $("#openButton"),
      emptyOpenButton: $("#emptyOpenButton"),
      mergeButton: $("#mergeButton"),
      insertButton: $("#insertButton"),
      shareButton: $("#shareButton"),
      themeButton: $("#themeButton"),
      exportButton: $("#exportButton"),
      openFileInput: $("#openFileInput"),
      mergeFileInput: $("#mergeFileInput"),
      annotationImageInput: $("#annotationImageInput"),
      imageToPdfInput: $("#imageToPdfInput"),
      sidebar: $("#sidebar"),
      openSidebarButton: $("#openSidebarButton"),
      closeSidebarButton: $("#closeSidebarButton"),
      pageList: $("#pageList"),
      pageCount: $("#pageCount"),
      selectAllCheckbox: $("#selectAllCheckbox"),
      rangeButton: $("#rangeButton"),
      extractButton: $("#extractButton"),
      undoButton: $("#undoButton"),
      redoButton: $("#redoButton"),
      rotateButton: $("#rotateButton"),
      deleteButton: $("#deleteButton"),
      textToolButton: $("#textToolButton"),
      penToolButton: $("#penToolButton"),
      highlightToolButton: $("#highlightToolButton"),
      rectToolButton: $("#rectToolButton"),
      arrowToolButton: $("#arrowToolButton"),
      imageToolButton: $("#imageToolButton"),
      signatureToolButton: $("#signatureToolButton"),
      formToolButton: $("#formToolButton"),
      searchToolButton: $("#searchToolButton"),
      ocrToolButton: $("#ocrToolButton"),
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
      drawingControls: $("#drawingControls"),
      drawingToolName: $("#drawingToolName"),
      drawingToolHint: $("#drawingToolHint"),
      drawingColor: $("#drawingColor"),
      drawingWidth: $("#drawingWidth"),
      drawingWidthValue: $("#drawingWidthValue"),
      closeDrawingButton: $("#closeDrawingButton"),
      searchControls: $("#searchControls"),
      searchInput: $("#searchInput"),
      searchResultStatus: $("#searchResultStatus"),
      searchPreviousButton: $("#searchPreviousButton"),
      searchNextButton: $("#searchNextButton"),
      closeSearchButton: $("#closeSearchButton"),
      viewerScroll: $("#viewerScroll"),
      emptyState: $("#emptyState"),
      documentView: $("#documentView"),
      pageStage: $("#pageStage"),
      pdfCanvas: $("#pdfCanvas"),
      textLayer: $("#textLayer"),
      ocrSelectionLayer: $("#ocrSelectionLayer"),
      copySelectedTextButton: $("#copySelectedTextButton"),
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
      recentFiles: $("#recentFiles"),
      recentFileList: $("#recentFileList"),
      passwordDialog: $("#passwordDialog"),
      passwordFileName: $("#passwordFileName"),
      passwordInput: $("#passwordInput"),
      passwordError: $("#passwordError"),
      insertDialog: $("#insertDialog"),
      blankPortraitButton: $("#blankPortraitButton"),
      blankLandscapeButton: $("#blankLandscapeButton"),
      imageToPdfButton: $("#imageToPdfButton"),
      rangeDialog: $("#rangeDialog"),
      rangeInput: $("#rangeInput"),
      rangeError: $("#rangeError"),
      rangeAcceptButton: $("#rangeAcceptButton"),
      signatureDialog: $("#signatureDialog"),
      signatureCanvas: $("#signatureCanvas"),
      clearSignatureButton: $("#clearSignatureButton"),
      saveSignatureButton: $("#saveSignatureButton"),
      formDialog: $("#formDialog"),
      formFieldList: $("#formFieldList"),
      applyFormButton: $("#applyFormButton"),
      ocrDialog: $("#ocrDialog"),
      ocrCloseButton: $("#ocrCloseButton"),
      ocrScope: $("#ocrScope"),
      ocrLanguage: $("#ocrLanguage"),
      ocrSkipTextPages: $("#ocrSkipTextPages"),
      ocrProgressPanel: $("#ocrProgressPanel"),
      ocrProgressTitle: $("#ocrProgressTitle"),
      ocrProgressDetail: $("#ocrProgressDetail"),
      ocrProgressBar: $("#ocrProgressBar"),
      ocrResultField: $("#ocrResultField"),
      ocrResultText: $("#ocrResultText"),
      copyOcrButton: $("#copyOcrButton"),
      cancelOcrButton: $("#cancelOcrButton"),
      startOcrButton: $("#startOcrButton"),
    };
  }

  async init() {
    if (!PDFDocument) {
      this.toast("PDF 編輯元件載入失敗，請重新整理頁面。", "error", 8000);
      return;
    }

    this.ensureRuntimeLayers();
    this.applySavedTheme();
    this.bindEvents();
    this.updateConnectivity();
    this.updateUI();
    this.renderRecentFiles();
    this.registerServiceWorker();
    this.registerFileHandler();

    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }

    const openAction =
      new URLSearchParams(location.search).get("action") === "open";
    if (openAction) {
      setTimeout(() => this.elements.openFileInput.click(), 350);
    }

    const consumedSharedFile = await this.consumeSharedFile();
    if (!consumedSharedFile && !openAction) {
      await this.offerAutosaveRestore();
    }
  }

  ensureRuntimeLayers() {
    const { pageStage, annotationLayer } = this.elements;
    if (!pageStage || !annotationLayer) return;
    if (!this.elements.textLayer) {
      const layer = document.createElement("div");
      layer.id = "textLayer";
      layer.className = "textLayer selection-text-layer";
      layer.setAttribute("aria-label", "PDF 可選取文字層");
      pageStage.insertBefore(layer, annotationLayer);
      this.elements.textLayer = layer;
    }
    if (!this.elements.ocrSelectionLayer) {
      const layer = document.createElement("div");
      layer.id = "ocrSelectionLayer";
      layer.className = "ocr-selection-layer";
      layer.setAttribute("aria-label", "OCR 可選取文字層");
      pageStage.insertBefore(layer, annotationLayer);
      this.elements.ocrSelectionLayer = layer;
    }
    if (!this.elements.copySelectedTextButton) {
      const button = document.createElement("button");
      button.id = "copySelectedTextButton";
      button.className = "copy-selection-button";
      button.type = "button";
      button.hidden = true;
      button.textContent = "複製選取文字";
      pageStage.insertBefore(button, annotationLayer);
      this.elements.copySelectedTextButton = button;
    }
  }

  bindEvents() {
    const {
      openButton,
      emptyOpenButton,
      mergeButton,
      insertButton,
      shareButton,
      themeButton,
      exportButton,
      openFileInput,
      mergeFileInput,
      annotationImageInput,
      imageToPdfInput,
      openSidebarButton,
      closeSidebarButton,
      selectAllCheckbox,
      rangeButton,
      extractButton,
      undoButton,
      redoButton,
      rotateButton,
      deleteButton,
      textToolButton,
      penToolButton,
      highlightToolButton,
      rectToolButton,
      arrowToolButton,
      imageToolButton,
      signatureToolButton,
      formToolButton,
      searchToolButton,
      ocrToolButton,
      zoomOutButton,
      zoomInButton,
      zoomResetButton,
      armTextButton,
      cancelTextButton,
      closeDrawingButton,
      searchInput,
      searchPreviousButton,
      searchNextButton,
      closeSearchButton,
      annotationLayer,
      viewerScroll,
    } = this.elements;

    openButton.addEventListener("click", () => openFileInput.click());
    emptyOpenButton.addEventListener("click", () => openFileInput.click());
    mergeButton.addEventListener("click", () => mergeFileInput.click());
    insertButton.addEventListener("click", () =>
      this.openDialog(this.elements.insertDialog)
    );
    themeButton.addEventListener("click", () => this.toggleTheme());
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

    annotationImageInput.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await this.insertImageAnnotation(file);
    });

    imageToPdfInput.addEventListener("change", async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      if (files.length) await this.convertImagesToPdf(files);
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

    rangeButton.addEventListener("click", () => {
      this.elements.rangeInput.value = "";
      this.elements.rangeError.hidden = true;
      this.openDialog(this.elements.rangeDialog);
      setTimeout(() => this.elements.rangeInput.focus(), 50);
    });
    this.elements.rangeAcceptButton.addEventListener("click", (event) => {
      event.preventDefault();
      this.applyPageRange();
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
    penToolButton.addEventListener("click", () => this.activateDrawingTool("pen"));
    highlightToolButton.addEventListener("click", () =>
      this.activateDrawingTool("highlight")
    );
    rectToolButton.addEventListener("click", () => this.activateDrawingTool("rect"));
    arrowToolButton.addEventListener("click", () =>
      this.activateDrawingTool("arrow")
    );
    imageToolButton.addEventListener("click", () => annotationImageInput.click());
    signatureToolButton.addEventListener("click", () => this.openSignatureDialog());
    formToolButton.addEventListener("click", () => this.openFormDialog());
    searchToolButton?.addEventListener("click", () =>
      this.toggleSearchControls()
    );
    ocrToolButton?.addEventListener("click", () => this.openOcrDialog());
    armTextButton.addEventListener("click", () => this.toggleTextPlacement());
    cancelTextButton.addEventListener("click", () => this.closeTextControls());
    closeDrawingButton.addEventListener("click", () => this.activateDrawingTool("select"));
    this.elements.drawingWidth.addEventListener("input", () => {
      this.elements.drawingWidthValue.textContent =
        this.elements.drawingWidth.value;
    });

    this.elements.blankPortraitButton.addEventListener("click", async () => {
      this.closeDialog(this.elements.insertDialog);
      await this.insertBlankPage("portrait");
    });
    this.elements.blankLandscapeButton.addEventListener("click", async () => {
      this.closeDialog(this.elements.insertDialog);
      await this.insertBlankPage("landscape");
    });
    this.elements.imageToPdfButton.addEventListener("click", () => {
      this.closeDialog(this.elements.insertDialog);
      imageToPdfInput.click();
    });

    this.bindSignaturePad();
    this.elements.clearSignatureButton.addEventListener("click", () =>
      this.clearSignaturePad()
    );
    this.elements.saveSignatureButton.addEventListener("click", () =>
      this.saveSignature()
    );
    this.elements.applyFormButton.addEventListener("click", () =>
      this.applyFormValues()
    );
    searchInput?.addEventListener("input", () => {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = setTimeout(() => this.performSearch(), 240);
    });
    searchInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (this.searchMatches.length) {
        this.stepSearch(event.shiftKey ? -1 : 1);
      } else {
        this.performSearch();
      }
    });
    searchPreviousButton?.addEventListener("click", () => this.stepSearch(-1));
    searchNextButton?.addEventListener("click", () => this.stepSearch(1));
    closeSearchButton?.addEventListener("click", () =>
      this.closeSearchControls()
    );
    this.elements.startOcrButton?.addEventListener("click", () =>
      this.startOcr()
    );
    this.elements.cancelOcrButton?.addEventListener("click", () =>
      this.cancelOcr()
    );
    this.elements.copyOcrButton?.addEventListener("click", () =>
      this.copyOcrText()
    );
    this.elements.ocrDialog?.addEventListener("cancel", (event) => {
      if (!this.ocrRunning) return;
      event.preventDefault();
      this.cancelOcr();
    });
    document.addEventListener("click", (event) => {
      const button = event.target.closest(
        "dialog.dialog-fallback-open button[value]"
      );
      const dialog = button?.closest("dialog");
      if (!dialog) return;
      event.preventDefault();
      this.closeDialog(dialog, button.value);
    });
    document.addEventListener("submit", (event) => {
      const dialog = event.target.closest?.("dialog.dialog-fallback-open");
      if (!dialog) return;
      event.preventDefault();
      if (dialog === this.elements.rangeDialog) {
        this.applyPageRange();
        return;
      }
      this.closeDialog(dialog, event.submitter?.value || "confirm");
    });
    document.addEventListener("selectionchange", () =>
      this.updateSelectedPageText()
    );
    this.elements.copySelectedTextButton?.addEventListener(
      "pointerdown",
      (event) => event.preventDefault()
    );
    this.elements.copySelectedTextButton?.addEventListener("click", () =>
      this.copySelectedPageText()
    );

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
    window.addEventListener("pointercancel", (event) =>
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
      const pdfFiles = files.filter(
        (file) =>
          file.type === "application/pdf" ||
          file.name.toLowerCase().endsWith(".pdf")
      );
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (pdfFiles.length) {
        await this.loadFiles(pdfFiles, { replace: !this.pages.length });
      }
      if (imageFiles.length) {
        await this.convertImagesToPdf(imageFiles);
      }
      if (!pdfFiles.length && !imageFiles.length && files.length) {
        this.toast("請拖入 PDF 或圖片檔案。", "error");
      }
    });

    new ResizeObserver(() => {
      if (!this.pages.length) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.renderActivePage(), 120);
    }).observe(viewerScroll);
  }

  async loadFiles(fileList, { replace = false, remember = true } = {}) {
    const files = fileList.filter(
      (file) =>
        file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    );

    if (!files.length) {
      this.toast("請選擇 PDF 檔案。", "error");
      return [];
    }

    this.setBusy(true, "正在讀取 PDF", `準備載入 ${files.length} 個檔案`, 0);
    const loaded = [];
    const errors = [];
    let newPageIds = [];

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
        this.textIndex.clear();
        this.undoStack = [];
        this.redoStack = [];
      } else {
        this.pushHistory();
      }

      newPageIds = [];
      for (const { source, pages } of loaded) {
        this.sources.set(source.id, source);
        this.pages.push(...pages);
        newPageIds.push(...pages.map((page) => page.id));
      }

      this.activePageId = newPageIds[0] || this.activePageId;
      this.selectedPageIds = new Set(newPageIds.slice(0, 1));
      this.selectedAnnotationId = null;
      this.searchBuildToken += 1;
      this.searchMatches = [];
      this.searchCursor = -1;
      this.dirty = !replace || loaded.length > 1;
      this.zoom = 1;
      this.closeTextControls();
      this.activateDrawingTool("select");
      this.renderAll();
      if (remember) this.rememberRecentFiles(files);
      this.scheduleAutosave();
      if (
        this.elements.searchControls &&
        !this.elements.searchControls.hidden &&
        this.elements.searchInput.value.trim()
      ) {
        this.performSearch();
      }

      const pageTotal = loaded.reduce((sum, item) => sum + item.pages.length, 0);
      const encryptedCount = loaded.filter((item) => item.source.encrypted).length;
      this.toast(
        replace
          ? `已開啟 ${pageTotal} 頁 PDF。`
          : `已加入 ${files.length - errors.length} 份文件、${pageTotal} 頁。`,
        "success"
      );
      if (encryptedCount) {
        this.toast(
          `已解鎖 ${encryptedCount} 份受保護文件；匯出時會重建為無密碼 PDF。`,
          "success",
          7000
        );
      }
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
          ? `${errors.length} 個受保護檔案未解鎖或密碼不正確。`
          : `${errors.length} 個檔案讀取失敗，請確認檔案是否完整。`,
        "error",
        7000
      );
    }
    return newPageIds;
  }

  async loadSource(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.loadSourceFromBytes({
      bytes,
      name: file.name,
      size: file.size,
    });
  }

  async loadSourceFromBytes({ bytes, name, size, sourceId = makeId("source") }) {
    let passwordWasRequested = false;
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

    loadingTask.onPassword = async (updatePassword, reason) => {
      passwordWasRequested = true;
      const password = await this.requestPassword(
        name,
        reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      );
      updatePassword(
        password === null ? new Error("Password entry cancelled") : password
      );
    };

    let pdfjsDoc;
    try {
      pdfjsDoc = await loadingTask.promise;
    } catch (error) {
      await loadingTask.destroy().catch(() => {});
      throw error;
    }

    let pdfLibDoc = null;
    let encrypted = passwordWasRequested;
    if (!encrypted) {
      try {
        pdfLibDoc = await PDFDocument.load(bytes, {
          ignoreEncryption: false,
          updateMetadata: false,
        });
      } catch (error) {
        if (/encrypt|password/i.test(error?.message || "")) {
          encrypted = true;
        } else {
          await loadingTask.destroy().catch(() => {});
          throw error;
        }
      }
    }

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
        name,
        size,
        bytes,
        loadingTask,
        pdfjsDoc,
        pdfLibDoc,
        encrypted,
      },
      pages,
    };
  }

  requestPassword(fileName, incorrect = false) {
    const dialog = this.elements.passwordDialog;
    this.elements.passwordFileName.textContent = fileName;
    this.elements.passwordError.hidden = !incorrect;
    this.elements.passwordInput.value = "";
    if (!this.isDialogOpen(dialog)) this.openDialog(dialog);
    setTimeout(() => this.elements.passwordInput.focus(), 40);

    return new Promise((resolve) => {
      const handleClose = () => {
        dialog.removeEventListener("close", handleClose);
        const value =
          dialog.returnValue === "confirm"
            ? this.elements.passwordInput.value
            : null;
        resolve(value || null);
      };
      dialog.addEventListener("close", handleClose, { once: true });
    });
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
      clearTimeout(this.searchDebounceTimer);
      this.searchBuildToken += 1;
      this.searchMatches = [];
      this.searchCursor = -1;
      if (this.elements.searchControls) {
        this.elements.searchControls.hidden = true;
        this.elements.searchToolButton?.classList.remove("active");
        this.elements.searchInput.value = "";
        this.elements.searchPreviousButton.disabled = true;
        this.elements.searchNextButton.disabled = true;
        this.elements.searchResultStatus.textContent = "輸入文字開始搜尋";
      }
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
    [
      this.elements.penToolButton,
      this.elements.highlightToolButton,
      this.elements.rectToolButton,
      this.elements.arrowToolButton,
      this.elements.imageToolButton,
      this.elements.signatureToolButton,
      this.elements.formToolButton,
      this.elements.searchToolButton,
      this.elements.ocrToolButton,
    ].filter(Boolean).forEach((button) => {
      button.disabled = !hasDocument;
    });
    this.elements.zoomOutButton.disabled = !hasDocument || this.zoom <= 0.5;
    this.elements.zoomInButton.disabled = !hasDocument || this.zoom >= 2.5;
    this.elements.zoomResetButton.disabled = !hasDocument;
    this.elements.extractButton.disabled = !selectedCount;
    this.elements.rangeButton.disabled = !hasDocument;
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
      const ocrPageCount = this.pages.filter(
        (page) => this.textIndex.get(page.id)?.ocr
      ).length;
      this.elements.documentStatus.textContent =
        `${this.sources.size} 份文件・${this.formatBytes(totalSize)}` +
        ([...this.sources.values()].some((source) => source.encrypted)
          ? "・含已解鎖文件"
          : "") +
        (ocrPageCount ? `・OCR ${ocrPageCount} 頁` : "") +
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
      sourceLabel.textContent = `${source?.encrypted ? "🔓 " : ""}${
        source?.name || "PDF"
      }`;
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
    this.hideSelectedPageText({ clearSelection: true });
    const pageRecord = this.pages.find((page) => page.id === this.activePageId);
    if (!pageRecord) {
      this.currentViewport = null;
      this.currentRenderedPageId = null;
      this.currentTextLayerTask?.cancel?.();
      this.currentTextLayerTask = null;
      this.elements.textLayer.replaceChildren();
      this.elements.ocrSelectionLayer.replaceChildren();
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
    if (this.currentTextLayerTask) {
      this.currentTextLayerTask.cancel();
      this.currentTextLayerTask = null;
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
      this.elements.pageStage.style.setProperty(
        "--total-scale-factor",
        viewport.scale
      );
      this.elements.textLayer.replaceChildren();
      this.elements.ocrSelectionLayer.replaceChildren();
      this.elements.ocrSelectionLayer.classList.remove("active");

      this.currentViewport = viewport;
      this.currentRenderedPageId = pageRecord.id;
      this.renderAnnotations();
      const textContentPromise = page.getTextContent().catch((error) => {
        console.warn("[PDF Editor] Selectable text layer unavailable", error);
        return null;
      });

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
      const textContent = await textContentPromise;
      if (token !== this.renderToken) return;
      await this.renderSelectableTextLayers(
        pageRecord,
        viewport,
        textContent,
        token
      );
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") {
        console.error("[PDF Editor] Page render failed", error);
        this.toast("頁面預覽失敗，請嘗試重新開啟文件。", "error");
      }
    }
  }

  async renderSelectableTextLayers(
    pageRecord,
    viewport,
    textContent,
    token
  ) {
    const nativeText = (textContent?.items || [])
      .map((item) => item?.str || "")
      .join("");
    const nativeCharacterCount = nativeText.replace(/\s/g, "").length;

    if (textContent?.items?.length) {
      this.indexNativeTextContent(pageRecord, textContent);
      try {
        const textLayerTask = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: this.elements.textLayer,
          viewport,
        });
        this.elements.textLayer.style.width =
          `${viewport.rawDims.pageWidth * viewport.scale}px`;
        this.elements.textLayer.style.height =
          `${viewport.rawDims.pageHeight * viewport.scale}px`;
        this.currentTextLayerTask = textLayerTask;
        await textLayerTask.render();
        if (token !== this.renderToken) return;
        this.currentTextLayerTask = null;
      } catch (error) {
        if (error?.name !== "AbortException") {
          console.warn("[PDF Editor] Text selection layer failed", error);
        }
      }
    }

    const ocr = this.textIndex.get(pageRecord.id)?.ocr;
    if (!ocr || nativeCharacterCount >= 8 || token !== this.renderToken) return;
    this.renderOcrSelectionLayer(pageRecord, ocr);
  }

  renderOcrSelectionLayer(pageRecord, ocr) {
    const layer = this.elements.ocrSelectionLayer;
    layer.replaceChildren();
    const words = ocr.words || [];

    if (!words.length && ocr.rawText) {
      const fallback = document.createElement("span");
      fallback.className = "ocr-selection-fallback";
      fallback.textContent = ocr.rawText;
      layer.append(fallback);
      layer.classList.add("active");
      return;
    }

    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");
    for (const word of words) {
      const adjusted = this.transformOcrBox(
        { ...word, rotation: ocr.rotation || 0 },
        this.getPageRotation(pageRecord)
      );
      const width = Math.max(
        4,
        (adjusted.x1 - adjusted.x0) * this.currentViewport.width
      );
      const height = Math.max(
        6,
        (adjusted.y1 - adjusted.y0) * this.currentViewport.height
      );
      const span = document.createElement("span");
      span.className = "ocr-selection-word";
      span.textContent = `${word.text} `;
      span.style.left = `${adjusted.x0 * this.currentViewport.width}px`;
      span.style.top = `${adjusted.y0 * this.currentViewport.height}px`;
      span.style.width = `${width}px`;
      span.style.height = `${height}px`;
      span.style.fontSize = `${height}px`;
      if (measureContext) {
        measureContext.font = `${height}px sans-serif`;
        const measuredWidth = measureContext.measureText(span.textContent).width;
        if (measuredWidth > 0) {
          span.style.transform = `scaleX(${width / measuredWidth})`;
        }
      }
      layer.append(span);
    }
    layer.classList.toggle("active", words.length > 0);
  }

  updateSelectedPageText() {
    const selection = document.getSelection();
    const button = this.elements.copySelectedTextButton;
    if (!selection || selection.isCollapsed || !selection.rangeCount || !button) {
      this.selectedPageText = "";
      if (button) button.hidden = true;
      return;
    }
    const range = selection.getRangeAt(0);
    const layers = [
      this.elements.textLayer,
      this.elements.ocrSelectionLayer,
    ].filter(Boolean);
    const isPageText = layers.some(
      (layer) =>
        layer.contains(range.startContainer) && layer.contains(range.endContainer)
    );
    const text = isPageText ? selection.toString().trim() : "";
    this.selectedPageText = text;
    button.hidden = !text;
  }

  hideSelectedPageText({ clearSelection = false } = {}) {
    this.selectedPageText = "";
    if (this.elements.copySelectedTextButton) {
      this.elements.copySelectedTextButton.hidden = true;
    }
    if (clearSelection) document.getSelection()?.removeAllRanges();
  }

  async copySelectedPageText() {
    const text = this.selectedPageText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    this.toast(`已複製 ${text.length} 個字元。`, "success");
    this.hideSelectedPageText({ clearSelection: true });
  }

  renderAnnotations() {
    const layer = this.elements.annotationLayer;
    layer.replaceChildren();
    layer.classList.toggle("placing", this.textPlacementArmed);
    layer.classList.toggle(
      "drawing",
      ["pen", "highlight", "rect", "arrow"].includes(this.activeTool)
    );

    const pageRecord = this.pages.find(
      (page) => page.id === this.currentRenderedPageId
    );
    if (!pageRecord || !this.currentViewport) return;

    const searchLayer = document.createElement("div");
    searchLayer.className = "search-highlight-layer";
    searchLayer.setAttribute("aria-hidden", "true");
    layer.append(searchLayer);
    this.renderSearchHighlights(searchLayer, pageRecord);

    const vectorLayer = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    vectorLayer.classList.add("annotation-vector-layer");
    vectorLayer.setAttribute("width", this.currentViewport.width);
    vectorLayer.setAttribute("height", this.currentViewport.height);
    vectorLayer.setAttribute(
      "viewBox",
      `0 0 ${this.currentViewport.width} ${this.currentViewport.height}`
    );
    layer.append(vectorLayer);

    for (const annotation of pageRecord.annotations) {
      if (annotation.type === "text") {
        const [left, bottom] = this.currentViewport.convertToViewportPoint(
          annotation.x,
          annotation.y
        );
        const metrics = this.getAnnotationMetrics(annotation);
        const item = document.createElement("div");
        item.className = `annotation-item annotation-text${
          annotation.id === this.selectedAnnotationId ? " selected" : ""
        }`;
        item.dataset.annotationId = annotation.id;
        item.tabIndex = 0;
        item.textContent = annotation.text;
        item.style.left = `${left}px`;
        item.style.top = `${
          bottom - metrics.height * this.currentViewport.scale
        }px`;
        item.style.fontSize = `${
          annotation.fontSize * this.currentViewport.scale
        }px`;
        item.style.color = annotation.color;
        item.style.lineHeight = `${
          metrics.lineHeight * this.currentViewport.scale
        }px`;
        layer.append(item);
      } else if (annotation.type === "image") {
        const [left, bottom] = this.currentViewport.convertToViewportPoint(
          annotation.x,
          annotation.y
        );
        const item = document.createElement("img");
        item.className = `annotation-item annotation-image${
          annotation.id === this.selectedAnnotationId ? " selected" : ""
        }`;
        item.dataset.annotationId = annotation.id;
        item.tabIndex = 0;
        item.draggable = false;
        item.alt = annotation.label || "圖片標註";
        item.src = annotation.dataUrl;
        item.style.left = `${left}px`;
        item.style.top = `${
          bottom - annotation.height * this.currentViewport.scale
        }px`;
        item.style.width = `${
          annotation.width * this.currentViewport.scale
        }px`;
        item.style.height = `${
          annotation.height * this.currentViewport.scale
        }px`;
        layer.append(item);
      } else {
        const shape = this.createSvgAnnotation(annotation);
        if (shape) vectorLayer.append(shape);
      }
    }

    if (this.drawingDraft) {
      const draftShape = this.createSvgAnnotation(this.drawingDraft, true);
      if (draftShape) vectorLayer.append(draftShape);
    }
  }

  toggleSearchControls() {
    if (
      !this.pages.length ||
      !this.elements.searchControls ||
      !this.elements.searchToolButton
    ) {
      return;
    }
    const willOpen = this.elements.searchControls.hidden;
    if (!willOpen) {
      this.closeSearchControls();
      return;
    }
    this.closeTextControls();
    this.activateDrawingTool("select");
    this.elements.searchControls.hidden = false;
    this.elements.searchToolButton.classList.add("active");
    setTimeout(() => {
      this.elements.searchInput.focus();
      this.elements.searchInput.select();
    }, 20);
  }

  closeSearchControls() {
    clearTimeout(this.searchDebounceTimer);
    this.searchBuildToken += 1;
    this.elements.searchControls.hidden = true;
    this.elements.searchToolButton.classList.remove("active");
    this.clearSearchResults();
  }

  clearSearchResults({ preserveQuery = false } = {}) {
    this.searchMatches = [];
    this.searchCursor = -1;
    if (!preserveQuery) this.elements.searchInput.value = "";
    this.elements.searchPreviousButton.disabled = true;
    this.elements.searchNextButton.disabled = true;
    this.elements.searchResultStatus.textContent = "輸入文字開始搜尋";
    this.renderAnnotations();
  }

  async performSearch() {
    const query = this.elements.searchInput.value.trim();
    const token = ++this.searchBuildToken;
    this.searchMatches = [];
    this.searchCursor = -1;
    this.elements.searchPreviousButton.disabled = true;
    this.elements.searchNextButton.disabled = true;

    if (!query) {
      this.elements.searchResultStatus.textContent = "輸入文字開始搜尋";
      this.renderAnnotations();
      return;
    }

    this.elements.searchResultStatus.textContent = "正在建立文字索引…";
    const matches = [];

    try {
      for (let index = 0; index < this.pages.length; index += 1) {
        if (token !== this.searchBuildToken) return;
        const pageRecord = this.pages[index];
        this.elements.searchResultStatus.textContent =
          `搜尋第 ${index + 1} / ${this.pages.length} 頁…`;
        let entry;
        try {
          entry = await this.buildNativeTextIndex(pageRecord);
        } catch (error) {
          console.warn(
            `[PDF Editor] Could not index page ${index + 1}`,
            error
          );
          entry = this.textIndex.get(pageRecord.id) || {};
        }
        if (token !== this.searchBuildToken) return;
        matches.push(
          ...this.findMatchesInText(
            pageRecord,
            entry.native,
            query,
            "native"
          ),
          ...this.findMatchesInText(pageRecord, entry.ocr, query, "ocr")
        );
      }

      if (token !== this.searchBuildToken) return;
      this.searchMatches = matches;
      this.searchCursor = matches.length ? 0 : -1;
      const hasMatches = matches.length > 0;
      this.elements.searchPreviousButton.disabled = !hasMatches;
      this.elements.searchNextButton.disabled = !hasMatches;

      if (hasMatches) {
        await this.showSearchMatch(0);
      } else {
        this.elements.searchResultStatus.textContent = "找不到符合的文字";
        this.renderAnnotations();
      }
    } catch (error) {
      if (token !== this.searchBuildToken) return;
      console.error("[PDF Editor] Text search failed", error);
      this.elements.searchResultStatus.textContent = "搜尋失敗";
      this.toast("文字搜尋失敗，請重新開啟文件後再試。", "error");
    }
  }

  async buildNativeTextIndex(pageRecord) {
    const current = this.textIndex.get(pageRecord.id) || {};
    if (current.native) return current;
    const source = this.sources.get(pageRecord.sourceId);
    if (!source) return current;

    const pdfPage = await source.pdfjsDoc.getPage(
      pageRecord.sourcePageIndex + 1
    );
    const content = await pdfPage.getTextContent();
    return this.indexNativeTextContent(pageRecord, content);
  }

  indexNativeTextContent(pageRecord, content) {
    const current = this.textIndex.get(pageRecord.id) || {};
    let text = "";
    const segments = [];

    for (const item of content.items || []) {
      if (typeof item?.str !== "string" || !item.str) continue;
      if (text && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
      const start = text.length;
      text += item.str;
      const end = text.length;
      segments.push({
        text: item.str,
        start,
        end,
        transform: Array.from(item.transform || []),
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        dir: item.dir || "ltr",
      });
      if (item.hasEOL) text += "\n";
    }

    current.native = {
      text,
      segments,
      indexedAt: Date.now(),
    };
    this.textIndex.set(pageRecord.id, current);
    return current;
  }

  findMatchesInText(pageRecord, indexPart, query, sourceKind) {
    if (!indexPart?.text) return [];
    const text = String(indexPart.text);
    const normalized = this.normalizeSearchText(text);
    const normalizedText = normalized.text;
    const normalizedQuery = this.normalizeSearchText(query).text;
    if (!normalizedQuery) return [];
    const units =
      sourceKind === "ocr" ? indexPart.words || [] : indexPart.segments || [];
    const results = [];
    let offset = 0;

    while (offset <= normalizedText.length - normalizedQuery.length) {
      const normalizedStart = normalizedText.indexOf(normalizedQuery, offset);
      if (normalizedStart < 0) break;
      const normalizedEnd = normalizedStart + normalizedQuery.length;
      const start = normalized.starts[normalizedStart] ?? 0;
      const end =
        normalized.ends[normalizedEnd - 1] ?? Math.min(text.length, start + 1);
      const boxes = units
        .filter((unit) => unit.end > start && unit.start < end)
        .map((unit) =>
          sourceKind === "ocr"
            ? {
                kind: "ocr",
                x0: unit.x0,
                y0: unit.y0,
                x1: unit.x1,
                y1: unit.y1,
                rotation: indexPart.rotation || 0,
              }
            : {
                kind: "native",
                text: unit.text,
                transform: unit.transform,
                width: unit.width,
                height: unit.height,
                dir: unit.dir,
              }
        );
      results.push({
        pageId: pageRecord.id,
        pageNumber: this.pages.indexOf(pageRecord) + 1,
        source: sourceKind,
        start,
        end,
        snippet: this.createSearchSnippet(text, start, end),
        boxes,
      });
      offset = Math.max(normalizedEnd, normalizedStart + 1);
    }

    return results;
  }

  normalizeSearchText(value) {
    let text = "";
    const starts = [];
    const ends = [];
    let originalOffset = 0;
    for (const character of String(value || "")) {
      const characterEnd = originalOffset + character.length;
      if (!/\s/u.test(character)) {
        const folded = character.toLocaleLowerCase("zh-TW");
        for (const foldedCharacter of folded) {
          text += foldedCharacter;
          for (let index = 0; index < foldedCharacter.length; index += 1) {
            starts.push(originalOffset);
            ends.push(characterEnd);
          }
        }
      }
      originalOffset = characterEnd;
    }
    return { text, starts, ends };
  }

  createSearchSnippet(text, start, end) {
    const before = Math.max(0, start - 28);
    const after = Math.min(text.length, end + 34);
    const snippet = text.slice(before, after).replace(/\s+/g, " ").trim();
    return `${before ? "…" : ""}${snippet}${after < text.length ? "…" : ""}`;
  }

  stepSearch(direction) {
    if (!this.searchMatches.length) return;
    const next =
      (this.searchCursor + direction + this.searchMatches.length) %
      this.searchMatches.length;
    this.showSearchMatch(next);
  }

  async showSearchMatch(index) {
    const match = this.searchMatches[index];
    if (!match) return;
    this.searchCursor = index;
    const pageChanged = this.activePageId !== match.pageId;
    this.activePageId = match.pageId;
    this.selectedPageIds = new Set([match.pageId]);
    this.selectedAnnotationId = null;
    this.updateUI();
    if (pageChanged) this.renderSidebar();
    await this.renderActivePage();
    this.elements.viewerScroll.scrollTo({
      top: 0,
      left: 0,
      behavior: "smooth",
    });
    const sourceLabel = match.source === "ocr" ? "OCR" : "PDF 文字";
    const currentPageNumber =
      this.pages.findIndex((page) => page.id === match.pageId) + 1;
    this.elements.searchResultStatus.textContent =
      `${index + 1} / ${this.searchMatches.length}・第 ${currentPageNumber} 頁・${sourceLabel}`;
    this.elements.searchResultStatus.title = match.snippet;
  }

  renderSearchHighlights(layer, pageRecord) {
    const match = this.searchMatches[this.searchCursor];
    if (!match || match.pageId !== pageRecord.id) return;
    const boxes = match.boxes || [];

    if (!boxes.length) {
      const pageHit = document.createElement("div");
      pageHit.className = "search-page-hit";
      layer.append(pageHit);
      return;
    }

    for (const box of boxes) {
      const highlight = document.createElement("div");
      highlight.className = `search-highlight${
        box.kind === "ocr" ? " ocr" : ""
      }`;
      if (box.kind === "ocr") {
        const adjusted = this.transformOcrBox(
          box,
          this.getPageRotation(pageRecord)
        );
        highlight.style.left = `${adjusted.x0 * this.currentViewport.width}px`;
        highlight.style.top = `${adjusted.y0 * this.currentViewport.height}px`;
        highlight.style.width = `${Math.max(
          4,
          (adjusted.x1 - adjusted.x0) * this.currentViewport.width
        )}px`;
        highlight.style.height = `${Math.max(
          4,
          (adjusted.y1 - adjusted.y0) * this.currentViewport.height
        )}px`;
      } else if (box.transform?.length === 6) {
        const transformed = pdfjsLib.Util.transform(
          this.currentViewport.transform,
          box.transform
        );
        const fontHeight = Math.max(
          4,
          Math.hypot(transformed[2], transformed[3])
        );
        const angle = Math.atan2(transformed[1], transformed[0]);
        const width = Math.max(
          4,
          box.width * this.currentViewport.scale ||
            fontHeight * Math.max(1, box.text?.length || 1) * 0.55
        );
        highlight.style.left = `${transformed[4]}px`;
        highlight.style.top = `${transformed[5] - fontHeight}px`;
        highlight.style.width = `${width}px`;
        highlight.style.height = `${fontHeight}px`;
        highlight.style.transform = `rotate(${angle}rad)`;
      }
      layer.append(highlight);
    }
  }

  transformOcrBox(box, currentRotation) {
    const delta = normalizedRotation(
      currentRotation - normalizedRotation(box.rotation || 0)
    );
    const transformPoint = ([x, y]) => {
      if (delta === 90) return [1 - y, x];
      if (delta === 180) return [1 - x, 1 - y];
      if (delta === 270) return [y, 1 - x];
      return [x, y];
    };
    const points = [
      [box.x0, box.y0],
      [box.x1, box.y0],
      [box.x1, box.y1],
      [box.x0, box.y1],
    ].map(transformPoint);
    const xValues = points.map(([x]) => x);
    const yValues = points.map(([, y]) => y);
    return {
      x0: Math.min(...xValues),
      y0: Math.min(...yValues),
      x1: Math.max(...xValues),
      y1: Math.max(...yValues),
    };
  }

  openOcrDialog() {
    if (!this.pages.length || !this.elements.ocrDialog) return;
    const selectedOption = this.elements.ocrScope.querySelector(
      'option[value="selected"]'
    );
    selectedOption.textContent = this.selectedPageIds.size
      ? `所選頁面（${this.selectedPageIds.size} 頁）`
      : "所選頁面（未選時使用目前頁）";
    this.elements.ocrScope.value =
      this.selectedPageIds.size > 1 ? "selected" : "active";
    const existing = this.textIndex.get(this.activePageId)?.ocr;
    this.elements.ocrResultText.value = existing?.rawText || "";
    this.elements.ocrResultField.hidden = !existing?.rawText;
    this.elements.copyOcrButton.hidden = !existing?.rawText;
    this.elements.ocrProgressPanel.hidden = true;
    this.elements.ocrProgressBar.style.width = "0%";
    this.setOcrRunningState(false);
    this.openDialog(this.elements.ocrDialog);
  }

  getOcrPageRecords() {
    const scope = this.elements.ocrScope.value;
    if (scope === "all") return [...this.pages];
    if (scope === "selected" && this.selectedPageIds.size) {
      return this.pages.filter((page) => this.selectedPageIds.has(page.id));
    }
    const active = this.pages.find((page) => page.id === this.activePageId);
    return active ? [active] : [];
  }

  setOcrRunningState(running) {
    this.ocrRunning = running;
    this.elements.ocrScope.disabled = running;
    this.elements.ocrSkipTextPages.disabled = running;
    this.elements.ocrCloseButton.disabled = running;
    this.elements.startOcrButton.disabled = running;
    this.elements.cancelOcrButton.hidden = !running;
    if (!running) this.elements.startOcrButton.textContent = "開始辨識";
  }

  async ensureOcrWorker() {
    if (this.ocrWorker) return this.ocrWorker;
    if (!window.Tesseract?.createWorker) {
      throw new Error("Tesseract.js is unavailable");
    }
    this.elements.ocrProgressPanel.hidden = false;
    this.elements.ocrProgressTitle.textContent = "載入 OCR 引擎";
    this.elements.ocrProgressDetail.textContent = "準備繁體中文與英文模型";
    this.elements.ocrProgressBar.style.width = "3%";

    this.ocrWorker = await window.Tesseract.createWorker(
      ["chi_tra", "eng"],
      window.Tesseract.OEM?.LSTM_ONLY ?? 1,
      {
        workerPath: new URL(
          "./vendor/tesseract/worker.min.js",
          location.href
        ).href,
        corePath: new URL("./vendor/tesseract/core/", location.href).href,
        langPath: new URL(
          "./vendor/tesseract/lang-data/",
          location.href
        ).href,
        workerBlobURL: false,
        gzip: true,
        logger: (message) => this.updateOcrProgress(message),
        errorHandler: (error) =>
          console.error("[PDF Editor] OCR worker error", error),
      }
    );
    return this.ocrWorker;
  }

  updateOcrProgress(message) {
    if (!this.ocrRunning) return;
    const labels = {
      "loading tesseract core": "載入 OCR 核心",
      "initializing tesseract": "初始化 OCR",
      "loading language traineddata": "載入語言模型",
      "initializing api": "初始化辨識模型",
      "recognizing text": "辨識頁面文字",
    };
    const status = labels[message.status] || "處理 OCR";
    const progress = Number.isFinite(message.progress) ? message.progress : 0;
    const pageBase =
      this.ocrPageTotal && this.ocrPageNumber
        ? (this.ocrPageNumber - 1) / this.ocrPageTotal
        : 0;
    const totalProgress = this.ocrPageTotal
      ? (pageBase + progress / this.ocrPageTotal) * 100
      : Math.max(3, progress * 10);
    this.elements.ocrProgressTitle.textContent = status;
    this.elements.ocrProgressDetail.textContent = this.ocrPageNumber
      ? `第 ${this.ocrPageNumber} / ${this.ocrPageTotal} 頁`
      : "首次使用正在準備本機模型";
    this.elements.ocrProgressBar.style.width = `${Math.min(
      99,
      Math.max(3, totalProgress)
    )}%`;
  }

  async startOcr() {
    if (this.ocrRunning) return;
    const pageRecords = this.getOcrPageRecords();
    if (!pageRecords.length) {
      this.toast("沒有可辨識的頁面。", "error");
      return;
    }

    this.ocrCancelled = false;
    this.ocrPageNumber = 0;
    this.ocrPageTotal = pageRecords.length;
    this.elements.ocrResultText.value = "";
    this.elements.ocrResultField.hidden = true;
    this.elements.copyOcrButton.hidden = true;
    this.elements.ocrProgressPanel.hidden = false;
    this.elements.ocrProgressTitle.textContent = "準備 OCR";
    this.elements.ocrProgressDetail.textContent =
      `共 ${pageRecords.length} 頁`;
    this.elements.ocrProgressBar.style.width = "2%";
    this.setOcrRunningState(true);

    const resultSections = [];
    let recognizedCount = 0;
    let skippedCount = 0;

    try {
      const worker = await this.ensureOcrWorker();
      if (this.ocrCancelled) {
        await worker.terminate().catch(() => {});
        this.ocrWorker = null;
        return;
      }

      for (let index = 0; index < pageRecords.length; index += 1) {
        if (this.ocrCancelled) break;
        const pageRecord = pageRecords[index];
        const pageNumber = this.pages.indexOf(pageRecord) + 1;
        this.ocrPageNumber = index + 1;

        if (this.elements.ocrSkipTextPages.checked) {
          const entry = await this.buildNativeTextIndex(pageRecord);
          if ((entry.native?.text || "").replace(/\s/g, "").length >= 8) {
            skippedCount += 1;
            this.elements.ocrProgressTitle.textContent = "略過已有文字的頁面";
            this.elements.ocrProgressDetail.textContent =
              `第 ${index + 1} / ${pageRecords.length} 頁`;
            this.elements.ocrProgressBar.style.width =
              `${Math.round(((index + 1) / pageRecords.length) * 100)}%`;
            continue;
          }
        }

        this.elements.ocrProgressTitle.textContent = "建立頁面影像";
        this.elements.ocrProgressDetail.textContent =
          `第 ${index + 1} / ${pageRecords.length} 頁`;
        const canvas = await this.renderPageForOcr(pageRecord);
        if (this.ocrCancelled) break;
        const recognition = await worker.recognize(
          canvas,
          {},
          { text: true, blocks: true }
        );
        const ocrIndex = this.buildOcrIndex(
          recognition.data,
          canvas.width,
          canvas.height,
          this.getPageRotation(pageRecord)
        );
        const entry = this.textIndex.get(pageRecord.id) || {};
        entry.ocr = ocrIndex;
        this.textIndex.set(pageRecord.id, entry);
        recognizedCount += 1;
        resultSections.push(
          `【第 ${pageNumber} 頁】\n${ocrIndex.rawText || "（未辨識到文字）"}`
        );
      }

      if (this.ocrCancelled) {
        this.elements.ocrProgressTitle.textContent = "已停止辨識";
        this.elements.ocrProgressDetail.textContent =
          `已完成 ${recognizedCount} 頁`;
        this.toast("OCR 已停止；已完成的頁面仍會保留。");
      } else {
        this.elements.ocrProgressTitle.textContent = "OCR 完成";
        this.elements.ocrProgressDetail.textContent =
          `辨識 ${recognizedCount} 頁${skippedCount ? `・略過 ${skippedCount} 頁` : ""}`;
        this.elements.ocrProgressBar.style.width = "100%";
        this.toast(
          recognizedCount
            ? `OCR 已完成 ${recognizedCount} 頁，可立即搜尋辨識文字。`
            : "所選頁面已有可搜尋文字，不需要 OCR。",
          "success",
          6500
        );
      }

      const resultText = resultSections.join("\n\n");
      this.elements.ocrResultText.value = resultText;
      this.elements.ocrResultField.hidden = !resultText;
      this.elements.copyOcrButton.hidden = !resultText;
      this.updateUI();
      this.scheduleAutosave();
      if (
        this.elements.searchControls &&
        !this.elements.searchControls.hidden &&
        this.elements.searchInput.value.trim()
      ) {
        await this.performSearch();
      } else {
        await this.renderActivePage();
      }
    } catch (error) {
      if (!this.ocrCancelled) {
        console.error("[PDF Editor] OCR failed", error);
        this.elements.ocrProgressTitle.textContent = "OCR 無法完成";
        this.elements.ocrProgressDetail.textContent =
          "請確認瀏覽器允許 WebAssembly 與背景工作執行";
        this.toast("OCR 辨識失敗，請重新整理後再試。", "error", 7000);
      }
    } finally {
      this.setOcrRunningState(false);
      this.ocrPageNumber = 0;
      this.ocrPageTotal = 0;
    }
  }

  async cancelOcr() {
    if (!this.ocrRunning) return;
    this.ocrCancelled = true;
    this.elements.cancelOcrButton.disabled = true;
    this.elements.ocrProgressTitle.textContent = "正在停止 OCR";
    this.elements.ocrProgressDetail.textContent = "保留已完成的辨識結果";
    const worker = this.ocrWorker;
    this.ocrWorker = null;
    if (worker) await worker.terminate().catch(() => {});
    this.elements.cancelOcrButton.disabled = false;
  }

  async renderPageForOcr(pageRecord) {
    const source = this.sources.get(pageRecord.sourceId);
    if (!source) throw new Error("OCR source is unavailable");
    const pdfPage = await source.pdfjsDoc.getPage(
      pageRecord.sourcePageIndex + 1
    );
    const rotation = this.getPageRotation(pageRecord);
    const baseViewport = pdfPage.getViewport({ scale: 1, rotation });
    const scale = Math.min(
      2.7,
      Math.max(1, 2300 / Math.max(baseViewport.width, baseViewport.height))
    );
    const viewport = pdfPage.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({
      canvasContext: context,
      viewport,
      background: "#ffffff",
    }).promise;
    return canvas;
  }

  buildOcrIndex(data, imageWidth, imageHeight, rotation) {
    const detectedWords = [];
    for (const block of data?.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          for (const word of line.words || []) {
            const wordText = String(word.text || "").trim();
            const bbox = word.bbox;
            if (!wordText || !bbox) continue;
            detectedWords.push({
              text: wordText,
              x0: Math.max(0, Math.min(1, bbox.x0 / imageWidth)),
              y0: Math.max(0, Math.min(1, bbox.y0 / imageHeight)),
              x1: Math.max(0, Math.min(1, bbox.x1 / imageWidth)),
              y1: Math.max(0, Math.min(1, bbox.y1 / imageHeight)),
              confidence: Number(word.confidence) || 0,
            });
          }
        }
      }
    }

    let searchableText = "";
    const words = detectedWords.map((word) => {
      if (searchableText) searchableText += " ";
      const start = searchableText.length;
      searchableText += word.text;
      return {
        ...word,
        start,
        end: searchableText.length,
      };
    });
    const rawText = String(data?.text || "").trim();
    if (!searchableText) searchableText = rawText;

    return {
      text: searchableText,
      rawText,
      words,
      rotation,
      indexedAt: Date.now(),
    };
  }

  async copyOcrText() {
    const text = this.elements.ocrResultText.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.elements.ocrResultText.focus();
      this.elements.ocrResultText.select();
      document.execCommand("copy");
    }
    this.toast("OCR 文字已複製。", "success");
  }

  createSvgAnnotation(annotation, draft = false) {
    const points = (annotation.points || []).map(([x, y]) =>
      this.currentViewport.convertToViewportPoint(x, y)
    );
    if (!points.length) return null;
    const namespace = "http://www.w3.org/2000/svg";
    const selected =
      !draft && annotation.id === this.selectedAnnotationId;
    let shape;

    if (annotation.type === "path") {
      shape = document.createElementNS(namespace, "path");
      shape.setAttribute(
        "d",
        points
          .map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`)
          .join(" ")
      );
      shape.setAttribute("fill", "none");
      shape.setAttribute("stroke", annotation.color);
      shape.setAttribute(
        "stroke-width",
        Math.max(1, annotation.width * this.currentViewport.scale)
      );
      shape.setAttribute("stroke-linecap", "round");
      shape.setAttribute("stroke-linejoin", "round");
      shape.setAttribute("opacity", annotation.opacity ?? 1);
    } else if (annotation.type === "rect" && points.length >= 2) {
      const [[x1, y1], [x2, y2]] = points;
      shape = document.createElementNS(namespace, "rect");
      shape.setAttribute("x", Math.min(x1, x2));
      shape.setAttribute("y", Math.min(y1, y2));
      shape.setAttribute("width", Math.abs(x2 - x1));
      shape.setAttribute("height", Math.abs(y2 - y1));
      shape.setAttribute("fill", "none");
      shape.setAttribute("stroke", annotation.color);
      shape.setAttribute(
        "stroke-width",
        Math.max(1, annotation.width * this.currentViewport.scale)
      );
    } else if (annotation.type === "arrow" && points.length >= 2) {
      const [[x1, y1], [x2, y2]] = points;
      shape = document.createElementNS(namespace, "g");
      const line = document.createElementNS(namespace, "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.setAttribute("stroke", annotation.color);
      line.setAttribute(
        "stroke-width",
        Math.max(1, annotation.width * this.currentViewport.scale)
      );
      line.setAttribute("stroke-linecap", "round");
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(
        9,
        annotation.width * this.currentViewport.scale * 3.5
      );
      const polygon = document.createElementNS(namespace, "polygon");
      polygon.setAttribute(
        "points",
        [
          [x2, y2],
          [
            x2 - head * Math.cos(angle - Math.PI / 6),
            y2 - head * Math.sin(angle - Math.PI / 6),
          ],
          [
            x2 - head * Math.cos(angle + Math.PI / 6),
            y2 - head * Math.sin(angle + Math.PI / 6),
          ],
        ]
          .map((point) => point.join(","))
          .join(" ")
      );
      polygon.setAttribute("fill", annotation.color);
      shape.append(line, polygon);
    }

    if (!shape) return null;
    shape.classList.add("vector-annotation");
    if (selected) shape.classList.add("selected");
    if (!draft) {
      shape.dataset.annotationId = annotation.id;
      shape.setAttribute("tabindex", "0");
    }
    return shape;
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
    const annotationItem = event.target.closest("[data-annotation-id]");
    if (annotationItem) {
      this.selectedAnnotationId = annotationItem.dataset.annotationId;
      this.renderAnnotations();
      return;
    }

    this.selectedAnnotationId = null;

    if (this.activeTool !== "select" && this.activeTool !== "text") {
      return;
    }

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
    if (!this.currentViewport) return;
    const annotationTarget = event.target.closest("[data-annotation-id]");
    if (
      !annotationTarget &&
      ["pen", "highlight", "rect", "arrow"].includes(this.activeTool)
    ) {
      event.preventDefault();
      this.elements.annotationLayer.setPointerCapture?.(event.pointerId);
      const point = this.eventToPdfPoint(event);
      if (!point) return;
      this.drawingDraft = {
        id: makeId("annotation"),
        type:
          this.activeTool === "pen" || this.activeTool === "highlight"
            ? "path"
            : this.activeTool,
        tool: this.activeTool,
        color: this.elements.drawingColor.value,
        width:
          this.activeTool === "highlight"
            ? Math.max(10, Number(this.elements.drawingWidth.value) * 3)
            : Number(this.elements.drawingWidth.value),
        opacity: this.activeTool === "highlight" ? 0.35 : 1,
        points: [point, point],
      };
      this.renderAnnotations();
      return;
    }

    const item = event.target.closest(".annotation-item");
    if (!item) {
      if (annotationTarget) {
        this.selectedAnnotationId = annotationTarget.dataset.annotationId;
        this.renderAnnotations();
      }
      return;
    }
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
    if (this.drawingDraft) {
      const point = this.eventToPdfPoint(event);
      if (!point) return;
      if (this.drawingDraft.type === "path") {
        const previous =
          this.drawingDraft.points[this.drawingDraft.points.length - 1];
        const [prevX, prevY] = this.currentViewport.convertToViewportPoint(
          previous[0],
          previous[1]
        );
        const [nextX, nextY] =
          this.currentViewport.convertToViewportPoint(point[0], point[1]);
        if (Math.hypot(nextX - prevX, nextY - prevY) >= 2) {
          this.drawingDraft.points.push(point);
        }
      } else {
        this.drawingDraft.points[1] = point;
      }
      if (!this.drawingFrame) {
        this.drawingFrame = requestAnimationFrame(() => {
          this.drawingFrame = null;
          this.renderAnnotations();
        });
      }
      return;
    }

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

  handleAnnotationPointerUp(event) {
    if (
      event?.pointerId !== undefined &&
      this.elements.annotationLayer.hasPointerCapture?.(event.pointerId)
    ) {
      this.elements.annotationLayer.releasePointerCapture(event.pointerId);
    }
    if (this.drawingDraft) {
      const draft = this.drawingDraft;
      this.drawingDraft = null;
      if (this.drawingFrame) {
        cancelAnimationFrame(this.drawingFrame);
        this.drawingFrame = null;
      }
      const hasEnoughPoints =
        draft.type === "path"
          ? draft.points.length >= 3
          : this.annotationDistance(draft.points[0], draft.points[1]) >= 4;
      if (hasEnoughPoints) {
        this.mutate(
          () => {
            const page = this.pages.find(
              (item) => item.id === this.activePageId
            );
            page.annotations.push(draft);
            this.selectedAnnotationId = draft.id;
          },
          { sidebar: false }
        );
      } else {
        this.renderAnnotations();
      }
      return;
    }

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
      this.scheduleAutosave();
    }

    this.annotationDrag = null;
    this.renderAnnotations();
  }

  renderAnnotationsSelectionOnly() {
    $$("[data-annotation-id]").forEach((item) => {
      item.classList.toggle(
        "selected",
        item.dataset.annotationId === this.selectedAnnotationId
      );
    });
  }

  eventToPdfPoint(event) {
    if (!this.currentViewport) return null;
    const rect = this.elements.annotationLayer.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
    return this.currentViewport.convertToPdfPoint(x, y);
  }

  annotationDistance(pointA, pointB) {
    if (!pointA || !pointB || !this.currentViewport) return 0;
    const a = this.currentViewport.convertToViewportPoint(...pointA);
    const b = this.currentViewport.convertToViewportPoint(...pointB);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
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
    if (
      this.elements.searchControls &&
      !this.elements.searchControls.hidden &&
      this.elements.searchInput.value.trim()
    ) {
      this.performSearch();
    }
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
    if (
      this.elements.searchControls &&
      !this.elements.searchControls.hidden &&
      this.elements.searchInput.value.trim()
    ) {
      this.performSearch();
    }
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
    this.toast("標註已刪除。", "success");
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
    this.scheduleAutosave();
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
    this.scheduleAutosave();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(clonePages(this.pages));
    this.pages = this.redoStack.pop();
    this.dirty = true;
    this.selectedAnnotationId = null;
    this.normalizeState();
    this.renderAll();
    this.scheduleAutosave();
  }

  changeZoom(delta) {
    this.zoom = Math.min(2.5, Math.max(0.5, this.zoom + delta));
    this.updateUI();
    this.renderActivePage();
  }

  activateDrawingTool(tool) {
    if (tool !== "select") {
      this.hideSelectedPageText({ clearSelection: true });
    }
    if (
      tool !== "select" &&
      this.elements.searchControls &&
      !this.elements.searchControls.hidden
    ) {
      this.closeSearchControls();
    }
    this.activeTool = tool;
    this.textPlacementArmed = false;
    this.elements.textControls.hidden = true;
    this.elements.drawingControls.hidden = tool === "select";
    const labels = {
      pen: ["自由畫筆", "直接在頁面上拖曳繪製；按 Esc 回到選取模式。"],
      highlight: [
        "螢光筆",
        "以半透明筆畫標記內容；可調整顏色與基礎粗細。",
      ],
      rect: ["矩形框", "從一個角拖曳到另一個角建立外框。"],
      arrow: ["箭頭", "從起點拖曳到箭頭指向的位置。"],
    };
    if (labels[tool]) {
      [this.elements.drawingToolName.textContent, this.elements.drawingToolHint.textContent] =
        labels[tool];
      if (tool === "highlight" && this.elements.drawingColor.value === "#ef5a52") {
        this.elements.drawingColor.value = "#ffe066";
      } else if (tool !== "highlight" && this.elements.drawingColor.value === "#ffe066") {
        this.elements.drawingColor.value = "#ef5a52";
      }
    }
    const buttonMap = {
      text: this.elements.textToolButton,
      pen: this.elements.penToolButton,
      highlight: this.elements.highlightToolButton,
      rect: this.elements.rectToolButton,
      arrow: this.elements.arrowToolButton,
    };
    Object.entries(buttonMap).forEach(([name, button]) =>
      button.classList.toggle("active", name === tool)
    );
    this.renderAnnotations();
  }

  toggleTextControls() {
    const willOpen = this.elements.textControls.hidden;
    if (
      willOpen &&
      this.elements.searchControls &&
      !this.elements.searchControls.hidden
    ) {
      this.closeSearchControls();
    }
    this.elements.textControls.hidden = !willOpen;
    this.elements.textToolButton.classList.toggle("active", willOpen);
    if (willOpen) {
      this.activeTool = "text";
      this.elements.drawingControls.hidden = true;
      [
        this.elements.penToolButton,
        this.elements.highlightToolButton,
        this.elements.rectToolButton,
        this.elements.arrowToolButton,
      ].forEach((button) => button.classList.remove("active"));
      this.elements.annotationText.focus();
    } else {
      this.activeTool = "select";
      this.textPlacementArmed = false;
      this.elements.armTextButton.textContent = "準備放置";
      this.renderAnnotations();
    }
  }

  closeTextControls() {
    this.elements.textControls.hidden = true;
    this.elements.textToolButton.classList.remove("active");
    if (this.activeTool === "text") this.activeTool = "select";
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

  applyPageRange() {
    const input = this.elements.rangeInput.value.trim();
    const result = this.parsePageRange(input);
    if (result.error) {
      this.elements.rangeError.textContent = result.error;
      this.elements.rangeError.hidden = false;
      return;
    }
    this.selectedPageIds = new Set(
      result.pages.map((pageNumber) => this.pages[pageNumber - 1].id)
    );
    this.activePageId =
      this.pages[result.pages[0] - 1]?.id || this.activePageId;
    this.closeDialog(this.elements.rangeDialog);
    this.updateUI();
    this.renderSidebar();
    this.renderActivePage();
    this.toast(`已選取 ${result.pages.length} 頁。`, "success");
  }

  parsePageRange(input) {
    if (!input) return { error: "請輸入頁碼或範圍。" };
    const selected = new Set();
    for (const rawPart of input.split(/[,，]/)) {
      const part = rawPart.trim();
      if (!part) continue;
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      const single = part.match(/^\d+$/);
      if (!range && !single) {
        return { error: `無法辨識「${part}」，請使用 1-3, 6 的格式。` };
      }
      const start = range ? Number(range[1]) : Number(part);
      const end = range ? Number(range[2]) : start;
      if (
        start < 1 ||
        end < 1 ||
        start > this.pages.length ||
        end > this.pages.length
      ) {
        return { error: `頁碼必須介於 1 到 ${this.pages.length}。` };
      }
      const step = start <= end ? 1 : -1;
      for (let value = start; value !== end + step; value += step) {
        selected.add(value);
      }
    }
    const pages = [...selected].sort((a, b) => a - b);
    return pages.length ? { pages } : { error: "沒有可選取的頁碼。" };
  }

  async insertBlankPage(orientation) {
    const previousActiveId = this.activePageId;
    const document = await PDFDocument.create();
    const size =
      orientation === "landscape" ? [841.89, 595.28] : [595.28, 841.89];
    document.addPage(size);
    const bytes = await document.save();
    const file = new File(
      [bytes],
      orientation === "landscape" ? "空白頁-橫向.pdf" : "空白頁-直向.pdf",
      { type: "application/pdf" }
    );
    const insertedIds = await this.loadFiles([file], {
      replace: !this.pages.length,
      remember: false,
    });
    if (previousActiveId && insertedIds.length) {
      this.placePagesAfter(insertedIds, previousActiveId);
    } else if (insertedIds.length) {
      this.dirty = true;
      this.updateUI();
      this.scheduleAutosave();
    }
  }

  placePagesAfter(insertedIds, afterPageId) {
    const insertedSet = new Set(insertedIds);
    const inserted = this.pages.filter((page) => insertedSet.has(page.id));
    const remaining = this.pages.filter((page) => !insertedSet.has(page.id));
    const targetIndex = remaining.findIndex((page) => page.id === afterPageId);
    if (targetIndex < 0) return;
    this.pages = [
      ...remaining.slice(0, targetIndex + 1),
      ...inserted,
      ...remaining.slice(targetIndex + 1),
    ];
    this.activePageId = inserted[0]?.id || this.activePageId;
    this.selectedPageIds = new Set(insertedIds);
    this.dirty = true;
    this.renderAll();
    this.scheduleAutosave();
  }

  async convertImagesToPdf(files) {
    const previousActiveId = this.activePageId;
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      this.toast("請選擇圖片檔案。", "error");
      return;
    }
    this.setBusy(true, "正在建立圖片 PDF", `準備 ${images.length} 張圖片`, 0);
    try {
      const document = await PDFDocument.create();
      for (let index = 0; index < images.length; index += 1) {
        const file = images[index];
        const bytes = await this.imageFileToCompatibleBytes(file);
        const embedded =
          bytes.type === "image/jpeg"
            ? await document.embedJpg(bytes.data)
            : await document.embedPng(bytes.data);
        const landscape = embedded.width > embedded.height;
        const [pageWidth, pageHeight] = landscape
          ? [841.89, 595.28]
          : [595.28, 841.89];
        const page = document.addPage([pageWidth, pageHeight]);
        const margin = 24;
        const scale = Math.min(
          (pageWidth - margin * 2) / embedded.width,
          (pageHeight - margin * 2) / embedded.height
        );
        const width = embedded.width * scale;
        const height = embedded.height * scale;
        page.drawImage(embedded, {
          x: (pageWidth - width) / 2,
          y: (pageHeight - height) / 2,
          width,
          height,
        });
        this.setBusy(
          true,
          "正在建立圖片 PDF",
          `${index + 1} / ${images.length}`,
          Math.round(((index + 1) / images.length) * 80)
        );
      }
      const output = await document.save();
      const pdfFile = new File([output], "圖片文件.pdf", {
        type: "application/pdf",
      });
      this.setBusy(false);
      const insertedIds = await this.loadFiles([pdfFile], {
        replace: !this.pages.length,
        remember: false,
      });
      if (previousActiveId && insertedIds.length) {
        this.placePagesAfter(insertedIds, previousActiveId);
      } else if (insertedIds.length) {
        this.dirty = true;
        this.updateUI();
        this.scheduleAutosave();
      }
    } catch (error) {
      console.error("[PDF Editor] Image conversion failed", error);
      this.setBusy(false);
      this.toast("圖片轉 PDF 失敗，請確認圖片格式。", "error");
    }
  }

  async imageFileToCompatibleBytes(file) {
    if (file.type === "image/jpeg" || file.type === "image/png") {
      return {
        type: file.type,
        data: new Uint8Array(await file.arrayBuffer()),
      };
    }
    const dataUrl = await this.fileToDataUrl(file);
    const image = await this.loadHtmlImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return {
      type: "image/png",
      data: new Uint8Array(await blob.arrayBuffer()),
    };
  }

  async insertImageAnnotation(file) {
    if (!this.pages.length || !this.currentViewport) return;
    try {
      const dataUrl = await this.fileToDataUrl(file);
      const image = await this.loadHtmlImage(dataUrl);
      this.addImageAnnotationData(dataUrl, image.naturalWidth, image.naturalHeight, {
        label: file.name,
      });
    } catch (error) {
      console.error("[PDF Editor] Image annotation failed", error);
      this.toast("圖片讀取失敗。", "error");
    }
  }

  addImageAnnotationData(
    dataUrl,
    naturalWidth,
    naturalHeight,
    { label = "圖片標註", preferredWidth = 180 } = {}
  ) {
    if (!this.currentViewport) return;
    const visibleWidth = this.currentViewport.width / this.currentViewport.scale;
    const visibleHeight =
      this.currentViewport.height / this.currentViewport.scale;
    let width = Math.min(preferredWidth, visibleWidth * 0.42);
    let height = width * (naturalHeight / naturalWidth);
    if (height > visibleHeight * 0.35) {
      height = visibleHeight * 0.35;
      width = height * (naturalWidth / naturalHeight);
    }
    const screenLeft =
      (this.currentViewport.width - width * this.currentViewport.scale) / 2;
    const screenBottom =
      (this.currentViewport.height + height * this.currentViewport.scale) / 2;
    const [x, y] = this.currentViewport.convertToPdfPoint(
      screenLeft,
      screenBottom
    );
    const annotation = {
      id: makeId("annotation"),
      type: "image",
      dataUrl,
      label,
      x,
      y,
      width,
      height,
    };
    this.mutate(
      () => {
        const page = this.pages.find((item) => item.id === this.activePageId);
        page.annotations.push(annotation);
        this.selectedAnnotationId = annotation.id;
      },
      { sidebar: false }
    );
    this.toast("圖片已加入，可拖曳調整位置。", "success");
  }

  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  loadHtmlImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
  }

  openSignatureDialog() {
    this.clearSignaturePad();
    this.openDialog(this.elements.signatureDialog);
  }

  bindSignaturePad() {
    const canvas = this.elements.signatureCanvas;
    const getPoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [
        ((event.clientX - rect.left) / rect.width) * canvas.width,
        ((event.clientY - rect.top) / rect.height) * canvas.height,
      ];
    };
    canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.signatureDrawing = true;
      this.signatureHasInk = true;
      const context = canvas.getContext("2d");
      const [x, y] = getPoint(event);
      context.beginPath();
      context.moveTo(x, y);
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.signatureDrawing) return;
      const context = canvas.getContext("2d");
      const [x, y] = getPoint(event);
      context.lineTo(x, y);
      context.stroke();
    });
    const finish = () => {
      this.signatureDrawing = false;
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
  }

  clearSignaturePad() {
    const canvas = this.elements.signatureCanvas;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#172033";
    context.lineWidth = 5;
    context.lineCap = "round";
    context.lineJoin = "round";
    this.signatureHasInk = false;
  }

  saveSignature() {
    if (!this.signatureHasInk) {
      this.toast("請先在簽名區手寫簽名。", "error");
      return;
    }
    const source = this.elements.signatureCanvas;
    const context = source.getContext("2d");
    const pixels = context.getImageData(0, 0, source.width, source.height);
    let minX = source.width;
    let minY = source.height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        if (pixels.data[(y * source.width + x) * 4 + 3] > 20) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    const padding = 12;
    const width = Math.max(1, maxX - minX + padding * 2);
    const height = Math.max(1, maxY - minY + padding * 2);
    const cropped = document.createElement("canvas");
    cropped.width = width;
    cropped.height = height;
    cropped
      .getContext("2d")
      .drawImage(
        source,
        minX - padding,
        minY - padding,
        width,
        height,
        0,
        0,
        width,
        height
      );
    this.closeDialog(this.elements.signatureDialog);
    this.addImageAnnotationData(
      cropped.toDataURL("image/png"),
      width,
      height,
      { label: "手寫簽名", preferredWidth: 170 }
    );
  }

  async openFormDialog() {
    const page = this.pages.find((item) => item.id === this.activePageId);
    const source = this.sources.get(page?.sourceId);
    if (!source || source.encrypted || !source.pdfLibDoc) {
      this.toast("受密碼保護的 PDF 目前不支援直接填寫表單。", "error");
      return;
    }
    const fields = source.pdfLibDoc.getForm().getFields();
    if (!fields.length) {
      this.toast("目前來源沒有可填寫的 PDF 表單欄位。");
      return;
    }
    this.elements.formFieldList.replaceChildren();
    for (const field of fields) {
      const row = document.createElement("label");
      row.className = "form-field-row";
      const title = document.createElement("span");
      title.textContent = field.getName();
      row.append(title);
      let control;
      if (field instanceof window.PDFLib.PDFTextField) {
        control = document.createElement("input");
        control.type = "text";
        control.value = field.getText() || "";
        control.dataset.fieldType = "text";
      } else if (field instanceof window.PDFLib.PDFCheckBox) {
        control = document.createElement("input");
        control.type = "checkbox";
        control.checked = field.isChecked();
        control.dataset.fieldType = "checkbox";
      } else if (
        field instanceof window.PDFLib.PDFDropdown ||
        field instanceof window.PDFLib.PDFRadioGroup ||
        field instanceof window.PDFLib.PDFOptionList
      ) {
        control = document.createElement("select");
        control.dataset.fieldType =
          field instanceof window.PDFLib.PDFRadioGroup ? "radio" : "select";
        const selected = field.getSelected?.() || "";
        for (const option of field.getOptions()) {
          const optionElement = document.createElement("option");
          optionElement.value = option;
          optionElement.textContent = option;
          optionElement.selected = Array.isArray(selected)
            ? selected.includes(option)
            : selected === option;
          control.append(optionElement);
        }
      } else {
        const unsupported = document.createElement("small");
        unsupported.textContent = "此欄位類型暫不支援";
        row.append(unsupported);
        this.elements.formFieldList.append(row);
        continue;
      }
      control.dataset.fieldName = field.getName();
      row.append(control);
      this.elements.formFieldList.append(row);
    }
    this.elements.formDialog.dataset.sourceId = source.id;
    this.openDialog(this.elements.formDialog);
  }

  async applyFormValues() {
    const source = this.sources.get(this.elements.formDialog.dataset.sourceId);
    if (!source) return;
    this.setBusy(true, "正在套用表單", source.name, 12);
    try {
      const document = await PDFDocument.load(source.bytes.slice(), {
        updateMetadata: false,
      });
      const form = document.getForm();
      for (const control of this.elements.formFieldList.querySelectorAll(
        "[data-field-name]"
      )) {
        const field = form.getField(control.dataset.fieldName);
        if (control.dataset.fieldType === "text") {
          field.setText(control.value);
        } else if (control.dataset.fieldType === "checkbox") {
          control.checked ? field.check() : field.uncheck();
        } else if (control.value) {
          field.select(control.value);
        }
      }
      const font = await this.loadAnnotationFont(document);
      form.updateFieldAppearances(font);
      form.flatten();
      const bytes = new Uint8Array(await document.save());
      const replacement = await this.loadSourceFromBytes({
        bytes,
        name: source.name,
        size: bytes.byteLength,
        sourceId: source.id,
      });
      await source.loadingTask?.destroy?.().catch?.(() => {});
      this.sources.set(source.id, replacement.source);
      for (const page of this.pages.filter(
        (item) => item.sourceId === source.id
      )) {
        page.baseRotation =
          replacement.pages[page.sourcePageIndex]?.baseRotation ||
          page.baseRotation;
        this.textIndex.delete(page.id);
      }
      this.closeDialog(this.elements.formDialog);
      this.dirty = true;
      this.renderAll();
      this.scheduleAutosave();
      if (
        this.elements.searchControls &&
        !this.elements.searchControls.hidden &&
        this.elements.searchInput.value.trim()
      ) {
        this.performSearch();
      }
      this.toast("表單內容已套用並扁平化。", "success");
    } catch (error) {
      console.error("[PDF Editor] Form fill failed", error);
      this.toast("表單套用失敗；部分特殊欄位可能不受支援。", "error");
    } finally {
      this.setBusy(false);
    }
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
          record.annotations.some((annotation) => annotation.type === "text") &&
          this.getPageRotation(record) === 0 &&
          !this.sources.get(record.sourceId)?.encrypted
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
          !source.encrypted &&
          this.canEncodeAnnotations(record.annotations, annotationFont);

        if (source.encrypted || (record.annotations.length && !canDrawAsVector)) {
          await this.addRasterizedAnnotatedPage(output, record);
        } else {
          const [copiedPage] = await output.copyPages(source.pdfLibDoc, [
            record.sourcePageIndex,
          ]);
          output.addPage(copiedPage);
          copiedPage.setRotation(degrees(rotation));
          if (record.annotations.length) {
            await this.drawVectorAnnotations(
              copiedPage,
              record.annotations,
              annotationFont,
              output
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
      this.scheduleAutosave();
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

  async drawVectorAnnotations(page, annotations, font, outputDocument) {
    for (const annotation of annotations) {
      const color = this.hexToRgb(annotation.color);
      const pdfColor = window.PDFLib.rgb(color.r, color.g, color.b);
      if (annotation.type === "text") {
        const metrics = this.getAnnotationMetrics(annotation);
        const firstBaseline =
          annotation.y + metrics.height - annotation.fontSize - 1;
        metrics.lines.forEach((line, index) => {
          page.drawText(line || " ", {
            x: annotation.x,
            y: firstBaseline - index * metrics.lineHeight,
            size: annotation.fontSize,
            font,
            color: pdfColor,
          });
        });
      } else if (annotation.type === "path") {
        for (let index = 1; index < annotation.points.length; index += 1) {
          page.drawLine({
            start: {
              x: annotation.points[index - 1][0],
              y: annotation.points[index - 1][1],
            },
            end: {
              x: annotation.points[index][0],
              y: annotation.points[index][1],
            },
            thickness: annotation.width,
            color: pdfColor,
            opacity: annotation.opacity ?? 1,
            lineCap: window.PDFLib.LineCapStyle.Round,
          });
        }
      } else if (annotation.type === "rect") {
        const [[x1, y1], [x2, y2]] = annotation.points;
        page.drawRectangle({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          borderColor: pdfColor,
          borderWidth: annotation.width,
          borderOpacity: annotation.opacity ?? 1,
        });
      } else if (annotation.type === "arrow") {
        const [[x1, y1], [x2, y2]] = annotation.points;
        page.drawLine({
          start: { x: x1, y: y1 },
          end: { x: x2, y: y2 },
          thickness: annotation.width,
          color: pdfColor,
          lineCap: window.PDFLib.LineCapStyle.Round,
        });
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(8, annotation.width * 4);
        for (const offset of [-Math.PI / 6, Math.PI / 6]) {
          page.drawLine({
            start: { x: x2, y: y2 },
            end: {
              x: x2 - head * Math.cos(angle + offset),
              y: y2 - head * Math.sin(angle + offset),
            },
            thickness: annotation.width,
            color: pdfColor,
            lineCap: window.PDFLib.LineCapStyle.Round,
          });
        }
      } else if (annotation.type === "image") {
        const embedded = annotation.dataUrl.startsWith("data:image/png")
          ? await outputDocument.embedPng(annotation.dataUrl)
          : await outputDocument.embedJpg(annotation.dataUrl);
        page.drawImage(embedded, {
          x: annotation.x,
          y: annotation.y,
          width: annotation.width,
          height: annotation.height,
        });
      }
    }
  }

  canEncodeAnnotations(annotations, font) {
    try {
      annotations
        .filter((annotation) => annotation.type === "text")
        .forEach((annotation) => {
          if (!font) throw new Error("Font is required");
          font.encodeText(annotation.text);
        });
      annotations
        .filter((annotation) => annotation.type === "image")
        .forEach((annotation) => {
          if (
            !annotation.dataUrl.startsWith("data:image/png") &&
            !annotation.dataUrl.startsWith("data:image/jpeg")
          ) {
            throw new Error("Image needs raster fallback");
          }
        });
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

    await this.drawRasterAnnotations(
      context,
      viewport,
      record.annotations,
      renderScale
    );

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

  async drawRasterAnnotations(context, viewport, annotations, renderScale) {
    const fontFamily =
      '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", Arial, sans-serif';
    for (const annotation of annotations) {
      context.save();
      context.globalAlpha = annotation.opacity ?? 1;
      context.strokeStyle = annotation.color || "#172033";
      context.fillStyle = annotation.color || "#172033";
      context.lineWidth = Math.max(1, (annotation.width || 1) * renderScale);
      context.lineCap = "round";
      context.lineJoin = "round";

      if (annotation.type === "text") {
        const metrics = this.getAnnotationMetrics(annotation);
        const [left, bottom] = viewport.convertToViewportPoint(
          annotation.x,
          annotation.y
        );
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
      } else if (annotation.type === "path") {
        const points = annotation.points.map((point) =>
          viewport.convertToViewportPoint(...point)
        );
        context.beginPath();
        points.forEach(([x, y], index) =>
          index ? context.lineTo(x, y) : context.moveTo(x, y)
        );
        context.stroke();
      } else if (annotation.type === "rect") {
        const [start, end] = annotation.points.map((point) =>
          viewport.convertToViewportPoint(...point)
        );
        context.strokeRect(
          Math.min(start[0], end[0]),
          Math.min(start[1], end[1]),
          Math.abs(end[0] - start[0]),
          Math.abs(end[1] - start[1])
        );
      } else if (annotation.type === "arrow") {
        const [start, end] = annotation.points.map((point) =>
          viewport.convertToViewportPoint(...point)
        );
        context.beginPath();
        context.moveTo(...start);
        context.lineTo(...end);
        context.stroke();
        const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
        const head = Math.max(10, (annotation.width || 2) * renderScale * 4);
        context.beginPath();
        context.moveTo(...end);
        context.lineTo(
          end[0] - head * Math.cos(angle - Math.PI / 6),
          end[1] - head * Math.sin(angle - Math.PI / 6)
        );
        context.lineTo(
          end[0] - head * Math.cos(angle + Math.PI / 6),
          end[1] - head * Math.sin(angle + Math.PI / 6)
        );
        context.closePath();
        context.fill();
      } else if (annotation.type === "image") {
        const image = await this.loadHtmlImage(annotation.dataUrl);
        const [left, bottom] = viewport.convertToViewportPoint(
          annotation.x,
          annotation.y
        );
        context.globalAlpha = 1;
        context.drawImage(
          image,
          left,
          bottom - annotation.height * renderScale,
          annotation.width * renderScale,
          annotation.height * renderScale
        );
      }
      context.restore();
    }
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

  applySavedTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("pdfEditor-theme");
    } catch {}
    const theme =
      saved ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    this.updateThemeMeta(theme);
  }

  toggleTheme() {
    const theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("pdfEditor-theme", theme);
    } catch {}
    this.updateThemeMeta(theme);
  }

  updateThemeMeta(theme) {
    const color = theme === "dark" ? "#111827" : "#f8fafc";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
    this.elements.themeButton?.setAttribute(
      "aria-label",
      theme === "dark" ? "切換淺色模式" : "切換深色模式"
    );
  }

  rememberRecentFiles(files) {
    let current = [];
    try {
      current = JSON.parse(localStorage.getItem("pdfEditor-recent") || "[]");
    } catch {}
    if (!Array.isArray(current)) current = [];
    const now = Date.now();
    for (const file of files) {
      const index = current.findIndex((item) => item.name === file.name);
      if (index >= 0) current.splice(index, 1);
      current.unshift({
        name: file.name,
        size: file.size,
        openedAt: now,
      });
    }
    try {
      localStorage.setItem(
        "pdfEditor-recent",
        JSON.stringify(current.slice(0, 5))
      );
    } catch {}
    this.renderRecentFiles();
  }

  renderRecentFiles() {
    let recent = [];
    try {
      recent = JSON.parse(localStorage.getItem("pdfEditor-recent") || "[]");
    } catch {}
    if (!Array.isArray(recent)) recent = [];
    this.elements.recentFileList?.replaceChildren();
    this.elements.recentFiles.hidden = !recent.length;
    for (const item of recent) {
      const row = document.createElement("div");
      row.className = "recent-file-row";
      const name = document.createElement("span");
      name.textContent = item.name;
      const meta = document.createElement("small");
      meta.textContent = `${this.formatBytes(item.size)}・${new Date(
        item.openedAt
      ).toLocaleDateString("zh-TW")}`;
      row.append(name, meta);
      this.elements.recentFileList.append(row);
    }
  }

  openEditorDb() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(EDITOR_DB_NAME, EDITOR_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("projects")) {
          db.createObjectStore("projects", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.dbPromise;
  }

  async projectDbOperation(mode, operation) {
    const db = await this.openEditorDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("projects", mode);
      const store = transaction.objectStore("projects");
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  scheduleAutosave() {
    if (this.restoringAutosave) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.saveAutosave(), 900);
  }

  async saveAutosave() {
    if (!this.pages.length) return;
    try {
      const sources = [...this.sources.values()].map((source) => ({
        id: source.id,
        name: source.name,
        size: source.size,
        encrypted: source.encrypted,
        bytes: source.bytes.slice(),
      }));
      const activePageIds = new Set(this.pages.map((page) => page.id));
      const textIndex = [...this.textIndex.entries()]
        .filter(
          ([pageId, entry]) => activePageIds.has(pageId) && entry?.ocr
        )
        .map(([pageId, entry]) => [pageId, { ocr: entry.ocr }]);
      await this.projectDbOperation("readwrite", (store) =>
        store.put({
          id: AUTOSAVE_KEY,
          savedAt: Date.now(),
          pages: clonePages(this.pages),
          activePageId: this.activePageId,
          sources,
          textIndex,
        })
      );
    } catch (error) {
      console.warn("[PDF Editor] Autosave failed", error);
      if (!this.autosaveWarningShown) {
        this.autosaveWarningShown = true;
        this.toast("草稿自動儲存失敗，可能是裝置空間不足。", "error", 7000);
      }
    }
  }

  async offerAutosaveRestore() {
    try {
      const project = await this.projectDbOperation("readonly", (store) =>
        store.get(AUTOSAVE_KEY)
      );
      if (!project?.pages?.length) return;
      const confirmed = await this.confirmAction({
        title: "還原上次草稿？",
        message: `找到 ${new Date(project.savedAt).toLocaleString(
          "zh-TW"
        )} 自動儲存的 ${project.pages.length} 頁文件。`,
        acceptLabel: "還原草稿",
      });
      if (confirmed) await this.restoreAutosave(project);
    } catch (error) {
      console.warn("[PDF Editor] Autosave restore check failed", error);
    }
  }

  async restoreAutosave(project) {
    this.restoringAutosave = true;
    this.setBusy(true, "正在還原草稿", "重新載入文件來源", 5);
    const restoredSources = new Map();
    try {
      for (let index = 0; index < project.sources.length; index += 1) {
        const saved = project.sources[index];
        this.setBusy(
          true,
          "正在還原草稿",
          `${saved.name}（${index + 1}/${project.sources.length}）`,
          10 + Math.round((index / project.sources.length) * 70)
        );
        const loaded = await this.loadSourceFromBytes({
          bytes: new Uint8Array(saved.bytes),
          name: saved.name,
          size: saved.size,
          sourceId: saved.id,
        });
        restoredSources.set(saved.id, loaded.source);
      }
      this.sources = restoredSources;
      this.pages = clonePages(project.pages);
      this.textIndex = new Map(
        Array.isArray(project.textIndex) ? project.textIndex : []
      );
      this.activePageId = project.activePageId;
      this.selectedPageIds = new Set([this.activePageId].filter(Boolean));
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = true;
      this.renderAll();
      this.toast("上次草稿已還原。", "success");
    } catch (error) {
      for (const source of restoredSources.values()) {
        source.loadingTask?.destroy?.().catch?.(() => {});
      }
      console.error("[PDF Editor] Autosave restore failed", error);
      this.toast("草稿無法完整還原，可能缺少受保護文件的密碼。", "error");
    } finally {
      this.restoringAutosave = false;
      this.setBusy(false);
    }
  }

  async consumeSharedFile() {
    if (!("caches" in window)) return false;
    try {
      const cache = await caches.open(SHARE_CACHE_NAME);
      const key = new URL("./shared-pdf", location.href).href;
      const response = await cache.match(key);
      if (!response) return false;
      await cache.delete(key);
      const blob = await response.blob();
      const encodedName = response.headers.get("X-PDF-File-Name");
      const fileName = encodedName
        ? decodeURIComponent(encodedName)
        : "分享的文件.pdf";
      const file = new File([blob], fileName, { type: "application/pdf" });
      await this.loadFiles([file], { replace: true });
      history.replaceState(null, "", "./");
      return true;
    } catch (error) {
      console.warn("[PDF Editor] Shared file import failed", error);
      return false;
    }
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
    if (
      command &&
      event.key.toLowerCase() === "f" &&
      this.pages.length &&
      this.elements.searchControls
    ) {
      event.preventDefault();
      if (this.elements.searchControls.hidden) this.toggleSearchControls();
      else {
        this.elements.searchInput.focus();
        this.elements.searchInput.select();
      }
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
    if (command && event.key.toLowerCase() === "s") {
      event.preventDefault();
      this.exportPages(this.pages.map((page) => page.id), {
        mode: "download",
        suffix: "edited",
      });
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
    } else if (event.key.toLowerCase() === "p" && this.pages.length) {
      event.preventDefault();
      this.activateDrawingTool("pen");
    } else if (event.key.toLowerCase() === "h" && this.pages.length) {
      event.preventDefault();
      this.activateDrawingTool("highlight");
    } else if (event.key.toLowerCase() === "t" && this.pages.length) {
      event.preventDefault();
      this.toggleTextControls();
    } else if (event.key.toLowerCase() === "v" && this.pages.length) {
      event.preventDefault();
      this.activateDrawingTool("select");
    } else if (event.key === "Escape") {
      if (
        this.elements.searchControls &&
        !this.elements.searchControls.hidden
      ) {
        this.closeSearchControls();
        return;
      }
      this.textPlacementArmed = false;
      this.selectedAnnotationId = null;
      this.elements.armTextButton.textContent = "準備放置";
      this.activateDrawingTool("select");
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

  isDialogOpen(dialog) {
    return Boolean(dialog?.open || dialog?.hasAttribute?.("open"));
  }

  openDialog(dialog) {
    if (!dialog || this.isDialogOpen(dialog)) return;
    dialog.returnValue = "";
    const useFallback = /Android|\bwv\b/i.test(navigator.userAgent);
    if (!useFallback && typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        return;
      } catch (error) {
        console.warn("[PDF Editor] Native dialog unavailable", error);
      }
    }
    dialog.setAttribute("open", "");
    dialog.classList.add("dialog-fallback-open");
    document.body.classList.add("fallback-dialog-open");
    requestAnimationFrame(() => {
      dialog
        .querySelector(
          "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])"
        )
        ?.focus();
    });
  }

  closeDialog(dialog, returnValue = "") {
    if (!dialog) return;
    if (dialog.classList.contains("dialog-fallback-open")) {
      dialog.returnValue = returnValue;
      dialog.removeAttribute("open");
      dialog.classList.remove("dialog-fallback-open");
      if (!document.querySelector("dialog.dialog-fallback-open")) {
        document.body.classList.remove("fallback-dialog-open");
      }
      dialog.dispatchEvent(new Event("close"));
      return;
    }
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close(returnValue);
      return;
    }
    dialog.returnValue = returnValue;
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }

  confirmAction({ title, message, acceptLabel = "確認" }) {
    const dialog = this.elements.confirmDialog;
    if (!dialog) return Promise.resolve(window.confirm(message));
    this.elements.confirmTitle.textContent = title;
    this.elements.confirmMessage.textContent = message;
    this.elements.confirmAcceptButton.textContent = acceptLabel;
    dialog.returnValue = "cancel";
    this.openDialog(dialog);
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
      const hadController = Boolean(navigator.serviceWorker.controller);
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || refreshing) return;
        refreshing = true;
        location.reload();
      });
      const registration = await navigator.serviceWorker.register("./sw.js");
      await registration.update();
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
