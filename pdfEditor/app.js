import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import {
  FEEDBACK_FORM_CONFIG,
  PDF_WORKSHOP_VERSION,
} from "./feedback-config.js";
import {
  buildPdfFileShareData,
  chooseExportDelivery,
  detectExportEnvironment,
} from "./export-delivery.mjs";
import { copyPagesBySource } from "./pdf-page-copy.mjs";
import {
  arrangeInsertedPages,
  getContainingPageGroup,
  PAGE_INSERTION_MODE,
} from "./page-insertion.mjs";
import {
  resizeRectFromHandle,
  transformPointBetweenRects,
} from "./annotation-resize.mjs";

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
const EDITOR_DB_VERSION = 3;
const AUTOSAVE_KEY = "autosave";
const RECENT_FILES_KEY = "pdfEditor-recent";
const RECENT_FILE_LIMIT = 5;
const SHARE_CACHE_NAME = "pdfEditor-share-inbox";
const INSTALL_INTRO_KEY = "pdfEditor-install-intro-seen-v1";
const VIEW_MODE_KEY = "pdfEditor-view-mode-v1";
const BROWSE_ZOOM_KEY = "pdfEditor-browse-zoom-v1";
const THUMBNAIL_WIDTH_SIDEBAR = 122;
const BROWSE_CARD_BASE_WIDTH = 180;
const BROWSE_ZOOM_MIN = 0.6;
const BROWSE_ZOOM_MAX = 2.4;
const PREVIEW_RENDER_CONCURRENCY = 2;
const SKIM_SETTLE_DELAY_MS = 160;
const BLOB_URL_LIFETIME_MS = 10 * 60 * 1000;
const FEEDBACK_LOG_LIMIT = 40;
const FEEDBACK_ERROR_INVITE_COOLDOWN_MS = 60 * 1000;

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
    this.draggedPageIds = [];
    this.draggedGroupId = null;
    this.collapsedPageGroupIds = new Set();
    this.pendingGroupRenameId = null;
    this.dragDropPosition = "before";
    this.suppressPageClick = false;
    this.annotationDrag = null;
    this.annotationResize = null;
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
    this.signatureColor = "#172033";
    this.signatureLineWidth = 5;
    this.textIndex = new Map();
    this.thumbnailCache = new Map();
    this.annotationImages = new Map();
    this.persistedSourceIds = new Set();
    this.searchMatches = [];
    this.searchCursor = -1;
    this.searchBuildToken = 0;
    this.searchDebounceTimer = null;
    this.ocrWorker = null;
    this.ocrIdleTimer = null;
    this.ocrRunning = false;
    this.ocrCancelled = false;
    this.ocrPageNumber = 0;
    this.ocrPageTotal = 0;
    this.selectedPageText = "";
    this.toolbarItems = [];
    this.toolbarOverflowFrame = null;
    this.installPrompt = null;
    this.installIntroTimer = null;
    this.installStateReady = false;
    this.detectedInstalledApp = false;
    this.excelWorker = null;
    this.excelWorkerRequests = new Map();
    this.excelWorkerRequestSequence = 0;
    this.excelWorkbookInfo = null;
    this.excelSheetConfigs = [];
    this.excelActiveSheetId = null;
    this.excelEstimateTimer = null;
    this.excelEstimateToken = 0;
    this.excelPreviewToken = 0;
    this.excelPreviewPageIndex = 0;
    this.excelPreviewDocument = null;
    this.excelPreviewRenderTask = null;
    this.excelImportMode = "insert";
    this.excelPreviousActiveId = null;
    this.pendingExportShare = null;
    this.pendingDownloadUrls = new Map();
    this.feedbackConfig = {
      ...FEEDBACK_FORM_CONFIG,
      entries: { ...FEEDBACK_FORM_CONFIG.entries },
    };
    this.feedbackDiagnostics = [];
    this.pendingFeedbackError = null;
    this.feedbackSubmitting = false;
    this.feedbackInviteShownAt = 0;
    this.feedbackConsoleRestore = [];
    this.feedbackServiceWorkerVersion = "尚未取得";
    this.feedbackServiceWorkerVersionPromise = null;

    let savedViewMode = null;
    try {
      savedViewMode = localStorage.getItem(VIEW_MODE_KEY);
    } catch {
      savedViewMode = null;
    }
    this.viewMode = savedViewMode === "continuous" ? "continuous" : "single";
    this.lastPageViewMode = this.viewMode;
    let savedBrowseZoom = NaN;
    try {
      savedBrowseZoom = parseFloat(localStorage.getItem(BROWSE_ZOOM_KEY));
    } catch {
      savedBrowseZoom = NaN;
    }
    this.browseZoom = Number.isFinite(savedBrowseZoom)
      ? Math.min(BROWSE_ZOOM_MAX, Math.max(BROWSE_ZOOM_MIN, savedBrowseZoom))
      : 1;
    this.browseThumbBucket = null;
    this.zoomSliderTimer = null;
    this.pageDimsCache = new Map();
    this.previewSlots = [];
    this.previewObserver = null;
    this.previewQueue = [];
    this.previewActiveRenders = 0;
    this.continuousLayoutToken = 0;
    this.skimSettleTimer = null;

    this.elements = {
      openButton: $("#openButton"),
      emptyOpenButton: $("#emptyOpenButton"),
      mergeButton: $("#mergeButton"),
      insertButton: $("#insertButton"),
      shareButton: $("#shareButton"),
      installButton: $("#installButton"),
      feedbackButton: $("#feedbackButton"),
      themeButton: $("#themeButton"),
      exportButton: $("#exportButton"),
      openFileInput: $("#openFileInput"),
      mergeFileInput: $("#mergeFileInput"),
      annotationImageInput: $("#annotationImageInput"),
      imageToPdfInput: $("#imageToPdfInput"),
      excelFileInput: $("#excelFileInput"),
      toolbar: $("#toolbar"),
      toolbarOverflow: $("#toolbarOverflow"),
      toolbarMoreButton: $("#toolbarMoreButton"),
      toolbarOverflowMenu: $("#toolbarOverflowMenu"),
      sidebar: $("#sidebar"),
      openSidebarButton: $("#openSidebarButton"),
      closeSidebarButton: $("#closeSidebarButton"),
      pageList: $("#pageList"),
      pageCount: $("#pageCount"),
      selectAllCheckbox: $("#selectAllCheckbox"),
      rangeButton: $("#rangeButton"),
      extractButton: $("#extractButton"),
      groupSelectedButton: $("#groupSelectedButton"),
      undoButton: $("#undoButton"),
      redoButton: $("#redoButton"),
      rotateButton: $("#rotateButton"),
      deleteButton: $("#deleteButton"),
      selectToolButton: $("#selectToolButton"),
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
      statusZoomOutButton: $("#statusZoomOutButton"),
      statusZoomInButton: $("#statusZoomInButton"),
      zoomSlider: $("#zoomSlider"),
      zoomSliderValue: $("#zoomSliderValue"),
      browseZoomOutButton: $("#browseZoomOutButton"),
      browseZoomInButton: $("#browseZoomInButton"),
      browseZoomSlider: $("#browseZoomSlider"),
      browseZoomValue: $("#browseZoomValue"),
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
      previewFlow: $("#previewFlow"),
      viewSingleButton: $("#viewSingleButton"),
      viewContinuousButton: $("#viewContinuousButton"),
      viewBrowseButton: $("#viewBrowseButton"),
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
      confirmExtraButton: $("#confirmExtraButton"),
      exportReadyDialog: $("#exportReadyDialog"),
      exportReadyEyebrow: $("#exportReadyEyebrow"),
      exportReadyTitle: $("#exportReadyTitle"),
      exportReadyMessage: $("#exportReadyMessage"),
      exportReadyFileName: $("#exportReadyFileName"),
      exportReadyFileMeta: $("#exportReadyFileMeta"),
      exportReadyNote: $("#exportReadyNote"),
      exportReadyCancelButton: $("#exportReadyCancelButton"),
      exportReadyShareButton: $("#exportReadyShareButton"),
      installDialog: $("#installDialog"),
      installNowButton: $("#installNowButton"),
      installStepsList: $("#installStepsList"),
      installDialogNote: $("#installDialogNote"),
      feedbackDialog: $("#feedbackDialog"),
      feedbackForm: $("#feedbackForm"),
      feedbackCloseButton: $("#feedbackCloseButton"),
      feedbackCancelButton: $("#feedbackCancelButton"),
      feedbackCategory: $("#feedbackCategory"),
      feedbackContact: $("#feedbackContact"),
      feedbackTitle: $("#feedbackTitle"),
      feedbackDescription: $("#feedbackDescription"),
      feedbackError: $("#feedbackError"),
      feedbackEnvironment: $("#feedbackEnvironment"),
      feedbackIncludeDiagnostics: $("#feedbackIncludeDiagnostics"),
      feedbackDiagnostics: $("#feedbackDiagnostics"),
      feedbackConfigWarning: $("#feedbackConfigWarning"),
      feedbackSubmitStatus: $("#feedbackSubmitStatus"),
      feedbackSubmitButton: $("#feedbackSubmitButton"),
      errorReportInvite: $("#errorReportInvite"),
      errorReportInviteMessage: $("#errorReportInviteMessage"),
      errorReportInviteButton: $("#errorReportInviteButton"),
      errorReportDismissButton: $("#errorReportDismissButton"),
      recentFiles: $("#recentFiles"),
      recentFileList: $("#recentFileList"),
      passwordDialog: $("#passwordDialog"),
      passwordFileName: $("#passwordFileName"),
      passwordInput: $("#passwordInput"),
      passwordError: $("#passwordError"),
      insertDialog: $("#insertDialog"),
      groupedInsertionDialog: $("#groupedInsertionDialog"),
      groupedInsertionTitle: $("#groupedInsertionTitle"),
      groupedInsertionMessage: $("#groupedInsertionMessage"),
      groupedInsertionCurrentGroupName: $("#groupedInsertionCurrentGroupName"),
      blankPortraitButton: $("#blankPortraitButton"),
      blankLandscapeButton: $("#blankLandscapeButton"),
      imageToPdfButton: $("#imageToPdfButton"),
      excelToPdfButton: $("#excelToPdfButton"),
      excelDialog: $("#excelDialog"),
      excelCloseButton: $("#excelCloseButton"),
      excelCancelButton: $("#excelCancelButton"),
      excelConvertButton: $("#excelConvertButton"),
      excelFileName: $("#excelFileName"),
      excelWorkbookMeta: $("#excelWorkbookMeta"),
      excelSheetList: $("#excelSheetList"),
      excelSelectionSummary: $("#excelSelectionSummary"),
      excelSelectVisibleButton: $("#excelSelectVisibleButton"),
      excelClearSelectionButton: $("#excelClearSelectionButton"),
      excelSettingsPanel: $("#excelSettingsPanel"),
      excelActiveSheetName: $("#excelActiveSheetName"),
      excelApplyLayoutButton: $("#excelApplyLayoutButton"),
      excelRangeMode: $("#excelRangeMode"),
      excelCustomRangeField: $("#excelCustomRangeField"),
      excelCustomRange: $("#excelCustomRange"),
      excelPaperSize: $("#excelPaperSize"),
      excelOrientation: $("#excelOrientation"),
      excelScaling: $("#excelScaling"),
      excelScalePercentField: $("#excelScalePercentField"),
      excelScalePercent: $("#excelScalePercent"),
      excelMargins: $("#excelMargins"),
      excelPageOrder: $("#excelPageOrder"),
      excelRepeatRows: $("#excelRepeatRows"),
      excelRepeatColumns: $("#excelRepeatColumns"),
      excelRowBreaks: $("#excelRowBreaks"),
      excelColumnBreaks: $("#excelColumnBreaks"),
      excelCenterHorizontal: $("#excelCenterHorizontal"),
      excelCenterVertical: $("#excelCenterVertical"),
      excelIncludeHeaderFooter: $("#excelIncludeHeaderFooter"),
      excelAddPageNumbers: $("#excelAddPageNumbers"),
      excelGridLines: $("#excelGridLines"),
      excelCompatibilityDetails: $("#excelCompatibilityDetails"),
      excelCompatibilitySummary: $("#excelCompatibilitySummary"),
      excelCompatibilityReport: $("#excelCompatibilityReport"),
      excelPreviewStage: $("#excelPreviewStage"),
      excelPreviewCanvas: $("#excelPreviewCanvas"),
      excelPreviewPlaceholder: $("#excelPreviewPlaceholder"),
      excelPreviewStatus: $("#excelPreviewStatus"),
      excelPreviewPage: $("#excelPreviewPage"),
      excelPreviewPrevious: $("#excelPreviewPrevious"),
      excelPreviewNext: $("#excelPreviewNext"),
      excelInsertPositionField: $("#excelInsertPositionField"),
      excelInsertPosition: $("#excelInsertPosition"),
      groupNameDialog: $("#groupNameDialog"),
      groupNameInput: $("#groupNameInput"),
      groupNameError: $("#groupNameError"),
      groupNameAcceptButton: $("#groupNameAcceptButton"),
      rangeDialog: $("#rangeDialog"),
      rangeInput: $("#rangeInput"),
      rangeError: $("#rangeError"),
      rangeAcceptButton: $("#rangeAcceptButton"),
      signatureDialog: $("#signatureDialog"),
      signatureCanvas: $("#signatureCanvas"),
      clearSignatureButton: $("#clearSignatureButton"),
      saveSignatureButton: $("#saveSignatureButton"),
      storeSignatureButton: $("#storeSignatureButton"),
      savedSignaturesSection: $("#savedSignaturesSection"),
      savedSignaturesGrid: $("#savedSignaturesGrid"),
      sigDivider: $("#sigDivider"),
      sigColorSwatches: $$(".sig-color-swatch"),
      sigColorCustom: $("#sigColorCustom"),
      sigColorCustomLabel: $(".sig-color-custom"),
      sigWidthButtons: $$(".sig-width-btn"),
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
    this.installFeedbackDiagnostics();
    if (!PDFDocument) {
      this.toast("PDF 編輯元件載入失敗，請重新整理頁面。", "error", 8000);
      return;
    }

    this.ensureRuntimeLayers();
    this.applySavedTheme();
    this.applyViewModeClasses();
    this.applyBrowseZoom();
    this.bindEvents();
    this.updateConnectivity();
    this.updateUI();
    this.updateInstallButton();
    this.renderRecentFiles();
    this.registerServiceWorker();
    this.registerFileHandler();
    this.initializeInstallExperience();

    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }

    const searchParams = new URLSearchParams(location.search);
    const openAction = searchParams.get("action") === "open";
    if (openAction) {
      setTimeout(() => this.elements.openFileInput.click(), 350);
    }

    const consumedSharedFile = await this.consumeSharedFile();
    if (
      !consumedSharedFile &&
      !openAction &&
      searchParams.get("testHarness") !== "1"
    ) {
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
      installButton,
      feedbackButton,
      themeButton,
      exportButton,
      openFileInput,
      mergeFileInput,
      annotationImageInput,
      imageToPdfInput,
      excelFileInput,
      openSidebarButton,
      closeSidebarButton,
      selectAllCheckbox,
      rangeButton,
      extractButton,
      groupSelectedButton,
      undoButton,
      redoButton,
      rotateButton,
      deleteButton,
      selectToolButton,
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
    this.elements.exportReadyShareButton?.addEventListener("click", () =>
      this.sharePreparedExport()
    );
    this.elements.exportReadyDialog?.addEventListener("close", () =>
      this.cancelPreparedExportShare()
    );
    installButton?.addEventListener("click", () =>
      this.showInstallIntro({ force: true })
    );
    feedbackButton?.addEventListener("click", () =>
      this.openFeedbackDialog({ reason: "manual" })
    );
    this.elements.feedbackIncludeDiagnostics?.addEventListener("change", () =>
      this.refreshFeedbackDiagnosticsPreview()
    );
    this.elements.feedbackForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.submitFeedback();
    });
    for (const button of [
      this.elements.feedbackCloseButton,
      this.elements.feedbackCancelButton,
    ]) {
      button?.addEventListener("click", () =>
        this.closeDialog(this.elements.feedbackDialog, "cancel")
      );
    }
    this.elements.feedbackDialog?.addEventListener("close", () => {
      this.feedbackSubmitting = false;
      this.elements.feedbackSubmitStatus.textContent = "";
    });
    this.elements.errorReportInviteButton?.addEventListener("click", () => {
      this.hideErrorReportInvite();
      this.openFeedbackDialog({
        reason: "global-error",
        errorRecord: this.pendingFeedbackError,
      });
    });
    this.elements.errorReportDismissButton?.addEventListener("click", () =>
      this.hideErrorReportInvite()
    );
    this.elements.installNowButton?.addEventListener("click", () =>
      this.installApp()
    );
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      this.installPrompt = event;
      this.installStateReady = true;
      this.detectedInstalledApp = false;
      this.updateInstallButton();
      this.scheduleInstallIntro(250);
    });
    window.addEventListener("appinstalled", () => {
      this.installPrompt = null;
      this.installStateReady = true;
      this.detectedInstalledApp = true;
      clearTimeout(this.installIntroTimer);
      this.installIntroTimer = null;
      this.markInstallIntroSeen();
      this.closeDialog(this.elements.installDialog, "installed");
      this.updateInstallButton();
      this.toast(
        "PDF 工坊已安裝；Android 會將它註冊為 PDF 分享目標。",
        "success",
        7000
      );
    });

    openFileInput.addEventListener("change", async (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      if (!files.length) return;
      if (this.pages.length) {
        const confirmed = await this.confirmAction({
          title: "開啟新的文件？",
          message: "目前尚未匯出的編輯內容將被新的文件取代。",
          acceptLabel: "開啟新文件",
        });
        if (!confirmed) return;
      }
      await this.handleOpenFiles(files);
    });

    mergeFileInput.addEventListener("change", async (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      if (files.length) {
        await this.loadFiles(files, {
          replace: false,
          insertionAnchorId: this.activePageId,
          insertAtAnchorOnlyIfGrouped: true,
        });
      }
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

    excelFileInput.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await this.openExcelImport(file, { mode: "insert" });
    });

    openSidebarButton.addEventListener("click", () =>
      document.body.classList.add("sidebar-visible")
    );
    closeSidebarButton.addEventListener("click", () => {
      if (this.viewMode === "browse") {
        this.setViewMode(this.lastPageViewMode || "single");
        return;
      }
      document.body.classList.remove("sidebar-visible");
    });

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
      this.refreshSidebarSelection();
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
    groupSelectedButton.addEventListener("click", () =>
      this.groupSelectedPages()
    );

    undoButton.addEventListener("click", () => this.undo());
    redoButton.addEventListener("click", () => this.redo());
    rotateButton.addEventListener("click", () => this.rotateSelectedPages());
    deleteButton.addEventListener("click", () => this.deleteSelection());
    selectToolButton.addEventListener("click", () =>
      this.activateDrawingTool("select")
    );
    textToolButton.addEventListener("click", () => this.toggleTextControls());
    penToolButton.addEventListener("click", () => this.activateDrawingTool("pen"));
    highlightToolButton.addEventListener("click", () =>
      this.activateDrawingTool("highlight")
    );
    rectToolButton.addEventListener("click", () => this.activateDrawingTool("rect"));
    arrowToolButton.addEventListener("click", () =>
      this.activateDrawingTool("arrow")
    );
    imageToolButton.addEventListener("click", () => {
      this.activateDrawingTool("select");
      annotationImageInput.click();
    });
    signatureToolButton.addEventListener("click", () => {
      this.activateDrawingTool("select");
      this.openSignatureDialog();
    });
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
    this.elements.excelToPdfButton.addEventListener("click", () => {
      this.closeDialog(this.elements.insertDialog);
      excelFileInput.click();
    });
    this.elements.excelCloseButton.addEventListener("click", () =>
      this.cancelExcelImport()
    );
    this.elements.excelCancelButton.addEventListener("click", () =>
      this.cancelExcelImport()
    );
    this.elements.excelConvertButton.addEventListener("click", () =>
      this.convertSelectedExcelSheets()
    );
    this.elements.excelSelectVisibleButton.addEventListener("click", () => {
      for (const config of this.excelSheetConfigs) {
        config.selected = config.state === "visible";
      }
      this.renderExcelSheetList();
      this.updateExcelSelection();
    });
    this.elements.excelClearSelectionButton.addEventListener("click", () => {
      for (const config of this.excelSheetConfigs) config.selected = false;
      this.renderExcelSheetList();
      this.updateExcelSelection();
    });
    this.elements.excelSheetList.addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"][data-sheet-id]');
      if (!checkbox) return;
      const config = this.getExcelSheetConfig(checkbox.dataset.sheetId);
      if (!config) return;
      config.selected = checkbox.checked;
      checkbox.closest(".excel-sheet-row")?.classList.toggle("is-selected", checkbox.checked);
      this.updateExcelSelection();
    });
    this.elements.excelSheetList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-sheet-action]");
      if (!button) return;
      const sheetId = Number(button.dataset.sheetId);
      if (button.dataset.sheetAction === "select") {
        this.setExcelActiveSheet(sheetId);
      } else if (button.dataset.sheetAction === "up") {
        this.moveExcelSheet(sheetId, -1);
      } else if (button.dataset.sheetAction === "down") {
        this.moveExcelSheet(sheetId, 1);
      }
    });
    this.elements.excelSettingsPanel.addEventListener("input", (event) =>
      this.handleExcelSettingsInput(event)
    );
    this.elements.excelApplyLayoutButton.addEventListener("click", () =>
      this.applyExcelLayoutToSelectedSheets()
    );
    this.elements.excelPreviewPrevious.addEventListener("click", () =>
      this.changeExcelPreviewPage(-1)
    );
    this.elements.excelPreviewNext.addEventListener("click", () =>
      this.changeExcelPreviewPage(1)
    );
    this.elements.excelDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.cancelExcelImport();
    });
    this.elements.excelDialog.addEventListener("submit", (event) => {
      event.preventDefault();
    });

    this.bindSignaturePad();
    this.elements.clearSignatureButton.addEventListener("click", () =>
      this.clearSignaturePad()
    );
    this.elements.saveSignatureButton.addEventListener("click", () =>
      this.saveSignature()
    );
    this.elements.storeSignatureButton.addEventListener("click", () =>
      this.storeSignatureToLocalStorage()
    );

    // Color swatches
    this.elements.sigColorSwatches.forEach((swatch) => {
      swatch.addEventListener("click", () => {
        this.signatureColor = swatch.dataset.color;
        this._applySignatureStyle();
        this.elements.sigColorSwatches.forEach((s) =>
          s.classList.remove("sig-color-active")
        );
        this.elements.sigColorCustomLabel.classList.remove("sig-color-active");
        swatch.classList.add("sig-color-active");
      });
    });
    // Custom color picker
    this.elements.sigColorCustom.addEventListener("input", (event) => {
      this.signatureColor = event.target.value;
      this._applySignatureStyle();
      this.elements.sigColorSwatches.forEach((s) =>
        s.classList.remove("sig-color-active")
      );
      this.elements.sigColorCustomLabel.classList.add("sig-color-active");
    });
    // Stroke width buttons
    this.elements.sigWidthButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        this.signatureLineWidth = Number(btn.dataset.width);
        this._applySignatureStyle();
        this.elements.sigWidthButtons.forEach((b) =>
          b.classList.remove("sig-width-active")
        );
        btn.classList.add("sig-width-active");
      });
    });
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
    this.elements.groupNameDialog?.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.submitter?.value !== "confirm") {
        this.closeDialog(this.elements.groupNameDialog, "cancel");
        return;
      }
      this.applyPageGroupName();
    });
    this.elements.groupNameDialog?.addEventListener("close", () => {
      this.pendingGroupRenameId = null;
      if (this.elements.groupNameError) {
        this.elements.groupNameError.hidden = true;
      }
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
    const resetZoom = () => {
      if (this.viewMode === "browse") {
        this.browseZoom = 1;
        this.applyBrowseZoom();
        return;
      }
      this.zoom = 1;
      this.applyZoomChange();
    };
    zoomResetButton.addEventListener("click", resetZoom);
    for (const button of [
      this.elements.zoomSliderValue,
      this.elements.browseZoomValue,
    ]) {
      button?.addEventListener("click", resetZoom);
    }
    for (const button of [
      this.elements.statusZoomOutButton,
      this.elements.browseZoomOutButton,
    ]) {
      button?.addEventListener("click", () => this.changeZoom(-0.15));
    }
    for (const button of [
      this.elements.statusZoomInButton,
      this.elements.browseZoomInButton,
    ]) {
      button?.addEventListener("click", () => this.changeZoom(0.15));
    }
    for (const slider of [
      this.elements.zoomSlider,
      this.elements.browseZoomSlider,
    ]) {
      slider?.addEventListener("input", () =>
        this.handleZoomSliderInput(parseInt(slider.value, 10) / 100)
      );
    }

    this.elements.viewSingleButton?.addEventListener("click", () =>
      this.setViewMode("single")
    );
    this.elements.viewContinuousButton?.addEventListener("click", () =>
      this.setViewMode("continuous")
    );
    this.elements.viewBrowseButton?.addEventListener("click", () =>
      this.setViewMode("browse")
    );
    viewerScroll.addEventListener(
      "scroll",
      () => this.handleViewerScroll(),
      { passive: true }
    );

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
    window.addEventListener("pagehide", () => this.releaseDownloadUrls());

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
      const excelFiles = files.filter((file) => this.isExcelFile(file));
      if (excelFiles.length) {
        if (excelFiles.length > 1 || pdfFiles.length || imageFiles.length) {
          this.toast("請一次拖入一個 Excel，或改為拖入 PDF／圖片。", "error");
          return;
        }
        await this.openExcelImport(excelFiles[0], {
          mode: this.pages.length ? "insert" : "open",
        });
        return;
      }
      if (pdfFiles.length) {
        await this.loadFiles(pdfFiles, {
          replace: !this.pages.length,
          insertionAnchorId: this.activePageId,
          insertAtAnchorOnlyIfGrouped: true,
        });
      }
      if (imageFiles.length) {
        await this.convertImagesToPdf(imageFiles);
      }
      if (!pdfFiles.length && !imageFiles.length && files.length) {
        this.toast("請拖入 PDF、Excel 或圖片檔案。", "error");
      }
    });

    new ResizeObserver(() => {
      if (!this.pages.length) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.viewMode === "browse") {
          this.scheduleBrowseGroupLayout();
        }
        if (this.viewMode === "continuous") {
          this.rebuildContinuousLayout({ anchorActive: true });
        }
        this.renderActivePage();
      }, 120);
    }).observe(viewerScroll);

    this.setupToolbarOverflow();
  }

  setupToolbarOverflow() {
    const { toolbar, toolbarOverflow, toolbarMoreButton, toolbarOverflowMenu } =
      this.elements;
    if (!toolbar || !toolbarOverflow || !toolbarMoreButton || !toolbarOverflowMenu) {
      return;
    }

    // Buttons inside the toolbar groups that may be collapsed into the
    // overflow menu, in visual order. Their original parent is remembered
    // so they can be restored before each measurement.
    this.toolbarItems = [
      ...toolbar.querySelectorAll(".toolbar-group .tool-button"),
    ].map((button) => ({ button, parent: button.parentElement }));

    toolbarMoreButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleToolbarOverflowMenu();
    });
    toolbarOverflowMenu.addEventListener("click", (event) => {
      if (event.target.closest("button")) {
        this.toggleToolbarOverflowMenu(false);
      }
    });
    document.addEventListener("click", (event) => {
      if (
        !toolbarOverflowMenu.hidden &&
        !toolbarOverflow.contains(event.target)
      ) {
        this.toggleToolbarOverflowMenu(false);
      }
    });

    new ResizeObserver(() => {
      if (this.toolbarOverflowFrame) return;
      this.toolbarOverflowFrame = requestAnimationFrame(() => {
        this.toolbarOverflowFrame = null;
        this.updateToolbarOverflow();
      });
    }).observe(toolbar);
    this.updateToolbarOverflow();
  }

  toggleToolbarOverflowMenu(open) {
    const { toolbarMoreButton, toolbarOverflowMenu } = this.elements;
    const willOpen = open ?? toolbarOverflowMenu.hidden;
    toolbarOverflowMenu.hidden = !willOpen;
    toolbarMoreButton.setAttribute("aria-expanded", String(willOpen));
    toolbarMoreButton.classList.toggle("active", willOpen);
  }

  updateToolbarOverflow() {
    const { toolbar, toolbarOverflow, toolbarOverflowMenu } = this.elements;
    if (!toolbar || !this.toolbarItems.length) return;

    this.toggleToolbarOverflowMenu(false);

    // Restore every button to its group, then move trailing buttons into
    // the menu until the toolbar no longer overflows.
    for (const item of this.toolbarItems) item.parent.append(item.button);
    toolbarOverflowMenu.replaceChildren();
    toolbarOverflow.hidden = true;

    const fits = () => toolbar.scrollWidth <= toolbar.clientWidth;
    if (!fits()) {
      toolbarOverflow.hidden = false;
      for (
        let index = this.toolbarItems.length - 1;
        index >= 0 && !fits();
        index -= 1
      ) {
        toolbarOverflowMenu.prepend(this.toolbarItems[index].button);
      }
    }

    // Hide dividers that end up next to an empty group.
    for (const divider of toolbar.querySelectorAll(".toolbar-divider")) {
      const nextGroup = divider.nextElementSibling;
      divider.hidden =
        !!nextGroup?.classList.contains("toolbar-group") &&
        !nextGroup.childElementCount;
    }
  }

  isExcelFile(file) {
    return (
      file?.type ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file?.name?.toLowerCase().endsWith(".xlsx")
    );
  }

  async handleOpenFiles(files) {
    const excelFiles = files.filter((file) => this.isExcelFile(file));
    if (excelFiles.length) {
      if (files.length !== 1 || excelFiles.length !== 1) {
        this.toast("請單獨選擇一個 Excel 檔案進行轉換。", "error");
        return;
      }
      await this.openExcelImport(excelFiles[0], { mode: "open" });
      return;
    }
    await this.loadFiles(files, { replace: true });
  }

  createExcelWorker() {
    this.disposeExcelWorker();
    if (!("Worker" in window)) {
      throw new Error("此瀏覽器不支援背景轉換 Excel。");
    }
    const worker = new Worker("./excel-worker.js");
    worker.addEventListener("message", (event) => {
      const message = event.data || {};
      const pending = this.excelWorkerRequests.get(message.requestId);
      if (message.type === "progress") {
        if (pending?.showProgress) {
          this.setBusy(
            true,
            message.title || "正在處理 Excel",
            message.detail || "請稍候…",
            message.progress || 0
          );
        }
        return;
      }
      if (!pending) return;
      this.excelWorkerRequests.delete(message.requestId);
      if (message.type === "error") {
        pending.reject(new Error(message.message || "Excel 轉換失敗。"));
        return;
      }
      pending.resolve(message);
    });
    worker.addEventListener("error", (event) => {
      console.error("[PDF Editor] Excel worker failed", event);
      for (const pending of this.excelWorkerRequests.values()) {
        pending.reject(new Error("Excel 轉換元件載入失敗。"));
      }
      this.excelWorkerRequests.clear();
    });
    this.excelWorker = worker;
  }

  requestExcelWorker(
    type,
    payload = {},
    transfer = [],
    { showProgress = false } = {}
  ) {
    if (!this.excelWorker) {
      return Promise.reject(new Error("Excel 轉換元件尚未啟動。"));
    }
    const requestId = ++this.excelWorkerRequestSequence;
    return new Promise((resolve, reject) => {
      this.excelWorkerRequests.set(requestId, {
        type,
        resolve,
        reject,
        showProgress,
      });
      try {
        this.excelWorker.postMessage({ type, requestId, ...payload }, transfer);
      } catch (error) {
        this.excelWorkerRequests.delete(requestId);
        reject(error);
      }
    });
  }

  disposeExcelWorker() {
    for (const pending of this.excelWorkerRequests.values()) {
      pending.reject(new DOMException("Excel import cancelled", "AbortError"));
    }
    this.excelWorkerRequests.clear();
    this.excelWorker?.terminate();
    this.excelWorker = null;
  }

  cancelExcelImport() {
    clearTimeout(this.excelEstimateTimer);
    this.excelEstimateTimer = null;
    this.excelEstimateToken += 1;
    this.excelPreviewToken += 1;
    this.closeDialog(this.elements.excelDialog, "cancel");
    this.disposeExcelWorker();
    this.destroyExcelPreview();
    this.excelWorkbookInfo = null;
    this.excelSheetConfigs = [];
    this.excelActiveSheetId = null;
    this.setBusy(false);
  }

  destroyExcelPreview() {
    try {
      this.excelPreviewRenderTask?.cancel?.();
    } catch {}
    this.excelPreviewRenderTask = null;
    this.excelPreviewDocument?.destroy?.().catch?.(() => {});
    this.excelPreviewDocument = null;
    if (this.elements.excelPreviewCanvas) {
      this.elements.excelPreviewCanvas.hidden = true;
      this.elements.excelPreviewCanvas.width = 0;
      this.elements.excelPreviewCanvas.height = 0;
    }
  }

  async openExcelImport(file, { mode = "insert" } = {}) {
    if (!this.isExcelFile(file)) {
      this.toast("目前支援 .xlsx 格式的 Excel 檔案。", "error");
      return;
    }
    const maxFileBytes = 25 * 1024 * 1024;
    if (file.size > maxFileBytes) {
      this.toast("Excel 檔案超過 25 MB，請先縮小檔案或列印範圍。", "error", 8000);
      return;
    }

    this.excelImportMode = mode === "open" || !this.pages.length ? "open" : "insert";
    this.excelPreviousActiveId = this.activePageId;
    this.excelSourceFile = file;
    this.excelWorkbookInfo = null;
    this.excelSheetConfigs = [];
    this.excelActiveSheetId = null;
    this.excelEstimateError = null;
    this.excelPreviewPageIndex = 0;
    this.destroyExcelPreview();
    this.elements.excelFileName.textContent = file.name;
    this.elements.excelWorkbookMeta.textContent = "正在讀取工作表…";
    this.elements.excelSheetList.replaceChildren();
    this.elements.excelCompatibilitySummary.textContent = "檢查中…";
    this.elements.excelCompatibilityReport.replaceChildren();
    this.showExcelPreviewPlaceholder("正在準備預覽", "變更範圍或版面後會自動更新");
    this.setBusy(true, "正在讀取 Excel", file.name, 2);

    try {
      this.createExcelWorker();
      const buffer = await file.arrayBuffer();
      const result = await this.requestExcelWorker(
        "parse",
        { name: file.name, buffer },
        [buffer],
        { showProgress: true }
      );
      this.excelWorkbookInfo = result;
      this.renderExcelSheetSelection(result);
      this.setBusy(false);
      this.openDialog(this.elements.excelDialog);
    } catch (error) {
      this.setBusy(false);
      if (error?.name === "AbortError") return;
      console.error("[PDF Editor] Excel parse failed", error);
      this.disposeExcelWorker();
      this.toast(
        /password|encrypt/i.test(error?.message || "")
          ? "目前不支援密碼保護的 Excel 檔案。"
          : error?.message || "Excel 讀取失敗，請確認檔案未損壞。",
        "error",
        8000
      );
    }
  }

  renderExcelSheetSelection(result) {
    const sheets = Array.isArray(result.sheets) ? result.sheets : [];
    this.excelSheetConfigs = sheets.map((sheet) => ({
      id: Number(sheet.id),
      name: sheet.name,
      state: sheet.state || "visible",
      selected: (sheet.state || "visible") === "visible",
      pageCount: Math.max(1, sheet.estimatedPages || 1),
      range: sheet.range || sheet.usedRange || "A1:A1",
      usedRange: sheet.usedRange || "A1:A1",
      rowCount: sheet.rowCount || 0,
      columnCount: sheet.columnCount || 0,
      compatibility: sheet.compatibility || { error: 0, warning: 0, info: 0 },
      options: {
        rangeMode: "used",
        customRange: sheet.usedRange || "A1:A1",
        paperSize: "source",
        orientation: "source",
        scaling: "source",
        scalePercent: 100,
        margins: "source",
        repeatRows: "",
        repeatColumns: "",
        rowBreaks: "",
        columnBreaks: "",
        pageOrder: "source",
        centerHorizontal: false,
        centerVertical: false,
        includeHeaderFooter: true,
        addPageNumbers: false,
        gridLines: false,
        ...(sheet.printSettings || {}),
      },
    }));
    this.excelActiveSheetId =
      this.excelSheetConfigs.find((config) => config.selected)?.id ||
      this.excelSheetConfigs[0]?.id ||
      null;
    this.renderExcelSheetList();
    this.renderExcelSheetSettings();
    this.renderExcelCompatibilityReport(result.compatibility);

    const visibleCount = sheets.filter(
      (sheet) => (sheet.state || "visible") === "visible"
    ).length;
    this.elements.excelWorkbookMeta.textContent = `${sheets.length} 個 Sheet・${visibleCount} 個可見`;
    this.elements.excelInsertPositionField.hidden =
      this.excelImportMode !== "insert" || !this.pages.length;
    this.elements.excelConvertButton.textContent =
      this.excelImportMode === "open" ? "建立 PDF 文件" : "轉換並插入";
    this.updateExcelSelection();
    this.scheduleExcelEstimate(0);
  }

  getExcelSheetConfig(sheetId = this.excelActiveSheetId) {
    return this.excelSheetConfigs.find(
      (config) => config.id === Number(sheetId)
    );
  }

  renderExcelSheetList() {
    const list = this.elements.excelSheetList;
    list.replaceChildren();
    this.excelSheetConfigs.forEach((config, index) => {
      const row = document.createElement("div");
      row.className = "excel-sheet-row";
      row.classList.toggle("is-selected", config.selected);
      row.classList.toggle("is-active", config.id === this.excelActiveSheetId);
      row.dataset.sheetId = String(config.id);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(config.id === this.excelActiveSheetId));

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.sheetId = String(config.id);
      checkbox.checked = config.selected;
      checkbox.setAttribute("aria-label", `轉換 ${config.name}`);

      const main = document.createElement("button");
      main.className = "excel-sheet-main";
      main.type = "button";
      main.dataset.sheetAction = "select";
      main.dataset.sheetId = String(config.id);
      const name = document.createElement("span");
      name.className = "excel-sheet-name";
      const title = document.createElement("strong");
      title.textContent = config.name;
      name.append(title);
      if (config.state !== "visible") {
        const state = document.createElement("span");
        state.className = "excel-sheet-state";
        state.textContent = config.state === "veryHidden" ? "深度隱藏" : "隱藏";
        name.append(state);
      }
      const meta = document.createElement("small");
      meta.textContent = `${config.range}・${config.rowCount} 列 × ${config.columnCount} 欄`;
      main.append(name, meta);

      const badges = document.createElement("span");
      badges.className = "excel-sheet-badges";
      for (const severity of ["error", "warning", "info"]) {
        const count = Number(config.compatibility?.[severity]) || 0;
        if (!count) continue;
        const badge = document.createElement("span");
        badge.className = `excel-sheet-badge ${severity}`;
        badge.textContent = String(count);
        badge.title = `${config.name}：${count} 項${
          severity === "error" ? "需處理" : severity === "warning" ? "警告" : "提示"
        }`;
        badges.append(badge);
      }
      name.append(badges);

      const pages = document.createElement("span");
      pages.className = "excel-sheet-pages";
      pages.dataset.sheetPages = String(config.id);
      pages.textContent = `${Math.max(1, config.pageCount || 1)} 頁`;

      const move = document.createElement("span");
      move.className = "excel-sheet-move";
      const up = document.createElement("button");
      up.type = "button";
      up.dataset.sheetAction = "up";
      up.dataset.sheetId = String(config.id);
      up.disabled = index === 0;
      up.textContent = "↑";
      up.setAttribute("aria-label", `將 ${config.name} 往前移`);
      const down = document.createElement("button");
      down.type = "button";
      down.dataset.sheetAction = "down";
      down.dataset.sheetId = String(config.id);
      down.disabled = index === this.excelSheetConfigs.length - 1;
      down.textContent = "↓";
      down.setAttribute("aria-label", `將 ${config.name} 往後移`);
      move.append(up, down);

      row.append(checkbox, main, pages, move);
      list.append(row);
    });
  }

  setExcelActiveSheet(sheetId) {
    if (!this.getExcelSheetConfig(sheetId)) return;
    this.excelActiveSheetId = Number(sheetId);
    this.excelPreviewPageIndex = 0;
    for (const row of this.elements.excelSheetList.querySelectorAll(".excel-sheet-row")) {
      const active = Number(row.dataset.sheetId) === this.excelActiveSheetId;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-selected", String(active));
    }
    this.renderExcelSheetSettings();
    this.requestExcelPreview();
  }

  moveExcelSheet(sheetId, direction) {
    const index = this.excelSheetConfigs.findIndex(
      (config) => config.id === Number(sheetId)
    );
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= this.excelSheetConfigs.length) return;
    const [config] = this.excelSheetConfigs.splice(index, 1);
    this.excelSheetConfigs.splice(nextIndex, 0, config);
    this.renderExcelSheetList();
    this.updateExcelSelection();
  }

  renderExcelSheetSettings() {
    const config = this.getExcelSheetConfig();
    const panel = this.elements.excelSettingsPanel;
    panel.toggleAttribute("inert", !config);
    this.elements.excelActiveSheetName.textContent = config?.name || "—";
    if (!config) return;
    const options = config.options;
    this.elements.excelRangeMode.value = options.rangeMode;
    this.elements.excelCustomRange.value = options.customRange || "";
    this.elements.excelPaperSize.value = options.paperSize;
    this.elements.excelOrientation.value = options.orientation;
    this.elements.excelScaling.value = options.scaling;
    this.elements.excelScalePercent.value = options.scalePercent || 100;
    this.elements.excelMargins.value = options.margins;
    this.elements.excelPageOrder.value = options.pageOrder;
    this.elements.excelRepeatRows.value = options.repeatRows || "";
    this.elements.excelRepeatColumns.value = options.repeatColumns || "";
    this.elements.excelRowBreaks.value = options.rowBreaks || "";
    this.elements.excelColumnBreaks.value = options.columnBreaks || "";
    this.elements.excelCenterHorizontal.checked = !!options.centerHorizontal;
    this.elements.excelCenterVertical.checked = !!options.centerVertical;
    this.elements.excelIncludeHeaderFooter.checked = !!options.includeHeaderFooter;
    this.elements.excelAddPageNumbers.checked = !!options.addPageNumbers;
    this.elements.excelGridLines.checked = !!options.gridLines;
    this.updateExcelConditionalFields();
  }

  updateExcelConditionalFields() {
    this.elements.excelCustomRangeField.hidden =
      this.elements.excelRangeMode.value !== "custom";
    this.elements.excelScalePercentField.hidden =
      this.elements.excelScaling.value !== "custom";
  }

  handleExcelSettingsInput(event) {
    const config = this.getExcelSheetConfig();
    if (!config) return;
    const optionById = {
      excelRangeMode: "rangeMode",
      excelCustomRange: "customRange",
      excelPaperSize: "paperSize",
      excelOrientation: "orientation",
      excelScaling: "scaling",
      excelScalePercent: "scalePercent",
      excelMargins: "margins",
      excelPageOrder: "pageOrder",
      excelRepeatRows: "repeatRows",
      excelRepeatColumns: "repeatColumns",
      excelRowBreaks: "rowBreaks",
      excelColumnBreaks: "columnBreaks",
      excelCenterHorizontal: "centerHorizontal",
      excelCenterVertical: "centerVertical",
      excelIncludeHeaderFooter: "includeHeaderFooter",
      excelAddPageNumbers: "addPageNumbers",
      excelGridLines: "gridLines",
    };
    const option = optionById[event.target.id];
    if (!option) return;
    let value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    if (option === "scalePercent") {
      value = Math.min(400, Math.max(10, Number(value) || 100));
    }
    config.options[option] = value;
    this.excelPreviewPageIndex = 0;
    this.updateExcelConditionalFields();
    this.scheduleExcelEstimate();
  }

  applyExcelLayoutToSelectedSheets() {
    const source = this.getExcelSheetConfig();
    if (!source) return;
    const layoutKeys = [
      "paperSize",
      "orientation",
      "scaling",
      "scalePercent",
      "margins",
      "pageOrder",
      "centerHorizontal",
      "centerVertical",
      "includeHeaderFooter",
      "addPageNumbers",
      "gridLines",
    ];
    let applied = 0;
    for (const config of this.excelSheetConfigs) {
      if (!config.selected || config.id === source.id) continue;
      for (const key of layoutKeys) config.options[key] = source.options[key];
      applied += 1;
    }
    this.toast(
      applied ? `已將版面設定套用到另外 ${applied} 個 Sheet。` : "沒有其他已選取的 Sheet。",
      applied ? "success" : "error",
      3600
    );
    if (applied) this.scheduleExcelEstimate(0);
  }

  renderExcelCompatibilityReport(report = {}) {
    const summary = report.summary || { error: 0, warning: 0, info: 0 };
    const summaryElement = this.elements.excelCompatibilitySummary;
    summaryElement.replaceChildren();
    const labels = { error: "需處理", warning: "警告", info: "提示" };
    for (const severity of ["error", "warning", "info"]) {
      const badge = document.createElement("span");
      badge.className = `excel-compatibility-count ${severity}`;
      badge.textContent = `${labels[severity]} ${summary[severity] || 0}`;
      summaryElement.append(badge);
    }

    const list = this.elements.excelCompatibilityReport;
    list.replaceChildren();
    const items = Array.isArray(report.items) ? report.items : [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "excel-compatibility-empty";
      empty.textContent = "未發現目前已知的轉換相容性問題。";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = `excel-compatibility-item ${item.severity}`;
      const icon = document.createElement("span");
      icon.className = "excel-compatibility-icon";
      icon.textContent = item.severity === "error" ? "!" : item.severity === "warning" ? "△" : "i";
      const copy = document.createElement("span");
      copy.className = "excel-compatibility-copy";
      const title = document.createElement("strong");
      title.textContent = item.message;
      const sheet = document.createElement("span");
      sheet.textContent = item.sheetName;
      copy.append(title, sheet);
      if (item.detail) {
        const detail = document.createElement("small");
        detail.textContent = item.detail;
        copy.append(detail);
      }
      row.append(icon, copy);
      list.append(row);
    }
  }

  getExcelSheetPayload({ selectedOnly = false } = {}) {
    return this.excelSheetConfigs
      .filter((config) => !selectedOnly || config.selected)
      .map((config) => ({ id: config.id, options: { ...config.options } }));
  }

  updateExcelSelection() {
    const selected = this.excelSheetConfigs.filter((config) => config.selected);
    const estimatedPages = selected.reduce(
      (sum, config) => sum + Math.max(1, config.pageCount || 1),
      0
    );
    this.elements.excelSelectionSummary.textContent = selected.length
      ? `已選 ${selected.length} 個，預估 ${estimatedPages} 頁${
          this.excelEstimatePending ? "（重新計算中）" : ""
        }`
      : "尚未選取";
    this.elements.excelConvertButton.disabled =
      !selected.length || !!this.excelEstimateError;
  }

  scheduleExcelEstimate(delay = 260) {
    clearTimeout(this.excelEstimateTimer);
    const token = ++this.excelEstimateToken;
    this.excelEstimatePending = true;
    this.excelEstimateError = null;
    this.updateExcelSelection();
    this.elements.excelPreviewStatus.textContent = "正在重新計算頁數…";
    this.excelEstimateTimer = setTimeout(async () => {
      try {
        const result = await this.requestExcelWorker("estimate", {
          sheets: this.getExcelSheetPayload(),
        });
        if (token !== this.excelEstimateToken) return;
        for (const item of result.sheets || []) {
          const config = this.getExcelSheetConfig(item.id);
          if (!config) continue;
          config.pageCount = Math.max(1, item.pageCount || 1);
          if (item.ranges?.length) config.range = item.ranges.join("、");
          const pages = this.elements.excelSheetList.querySelector(
            `[data-sheet-pages="${config.id}"]`
          );
          if (pages) pages.textContent = `${config.pageCount} 頁`;
          const rowMeta = this.elements.excelSheetList.querySelector(
            `.excel-sheet-row[data-sheet-id="${config.id}"] .excel-sheet-main small`
          );
          if (rowMeta) {
            rowMeta.textContent = `${config.range}・${config.rowCount} 列 × ${config.columnCount} 欄`;
          }
        }
        this.excelEstimatePending = false;
        this.excelEstimateError = null;
        const active = this.getExcelSheetConfig();
        this.excelPreviewPageIndex = Math.min(
          this.excelPreviewPageIndex,
          Math.max(0, (active?.pageCount || 1) - 1)
        );
        this.updateExcelSelection();
        this.requestExcelPreview();
      } catch (error) {
        if (token !== this.excelEstimateToken || error?.name === "AbortError") return;
        this.excelEstimatePending = false;
        this.excelEstimateError = error;
        this.elements.excelPreviewStatus.textContent = "設定無法產生預覽";
        this.showExcelPreviewPlaceholder("請檢查 Sheet 設定", error.message);
        this.updateExcelSelection();
      }
    }, delay);
  }

  showExcelPreviewPlaceholder(title, detail = "") {
    const placeholder = this.elements.excelPreviewPlaceholder;
    placeholder.hidden = false;
    const strong = placeholder.querySelector("strong");
    const small = placeholder.querySelector("small");
    if (strong) strong.textContent = title;
    if (small) small.textContent = detail;
    this.elements.excelPreviewCanvas.hidden = true;
  }

  async requestExcelPreview() {
    const config = this.getExcelSheetConfig();
    if (!config || !this.excelWorker || this.excelEstimateError) return;
    const pageCount = Math.max(1, config.pageCount || 1);
    this.excelPreviewPageIndex = Math.min(
      Math.max(0, this.excelPreviewPageIndex),
      pageCount - 1
    );
    const token = ++this.excelPreviewToken;
    this.elements.excelPreviewStatus.textContent = `${config.name}・正在產生預覽`;
    this.elements.excelPreviewPage.textContent = `${this.excelPreviewPageIndex + 1} / ${pageCount}`;
    this.elements.excelPreviewPrevious.disabled = this.excelPreviewPageIndex === 0;
    this.elements.excelPreviewNext.disabled = this.excelPreviewPageIndex >= pageCount - 1;
    this.showExcelPreviewPlaceholder("正在產生單頁預覽", config.name);
    try {
      const result = await this.requestExcelWorker("preview", {
        sheet: { id: config.id, options: { ...config.options } },
        pageIndex: this.excelPreviewPageIndex,
      });
      if (token !== this.excelPreviewToken) return;
      config.pageCount = Math.max(1, result.pageCount || 1);
      this.excelPreviewPageIndex = result.pageIndex || 0;
      await this.renderExcelPreviewPdf(result.bytes, token);
      if (token !== this.excelPreviewToken) return;
      this.elements.excelPreviewStatus.textContent = `${config.name}・${Math.round(
        result.pageWidth
      )} × ${Math.round(result.pageHeight)} pt`;
      this.elements.excelPreviewPage.textContent = `${this.excelPreviewPageIndex + 1} / ${config.pageCount}`;
      this.elements.excelPreviewPrevious.disabled = this.excelPreviewPageIndex === 0;
      this.elements.excelPreviewNext.disabled =
        this.excelPreviewPageIndex >= config.pageCount - 1;
    } catch (error) {
      if (token !== this.excelPreviewToken || error?.name === "AbortError") return;
      console.error("[PDF Editor] Excel preview failed", error);
      this.elements.excelPreviewStatus.textContent = "預覽失敗";
      this.showExcelPreviewPlaceholder("無法顯示預覽", error.message);
    }
  }

  async renderExcelPreviewPdf(bytes, token) {
    try {
      this.excelPreviewRenderTask?.cancel?.();
    } catch {}
    this.excelPreviewDocument?.destroy?.().catch?.(() => {});
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useWorkerFetch: false,
      standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
      cMapUrl: PDFJS_CMAP_URL,
      cMapPacked: true,
      wasmUrl: PDFJS_WASM_URL,
      useSystemFonts: true,
    });
    const document = await loadingTask.promise;
    if (token !== this.excelPreviewToken) {
      await document.destroy();
      return;
    }
    this.excelPreviewDocument = document;
    const page = await document.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const stage = this.elements.excelPreviewStage;
    const availableWidth = Math.max(180, stage.clientWidth - 34);
    const availableHeight = Math.max(240, stage.clientHeight - 34);
    const scale = Math.min(
      1.25,
      availableWidth / baseViewport.width,
      availableHeight / baseViewport.height
    );
    const viewport = page.getViewport({ scale: Math.max(0.2, scale) });
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const canvas = this.elements.excelPreviewCanvas;
    canvas.width = Math.ceil(viewport.width * pixelRatio);
    canvas.height = Math.ceil(viewport.height * pixelRatio);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    const context = canvas.getContext("2d", { alpha: false });
    this.excelPreviewRenderTask = page.render({
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      background: "#ffffff",
    });
    await this.excelPreviewRenderTask.promise;
    if (token !== this.excelPreviewToken) return;
    this.elements.excelPreviewPlaceholder.hidden = true;
    canvas.hidden = false;
  }

  changeExcelPreviewPage(direction) {
    const config = this.getExcelSheetConfig();
    if (!config) return;
    const next = Math.min(
      Math.max(0, this.excelPreviewPageIndex + direction),
      Math.max(0, config.pageCount - 1)
    );
    if (next === this.excelPreviewPageIndex) return;
    this.excelPreviewPageIndex = next;
    this.requestExcelPreview();
  }

  async convertSelectedExcelSheets() {
    const selectedSheets = this.getExcelSheetPayload({ selectedOnly: true });
    if (!selectedSheets.length) {
      this.toast("請至少選取一個 Sheet。", "error");
      return;
    }
    this.elements.excelConvertButton.disabled = true;
    this.setBusy(true, "正在將 Excel 轉成 PDF", "準備工作表版面", 1);

    try {
      const result = await this.requestExcelWorker(
        "convert",
        { sheets: selectedSheets },
        [],
        { showProgress: true }
      );
      const sourceBase = (this.excelSourceFile?.name || "Excel")
        .replace(/\.xlsx$/i, "")
        .trim();
      const pdfName = `${this.sanitizeFileName(sourceBase || "Excel")}-Excel.pdf`;
      const pdfFile = new File([new Uint8Array(result.bytes)], pdfName, {
        type: "application/pdf",
      });
      const shouldReplace = this.excelImportMode === "open" || !this.pages.length;
      const insertedIds = await this.loadFiles([pdfFile], {
        replace: shouldReplace,
        remember: false,
        insertionAnchorId:
          !shouldReplace &&
          this.elements.excelInsertPosition.value === "after"
            ? this.excelPreviousActiveId
            : null,
      });

      if (insertedIds.length) {
        this.dirty = true;
        this.updateUI();
        this.scheduleAutosave();
      }

      if (this.excelSourceFile) {
        await this.rememberRecentFiles([this.excelSourceFile]);
      }
      this.closeDialog(this.elements.excelDialog, "converted");
      this.disposeExcelWorker();
      this.destroyExcelPreview();
      this.excelWorkbookInfo = null;
      this.excelSheetConfigs = [];
      this.setBusy(false);
      this.toast(
        `已將 ${selectedSheets.length} 個 Sheet 轉成 ${result.pageCount} 頁 PDF。`,
        "success",
        6500
      );
      if (result.warnings?.length) {
        this.toast(result.warnings.slice(0, 2).join("；"), "error", 8000);
      }
    } catch (error) {
      this.setBusy(false);
      if (error?.name === "AbortError") return;
      console.error("[PDF Editor] Excel conversion failed", error);
      this.elements.excelConvertButton.disabled = false;
      this.toast(error?.message || "Excel 轉 PDF 失敗。", "error", 8000);
    }
  }

  async loadFiles(
    fileList,
    {
      replace = false,
      remember = true,
      insertionAnchorId = null,
      insertAtAnchorOnlyIfGrouped = false,
    } = {}
  ) {
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
      const pageTotal = loaded.reduce((sum, item) => sum + item.pages.length, 0);
      const insertionContext =
        !replace && insertionAnchorId
          ? getContainingPageGroup(this.pages, insertionAnchorId)
          : null;
      let insertionMode = null;
      let targetGroupName = "";

      if (insertionContext) {
        targetGroupName = this.getPageGroupLabel(insertionContext.groupId);
        if (pageTotal === 1) {
          insertionMode = PAGE_INSERTION_MODE.CURRENT_GROUP;
        } else {
          this.setBusy(false);
          insertionMode = await this.chooseGroupedPageInsertion({
            pageCount: pageTotal,
            groupName: targetGroupName,
          });
          if (!insertionMode) {
            for (const { source } of loaded) {
              source.loadingTask?.destroy?.().catch?.(() => {});
            }
            return [];
          }
          this.setBusy(
            true,
            "正在插入 PDF",
            `準備加入 ${pageTotal} 個頁面`,
            90
          );
        }
      } else if (insertionAnchorId && !insertAtAnchorOnlyIfGrouped) {
        insertionMode = PAGE_INSERTION_MODE.AFTER_ANCHOR;
      }

      if (replace) {
        for (const source of this.sources.values()) {
          source.loadingTask?.destroy?.().catch?.(() => {});
        }
        this.sources.clear();
        this.pages = [];
        this.textIndex.clear();
        this.thumbnailCache.clear();
        this.annotationImages.clear();
        this.persistedSourceIds.clear();
        this.undoStack = [];
        this.redoStack = [];
      } else {
        this.pushHistory();
        this.redoStack = [];
      }

      newPageIds = [];
      for (const { source, pages } of loaded) {
        this.sources.set(source.id, source);
        this.pages.push(...pages);
        newPageIds.push(...pages.map((page) => page.id));
      }

      if (insertionMode) {
        this.pages = arrangeInsertedPages({
          pages: this.pages,
          insertedIds: newPageIds,
          anchorPageId: insertionAnchorId,
          mode: insertionMode,
          newGroupId:
            insertionMode === PAGE_INSERTION_MODE.AFTER_GROUP
              ? makeId("group")
              : null,
          targetGroupName,
        });
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
      if (remember) await this.rememberRecentFiles(files);
      this.scheduleAutosave();
      if (
        this.elements.searchControls &&
        !this.elements.searchControls.hidden &&
        this.elements.searchInput.value.trim()
      ) {
        this.performSearch();
      }

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

  chooseGroupedPageInsertion({ pageCount, groupName }) {
    const dialog = this.elements.groupedInsertionDialog;
    if (!dialog) return Promise.resolve(PAGE_INSERTION_MODE.CURRENT_GROUP);
    this.elements.groupedInsertionTitle.textContent = `插入 ${pageCount} 個頁面`;
    this.elements.groupedInsertionMessage.textContent =
      "目前頁面位於群組中，請選擇多頁內容的插入方式。";
    this.elements.groupedInsertionCurrentGroupName.textContent = groupName;
    dialog.returnValue = "cancel";
    this.openDialog(dialog);
    return new Promise((resolve) => {
      dialog.addEventListener(
        "close",
        () => {
          const value = dialog.returnValue;
          resolve(
            value === PAGE_INSERTION_MODE.CURRENT_GROUP ||
              value === PAGE_INSERTION_MODE.AFTER_GROUP
              ? value
              : null
          );
        },
        { once: true }
      );
    });
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
        groupId: sourceId,
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
    if (this.viewMode === "continuous") this.rebuildContinuousLayout();
    this.renderActivePage();
  }

  migrateLegacyPageGroups(pages) {
    let previousSourceId = null;
    let runGroupId = null;
    for (const page of pages) {
      if (Object.prototype.hasOwnProperty.call(page, "groupId")) {
        previousSourceId = page.sourceId;
        runGroupId = page.groupId;
        continue;
      }
      if (page.sourceId !== previousSourceId || !runGroupId) {
        runGroupId = makeId("group");
      }
      page.groupId = runGroupId;
      previousSourceId = page.sourceId;
    }
    return pages;
  }

  normalizeState() {
    const pageIds = new Set(this.pages.map((page) => page.id));
    const pageGroupIds = new Set(
      this.pages.map((page) => page.groupId).filter(Boolean)
    );
    this.selectedPageIds = new Set(
      [...this.selectedPageIds].filter((id) => pageIds.has(id))
    );
    this.collapsedPageGroupIds = new Set(
      [...this.collapsedPageGroupIds].filter((id) => pageGroupIds.has(id))
    );

    if (!pageIds.has(this.activePageId)) {
      this.activePageId = this.pages[0]?.id || null;
    }

    if (!this.pages.length) {
      this.activePageId = null;
      this.selectedPageIds.clear();
      this.selectedAnnotationId = null;
      this.previewSlots = [];
      this.previewQueue.length = 0;
      this.elements.previewFlow?.replaceChildren();
      this.elements.documentView?.classList.remove("skimming");
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
      !hasDocument || !this.supportsPdfFileShare();
    this.elements.undoButton.disabled = !hasDocument || !this.undoStack.length;
    this.elements.redoButton.disabled = !hasDocument || !this.redoStack.length;
    this.elements.rotateButton.disabled = !hasDocument;
    this.elements.deleteButton.disabled = !hasDocument;
    this.elements.selectToolButton.disabled = !hasDocument;
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
    const usingBrowseZoom = this.viewMode === "browse";
    const zoomValue = usingBrowseZoom ? this.browseZoom : this.zoom;
    const zoomMin = usingBrowseZoom ? BROWSE_ZOOM_MIN : 0.5;
    const zoomMax = usingBrowseZoom ? BROWSE_ZOOM_MAX : 2.5;
    const zoomPercent = Math.round(zoomValue * 100);
    const zoomAtMin = !hasDocument || zoomValue <= zoomMin;
    const zoomAtMax = !hasDocument || zoomValue >= zoomMax;
    this.elements.zoomOutButton.disabled = zoomAtMin;
    this.elements.zoomInButton.disabled = zoomAtMax;
    this.elements.zoomResetButton.disabled = !hasDocument;
    for (const button of [
      this.elements.statusZoomOutButton,
      this.elements.browseZoomOutButton,
    ]) {
      if (button) button.disabled = zoomAtMin;
    }
    for (const button of [
      this.elements.statusZoomInButton,
      this.elements.browseZoomInButton,
    ]) {
      if (button) button.disabled = zoomAtMax;
    }
    for (const slider of [
      this.elements.zoomSlider,
      this.elements.browseZoomSlider,
    ]) {
      if (!slider) continue;
      slider.min = Math.round(zoomMin * 100);
      slider.max = Math.round(zoomMax * 100);
      slider.value = zoomPercent;
      slider.disabled = !hasDocument;
    }
    for (const value of [
      this.elements.zoomSliderValue,
      this.elements.browseZoomValue,
    ]) {
      if (!value) continue;
      value.disabled = !hasDocument;
      value.textContent = `${zoomPercent}%`;
    }
    this.elements.extractButton.disabled = !selectedCount;
    this.elements.groupSelectedButton.disabled = selectedCount < 2;
    this.elements.rangeButton.disabled = !hasDocument;
    this.elements.selectAllCheckbox.disabled = !hasDocument;

    this.elements.zoomResetButton.textContent = `${zoomPercent}%`;

    const viewModeButtons = [
      [this.elements.viewSingleButton, "single"],
      [this.elements.viewContinuousButton, "continuous"],
      [this.elements.viewBrowseButton, "browse"],
    ];
    for (const [button, mode] of viewModeButtons) {
      if (!button) continue;
      button.disabled = !hasDocument;
      const active = this.viewMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
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

  getPageGroupCounts() {
    const counts = new Map();
    for (const page of this.pages) {
      if (!page.groupId) continue;
      counts.set(page.groupId, (counts.get(page.groupId) || 0) + 1);
    }
    return counts;
  }

  getPageBlocks() {
    const groupCounts = this.getPageGroupCounts();
    const blocks = [];
    for (let index = 0; index < this.pages.length; ) {
      const page = this.pages[index];
      const groupId =
        page.groupId && (groupCounts.get(page.groupId) || 0) > 1
          ? page.groupId
          : null;
      if (!groupId) {
        blocks.push({ type: "page", id: page.id, pages: [page] });
        index += 1;
        continue;
      }
      const pages = [];
      while (index < this.pages.length && this.pages[index].groupId === groupId) {
        pages.push(this.pages[index]);
        index += 1;
      }
      blocks.push({ type: "group", id: groupId, pages });
    }
    return blocks;
  }

  getPageGroupLabel(groupId) {
    const pages = this.pages.filter((page) => page.groupId === groupId);
    const customLabel = pages.find((page) => page.groupName)?.groupName;
    if (customLabel) return customLabel;
    const sourceNames = [
      ...new Set(
        pages
          .map((page) => this.sources.get(page.sourceId)?.name)
          .filter(Boolean)
      ),
    ];
    return sourceNames.length === 1 ? sourceNames[0] : "自訂頁面群組";
  }

  getPageGroupColorIndex(groupId) {
    const groupIds = [
      ...new Set(this.pages.map((page) => page.groupId).filter(Boolean)),
    ];
    return Math.max(0, groupIds.indexOf(groupId)) % 6;
  }

  canMovePageGroup(groupId, delta) {
    const blocks = this.getPageBlocks();
    const index = blocks.findIndex(
      (block) => block.type === "group" && block.id === groupId
    );
    return index >= 0 && index + delta >= 0 && index + delta < blocks.length;
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
    const groupCounts = this.getPageGroupCounts();
    let currentGroupId = null;
    let currentGroupPages = null;

    this.pages.forEach((pageRecord, index) => {
      const source = this.sources.get(pageRecord.sourceId);
      const displayGroupId =
        pageRecord.groupId && (groupCounts.get(pageRecord.groupId) || 0) > 1
          ? pageRecord.groupId
          : null;
      if (displayGroupId !== currentGroupId) {
        currentGroupId = displayGroupId;
        currentGroupPages = null;
        if (displayGroupId) {
          const groupedPageRecords = this.pages.filter(
            (page) => page.groupId === displayGroupId
          );
          const groupedPageIds = groupedPageRecords.map((page) => page.id);
          const group = document.createElement("section");
          group.className = "page-group";
          group.dataset.groupId = displayGroupId;
          group.dataset.groupColor = String(
            this.getPageGroupColorIndex(displayGroupId)
          );
          const groupCollapsed =
            this.collapsedPageGroupIds.has(displayGroupId);
          group.classList.toggle("collapsed", groupCollapsed);
          if (
            this.pages.some(
              (page) =>
                page.groupId === displayGroupId && page.id === this.activePageId
            )
          ) {
            group.classList.add("active");
          }

          const header = document.createElement("div");
          header.className = "page-group-header";
          header.draggable = true;
          header.title = "拖曳以移動整個群組";
          const title = document.createElement("div");
          title.className = "page-group-title";
          const dragHandle = document.createElement("span");
          dragHandle.className = "page-group-drag-handle";
          dragHandle.textContent = "⋮⋮";
          dragHandle.setAttribute("aria-hidden", "true");
          const selectWrap = document.createElement("label");
          selectWrap.className = "group-select";
          selectWrap.title = "選取或取消這個群組的所有頁面";
          const groupCheckbox = document.createElement("input");
          groupCheckbox.type = "checkbox";
          groupCheckbox.className = "group-select-checkbox";
          groupCheckbox.dataset.groupId = displayGroupId;
          const selectedGroupPageCount = groupedPageIds.filter((id) =>
            this.selectedPageIds.has(id)
          ).length;
          groupCheckbox.checked =
            selectedGroupPageCount === groupedPageIds.length;
          groupCheckbox.indeterminate =
            selectedGroupPageCount > 0 &&
            selectedGroupPageCount < groupedPageIds.length;
          groupCheckbox.setAttribute(
            "aria-label",
            `選取或取消群組「${this.getPageGroupLabel(displayGroupId)}」的所有頁面`
          );
          groupCheckbox.addEventListener("click", (event) =>
            event.stopPropagation()
          );
          groupCheckbox.addEventListener("change", () => {
            for (const pageId of groupedPageIds) {
              if (groupCheckbox.checked) this.selectedPageIds.add(pageId);
              else this.selectedPageIds.delete(pageId);
            }
            this.updateUI();
            this.refreshSidebarSelection();
          });
          selectWrap.append(groupCheckbox);
          const name = document.createElement("strong");
          name.textContent = this.getPageGroupLabel(displayGroupId);
          name.title = name.textContent;
          const count = document.createElement("span");
          count.textContent = `${groupCounts.get(displayGroupId)} 頁`;
          title.append(dragHandle, selectWrap, name, count);

          const actions = document.createElement("div");
          actions.className = "page-group-actions";
          const collapseButton = document.createElement("button");
          collapseButton.className = "mini-button group-collapse-button";
          collapseButton.type = "button";
          collapseButton.title = groupCollapsed ? "展開群組" : "收合群組";
          collapseButton.setAttribute("aria-label", collapseButton.title);
          collapseButton.setAttribute(
            "aria-expanded",
            groupCollapsed ? "false" : "true"
          );
          collapseButton.innerHTML = groupCollapsed
            ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m10 7-5 5 5 5"/><path d="m14 7 5 5-5 5"/></svg>'
            : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 7 5 5-5 5"/><path d="m19 7-5 5 5 5"/></svg>';
          collapseButton.addEventListener("click", (event) => {
            event.stopPropagation();
            this.togglePageGroupCollapsed(displayGroupId);
          });
          const renameButton = document.createElement("button");
          renameButton.className = "mini-button group-rename-button";
          renameButton.type = "button";
          renameButton.title = "修改群組名稱";
          renameButton.setAttribute("aria-label", renameButton.title);
          renameButton.innerHTML =
            '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16z"/><path d="m14.5 6.7 2.8 2.8"/></svg>';
          renameButton.addEventListener("click", (event) => {
            event.stopPropagation();
            this.openPageGroupNameDialog(displayGroupId);
          });
          actions.append(
            collapseButton,
            renameButton,
            this.createMoveButton(
              "up",
              !this.canMovePageGroup(displayGroupId, -1),
              () => this.movePageGroup(displayGroupId, -1),
              "整組向前移動"
            ),
            this.createMoveButton(
              "down",
              !this.canMovePageGroup(displayGroupId, 1),
              () => this.movePageGroup(displayGroupId, 1),
              "整組向後移動"
            )
          );
          const ungroupButton = document.createElement("button");
          ungroupButton.className = "group-ungroup-button";
          ungroupButton.type = "button";
          ungroupButton.textContent = "解除";
          ungroupButton.title = "解除這個群組";
          ungroupButton.addEventListener("click", (event) => {
            event.stopPropagation();
            this.ungroupPages(displayGroupId);
          });
          actions.append(ungroupButton);
          header.append(title, actions);

          const groupDragTarget = groupCollapsed ? group : header;
          groupDragTarget.draggable = true;
          groupDragTarget.title = "拖曳以移動整個群組";
          if (groupCollapsed) header.draggable = false;
          groupDragTarget.addEventListener("dragstart", (event) => {
            if (event.target.closest("button, input, label")) {
              event.preventDefault();
              return;
            }
            this.suppressPageClick = true;
            this.draggedGroupId = displayGroupId;
            this.draggedPageId = null;
            this.draggedPageIds = [...groupedPageIds];
            this.activePageId = groupedPageIds[0] || this.activePageId;
            this.selectedPageIds = new Set(groupedPageIds);
            group.classList.add("dragging");
            for (const draggedCard of list.querySelectorAll(".page-card")) {
              draggedCard.classList.toggle(
                "dragging",
                this.draggedPageIds.includes(draggedCard.dataset.pageId)
              );
            }
            this.updateUI();
            this.refreshSidebarSelection();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", groupedPageIds[0] || "");
            event.dataTransfer.setData(
              "application/x-pdf-workshop-pages",
              JSON.stringify(groupedPageIds)
            );
          });
          groupDragTarget.addEventListener("dragend", () => {
            this.draggedGroupId = null;
            this.draggedPageId = null;
            this.draggedPageIds = [];
            list
              .querySelectorAll(
                ".page-group.dragging, .page-group.drag-over-before, .page-group.drag-over-after, .page-card.dragging, .page-card.drag-over-before, .page-card.drag-over-after"
              )
              .forEach((item) =>
                item.classList.remove(
                  "dragging",
                  "drag-over-before",
                  "drag-over-after"
                )
              );
            setTimeout(() => {
              this.suppressPageClick = false;
            }, 350);
          });

          group.addEventListener("dragover", (event) => {
            if (
              event.target.closest(".page-card") ||
              !this.draggedPageIds.length ||
              groupedPageIds.every((id) => this.draggedPageIds.includes(id))
            ) {
              return;
            }
            event.preventDefault();
            const dropZone =
              event.target.closest(".page-group-header") || group;
            const rect = dropZone.getBoundingClientRect();
            const useHorizontalAxis =
              this.viewMode === "browse" && group.classList.contains("collapsed");
            this.dragDropPosition = useHorizontalAxis
              ? event.clientX < rect.left + rect.width / 2
                ? "before"
                : "after"
              : event.clientY < rect.top + rect.height / 2
                ? "before"
                : "after";
            group.classList.toggle(
              "drag-over-before",
              this.dragDropPosition === "before"
            );
            group.classList.toggle(
              "drag-over-after",
              this.dragDropPosition === "after"
            );
            event.dataTransfer.dropEffect = "move";
          });
          group.addEventListener("dragleave", (event) => {
            if (group.contains(event.relatedTarget)) return;
            group.classList.remove("drag-over-before", "drag-over-after");
          });
          group.addEventListener("drop", (event) => {
            if (event.target.closest(".page-card")) return;
            event.preventDefault();
            event.stopPropagation();
            group.classList.remove("drag-over-before", "drag-over-after");
            let draggedIds = this.draggedPageIds;
            if (!draggedIds.length) {
              try {
                draggedIds = JSON.parse(
                  event.dataTransfer.getData(
                    "application/x-pdf-workshop-pages"
                  )
                );
              } catch {
                draggedIds = [event.dataTransfer.getData("text/plain")].filter(
                  Boolean
                );
              }
            }
            if (
              !draggedIds.length ||
              groupedPageIds.every((id) => draggedIds.includes(id))
            ) {
              return;
            }
            const targetId =
              this.dragDropPosition === "after"
                ? groupedPageIds.at(-1)
                : groupedPageIds[0];
            this.reorderPages(draggedIds, targetId, this.dragDropPosition);
          });

          currentGroupPages = document.createElement("div");
          currentGroupPages.className = "page-group-pages";
          group.append(header, currentGroupPages);
          list.append(group);
        }
      }
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
        this.refreshSidebarSelection();
      });
      checkboxWrap.append(checkbox);

      const previewColumn = document.createElement("div");
      previewColumn.className = "page-card-preview";
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
        if (this.suppressPageClick) {
          event.preventDefault();
          return;
        }
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

      card.addEventListener("dblclick", () => {
        if (this.viewMode !== "browse") return;
        this.selectedPageIds = new Set([pageRecord.id]);
        this.selectPage(pageRecord.id);
        this.setViewMode(this.lastPageViewMode || "single");
      });

      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.selectedPageIds = new Set([pageRecord.id]);
          this.selectPage(pageRecord.id);
          if (this.viewMode === "browse" && event.key === "Enter") {
            this.setViewMode(this.lastPageViewMode || "single");
          }
        }
      });

      card.addEventListener("dragstart", (event) => {
        this.suppressPageClick = true;
        this.draggedGroupId = null;
        this.draggedPageId = pageRecord.id;
        const moveSelection =
          this.selectedPageIds.has(pageRecord.id) &&
          this.selectedPageIds.size > 1;
        this.draggedPageIds = moveSelection
          ? this.pages
              .filter((page) => this.selectedPageIds.has(page.id))
              .map((page) => page.id)
          : [pageRecord.id];
        if (!moveSelection) {
          this.selectedPageIds = new Set([pageRecord.id]);
          this.activePageId = pageRecord.id;
          this.refreshSidebarSelection();
        }
        for (const draggedCard of list.querySelectorAll(".page-card")) {
          draggedCard.classList.toggle(
            "dragging",
            this.draggedPageIds.includes(draggedCard.dataset.pageId)
          );
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", pageRecord.id);
        event.dataTransfer.setData(
          "application/x-pdf-workshop-pages",
          JSON.stringify(this.draggedPageIds)
        );
      });
      card.addEventListener("dragend", () => {
        this.draggedGroupId = null;
        this.draggedPageId = null;
        this.draggedPageIds = [];
        list
          .querySelectorAll(
            ".page-group.dragging, .page-group.drag-over-before, .page-group.drag-over-after, .page-card.dragging, .page-card.drag-over-before, .page-card.drag-over-after"
          )
          .forEach((item) =>
            item.classList.remove(
              "dragging",
              "drag-over-before",
              "drag-over-after"
            )
          );
        setTimeout(() => {
          this.suppressPageClick = false;
        }, 350);
      });
      card.addEventListener("dragover", (event) => {
        if (
          !this.draggedPageIds.length ||
          this.draggedPageIds.includes(pageRecord.id)
        ) {
          return;
        }
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        const useHorizontalAxis =
          this.viewMode === "browse" &&
          Math.abs(event.clientY - (rect.top + rect.height / 2)) <
            rect.height * 0.3;
        this.dragDropPosition = useHorizontalAxis
          ? event.clientX < rect.left + rect.width / 2
            ? "before"
            : "after"
          : event.clientY < rect.top + rect.height / 2
            ? "before"
            : "after";
        card.classList.toggle(
          "drag-over-before",
          this.dragDropPosition === "before"
        );
        card.classList.toggle(
          "drag-over-after",
          this.dragDropPosition === "after"
        );
        event.dataTransfer.dropEffect = "move";
      });
      card.addEventListener("dragleave", () =>
        card.classList.remove("drag-over-before", "drag-over-after")
      );
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        card.classList.remove("drag-over-before", "drag-over-after");
        let draggedIds = this.draggedPageIds;
        if (!draggedIds.length) {
          try {
            draggedIds = JSON.parse(
              event.dataTransfer.getData("application/x-pdf-workshop-pages")
            );
          } catch {
            draggedIds = [event.dataTransfer.getData("text/plain")].filter(
              Boolean
            );
          }
        }
        if (draggedIds.length && !draggedIds.includes(pageRecord.id)) {
          this.reorderPages(
            draggedIds,
            pageRecord.id,
            this.dragDropPosition
          );
        }
      });

      (currentGroupPages || list).append(card);
    });

    if (this.viewMode === "browse") {
      this.scheduleBrowseGroupLayout();
    } else {
      this.layoutCollapsedSidebarGroups();
    }
    this.queueThumbnails(thumbnailJobs, generation);
  }

  layoutCollapsedSidebarGroups() {
    const list = this.elements.pageList;
    for (const group of list.querySelectorAll(":scope > .page-group.collapsed")) {
      const header = group.querySelector(".page-group-header");
      const cards = [...group.querySelectorAll(".page-card")];
      if (!header || !cards.length) continue;
      const collapsedRow = document.createElement("div");
      collapsedRow.className = "page-group-row page-group-collapsed-row";
      collapsedRow.append(
        header,
        this.createCollapsedGroupPreview(group.dataset.groupId, cards)
      );
      group.replaceChildren(collapsedRow);
    }
  }

  createCollapsedGroupPreview(groupId, cards) {
    const groupName = this.getPageGroupLabel(groupId);
    const groupedPageIds = cards
      .map((card) => card.dataset.pageId)
      .filter(Boolean);
    const collapsedPreview = document.createElement("div");
    collapsedPreview.className = "page-group-collapsed-preview";
    collapsedPreview.tabIndex = 0;
    collapsedPreview.setAttribute("role", "button");
    collapsedPreview.setAttribute(
      "aria-label",
      `單選群組「${groupName}」，共 ${groupedPageIds.length} 頁`
    );
    collapsedPreview.title = `單選群組「${groupName}」`;
    const selectCollapsedGroup = (event) => {
      if (this.suppressPageClick) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      if (!groupedPageIds.length) return;
      this.selectedPageIds = new Set(groupedPageIds);
      this.selectPage(groupedPageIds[0]);
    };
    collapsedPreview.addEventListener("click", selectCollapsedGroup);
    collapsedPreview.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectCollapsedGroup(event);
    });

    const collapsedMeta = document.createElement("div");
    collapsedMeta.className = "page-group-collapsed-meta";
    const collapsedName = document.createElement("strong");
    collapsedName.textContent = groupName;
    collapsedName.title = groupName;
    const collapsedCount = document.createElement("span");
    collapsedCount.textContent = `${cards.length} 頁`;
    collapsedMeta.append(collapsedName, collapsedCount);

    const deck = document.createElement("div");
    deck.className = "page-group-collapsed-deck";
    const previewCount = Math.min(
      5,
      Math.max(3, Math.ceil(cards.length / 16) + 2)
    );
    deck.style.setProperty("--deck-count", String(previewCount));
    const sampleIndexes = new Set();
    for (let previewIndex = 0; previewIndex < previewCount; previewIndex += 1) {
      const sampleIndex =
        previewCount === 1
          ? 0
          : Math.round(
              (previewIndex * (cards.length - 1)) / (previewCount - 1)
            );
      sampleIndexes.add(sampleIndex);
    }
    const uniqueSampleIndexes = [...sampleIndexes];
    for (let previewIndex = 0; previewIndex < previewCount; previewIndex += 1) {
      const sampleIndex = uniqueSampleIndexes[previewIndex];
      const thumbnail = cards[sampleIndex]?.querySelector(".thumbnail-wrap");
      const deckCard = document.createElement("div");
      deckCard.className = "page-group-collapsed-thumb";
      deckCard.style.setProperty(
        "--stack-left",
        `${previewCount > 1 ? (previewIndex * 42) / (previewCount - 1) : 0}%`
      );
      deckCard.style.zIndex = String(previewIndex + 1);
      if (thumbnail) {
        deckCard.append(thumbnail);
        const canvas = thumbnail.querySelector("canvas");
        this.syncCollapsedThumbnailAspect(canvas);
      } else {
        deckCard.classList.add("placeholder");
        deckCard.innerHTML =
          '<span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>';
      }
      deck.append(deckCard);
    }
    collapsedPreview.append(collapsedMeta, deck);
    return collapsedPreview;
  }

  syncCollapsedThumbnailAspect(canvas) {
    if (!canvas?.width || !canvas?.height) return;
    const collapsedThumb = canvas.closest(".page-group-collapsed-thumb");
    if (!collapsedThumb) return;
    collapsedThumb.style.setProperty(
      "--page-aspect-ratio",
      `${canvas.width} / ${canvas.height}`
    );
  }

  scheduleBrowseGroupLayout() {
    if (this.viewMode !== "browse" || !this.elements.pageList) return;
    cancelAnimationFrame(this.browseGroupLayoutFrame);
    this.browseGroupLayoutFrame = requestAnimationFrame(() => {
      this.browseGroupLayoutFrame = requestAnimationFrame(() => {
        this.browseGroupLayoutFrame = null;
        this.layoutBrowseGroupRows();
      });
    });
  }

  layoutBrowseGroupRows() {
    if (this.viewMode !== "browse") return;
    const list = this.elements.pageList;
    const listStyle = getComputedStyle(list);
    const contentWidth =
      list.clientWidth -
      (parseFloat(listStyle.paddingLeft) || 0) -
      (parseFloat(listStyle.paddingRight) || 0);
    const cardWidth =
      parseFloat(listStyle.getPropertyValue("--browse-card-width")) ||
      BROWSE_CARD_BASE_WIDTH;
    const railWidth = 54;
    const innerPadding = 20;
    const gap = 14;
    const columns = Math.max(
      1,
      Math.floor(
        (Math.max(cardWidth, contentWidth - railWidth - innerPadding) + gap) /
          (cardWidth + gap)
      )
    );

    for (const group of list.querySelectorAll(":scope > .page-group")) {
      const header = group.querySelector(".page-group-header");
      const cards = [...group.querySelectorAll(".page-card")];
      if (!header || !cards.length) continue;
      const groupName = this.getPageGroupLabel(group.dataset.groupId);
      if (group.classList.contains("collapsed")) {
        const collapsedRow = document.createElement("div");
        collapsedRow.className = "page-group-row page-group-collapsed-row";
        collapsedRow.append(
          header,
          this.createCollapsedGroupPreview(group.dataset.groupId, cards)
        );
        group.replaceChildren(collapsedRow);
        continue;
      }
      const rowCount = Math.ceil(cards.length / columns);
      const fragment = document.createDocumentFragment();
      group.style.setProperty("--group-columns", String(columns));

      for (let start = 0, rowIndex = 0; start < cards.length; start += columns) {
        const row = document.createElement("div");
        row.className = "page-group-row";
        row.dataset.groupRow = String(rowIndex + 1);

        if (rowIndex === 0) {
          row.append(header);
        } else {
          const continuation = document.createElement("div");
          continuation.className = "page-group-row-label";
          continuation.title = `${groupName}（第 ${rowIndex + 1} 列，共 ${rowCount} 列）`;
          const continuationName = document.createElement("strong");
          continuationName.textContent = groupName;
          const continuationCount = document.createElement("span");
          continuationCount.textContent = `${rowIndex + 1}/${rowCount}`;
          continuation.append(continuationName, continuationCount);
          row.append(continuation);
        }

        const rowPages = document.createElement("div");
        rowPages.className = "page-group-pages page-group-row-pages";
        rowPages.append(...cards.slice(start, start + columns));
        row.append(rowPages);
        fragment.append(row);
        rowIndex += 1;
      }
      group.replaceChildren(fragment);
    }
  }

  createMoveButton(direction, disabled, handler, title = "") {
    const button = document.createElement("button");
    button.className = "mini-button";
    button.type = "button";
    button.disabled = disabled;
    button.title =
      title || (direction === "up" ? "向前移一頁" : "向後移一頁");
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
      if (generation !== this.thumbnailGeneration) return;
      if (!job.canvas.isConnected) continue;
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
    const rotation = this.getPageRotation(pageRecord);
    const targetWidth =
      this.viewMode === "browse"
        ? this.getBrowseThumbWidth()
        : THUMBNAIL_WIDTH_SIDEBAR;

    const cached = this.thumbnailCache.get(pageRecord.id);
    if (cached && cached.rotation === rotation && cached.width === targetWidth) {
      canvas.width = cached.canvas.width;
      canvas.height = cached.canvas.height;
      canvas.style.width = cached.styleWidth;
      canvas.style.height = cached.styleHeight;
      canvas.getContext("2d", { alpha: false }).drawImage(cached.canvas, 0, 0);
      this.syncCollapsedThumbnailAspect(canvas);
      return;
    }

    const page = await source.pdfjsDoc.getPage(pageRecord.sourcePageIndex + 1);
    const baseViewport = page.getViewport({ scale: 1, rotation });
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale, rotation });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const context = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    this.syncCollapsedThumbnailAspect(canvas);
    if (this.viewMode === "browse") {
      // 網格卡片可能比縮圖解析度級距窄；只讓 CSS 縮小寬度、卻保留
      // 固定像素高度會把橫式與直式頁都拉成細長形。讓瀏覽縮圖填滿
      // 可用寬度，並由 canvas 的 intrinsic ratio 自動計算高度。
      canvas.style.width = "100%";
      canvas.style.height = "auto";
    } else {
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
    }

    await page.render({
      canvasContext: context,
      viewport,
      transform:
        outputScale === 1
          ? null
          : [outputScale, 0, 0, outputScale, 0, 0],
    }).promise;

    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext("2d", { alpha: false }).drawImage(canvas, 0, 0);
    this.thumbnailCache.set(pageRecord.id, {
      rotation,
      width: targetWidth,
      canvas: copy,
      styleWidth: canvas.style.width,
      styleHeight: canvas.style.height,
    });
    while (this.thumbnailCache.size > 200) {
      this.thumbnailCache.delete(this.thumbnailCache.keys().next().value);
    }
  }

  refreshSidebarSelection() {
    const cards = this.elements.pageList.querySelectorAll(".page-card");
    for (const card of cards) {
      const pageId = card.dataset.pageId;
      card.classList.toggle("active", pageId === this.activePageId);
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = this.selectedPageIds.has(pageId);
    }
    for (const group of this.elements.pageList.querySelectorAll(
      ".page-group[data-group-id]"
    )) {
      const groupId = group.dataset.groupId;
      const groupPageIds = this.pages
        .filter((page) => page.groupId === groupId)
        .map((page) => page.id);
      const selectedCount = groupPageIds.filter((id) =>
        this.selectedPageIds.has(id)
      ).length;
      const checkbox = group.querySelector(".group-select-checkbox");
      if (checkbox) {
        checkbox.checked =
          groupPageIds.length > 0 && selectedCount === groupPageIds.length;
        checkbox.indeterminate =
          selectedCount > 0 && selectedCount < groupPageIds.length;
      }
      group.classList.toggle(
        "active",
        groupPageIds.includes(this.activePageId)
      );
      group.classList.toggle(
        "selected",
        groupPageIds.length > 0 && selectedCount === groupPageIds.length
      );
    }
  }

  async renderActivePage() {
    if (this.viewMode === "browse") return;
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
      const fitScale = this.getFitScale(baseViewport.width);
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
      this.syncStageToSlot();
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
        item.src = this.getAnnotationImageData(annotation);
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

    const selectedAnnotation = pageRecord.annotations.find(
      (annotation) => annotation.id === this.selectedAnnotationId
    );
    if (selectedAnnotation) {
      this.renderAnnotationResizeControls(layer, selectedAnnotation);
    }

    if (this.drawingDraft) {
      const draftShape = this.createSvgAnnotation(this.drawingDraft, true);
      if (draftShape) vectorLayer.append(draftShape);
    }
  }

  renderAnnotationResizeControls(layer, annotation) {
    const target = [...layer.querySelectorAll("[data-annotation-id]")].find(
      (element) =>
        element.dataset.annotationId === annotation.id &&
        !element.classList.contains("annotation-resize-handle")
    );
    if (!target) return;
    const layerRect = layer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (!targetRect.width && !targetRect.height) return;

    const minControlSize = 18;
    const width = Math.max(minControlSize, targetRect.width);
    const height = Math.max(minControlSize, targetRect.height);
    const left =
      targetRect.left - layerRect.left - (width - targetRect.width) / 2;
    const top =
      targetRect.top - layerRect.top - (height - targetRect.height) / 2;
    const box = document.createElement("div");
    box.className = "annotation-selection-box";
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "標註大小調整");

    const labels = {
      nw: "從左上角調整大小",
      ne: "從右上角調整大小",
      se: "從右下角調整大小",
      sw: "從左下角調整大小",
    };
    for (const handle of ["nw", "ne", "se", "sw"]) {
      const control = document.createElement("button");
      control.className = `annotation-resize-handle handle-${handle}`;
      control.type = "button";
      control.dataset.annotationId = annotation.id;
      control.dataset.resizeHandle = handle;
      control.setAttribute("aria-label", labels[handle]);
      control.title = labels[handle];
      box.append(control);
    }
    layer.append(box);
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
    if (this.viewMode === "browse") {
      this.setViewMode(this.lastPageViewMode || "single");
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
    this.activePageId = match.pageId;
    this.selectedPageIds = new Set([match.pageId]);
    this.selectedAnnotationId = null;
    if (this.viewMode === "browse") {
      this.setViewMode(this.lastPageViewMode || "single");
    }
    this.updateUI();
    this.refreshSidebarSelection();
    await this.renderActivePage();
    if (this.viewMode === "continuous") {
      this.scrollToActiveSlot({ behavior: "smooth" });
    } else {
      this.elements.viewerScroll.scrollTo({
        top: 0,
        left: 0,
        behavior: "smooth",
      });
    }
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
    clearTimeout(this.ocrIdleTimer);
    this.ocrIdleTimer = null;
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
      this.scheduleOcrWorkerShutdown();
    }
  }

  scheduleOcrWorkerShutdown() {
    clearTimeout(this.ocrIdleTimer);
    this.ocrIdleTimer = null;
    if (!this.ocrWorker) return;
    // Release the Tesseract WASM memory (~100MB) after a few idle minutes;
    // the worker is recreated transparently on the next OCR run.
    this.ocrIdleTimer = setTimeout(async () => {
      this.ocrIdleTimer = null;
      if (this.ocrRunning || !this.ocrWorker) return;
      const worker = this.ocrWorker;
      this.ocrWorker = null;
      await worker.terminate().catch(() => {});
    }, 3 * 60 * 1000);
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
    this.toast("文字已加入，可拖曳移動並使用控制點調整大小。", "success");
  }

  handleAnnotationPointerDown(event) {
    if (!this.currentViewport) return;
    const resizeHandle = event.target.closest("[data-resize-handle]");
    if (resizeHandle) {
      event.preventDefault();
      event.stopPropagation();
      const page = this.pages.find((item) => item.id === this.activePageId);
      const annotation = page?.annotations.find(
        (item) => item.id === resizeHandle.dataset.annotationId
      );
      const selectionBox = resizeHandle.closest(".annotation-selection-box");
      if (!annotation || !selectionBox) return;
      const layerRect = this.elements.annotationLayer.getBoundingClientRect();
      const boxRect = selectionBox.getBoundingClientRect();
      this.selectedAnnotationId = annotation.id;
      this.annotationResize = {
        annotationId: annotation.id,
        pageId: this.activePageId,
        handle: resizeHandle.dataset.resizeHandle,
        original: clonePages([annotation])[0],
        bounds: {
          left: boxRect.left - layerRect.left,
          top: boxRect.top - layerRect.top,
          width: boxRect.width,
          height: boxRect.height,
        },
        layerRect,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      };
      this.elements.annotationLayer.setPointerCapture?.(event.pointerId);
      return;
    }
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

    const resize = this.annotationResize;
    if (resize) {
      const deltaX = event.clientX - resize.startClientX;
      const deltaY = event.clientY - resize.startClientY;
      if (!resize.moved && Math.hypot(deltaX, deltaY) < 3) return;
      if (!resize.moved) {
        this.pushHistory();
        resize.moved = true;
      }
      const layer = this.elements.annotationLayer;
      const pointer = {
        x: Math.min(
          layer.clientWidth,
          Math.max(0, event.clientX - resize.layerRect.left)
        ),
        y: Math.min(
          layer.clientHeight,
          Math.max(0, event.clientY - resize.layerRect.top)
        ),
      };
      const targetBounds = resizeRectFromHandle({
        bounds: resize.bounds,
        handle: resize.handle,
        pointer,
        minWidth: 20,
        minHeight: 18,
        lockAspect: ["text", "image"].includes(resize.original.type),
      });
      this.resizeAnnotationToBounds(resize, targetBounds);
      this.renderAnnotations();
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
    const resize = this.annotationResize;
    if (resize) {
      if (resize.moved) {
        this.redoStack = [];
        this.dirty = true;
        this.updateUI();
        this.scheduleAutosave();
      }
      this.annotationResize = null;
      this.renderAnnotations();
      return;
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
    $$(
      ".annotation-item[data-annotation-id], .vector-annotation[data-annotation-id]",
    ).forEach((item) => {
      item.classList.toggle(
        "selected",
        item.dataset.annotationId === this.selectedAnnotationId
      );
    });
  }

  resizeAnnotationToBounds(resize, targetBounds) {
    if (!this.currentViewport) return;
    const page = this.pages.find((item) => item.id === resize.pageId);
    const annotation = page?.annotations.find(
      (item) => item.id === resize.annotationId
    );
    if (!annotation) return;
    const original = resize.original;

    if (original.type === "image") {
      annotation.width = targetBounds.width / this.currentViewport.scale;
      annotation.height = targetBounds.height / this.currentViewport.scale;
      [annotation.x, annotation.y] = this.currentViewport.convertToPdfPoint(
        targetBounds.left,
        targetBounds.top + targetBounds.height
      );
      return;
    }

    if (original.type === "text") {
      const scale = targetBounds.width / Math.max(1, resize.bounds.width);
      annotation.fontSize = Math.min(
        240,
        Math.max(4, original.fontSize * scale)
      );
      const metrics = this.getAnnotationMetrics(annotation);
      [annotation.x, annotation.y] = this.currentViewport.convertToPdfPoint(
        targetBounds.left,
        targetBounds.top + metrics.height * this.currentViewport.scale
      );
      return;
    }

    if (Array.isArray(original.points)) {
      annotation.points = original.points.map(([x, y]) => {
        const [screenX, screenY] =
          this.currentViewport.convertToViewportPoint(x, y);
        const transformed = transformPointBetweenRects(
          { x: screenX, y: screenY },
          resize.bounds,
          targetBounds
        );
        return this.currentViewport.convertToPdfPoint(
          transformed.x,
          transformed.y
        );
      });
    }
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
      this.refreshSidebarSelection();
      return;
    }
    this.activePageId = pageId;
    this.selectedAnnotationId = null;
    this.updateUI();
    this.refreshSidebarSelection();
    this.renderActivePage();
    if (this.viewMode === "continuous") {
      this.scrollToActiveSlot({ behavior: "smooth" });
    } else {
      this.elements.viewerScroll.scrollTo({
        top: 0,
        left: 0,
        behavior: "smooth",
      });
    }
    if (matchMedia("(max-width: 720px)").matches) {
      document.body.classList.remove("sidebar-visible");
    }
  }

  reorderPage(draggedId, targetId) {
    this.reorderPages([draggedId], targetId, "before");
  }

  reorderPages(draggedIds, targetId, position = "before") {
    const movedSet = new Set(
      draggedIds.filter((id) => this.pages.some((page) => page.id === id))
    );
    if (!movedSet.size || movedSet.has(targetId)) return;
    const targetPage = this.pages.find((page) => page.id === targetId);
    if (!targetPage) return;

    const originalGroupCounts = this.getPageGroupCounts();
    const movedGroupCounts = new Map();
    for (const page of this.pages) {
      if (!movedSet.has(page.id) || !page.groupId) continue;
      movedGroupCounts.set(
        page.groupId,
        (movedGroupCounts.get(page.groupId) || 0) + 1
      );
    }
    const movedGroupIds = [...movedGroupCounts.keys()];
    const preserveWithinGroupId =
      movedGroupIds.length === 1 && targetPage.groupId === movedGroupIds[0]
        ? movedGroupIds[0]
        : null;
    const partialGroupIds = new Set(
      [...movedGroupCounts]
        .filter(
          ([groupId, count]) =>
            groupId !== preserveWithinGroupId &&
            count < (originalGroupCounts.get(groupId) || 0)
        )
        .map(([groupId]) => groupId)
    );
    const targetGroupId =
      !preserveWithinGroupId &&
      targetPage.groupId &&
      (originalGroupCounts.get(targetPage.groupId) || 0) > 1
        ? targetPage.groupId
        : null;

    this.mutate(() => {
      const moved = this.pages.filter((page) => movedSet.has(page.id));
      const remaining = this.pages.filter((page) => !movedSet.has(page.id));

      for (const page of moved) {
        if (!partialGroupIds.has(page.groupId)) continue;
        page.groupId = null;
        delete page.groupName;
      }
      for (const groupId of partialGroupIds) {
        const leftovers = remaining.filter((page) => page.groupId === groupId);
        if (leftovers.length > 1) continue;
        for (const page of leftovers) {
          page.groupId = null;
          delete page.groupName;
        }
      }

      let insertionIndex;
      const remainingTargetGroup = targetGroupId
        ? remaining.filter((page) => page.groupId === targetGroupId)
        : [];
      if (remainingTargetGroup.length > 1) {
        const groupIndices = remainingTargetGroup.map((page) =>
          remaining.findIndex((item) => item.id === page.id)
        );
        insertionIndex =
          position === "after"
            ? Math.max(...groupIndices) + 1
            : Math.min(...groupIndices);
      } else {
        const targetIndex = remaining.findIndex((page) => page.id === targetId);
        insertionIndex = targetIndex + (position === "after" ? 1 : 0);
      }
      this.pages = [
        ...remaining.slice(0, insertionIndex),
        ...moved,
        ...remaining.slice(insertionIndex),
      ];
      this.activePageId = moved[0]?.id || this.activePageId;
      this.selectedPageIds = new Set(moved.map((page) => page.id));
    });
    this.toast(
      movedSet.size > 1
        ? `已一起移動 ${movedSet.size} 頁。`
        : "頁面順序已更新。",
      "success"
    );
  }

  movePage(pageId, delta) {
    const index = this.pages.findIndex((page) => page.id === pageId);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= this.pages.length) return;
    this.reorderPages(
      [pageId],
      this.pages[targetIndex].id,
      delta < 0 ? "before" : "after"
    );
  }

  groupSelectedPages() {
    const selected = this.pages.filter((page) =>
      this.selectedPageIds.has(page.id)
    );
    if (selected.length < 2) {
      this.toast("請先選取至少兩頁。", "error");
      return;
    }
    const selectedSet = new Set(selected.map((page) => page.id));
    const firstIndex = this.pages.findIndex((page) => selectedSet.has(page.id));
    const remainingPages = this.pages.filter(
      (page) => !selectedSet.has(page.id)
    );
    let insertionIndex = this.pages
      .slice(0, firstIndex)
      .filter((page) => !selectedSet.has(page.id)).length;
    const firstOriginalGroupId = selected[0].groupId;
    if (firstOriginalGroupId) {
      const originalGroupStart = remainingPages.findIndex(
        (page) => page.groupId === firstOriginalGroupId
      );
      if (originalGroupStart >= 0) insertionIndex = originalGroupStart;
    }
    const groupId = makeId("group");
    const affectedGroupIds = new Set(
      selected.map((page) => page.groupId).filter(Boolean)
    );

    this.mutate(() => {
      const remaining = this.pages.filter((page) => !selectedSet.has(page.id));
      for (const page of selected) {
        page.groupId = groupId;
        page.groupName = "自訂頁面群組";
      }
      for (const oldGroupId of affectedGroupIds) {
        const leftovers = remaining.filter(
          (page) => page.groupId === oldGroupId
        );
        if (leftovers.length > 1) continue;
        for (const page of leftovers) {
          page.groupId = null;
          delete page.groupName;
        }
      }
      this.pages = [
        ...remaining.slice(0, insertionIndex),
        ...selected,
        ...remaining.slice(insertionIndex),
      ];
      this.activePageId = selected[0].id;
      this.selectedPageIds = new Set(selected.map((page) => page.id));
    });
    this.toast(`已將 ${selected.length} 頁設為群組。`, "success");
  }

  togglePageGroupCollapsed(groupId) {
    if (!this.pages.some((page) => page.groupId === groupId)) return;
    if (this.collapsedPageGroupIds.has(groupId)) {
      this.collapsedPageGroupIds.delete(groupId);
    } else {
      this.collapsedPageGroupIds.add(groupId);
    }
    this.renderSidebar();
  }

  openPageGroupNameDialog(groupId) {
    const dialog = this.elements.groupNameDialog;
    const input = this.elements.groupNameInput;
    if (!dialog || !input) return;
    if (!this.pages.some((page) => page.groupId === groupId)) return;
    this.pendingGroupRenameId = groupId;
    input.value = this.getPageGroupLabel(groupId);
    this.elements.groupNameError.hidden = true;
    this.openDialog(dialog);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }

  applyPageGroupName() {
    const groupId = this.pendingGroupRenameId;
    const input = this.elements.groupNameInput;
    const error = this.elements.groupNameError;
    const name = input?.value.trim() || "";
    if (!groupId || !this.pages.some((page) => page.groupId === groupId)) {
      this.closeDialog(this.elements.groupNameDialog, "cancel");
      return;
    }
    if (!name) {
      error.textContent = "請輸入群組名稱。";
      error.hidden = false;
      input.focus();
      return;
    }
    if (name.length > 80) {
      error.textContent = "群組名稱最多 80 個字元。";
      error.hidden = false;
      input.focus();
      return;
    }
    const previousName = this.getPageGroupLabel(groupId);
    this.closeDialog(this.elements.groupNameDialog, "confirm");
    if (name === previousName) return;
    this.mutate(() => {
      for (const page of this.pages) {
        if (page.groupId === groupId) page.groupName = name;
      }
    });
    this.toast(`群組已重新命名為「${name}」。`, "success");
  }

  movePageGroup(groupId, delta) {
    const blocks = this.getPageBlocks();
    const index = blocks.findIndex(
      (block) => block.type === "group" && block.id === groupId
    );
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= blocks.length) return;
    const groupPages = blocks[index].pages;
    [blocks[index], blocks[targetIndex]] = [blocks[targetIndex], blocks[index]];
    this.mutate(() => {
      this.pages = blocks.flatMap((block) => block.pages);
      this.activePageId = groupPages[0]?.id || this.activePageId;
      this.selectedPageIds = new Set(groupPages.map((page) => page.id));
    });
    this.toast(`已整組${delta < 0 ? "向前" : "向後"}移動。`, "success");
  }

  ungroupPages(groupId) {
    const groupPages = this.pages.filter((page) => page.groupId === groupId);
    if (!groupPages.length) return;
    this.mutate(() => {
      for (const page of groupPages) {
        page.groupId = null;
        delete page.groupName;
      }
      this.activePageId = groupPages[0].id;
      this.selectedPageIds = new Set(groupPages.map((page) => page.id));
    });
    this.toast(`已解除 ${groupPages.length} 頁的群組。`, "success");
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
    this.collectGarbage();
    this.updateUI();
    if (sidebar) this.renderSidebar();
    if (this.viewMode === "continuous") this.rebuildContinuousLayout();
    this.renderActivePage();
    this.scheduleAutosave();
  }

  collectGarbage() {
    const referencedSourceIds = new Set();
    const referencedImageIds = new Set();
    const visit = (pages) => {
      for (const page of pages) {
        referencedSourceIds.add(page.sourceId);
        for (const annotation of page.annotations || []) {
          if (annotation.imageId) referencedImageIds.add(annotation.imageId);
        }
      }
    };
    visit(this.pages);
    this.undoStack.forEach(visit);
    this.redoStack.forEach(visit);

    for (const [id, source] of this.sources) {
      if (referencedSourceIds.has(id)) continue;
      source.loadingTask?.destroy?.().catch?.(() => {});
      this.sources.delete(id);
      this.persistedSourceIds.delete(id);
    }
    for (const id of [...this.annotationImages.keys()]) {
      if (!referencedImageIds.has(id)) this.annotationImages.delete(id);
    }
    const pageIds = new Set(this.pages.map((page) => page.id));
    for (const id of [...this.thumbnailCache.keys()]) {
      if (!pageIds.has(id)) this.thumbnailCache.delete(id);
    }
    for (const key of [...this.pageDimsCache.keys()]) {
      const sourceId = key.slice(0, key.lastIndexOf(":"));
      if (!referencedSourceIds.has(sourceId)) this.pageDimsCache.delete(key);
    }
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
    this.collectGarbage();
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
    this.collectGarbage();
    this.renderAll();
    this.scheduleAutosave();
  }

  changeZoom(delta) {
    if (this.viewMode === "browse") {
      this.browseZoom = Math.min(
        BROWSE_ZOOM_MAX,
        Math.max(BROWSE_ZOOM_MIN, this.browseZoom + delta)
      );
      this.applyBrowseZoom();
      return;
    }
    this.zoom = Math.min(2.5, Math.max(0.5, this.zoom + delta));
    this.applyZoomChange();
  }

  handleZoomSliderInput(ratio) {
    if (!Number.isFinite(ratio)) return;
    if (this.viewMode === "browse") {
      this.browseZoom = Math.min(
        BROWSE_ZOOM_MAX,
        Math.max(BROWSE_ZOOM_MIN, ratio)
      );
      // CSS 變數即時生效，跨解析度級距時 applyBrowseZoom 才重建縮圖
      this.applyBrowseZoom();
      return;
    }
    this.zoom = Math.min(2.5, Math.max(0.5, ratio));
    this.updateUI();
    // 拖曳期間僅更新數值顯示，停頓後才重新渲染頁面
    clearTimeout(this.zoomSliderTimer);
    this.zoomSliderTimer = setTimeout(() => this.applyZoomChange(), 120);
  }

  getBrowseThumbWidth() {
    if (this.browseZoom < 0.85) return 170;
    if (this.browseZoom <= 1.2) return 230;
    if (this.browseZoom <= 1.7) return 330;
    return 440;
  }

  applyBrowseZoom() {
    try {
      localStorage.setItem(BROWSE_ZOOM_KEY, String(this.browseZoom));
    } catch {
      /* localStorage 不可用時忽略 */
    }
    this.elements.pageList?.style.setProperty(
      "--browse-card-width",
      `${Math.round(BROWSE_CARD_BASE_WIDTH * this.browseZoom)}px`
    );
    const bucket = this.getBrowseThumbWidth();
    const bucketChanged = bucket !== this.browseThumbBucket;
    this.browseThumbBucket = bucket;
    this.updateUI();
    if (this.viewMode === "browse" && bucketChanged) {
      // 縮圖解析度跨級距時重建側欄，維持清晰度
      this.renderSidebar();
    } else if (this.viewMode === "browse") {
      this.scheduleBrowseGroupLayout();
    }
  }

  applyZoomChange() {
    this.updateUI();
    if (this.viewMode === "continuous") {
      this.rebuildContinuousLayout({ anchorActive: true });
    }
    this.renderActivePage();
  }

  /* ==================== 檢視模式（單頁／連續／瀏覽） ==================== */

  applyViewModeClasses() {
    document.body.classList.toggle("view-browse", this.viewMode === "browse");
    document.body.classList.toggle(
      "view-continuous",
      this.viewMode === "continuous"
    );
    this.elements.documentView?.classList.toggle(
      "continuous",
      this.viewMode === "continuous"
    );
    if (this.elements.previewFlow) {
      this.elements.previewFlow.hidden = this.viewMode !== "continuous";
    }
  }

  setViewMode(mode) {
    if (!["single", "continuous", "browse"].includes(mode)) return;
    if (mode === this.viewMode) return;
    const previous = this.viewMode;
    this.viewMode = mode;
    if (mode !== "browse") this.lastPageViewMode = mode;
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* localStorage 不可用時忽略 */
    }
    this.applyViewModeClasses();
    document.body.classList.remove("sidebar-visible");

    if (previous === "continuous") this.teardownContinuous();
    if (previous === "browse" || mode === "browse") {
      // 縮圖解析度隨模式不同，重建側欄
      this.renderSidebar();
    }

    if (mode === "continuous") {
      this.rebuildContinuousLayout({ anchorActive: true });
      this.renderActivePage();
    } else if (mode === "single") {
      this.renderActivePage();
      this.elements.viewerScroll.scrollTo({ top: 0, left: 0 });
    }
    this.updateUI();
  }

  teardownContinuous() {
    clearTimeout(this.skimSettleTimer);
    this.skimSettleTimer = null;
    this.continuousLayoutToken += 1;
    this.previewObserver?.disconnect();
    this.previewQueue.length = 0;
    this.previewSlots = [];
    this.elements.previewFlow?.replaceChildren();
    this.elements.documentView?.classList.remove("skimming");
    const stage = this.elements.pageStage;
    if (stage) {
      stage.style.top = "";
      stage.style.left = "";
    }
  }

  getFitScale(baseWidth) {
    const horizontalPadding = matchMedia("(max-width: 720px)").matches ? 40 : 88;
    const availableWidth = Math.max(
      260,
      this.elements.viewerScroll.clientWidth - horizontalPadding
    );
    return Math.min(1.5, Math.max(0.22, availableWidth / baseWidth));
  }

  async getPageBaseDims(pageRecord) {
    const key = `${pageRecord.sourceId}:${pageRecord.sourcePageIndex}`;
    const cached = this.pageDimsCache.get(key);
    if (cached) return cached;
    const source = this.sources.get(pageRecord.sourceId);
    if (!source) return null;
    const page = await source.pdfjsDoc.getPage(pageRecord.sourcePageIndex + 1);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const dims = { width: viewport.width, height: viewport.height };
    this.pageDimsCache.set(key, dims);
    return dims;
  }

  getRotatedDims(dims, rotation) {
    return rotation % 180 === 0
      ? { width: dims.width, height: dims.height }
      : { width: dims.height, height: dims.width };
  }

  async rebuildContinuousLayout({ anchorActive = false } = {}) {
    if (this.viewMode !== "continuous") return;
    const flow = this.elements.previewFlow;
    if (!flow) return;
    const token = ++this.continuousLayoutToken;

    this.previewObserver?.disconnect();
    this.previewQueue.length = 0;

    if (!this.pages.length) {
      flow.replaceChildren();
      this.previewSlots = [];
      return;
    }

    const dims = [];
    for (const pageRecord of this.pages) {
      const base = await this.getPageBaseDims(pageRecord);
      if (token !== this.continuousLayoutToken) return;
      dims.push(base);
    }

    if (!this.previewObserver) {
      this.previewObserver = new IntersectionObserver(
        (entries) => this.handlePreviewIntersection(entries),
        {
          root: this.elements.viewerScroll,
          rootMargin: "130% 0px",
          threshold: 0,
        }
      );
    }

    const fragment = document.createDocumentFragment();
    const slots = [];
    this.pages.forEach((pageRecord, index) => {
      const base = dims[index];
      if (!base) return;
      const rotation = this.getPageRotation(pageRecord);
      const rotated = this.getRotatedDims(base, rotation);
      const scale = this.getFitScale(rotated.width) * this.zoom;
      const slot = document.createElement("div");
      slot.className = "preview-slot";
      slot.dataset.pageId = pageRecord.id;
      slot.style.width = `${rotated.width * scale}px`;
      slot.style.height = `${rotated.height * scale}px`;
      slot.setAttribute("aria-label", `第 ${index + 1} 頁預覽`);
      const canvas = document.createElement("canvas");
      slot.append(canvas);
      const chip = document.createElement("span");
      chip.className = "preview-slot-num";
      chip.textContent = `${index + 1}`;
      slot.append(chip);
      slot.addEventListener("click", () => {
        this.selectedPageIds = new Set([pageRecord.id]);
        this.selectPage(pageRecord.id);
      });
      slots.push({ el: slot, pageId: pageRecord.id });
      fragment.append(slot);
    });

    if (token !== this.continuousLayoutToken) return;
    flow.replaceChildren(fragment);
    this.previewSlots = slots;
    for (const slot of slots) this.previewObserver.observe(slot.el);
    this.syncStageToSlot();
    if (anchorActive) this.scrollToActiveSlot({ behavior: "auto" });
  }

  handlePreviewIntersection(entries) {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        this.queuePreviewRender(entry.target);
      } else {
        this.releasePreviewSlot(entry.target);
      }
    }
  }

  queuePreviewRender(slot) {
    const state = slot.dataset.previewState;
    if (state === "rendered" || state === "queued") return;
    slot.dataset.previewState = "queued";
    this.paintPreviewPlaceholder(slot);
    this.previewQueue.push(slot);
    this.processPreviewQueue();
  }

  releasePreviewSlot(slot) {
    const queueIndex = this.previewQueue.indexOf(slot);
    if (queueIndex >= 0) this.previewQueue.splice(queueIndex, 1);
    if (slot.dataset.previewState === "rendered") {
      const canvas = slot.querySelector("canvas");
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    slot.dataset.previewState = "";
    slot.classList.remove("loaded");
  }

  paintPreviewPlaceholder(slot) {
    const pageRecord = this.pages.find(
      (page) => page.id === slot.dataset.pageId
    );
    if (!pageRecord) return;
    const cached = this.thumbnailCache.get(pageRecord.id);
    if (!cached || cached.rotation !== this.getPageRotation(pageRecord)) return;
    const canvas = slot.querySelector("canvas");
    if (!canvas) return;
    canvas.width = cached.canvas.width;
    canvas.height = cached.canvas.height;
    canvas.getContext("2d", { alpha: false }).drawImage(cached.canvas, 0, 0);
    slot.classList.add("loaded");
  }

  processPreviewQueue() {
    while (
      this.previewActiveRenders < PREVIEW_RENDER_CONCURRENCY &&
      this.previewQueue.length
    ) {
      const slot = this.previewQueue.shift();
      this.previewActiveRenders += 1;
      this.renderPreviewSlot(slot)
        .catch((error) => {
          if (error?.name !== "RenderingCancelledException") {
            console.warn("[PDF Editor] Preview render failed", error);
          }
          slot.dataset.previewState = "";
        })
        .finally(() => {
          this.previewActiveRenders -= 1;
          this.processPreviewQueue();
        });
    }
  }

  async renderPreviewSlot(slot) {
    const abandon = () => {
      slot.dataset.previewState = "";
    };
    if (this.viewMode !== "continuous" || !slot.isConnected) {
      abandon();
      return;
    }
    const pageRecord = this.pages.find(
      (page) => page.id === slot.dataset.pageId
    );
    const source = pageRecord && this.sources.get(pageRecord.sourceId);
    const canvas = slot.querySelector("canvas");
    if (!source || !canvas) {
      abandon();
      return;
    }

    const rotation = this.getPageRotation(pageRecord);
    const cssWidth = parseFloat(slot.style.width) || slot.clientWidth;
    const page = await source.pdfjsDoc.getPage(pageRecord.sourcePageIndex + 1);
    if (this.viewMode !== "continuous" || !slot.isConnected) {
      abandon();
      return;
    }
    const baseViewport = page.getViewport({ scale: 1, rotation });
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);
    const renderWidth = Math.min(900, cssWidth * outputScale);
    const viewport = page.getViewport({
      scale: renderWidth / baseViewport.width,
      rotation,
    });
    const target = document.createElement("canvas");
    target.width = Math.ceil(viewport.width);
    target.height = Math.ceil(viewport.height);
    await page.render({
      canvasContext: target.getContext("2d", { alpha: false }),
      viewport,
    }).promise;
    if (this.viewMode !== "continuous" || !slot.isConnected) {
      abandon();
      return;
    }
    canvas.width = target.width;
    canvas.height = target.height;
    canvas.getContext("2d", { alpha: false }).drawImage(target, 0, 0);
    slot.dataset.previewState = "rendered";
    slot.classList.add("loaded");
  }

  getSlotForPage(pageId) {
    return this.previewSlots.find((slot) => slot.pageId === pageId)?.el || null;
  }

  syncStageToSlot() {
    if (this.viewMode !== "continuous") return;
    const slot = this.getSlotForPage(this.activePageId);
    const stage = this.elements.pageStage;
    if (!slot || !stage) return;
    stage.style.top = `${slot.offsetTop}px`;
    stage.style.left = `${slot.offsetLeft}px`;
  }

  scrollToActiveSlot({ behavior = "smooth" } = {}) {
    if (this.viewMode !== "continuous") return;
    const slot = this.getSlotForPage(this.activePageId);
    if (!slot) return;
    const top = Math.max(
      0,
      slot.offsetTop + this.elements.documentView.offsetTop - 34
    );
    this.elements.viewerScroll.scrollTo({ top, behavior });
  }

  handleViewerScroll() {
    if (this.viewMode !== "continuous" || !this.pages.length) return;
    const documentView = this.elements.documentView;
    if (!documentView.classList.contains("skimming")) {
      documentView.classList.add("skimming");
    }
    const centerSlot = this.getCenterPreviewSlot();
    if (centerSlot) {
      const index = this.pages.findIndex(
        (page) => page.id === centerSlot.pageId
      );
      if (index >= 0) {
        this.elements.activePageStatus.textContent =
          `第 ${index + 1} / ${this.pages.length} 頁`;
      }
    }
    clearTimeout(this.skimSettleTimer);
    this.skimSettleTimer = setTimeout(
      () => this.settleSkim(),
      SKIM_SETTLE_DELAY_MS
    );
  }

  getCenterPreviewSlot() {
    if (!this.previewSlots.length) return null;
    const viewerRect = this.elements.viewerScroll.getBoundingClientRect();
    const centerY = viewerRect.top + viewerRect.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const slot of this.previewSlots) {
      const rect = slot.el.getBoundingClientRect();
      if (rect.top <= centerY && rect.bottom >= centerY) return slot;
      const distance =
        rect.top > centerY ? rect.top - centerY : centerY - rect.bottom;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slot;
      }
      if (rect.top > centerY) break;
    }
    return best;
  }

  settleSkim() {
    if (this.viewMode !== "continuous") return;
    this.elements.documentView.classList.remove("skimming");
    const centerSlot = this.getCenterPreviewSlot();
    if (!centerSlot) return;
    if (centerSlot.pageId === this.activePageId) {
      this.updateUI();
      return;
    }
    this.activePageId = centerSlot.pageId;
    this.selectedPageIds = new Set([centerSlot.pageId]);
    this.selectedAnnotationId = null;
    this.updateUI();
    this.refreshSidebarSelection();
    this.renderActivePage();
  }

  activateDrawingTool(tool) {
    if (tool !== "select") {
      this.hideSelectedPageText({ clearSelection: true });
    }
    if (
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
      select: this.elements.selectToolButton,
      text: this.elements.textToolButton,
      pen: this.elements.penToolButton,
      highlight: this.elements.highlightToolButton,
      rect: this.elements.rectToolButton,
      arrow: this.elements.arrowToolButton,
    };
    Object.entries(buttonMap).forEach(([name, button]) => {
      const active = name === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
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
        this.elements.selectToolButton,
        this.elements.penToolButton,
        this.elements.highlightToolButton,
        this.elements.rectToolButton,
        this.elements.arrowToolButton,
      ].forEach((button) => button.classList.remove("active"));
      this.elements.selectToolButton.setAttribute("aria-pressed", "false");
      this.elements.textToolButton.setAttribute("aria-pressed", "true");
      this.elements.annotationText.focus();
    } else {
      this.activateDrawingTool("select");
    }
  }

  closeTextControls() {
    this.elements.textControls.hidden = true;
    this.elements.textToolButton.classList.remove("active");
    if (this.activeTool === "text") {
      this.activeTool = "select";
      this.elements.selectToolButton.classList.add("active");
      this.elements.selectToolButton.setAttribute("aria-pressed", "true");
      this.elements.textToolButton.setAttribute("aria-pressed", "false");
    }
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
    this.refreshSidebarSelection();
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
      insertionAnchorId: previousActiveId,
    });
    if (insertedIds.length) {
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
        insertionAnchorId: previousActiveId,
      });
      if (insertedIds.length) {
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
    // Store the heavy dataUrl once in a shared map; annotations (and the
    // undo/redo snapshots cloned from them) only carry a lightweight id.
    const imageId = makeId("image");
    this.annotationImages.set(imageId, dataUrl);
    const annotation = {
      id: makeId("annotation"),
      type: "image",
      imageId,
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
    this.toast("圖片已加入，可拖曳移動並使用控制點調整大小。", "success");
  }

  getAnnotationImageData(annotation) {
    return annotation.imageId
      ? this.annotationImages.get(annotation.imageId) || ""
      : annotation.dataUrl || "";
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
    this.renderSavedSignatures();
    this.openDialog(this.elements.signatureDialog);
  }

  // ── Saved Signatures (localStorage) ──────────────────────────────────

  /** Key used for localStorage persistence */
  get _sigStorageKey() {
    return "pdfeditor_saved_signatures";
  }

  /** Load the saved signatures array from localStorage */
  _loadStoredSignatures() {
    try {
      return JSON.parse(localStorage.getItem(this._sigStorageKey) || "[]");
    } catch {
      return [];
    }
  }

  /** Persist the saved signatures array to localStorage */
  _saveStoredSignatures(list) {
    try {
      localStorage.setItem(this._sigStorageKey, JSON.stringify(list));
    } catch {
      this.toast("無法儲存簽名：本機儲存空間不足或受限。", "error");
    }
  }

  /**
   * Crop the current canvas drawing (same logic as saveSignature) and
   * return { dataUrl, width, height } or null if nothing is drawn.
   */
  _cropCurrentSignature() {
    if (!this.signatureHasInk) return null;
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
    cropped.getContext("2d").drawImage(
      source,
      minX - padding, minY - padding,
      width, height,
      0, 0, width, height
    );
    return { dataUrl: cropped.toDataURL("image/png"), width, height };
  }

  /** Save the current signature to localStorage for future reuse */
  storeSignatureToLocalStorage() {
    if (!this.signatureHasInk) {
      this.toast("請先在簽名區手寫簽名。", "error");
      return;
    }
    const cropped = this._cropCurrentSignature();
    if (!cropped) return;
    const list = this._loadStoredSignatures();
    // Limit to 12 saved signatures
    if (list.length >= 12) {
      this.toast("最多可儲存 12 個簽名，請先刪除舊簽名。", "error");
      return;
    }
    list.push({
      id: `sig_${Date.now()}`,
      dataUrl: cropped.dataUrl,
      width: cropped.width,
      height: cropped.height,
      createdAt: new Date().toISOString(),
    });
    this._saveStoredSignatures(list);
    this.toast("簽名已儲存，下次可直接調用。");
    this.renderSavedSignatures();
  }

  /** Delete a saved signature by its id */
  deleteSavedSignature(id) {
    const list = this._loadStoredSignatures().filter((s) => s.id !== id);
    this._saveStoredSignatures(list);
    this.renderSavedSignatures();
  }

  /**
   * Apply a saved signature directly to the document
   * (same as saveSignature but uses stored data)
   */
  applySavedSignature(dataUrl, width, height) {
    this.closeDialog(this.elements.signatureDialog);
    this.addImageAnnotationData(dataUrl, width, height, {
      label: "手寫簽名",
      preferredWidth: 170,
    });
  }

  /** Render the saved signatures gallery in the dialog */
  renderSavedSignatures() {
    const list = this._loadStoredSignatures();
    const section = this.elements.savedSignaturesSection;
    const grid = this.elements.savedSignaturesGrid;
    const divider = this.elements.sigDivider;
    const hasAny = list.length > 0;

    if (hasAny) {
      section.classList.add("has-signatures");
      divider.classList.add("has-signatures");
    } else {
      section.classList.remove("has-signatures");
      divider.classList.remove("has-signatures");
    }

    grid.innerHTML = "";
    for (const sig of list) {
      const item = document.createElement("div");
      item.className = "saved-sig-item";
      item.title = `建立於 ${new Date(sig.createdAt).toLocaleString("zh-TW")}`;

      const img = document.createElement("img");
      img.src = sig.dataUrl;
      img.alt = "已儲存的簽名";
      item.appendChild(img);

      // Delete button (×)
      const del = document.createElement("button");
      del.className = "saved-sig-delete";
      del.type = "button";
      del.title = "刪除此簽名";
      del.textContent = "×";
      del.setAttribute("aria-label", "刪除此簽名");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteSavedSignature(sig.id);
      });
      item.appendChild(del);

      // Click thumbnail → apply to document
      item.addEventListener("click", () =>
        this.applySavedSignature(sig.dataUrl, sig.width, sig.height)
      );

      grid.appendChild(item);
    }
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
      this._applySignatureStyle(context);
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

  /** Apply the current color + line-width settings to the canvas context (or the live canvas if none given) */
  _applySignatureStyle(context) {
    const ctx = context ?? this.elements.signatureCanvas.getContext("2d");
    ctx.strokeStyle = this.signatureColor;
    ctx.lineWidth = this.signatureLineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  clearSignaturePad() {
    const canvas = this.elements.signatureCanvas;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    this._applySignatureStyle(context);
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
      this.persistedSourceIds.delete(source.id);
      for (const page of this.pages.filter(
        (item) => item.sourceId === source.id
      )) {
        page.baseRotation =
          replacement.pages[page.sourcePageIndex]?.baseRotation ||
          page.baseRotation;
        this.textIndex.delete(page.id);
        this.thumbnailCache.delete(page.id);
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

    if (
      mode === "download" &&
      typeof window.showSaveFilePicker === "function"
    ) {
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
        console.warn("[PDF Editor] File picker unavailable", error);
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
      const annotationText = records
        .flatMap((record) =>
          record.annotations
            .filter((annotation) => annotation.type === "text")
            .map((annotation) => String(annotation.text || ""))
        )
        .join("");
      const annotationFont = needsVectorFont
        ? await this.loadAnnotationFont(output, annotationText)
        : null;

      const copyEntries = [];
      const copyableRecordIds = new Set();
      for (const record of records) {
        const source = this.sources.get(record.sourceId);
        if (!source) throw new Error("找不到頁面來源");
        const rotation = this.getPageRotation(record);
        const annotationsCanStayVector =
          !record.annotations.length ||
          (rotation === 0 &&
            this.canEncodeAnnotations(record.annotations, annotationFont));
        if (!source.encrypted && source.pdfLibDoc && annotationsCanStayVector) {
          copyableRecordIds.add(record.id);
          copyEntries.push({
            key: record.id,
            sourceDocument: source.pdfLibDoc,
            sourcePageIndex: record.sourcePageIndex,
          });
        }
      }
      this.setBusy(true, "正在建立 PDF", "整理共用字型與頁面資源", 4);
      const copiedPages = await copyPagesBySource(output, copyEntries);

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
        if (!copyableRecordIds.has(record.id)) {
          await this.addRasterizedAnnotatedPage(output, record);
        } else {
          const copiedPage = copiedPages.get(record.id);
          if (!copiedPage) throw new Error("複製 PDF 頁面失敗");
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

      const deliveryResult = await this.deliverExportedPdf({
        blob,
        fileName,
        fileHandle,
        requestedMode: mode,
      });
      this.setBusy(false);
      if (!["file-picker", "file-share", "blob-download"].includes(deliveryResult)) {
        return;
      }

      this.dirty = false;
      this.updateUI();
      this.scheduleAutosave();
      this.toast(
        deliveryResult === "file-share"
          ? "PDF 已交由系統分享。"
          : `已輸出 ${records.length} 頁 PDF。`,
        "success"
      );
    } catch (error) {
      this.setBusy(false);
      if (error?.name === "AbortError") return;
      console.error("[PDF Editor] Export failed", error);
      this.toast(
        error?.code === "FILE_SHARE_UNSUPPORTED"
          ? error.message
          : "PDF 輸出失敗；請確認文件未損壞並再試一次。",
        "error",
        8000
      );
    }
  }

  getExportEnvironment() {
    return detectExportEnvironment({
      navigatorLike: navigator,
      standalone: this.isStandaloneApp(),
    });
  }

  canSharePdfFile(file) {
    if (
      typeof navigator.share !== "function" ||
      typeof navigator.canShare !== "function"
    ) {
      return false;
    }
    try {
      return navigator.canShare({ files: [file] });
    } catch {
      return false;
    }
  }

  supportsPdfFileShare() {
    if (typeof File !== "function") return false;
    const probe = new File(["%PDF-1.7\n"], "pdf-workshop-share-test.pdf", {
      type: "application/pdf",
    });
    return this.canSharePdfFile(probe);
  }

  async deliverExportedPdf({
    blob,
    fileName,
    fileHandle = null,
    requestedMode = "download",
  }) {
    const file = new File([blob], fileName, { type: "application/pdf" });
    const environment = this.getExportEnvironment();
    const delivery = chooseExportDelivery({
      requestedMode,
      hasFileHandle: Boolean(fileHandle),
      canShareFile: this.canSharePdfFile(file),
      environment,
    });

    if (delivery === "file-picker") {
      this.setBusy(true, "正在儲存 PDF", fileName, 96);
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return delivery;
    }

    if (delivery === "file-share") {
      this.setBusy(false);
      return this.sharePdfFile(file);
    }

    if (delivery === "share-unsupported") {
      const error = new Error("此瀏覽器不支援分享 PDF 檔案");
      error.code = "FILE_SHARE_UNSUPPORTED";
      throw error;
    }

    if (delivery === "ios-standalone-unsupported") {
      this.setBusy(false);
      this.showExportDeliveryGuidance({
        file,
        title: "請改用 Safari 儲存",
        message:
          "目前的 iPhone／iPad 主畫面 APP 無法分享檔案。為避免畫面被導向 PDF 後無法返回，這次不會啟動 blob 下載。",
        note:
          "請從 Safari 開啟 PDF 工坊後重新匯出，或將 iOS 更新至支援檔案分享的版本。",
      });
      return delivery;
    }

    if (delivery === "standalone-unsupported") {
      this.setBusy(false);
      this.showExportDeliveryGuidance({
        file,
        title: "請改用瀏覽器儲存",
        message:
          "目前安裝的 APP 無法使用系統檔案分享；直接下載 blob 檔案可能被系統下載管理員判定為損壞。",
        note: "請使用 Chrome 或裝置原生瀏覽器開啟 PDF 工坊後重新匯出。",
      });
      return delivery;
    }

    this.downloadBlob(blob, fileName);
    return delivery;
  }

  async sharePdfFile(file) {
    const shareData = buildPdfFileShareData(file);
    if (navigator.userActivation?.isActive === false) {
      return this.queuePreparedExportShare(file);
    }
    try {
      await navigator.share(shareData);
      return "file-share";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
      if (error?.name === "NotAllowedError") {
        return this.queuePreparedExportShare(file);
      }
      throw error;
    }
  }

  queuePreparedExportShare(file) {
    const dialog = this.elements.exportReadyDialog;
    if (!dialog) {
      const error = new Error("無法開啟系統分享確認視窗");
      error.code = "FILE_SHARE_UNSUPPORTED";
      return Promise.reject(error);
    }
    this.cancelPreparedExportShare();
    this.elements.exportReadyEyebrow.textContent = "安全儲存";
    this.elements.exportReadyTitle.textContent = "PDF 已建立";
    this.elements.exportReadyMessage.textContent =
      "請點選下方按鈕開啟系統分享，再選擇「儲存到檔案」或其他儲存位置。";
    this.elements.exportReadyFileName.textContent = file.name;
    this.elements.exportReadyFileMeta.textContent = `${this.formatBytes(file.size)} · PDF`;
    this.elements.exportReadyNote.textContent =
      "PDF 已在本機準備完成；再次點擊可提供分享功能需要的使用者操作權限。";
    this.elements.exportReadyCancelButton.textContent = "取消";
    this.elements.exportReadyShareButton.hidden = false;
    this.elements.exportReadyShareButton.disabled = false;
    this.elements.exportReadyShareButton.textContent = "開啟系統分享";

    return new Promise((resolve) => {
      this.pendingExportShare = { file, resolve };
      this.openDialog(dialog);
    });
  }

  async sharePreparedExport() {
    const pending = this.pendingExportShare;
    if (!pending) return;
    const button = this.elements.exportReadyShareButton;
    button.disabled = true;
    button.textContent = "正在開啟…";
    try {
      await navigator.share(buildPdfFileShareData(pending.file));
      this.pendingExportShare = null;
      pending.resolve("file-share");
      this.closeDialog(this.elements.exportReadyDialog, "shared");
    } catch (error) {
      if (error?.name === "AbortError") {
        this.pendingExportShare = null;
        pending.resolve("cancelled");
        this.closeDialog(this.elements.exportReadyDialog, "cancel");
        return;
      }
      console.error("[PDF Editor] Prepared file share failed", error);
      button.disabled = false;
      button.textContent = "再試一次";
      this.elements.exportReadyNote.textContent =
        "系統分享沒有開啟。請再點一次；若仍失敗，請改用瀏覽器開啟後匯出。";
    }
  }

  cancelPreparedExportShare() {
    const pending = this.pendingExportShare;
    if (!pending) return;
    this.pendingExportShare = null;
    pending.resolve("cancelled");
  }

  showExportDeliveryGuidance({ file, title, message, note }) {
    const dialog = this.elements.exportReadyDialog;
    if (!dialog) {
      this.toast(message, "error", 9000);
      return;
    }
    this.cancelPreparedExportShare();
    this.elements.exportReadyEyebrow.textContent = "此裝置需要其他方式";
    this.elements.exportReadyTitle.textContent = title;
    this.elements.exportReadyMessage.textContent = message;
    this.elements.exportReadyFileName.textContent = file.name;
    this.elements.exportReadyFileMeta.textContent = `${this.formatBytes(file.size)} · 尚未儲存`;
    this.elements.exportReadyNote.textContent = note;
    this.elements.exportReadyCancelButton.textContent = "我知道了";
    this.elements.exportReadyShareButton.hidden = true;
    this.openDialog(dialog);
  }

  async loadAnnotationFont(outputDocument, subsetText = "") {
    if (!window.fontkit) {
      throw new Error("中文字型元件載入失敗");
    }
    outputDocument.registerFontkit(window.fontkit);
    if (!this.annotationFontBytesPromise) {
      this.annotationFontBytesPromise = fetch(
        "./vendor/pdf-lib/NotoSansTC-Regular.ttf"
      )
        .then((response) => {
          if (!response.ok) throw new Error("中文字型檔案讀取失敗");
          return response.arrayBuffer();
        })
        .catch((error) => {
          // 失敗不快取，讓下一次匯出可重試。
          this.annotationFontBytesPromise = null;
          throw error;
        });
    }
    const fontBytes = await this.annotationFontBytesPromise;
    let embedBytes = fontBytes;
    if (subsetText && window.HBSubset) {
      // 以 HarfBuzz WASM 依實際使用的字元裁切子集，將內嵌字型從數 MB 降到
      // 數十 KB；失敗時退回完整內嵌。表單流程（updateFieldAppearances）需
      // 渲染任意欄位內容，呼叫端不傳 subsetText 即維持完整內嵌。
      try {
        const subsetBytes = await window.HBSubset.subsetFont(
          new Uint8Array(fontBytes),
          `${subsetText} □…`,
          { wasmUrl: "./vendor/hb-subset/hb-subset.wasm" }
        );
        window.fontkit.create(subsetBytes);
        embedBytes = subsetBytes;
      } catch (error) {
        console.warn("[PDF Editor] 註解字型子集化失敗，改用完整內嵌。", error);
      }
    }
    return outputDocument.embedFont(embedBytes, {
      subset: false,
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
        const dataUrl = this.getAnnotationImageData(annotation);
        const embedded = dataUrl.startsWith("data:image/png")
          ? await outputDocument.embedPng(dataUrl)
          : await outputDocument.embedJpg(dataUrl);
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
          const dataUrl = this.getAnnotationImageData(annotation);
          if (
            !dataUrl.startsWith("data:image/png") &&
            !dataUrl.startsWith("data:image/jpeg")
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
        const image = await this.loadHtmlImage(
          this.getAnnotationImageData(annotation)
        );
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
    const environment = this.getExportEnvironment();
    if (environment.ios && environment.standalone) {
      const file = new File([blob], fileName, { type: "application/pdf" });
      this.showExportDeliveryGuidance({
        file,
        title: "請改用 Safari 儲存",
        message:
          "主畫面 APP 無法安全啟動這個下載，因此已阻止頁面直接導向 PDF。",
        note: "請從 Safari 開啟 PDF 工坊後重新匯出。",
      });
      return false;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    const timer = setTimeout(
      () => this.releaseDownloadUrl(url),
      BLOB_URL_LIFETIME_MS
    );
    this.pendingDownloadUrls.set(url, timer);
    return true;
  }

  releaseDownloadUrl(url) {
    const timer = this.pendingDownloadUrls.get(url);
    if (timer) clearTimeout(timer);
    this.pendingDownloadUrls.delete(url);
    URL.revokeObjectURL(url);
  }

  releaseDownloadUrls() {
    for (const url of [...this.pendingDownloadUrls.keys()]) {
      this.releaseDownloadUrl(url);
    }
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

  recentFileStorageId(file) {
    return JSON.stringify([
      String(file?.name || ""),
      Number(file?.size) || 0,
      Number(file?.lastModified) || 0,
    ]);
  }

  readRecentFiles() {
    let current = [];
    try {
      current = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || "[]");
    } catch {}
    return Array.isArray(current) ? current : [];
  }

  writeRecentFiles(items) {
    try {
      localStorage.setItem(
        RECENT_FILES_KEY,
        JSON.stringify(items.slice(0, RECENT_FILE_LIMIT))
      );
    } catch {}
  }

  async persistRecentFiles(files, recentItems) {
    const storedIds = new Set();
    for (const file of files) {
      const storageId = this.recentFileStorageId(file);
      try {
        const bytes = await file.arrayBuffer();
        await this.dbOperation("recentFiles", "readwrite", (store) =>
          store.put({
            id: storageId,
            name: file.name,
            size: file.size,
            type: file.type || "",
            lastModified: Number(file.lastModified) || 0,
            bytes,
          })
        );
        storedIds.add(storageId);
      } catch (error) {
        console.warn("[PDF Editor] Recent file persistence failed", error);
      }
    }

    try {
      const retainedIds = new Set(
        recentItems.map((item) => item.storageId).filter(Boolean)
      );
      const existingIds =
        (await this.dbOperation("recentFiles", "readonly", (store) =>
          store.getAllKeys()
        )) || [];
      for (const id of existingIds) {
        if (retainedIds.has(id)) continue;
        await this.dbOperation("recentFiles", "readwrite", (store) =>
          store.delete(id)
        );
      }
    } catch (error) {
      console.warn("[PDF Editor] Recent file cleanup failed", error);
    }
    return storedIds;
  }

  async rememberRecentFiles(files) {
    const current = this.readRecentFiles();
    const now = Date.now();
    for (const file of files) {
      const index = current.findIndex((item) => item.name === file.name);
      if (index >= 0) current.splice(index, 1);
      current.unshift({
        storageId: this.recentFileStorageId(file),
        name: file.name,
        size: file.size,
        type: file.type || "",
        lastModified: Number(file.lastModified) || 0,
        openedAt: now,
      });
    }
    const retained = current.slice(0, RECENT_FILE_LIMIT);
    const storedIds = await this.persistRecentFiles(files, retained);
    for (const item of retained) {
      if (storedIds.has(item.storageId)) item.available = true;
    }
    this.writeRecentFiles(retained);
    this.renderRecentFiles();
  }

  async loadRecentFileRecord(item) {
    if (item.storageId) {
      const record = await this.dbOperation("recentFiles", "readonly", (store) =>
        store.get(item.storageId)
      );
      if (record?.bytes) return record;
    }

    // v2 and earlier only stored metadata. If the same PDF is still part of
    // the autosaved project, reuse that source as a one-time migration path.
    const legacySources =
      (await this.dbOperation("sources", "readonly", (store) =>
        store.getAll()
      )) || [];
    return legacySources.find(
      (source) =>
        source.name === item.name && Number(source.size) === Number(item.size)
    );
  }

  async openRecentFile(item) {
    try {
      const record = await this.loadRecentFileRecord(item);
      if (!record?.bytes) {
        this.toast(
          "這筆是舊版最近紀錄，當時未保存檔案內容，請從裝置重新選擇檔案。",
          "error",
          7500
        );
        return;
      }
      if (this.pages.length) {
        const confirmed = await this.confirmAction({
          title: "重新開啟最近文件？",
          message: "目前尚未匯出的編輯內容將被最近文件取代。",
          acceptLabel: "開啟文件",
        });
        if (!confirmed) return;
      }
      const file = new File([record.bytes], record.name || item.name, {
        type:
          record.type ||
          (String(record.name || item.name).toLowerCase().endsWith(".xlsx")
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/pdf"),
        lastModified: Number(record.lastModified) || Date.now(),
      });
      if (this.isExcelFile(file)) {
        await this.openExcelImport(file, { mode: "open" });
        if (this.excelWorkbookInfo) await this.rememberRecentFiles([file]);
      } else {
        await this.loadFiles([file], { replace: true, remember: true });
      }
    } catch (error) {
      console.warn("[PDF Editor] Recent file reopen failed", error);
      this.setBusy(false);
      this.toast("最近文件無法開啟，請從裝置重新選擇檔案。", "error", 7000);
    }
  }

  renderRecentFiles() {
    const recent = this.readRecentFiles();
    this.elements.recentFileList?.replaceChildren();
    this.elements.recentFiles.hidden = !recent.length;
    for (const item of recent) {
      const row = document.createElement("button");
      row.className = "recent-file-row";
      row.type = "button";
      row.title = `重新開啟 ${item.name}`;
      row.setAttribute("aria-label", `重新開啟最近文件：${item.name}`);
      row.addEventListener("click", () => this.openRecentFile(item));
      const name = document.createElement("span");
      name.textContent = item.name;
      const meta = document.createElement("small");
      meta.textContent = `${this.formatBytes(item.size)}・${new Date(
        item.openedAt
      ).toLocaleDateString("zh-TW")}・開啟`;
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
        if (!db.objectStoreNames.contains("sources")) {
          db.createObjectStore("sources", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("recentFiles")) {
          db.createObjectStore("recentFiles", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.dbPromise;
  }

  async dbOperation(storeName, mode, operation) {
    const db = await this.openEditorDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  projectDbOperation(mode, operation) {
    return this.dbOperation("projects", mode, operation);
  }

  scheduleAutosave() {
    if (this.restoringAutosave) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.saveAutosave(), 900);
  }

  async saveAutosave() {
    if (!this.pages.length) return;
    try {
      const activeSourceIds = new Set(this.pages.map((page) => page.sourceId));

      // Heavy source bytes are written once per source, not on every edit.
      for (const source of this.sources.values()) {
        if (!activeSourceIds.has(source.id)) continue;
        if (this.persistedSourceIds.has(source.id)) continue;
        await this.dbOperation("sources", "readwrite", (store) =>
          store.put({
            id: source.id,
            name: source.name,
            size: source.size,
            encrypted: source.encrypted,
            bytes: source.bytes.slice(),
          })
        );
        this.persistedSourceIds.add(source.id);
      }

      // Drop stored sources no longer referenced by the current document.
      const storedIds =
        (await this.dbOperation("sources", "readonly", (store) =>
          store.getAllKeys()
        )) || [];
      for (const id of storedIds) {
        if (activeSourceIds.has(id)) continue;
        await this.dbOperation("sources", "readwrite", (store) =>
          store.delete(id)
        );
        this.persistedSourceIds.delete(id);
      }

      const activePageIds = new Set(this.pages.map((page) => page.id));
      const textIndex = [...this.textIndex.entries()]
        .filter(
          ([pageId, entry]) => activePageIds.has(pageId) && entry?.ocr
        )
        .map(([pageId, entry]) => [pageId, { ocr: entry.ocr }]);

      const annotationImages = [];
      const seenImageIds = new Set();
      for (const page of this.pages) {
        for (const annotation of page.annotations || []) {
          if (!annotation.imageId || seenImageIds.has(annotation.imageId)) {
            continue;
          }
          seenImageIds.add(annotation.imageId);
          const dataUrl = this.annotationImages.get(annotation.imageId);
          if (dataUrl) annotationImages.push([annotation.imageId, dataUrl]);
        }
      }

      await this.projectDbOperation("readwrite", (store) =>
        store.put({
          id: AUTOSAVE_KEY,
          version: 2,
          savedAt: Date.now(),
          pages: clonePages(this.pages),
          activePageId: this.activePageId,
          sourceIds: [...activeSourceIds],
          textIndex,
          annotationImages,
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
      const choice = await this.confirmAction({
        title: "還原上次草稿？",
        message: `找到 ${new Date(project.savedAt).toLocaleString(
          "zh-TW"
        )} 自動儲存的 ${project.pages.length} 頁文件。`,
        acceptLabel: "還原草稿",
        extraLabel: "取消並刪除草稿",
      });
      if (choice === "confirm") {
        await this.restoreAutosave(project);
      } else if (choice === "extra") {
        await this.deleteAutosaveDraft();
      }
    } catch (error) {
      console.warn("[PDF Editor] Autosave restore check failed", error);
    }
  }

  async deleteAutosaveDraft() {
    try {
      await this.projectDbOperation("readwrite", (store) =>
        store.delete(AUTOSAVE_KEY)
      );
      await this.dbOperation("sources", "readwrite", (store) => store.clear());
      this.persistedSourceIds.clear();
      this.toast("已刪除上次草稿。", "success");
    } catch (error) {
      console.warn("[PDF Editor] Draft deletion failed", error);
      this.toast("草稿刪除失敗，請稍後再試。", "error");
    }
  }

  async loadSavedSources(sourceIds) {
    const records = [];
    for (const id of sourceIds) {
      const record = await this.dbOperation("sources", "readonly", (store) =>
        store.get(id)
      );
      if (!record) throw new Error(`Missing saved source: ${id}`);
      records.push(record);
    }
    return records;
  }

  async restoreAutosave(project) {
    this.restoringAutosave = true;
    this.setBusy(true, "正在還原草稿", "重新載入文件來源", 5);
    const restoredSources = new Map();
    try {
      // v1 drafts embed source bytes inline; v2 keeps them in the
      // dedicated "sources" store.
      const savedSources = Array.isArray(project.sources)
        ? project.sources
        : await this.loadSavedSources(project.sourceIds || []);
      for (let index = 0; index < savedSources.length; index += 1) {
        const saved = savedSources[index];
        this.setBusy(
          true,
          "正在還原草稿",
          `${saved.name}（${index + 1}/${savedSources.length}）`,
          10 + Math.round((index / savedSources.length) * 70)
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
      this.persistedSourceIds = Array.isArray(project.sources)
        ? new Set()
        : new Set(restoredSources.keys());
      this.pages = this.migrateLegacyPageGroups(clonePages(project.pages));
      this.thumbnailCache.clear();
      this.annotationImages = new Map(
        Array.isArray(project.annotationImages) ? project.annotationImages : []
      );
      // Migrate v1 inline image annotations to the shared image store so
      // undo snapshots stay lightweight.
      for (const page of this.pages) {
        for (const annotation of page.annotations || []) {
          if (
            annotation.type === "image" &&
            annotation.dataUrl &&
            !annotation.imageId
          ) {
            annotation.imageId = makeId("image");
            this.annotationImages.set(annotation.imageId, annotation.dataUrl);
            delete annotation.dataUrl;
          }
        }
      }
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
      const requestedCount = Math.min(
        20,
        Math.max(
          1,
          Number(new URLSearchParams(location.search).get("count")) || 1
        )
      );
      const files = [];
      for (let index = 0; index < requestedCount; index += 1) {
        const key = new URL(`./shared-pdf-${index}`, location.href).href;
        let response = await cache.match(key);
        let matchedKey = key;
        if (!response && index === 0) {
          matchedKey = new URL("./shared-pdf", location.href).href;
          response = await cache.match(matchedKey);
        }
        if (!response) continue;
        await cache.delete(matchedKey);
        const blob = await response.blob();
        const encodedName = response.headers.get("X-PDF-File-Name");
        const fileName = encodedName
          ? decodeURIComponent(encodedName)
          : `分享的文件-${index + 1}.pdf`;
        files.push(
          new File([blob], fileName, {
            type: "application/pdf",
          })
        );
      }
      if (!files.length) return false;
      await this.loadFiles(files, { replace: true });
      history.replaceState(null, "", "./");
      return true;
    } catch (error) {
      console.warn("[PDF Editor] Shared file import failed", error);
      return false;
    }
  }

  handleKeyboard(event) {
    if (
      event.key === "Escape" &&
      this.elements.toolbarOverflowMenu &&
      !this.elements.toolbarOverflowMenu.hidden
    ) {
      this.toggleToolbarOverflowMenu(false);
      return;
    }
    if (document.querySelector("dialog[open]")) return;
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

  installFeedbackDiagnostics() {
    if (this.feedbackDiagnosticsInstalled) return;
    this.feedbackDiagnosticsInstalled = true;

    for (const level of ["warn", "error"]) {
      const original = console[level]?.bind(console);
      if (!original) continue;
      console[level] = (...args) => {
        this.recordFeedbackDiagnostic(level, ...args);
        original(...args);
      };
      this.feedbackConsoleRestore.push(() => {
        console[level] = original;
      });
    }

    window.addEventListener("error", (event) => {
      if (event.target && event.target !== window && !event.error) return;
      this.handleGlobalFeedbackError(
        event.error || new Error(event.message || "未知的 JavaScript 錯誤"),
        "window.error"
      );
    });
    window.addEventListener("unhandledrejection", (event) => {
      this.handleGlobalFeedbackError(event.reason, "unhandledrejection");
    });
  }

  serializeFeedbackDiagnosticValue(value) {
    if (value instanceof Error) {
      return `${value.name || "Error"}: ${value.message || "未知錯誤"}${
        value.stack ? `\n${value.stack}` : ""
      }`;
    }
    if (value instanceof File) {
      return `[File type=${value.type || "unknown"} size=${value.size}]`;
    }
    if (value instanceof Blob) {
      return `[Blob type=${value.type || "unknown"} size=${value.size}]`;
    }
    if (value instanceof Element) {
      return `[Element ${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}]`;
    }
    if (typeof value === "string") return value;
    if (value == null || ["number", "boolean", "bigint"].includes(typeof value)) {
      return String(value);
    }
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (key, nested) => {
        if (nested instanceof File) {
          return { type: nested.type || "unknown", size: nested.size };
        }
        if (nested instanceof Blob) {
          return { type: nested.type || "unknown", size: nested.size };
        }
        if (nested && typeof nested === "object") {
          if (seen.has(nested)) return "[Circular]";
          seen.add(nested);
        }
        return nested;
      });
    } catch {
      return String(value);
    }
  }

  recordFeedbackDiagnostic(level, ...values) {
    const message = values
      .map((value) => this.serializeFeedbackDiagnosticValue(value))
      .join(" ")
      .slice(0, 6000);
    this.feedbackDiagnostics.push({
      at: new Date().toISOString(),
      level,
      message,
    });
    if (this.feedbackDiagnostics.length > FEEDBACK_LOG_LIMIT) {
      this.feedbackDiagnostics.splice(
        0,
        this.feedbackDiagnostics.length - FEEDBACK_LOG_LIMIT
      );
    }
  }

  normalizeFeedbackError(error, source = "runtime") {
    const normalized = error instanceof Error ? error : new Error(String(error || "未知錯誤"));
    return {
      at: new Date().toISOString(),
      source,
      name: normalized.name || "Error",
      message: normalized.message || "未知錯誤",
      stack: normalized.stack || "",
    };
  }

  shouldIgnoreGlobalFeedbackError(record) {
    return /AbortError|RenderingCancelledException|ResizeObserver loop/i.test(
      `${record.name} ${record.message}`
    );
  }

  handleGlobalFeedbackError(error, source = "runtime") {
    const record = this.normalizeFeedbackError(error, source);
    this.recordFeedbackDiagnostic("unhandled", record);
    if (this.shouldIgnoreGlobalFeedbackError(record)) return;
    this.pendingFeedbackError = record;
    const now = Date.now();
    if (now - this.feedbackInviteShownAt < FEEDBACK_ERROR_INVITE_COOLDOWN_MS) {
      return;
    }
    this.feedbackInviteShownAt = now;
    this.showErrorReportInvite(record);
  }

  showErrorReportInvite(record) {
    const invite = this.elements.errorReportInvite;
    if (!invite) return;
    const message = String(record?.message || "未預期錯誤")
      .replace(/\s+/g, " ")
      .slice(0, 120);
    this.elements.errorReportInviteMessage.textContent = `${message}。您可以附上診斷資料協助我們修正。`;
    invite.hidden = false;
  }

  hideErrorReportInvite() {
    if (this.elements.errorReportInvite) {
      this.elements.errorReportInvite.hidden = true;
    }
  }

  openFeedbackDialog({ reason = "manual", errorRecord = null } = {}) {
    const dialog = this.elements.feedbackDialog;
    if (!dialog) return;

    this.elements.feedbackError.hidden = true;
    this.elements.feedbackSubmitStatus.textContent = "";
    this.elements.feedbackCategory.value =
      reason === "global-error" ? "效能異常" : "使用問題回報";
    this.elements.feedbackTitle.value =
      reason === "global-error" ? "操作時發生未預期錯誤" : "";
    this.elements.feedbackDescription.value =
      reason === "global-error"
        ? "請補充錯誤發生前的操作步驟，以及您原本預期的結果。"
        : "";
    this.pendingFeedbackError = errorRecord || this.pendingFeedbackError;
    this.elements.feedbackIncludeDiagnostics.checked =
      reason === "global-error";
    this.elements.feedbackEnvironment.value = this.buildFeedbackEnvironment();
    this.refreshFeedbackDiagnosticsPreview();
    this.refreshFeedbackServiceWorkerVersion();

    const configured = this.isFeedbackFormConfigured();
    this.elements.feedbackConfigWarning.textContent =
      this.feedbackConfig.disabledReason ||
      "Google 表單尚未設定，請先在 feedback-config.js 填入表單 ID 與欄位 ID。";
    this.elements.feedbackConfigWarning.hidden = configured;
    this.elements.feedbackSubmitButton.disabled = !configured;
    this.openDialog(dialog);
    setTimeout(() => this.elements.feedbackTitle.focus(), 60);
  }

  detectFeedbackBrowser() {
    const ua = navigator.userAgent || "";
    if (/Edg\//.test(ua)) return `Microsoft Edge ${ua.match(/Edg\/([\d.]+)/)?.[1] || ""}`.trim();
    if (/OPR\//.test(ua)) return `Opera ${ua.match(/OPR\/([\d.]+)/)?.[1] || ""}`.trim();
    if (/SamsungBrowser\//.test(ua)) {
      return `Samsung Internet ${ua.match(/SamsungBrowser\/([\d.]+)/)?.[1] || ""}`.trim();
    }
    if (/CriOS\//.test(ua)) return `Chrome iOS ${ua.match(/CriOS\/([\d.]+)/)?.[1] || ""}`.trim();
    if (/FxiOS\//.test(ua)) return `Firefox iOS ${ua.match(/FxiOS\/([\d.]+)/)?.[1] || ""}`.trim();
    if (/Chrome\//.test(ua)) return `Chrome ${ua.match(/Chrome\/([\d.]+)/)?.[1] || ""}`.trim();
    if (/Firefox\//.test(ua)) return `Firefox ${ua.match(/Firefox\/([\d.]+)/)?.[1] || ""}`.trim();
    if (/Safari\//.test(ua)) return `Safari ${ua.match(/Version\/([\d.]+)/)?.[1] || ""}`.trim();
    return "未知瀏覽器";
  }

  getFeedbackPwaState() {
    if (navigator.standalone === true) return "iOS 主畫面 PWA";
    if (matchMedia("(display-mode: standalone)").matches) return "Standalone PWA";
    if (matchMedia("(display-mode: fullscreen)").matches) return "Fullscreen PWA";
    if (matchMedia("(display-mode: minimal-ui)").matches) return "Minimal UI PWA";
    return "瀏覽器分頁";
  }

  queryFeedbackServiceWorkerVersion(worker) {
    if (!worker || typeof MessageChannel === "undefined") return Promise.resolve("");
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (value = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        channel.port1.close();
        resolve(String(value || ""));
      };
      const timeoutId = setTimeout(() => finish(""), 1200);
      channel.port1.onmessage = (event) => finish(event.data?.version);
      try {
        worker.postMessage({ type: "get-sw-version" }, [channel.port2]);
      } catch {
        finish("");
      }
    });
  }

  async detectFeedbackServiceWorkerCacheVersion() {
    if (typeof caches === "undefined") return "";
    try {
      const versions = (await caches.keys())
        .map((name) => name.match(/^pdfEditor-(v\d+)$/i)?.[1] || "")
        .filter(Boolean)
        .sort((left, right) =>
          Number(left.slice(1)) - Number(right.slice(1))
        );
      return versions.at(-1) || "";
    } catch {
      return "";
    }
  }

  async refreshFeedbackServiceWorkerVersion(registration = null) {
    if (!("serviceWorker" in navigator)) {
      this.feedbackServiceWorkerVersion = "瀏覽器不支援";
      return this.feedbackServiceWorkerVersion;
    }
    if (this.feedbackServiceWorkerVersionPromise) {
      return this.feedbackServiceWorkerVersionPromise;
    }
    this.feedbackServiceWorkerVersionPromise = (async () => {
      try {
        const currentRegistration =
          registration || (await navigator.serviceWorker.getRegistration());
        const candidates = [
          ["目前控制", navigator.serviceWorker.controller],
          ["Active", currentRegistration?.active],
          ["等待啟用", currentRegistration?.waiting],
          ["安裝中", currentRegistration?.installing],
        ];
        const seen = new Set();
        const uniqueCandidates = candidates.filter(([, worker]) => {
          if (!worker || seen.has(worker)) return false;
          seen.add(worker);
          return true;
        });
        if (!uniqueCandidates.length) return "尚未啟用";
        const results = await Promise.all(
          uniqueCandidates.map(async ([role, worker]) => ({
            role,
            version: await this.queryFeedbackServiceWorkerVersion(worker),
          }))
        );
        const current = results.find(
          (item) => item.version && ["目前控制", "Active"].includes(item.role)
        );
        const pending = results.find(
          (item) => item.version && ["等待啟用", "安裝中"].includes(item.role)
        );
        if (current) {
          return pending && pending.version !== current.version
            ? `${current.version}（目前）／${pending.version}（${pending.role}）`
            : current.version;
        }
        if (pending) return `${pending.version}（${pending.role}）`;
        const cachedVersion = await this.detectFeedbackServiceWorkerCacheVersion();
        return cachedVersion
          ? `${cachedVersion}（由快取辨識）`
          : "無法取得";
      } catch {
        const cachedVersion = await this.detectFeedbackServiceWorkerCacheVersion();
        return cachedVersion
          ? `${cachedVersion}（由快取辨識）`
          : "無法取得";
      }
    })();
    try {
      this.feedbackServiceWorkerVersion =
        await this.feedbackServiceWorkerVersionPromise;
      if (this.elements.feedbackDialog?.open) {
        this.elements.feedbackEnvironment.value = this.buildFeedbackEnvironment();
        this.refreshFeedbackDiagnosticsPreview();
      }
      return this.feedbackServiceWorkerVersion;
    } finally {
      this.feedbackServiceWorkerVersionPromise = null;
    }
  }

  buildFeedbackEnvironment() {
    const uaData = navigator.userAgentData;
    const platform = uaData?.platform || navigator.platform || "未知平台";
    const device = uaData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      ? "行動裝置"
      : "桌面裝置";
    return [
      `PDF 工坊版本：${PDF_WORKSHOP_VERSION}`,
      `Service Worker 版本：${this.feedbackServiceWorkerVersion}`,
      `裝置：${device}／${platform}`,
      `瀏覽器：${this.detectFeedbackBrowser()}`,
      `PWA 狀態：${this.getFeedbackPwaState()}`,
      `語言：${navigator.language || "未知"}`,
      `螢幕：${screen.width}×${screen.height}／視窗：${innerWidth}×${innerHeight}／DPR ${devicePixelRatio || 1}`,
      `連線：${navigator.onLine ? "線上" : "離線"}`,
      `時間：${new Date().toISOString()}`,
    ].join("\n");
  }

  buildFeedbackDiagnostics() {
    const state = {
      pageCount: this.pages.length,
      selectedPageCount: this.selectedPageIds.size,
      sourceCount: this.sources.size,
      viewMode: this.viewMode,
      activeTool: this.activeTool,
      dirty: this.dirty,
      zoom: this.zoom,
      serviceWorkerVersion: this.feedbackServiceWorkerVersion,
    };
    const records = this.feedbackDiagnostics.slice(-FEEDBACK_LOG_LIMIT);
    if (this.pendingFeedbackError) {
      const alreadyIncluded = records.some((item) =>
        item.message.includes(this.pendingFeedbackError.message)
      );
      if (!alreadyIncluded) {
        records.push({
          at: this.pendingFeedbackError.at,
          level: "unhandled",
          message: this.serializeFeedbackDiagnosticValue(this.pendingFeedbackError),
        });
      }
    }
    return [
      `狀態：${JSON.stringify(state)}`,
      "最近紀錄：",
      records.length
        ? records.map((item) => `[${item.at}] ${item.level}: ${item.message}`).join("\n")
        : "（沒有錯誤紀錄）",
    ].join("\n");
  }

  refreshFeedbackDiagnosticsPreview() {
    if (!this.elements.feedbackDiagnostics) return;
    this.elements.feedbackDiagnostics.value = this.buildFeedbackDiagnostics();
  }

  isFeedbackConfigValue(value) {
    return Boolean(
      String(value || "").trim() && !/[【】]/.test(String(value || ""))
    );
  }

  normalizeFeedbackEntry(value) {
    const entry = String(value || "").trim();
    if (!entry) return "";
    return entry.startsWith("entry.") ? entry : `entry.${entry}`;
  }

  isFeedbackFormConfigured() {
    const { enabled, formResponseUrl, entries = {} } = this.feedbackConfig || {};
    return (
      enabled !== false &&
      this.isFeedbackConfigValue(formResponseUrl) &&
      /^https:\/\/docs\.google\.com\/forms\/d\/e\/[^/]+\/formResponse$/.test(
        formResponseUrl
      ) &&
      ["category", "title", "description", "environment"].every((key) =>
        this.isFeedbackConfigValue(entries[key])
      )
    );
  }

  buildFeedbackPayload() {
    return {
      category: this.elements.feedbackCategory.value,
      title: this.elements.feedbackTitle.value.trim(),
      description: this.elements.feedbackDescription.value.trim(),
      contact: this.elements.feedbackContact.value.trim(),
      environment: this.elements.feedbackEnvironment.value,
      diagnostics: this.elements.feedbackIncludeDiagnostics.checked
        ? this.buildFeedbackDiagnostics()
        : "",
    };
  }

  validateFeedbackPayload(payload) {
    if (!payload.title) return "請輸入回報標題。";
    if (!payload.description) return "請輸入詳細說明。";
    const entries = this.feedbackConfig?.entries || {};
    if (payload.contact && !this.isFeedbackConfigValue(entries.contact)) {
      return "Google 表單尚未設定聯絡方式欄位。";
    }
    if (payload.diagnostics && !this.isFeedbackConfigValue(entries.diagnostics)) {
      return "Google 表單尚未設定診斷紀錄欄位。";
    }
    return "";
  }

  async sendFeedbackToGoogleForm(payload) {
    const { formResponseUrl, entries } = this.feedbackConfig;
    const params = new URLSearchParams();
    const groupedValues = new Map();
    for (const [key, value] of Object.entries(payload)) {
      if (!value || !this.isFeedbackConfigValue(entries[key])) continue;
      const entry = this.normalizeFeedbackEntry(entries[key]);
      const label = key === "diagnostics" ? "診斷紀錄" : "";
      const part = label ? `【${label}】\n${value}` : value;
      const existing = groupedValues.get(entry);
      groupedValues.set(entry, existing ? `${existing}\n\n${part}` : part);
    }
    for (const [entry, value] of groupedValues) params.set(entry, value);
    params.set("submit", "Submit");
    await fetch(formResponseUrl, {
      method: "POST",
      mode: "no-cors",
      body: params,
    });
  }

  async submitFeedback() {
    if (this.feedbackSubmitting) return;
    const errorElement = this.elements.feedbackError;
    errorElement.hidden = true;
    this.elements.feedbackSubmitStatus.textContent = "";

    if (!this.isFeedbackFormConfigured()) {
      errorElement.textContent = "Google 表單尚未完成設定，暫時無法送出。";
      errorElement.hidden = false;
      return;
    }
    if (!navigator.onLine) {
      errorElement.textContent = "目前是離線狀態，請連線後再送出回報。";
      errorElement.hidden = false;
      return;
    }

    this.feedbackSubmitting = true;
    this.elements.feedbackSubmitButton.disabled = true;
    this.elements.feedbackSubmitStatus.textContent = "正在準備回報…";
    await this.refreshFeedbackServiceWorkerVersion();
    this.elements.feedbackEnvironment.value = this.buildFeedbackEnvironment();
    this.refreshFeedbackDiagnosticsPreview();
    const payload = this.buildFeedbackPayload();
    const validationError = this.validateFeedbackPayload(payload);
    if (validationError) {
      errorElement.textContent = validationError;
      errorElement.hidden = false;
      this.elements.feedbackSubmitStatus.textContent = "";
      this.elements.feedbackSubmitButton.disabled = false;
      this.feedbackSubmitting = false;
      return;
    }

    this.elements.feedbackSubmitStatus.textContent = "正在送出…";
    try {
      await this.sendFeedbackToGoogleForm(payload);
      this.elements.feedbackSubmitStatus.textContent = "已送出";
      this.hideErrorReportInvite();
      this.pendingFeedbackError = null;
      this.toast("回報已送出，感謝您協助改善 PDF 工坊。", "success", 6000);
      setTimeout(() => this.closeDialog(this.elements.feedbackDialog, "sent"), 500);
    } catch (error) {
      console.warn("[PDF Editor] Feedback submission failed", error);
      errorElement.textContent = "回報送出失敗，請檢查網路後再試一次。";
      errorElement.hidden = false;
      this.elements.feedbackSubmitStatus.textContent = "";
      this.elements.feedbackSubmitButton.disabled = false;
    } finally {
      this.feedbackSubmitting = false;
    }
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

  // Without extraLabel resolves to a boolean (confirm / not). With
  // extraLabel resolves to "confirm" | "extra" | "cancel".
  confirmAction({ title, message, acceptLabel = "確認", extraLabel = "" }) {
    const dialog = this.elements.confirmDialog;
    if (!dialog) {
      const accepted = window.confirm(message);
      return Promise.resolve(extraLabel ? (accepted ? "confirm" : "cancel") : accepted);
    }
    this.elements.confirmTitle.textContent = title;
    this.elements.confirmMessage.textContent = message;
    this.elements.confirmAcceptButton.textContent = acceptLabel;
    if (this.elements.confirmExtraButton) {
      this.elements.confirmExtraButton.textContent = extraLabel;
      this.elements.confirmExtraButton.hidden = !extraLabel;
    }
    dialog.returnValue = "cancel";
    this.openDialog(dialog);
    return new Promise((resolve) => {
      dialog.addEventListener(
        "close",
        () =>
          resolve(
            extraLabel ? dialog.returnValue : dialog.returnValue === "confirm"
          ),
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

  isStandaloneApp() {
    return (
      matchMedia("(display-mode: standalone)").matches ||
      navigator.standalone === true
    );
  }

  hasSeenInstallIntro() {
    try {
      return localStorage.getItem(INSTALL_INTRO_KEY) === "1";
    } catch {
      return false;
    }
  }

  markInstallIntroSeen() {
    try {
      localStorage.setItem(INSTALL_INTRO_KEY, "1");
    } catch {
      // Storage restrictions should not prevent the install flow.
    }
  }

  // The install button and guide are available in every browser; the
  // native install prompt is only used when the browser provides one.
  shouldOfferInstall() {
    return (
      !this.isStandaloneApp() &&
      !this.detectedInstalledApp &&
      (this.installStateReady || Boolean(this.installPrompt))
    );
  }

  getInstallGuide() {
    const ua = navigator.userAgent;
    const isIos =
      /iPhone|iPad|iPod/i.test(ua) ||
      (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);

    if (isIos) {
      return {
        name: "iOS / iPadOS",
        steps: [
          "使用 Safari 開啟本頁",
          "點選網址列旁的「分享」按鈕",
          "選擇「加入主畫面」並確認",
        ],
        note: "iPhone 與 iPad 請透過 Safari 的分享選單安裝；安裝後可離線使用。",
      };
    }
    if (isAndroid && /Firefox/i.test(ua)) {
      return {
        name: "Android Firefox",
        steps: ["點選右上角「⋮」選單", "選擇「安裝」或「加入主畫面」"],
        note: "若需要從 Android 的 PDF 分享清單開啟文件，建議改用 Chrome 完整安裝。",
      };
    }
    if (isAndroid) {
      return {
        name: "Android",
        steps: [
          "點選 Chrome 右上角「⋮」選單",
          "選擇「安裝應用程式」",
          "安裝完成後即可從 PDF 分享清單選擇 PDF 工坊",
        ],
        note: "只有完整安裝的 PWA 才會出現在 Android 的 PDF 分享清單。",
      };
    }
    if (/Firefox/i.test(ua)) {
      return {
        name: "Firefox（桌面版）",
        steps: [
          "Firefox 桌面版目前不支援安裝 PWA",
          "可將本頁加入書籤，離線快取仍然有效",
          "若要安裝為 APP，請改用 Chrome、Edge 或 Safari 開啟本頁",
        ],
        note: "所有編輯功能在 Firefox 中仍可正常使用，僅無法安裝成獨立 APP。",
      };
    }
    if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR/i.test(ua)) {
      return {
        name: "macOS Safari",
        steps: [
          "點選 Safari 工具列的「分享」按鈕",
          "選擇「加入 Dock」",
          "之後可從 Dock 直接開啟 PDF 工坊",
        ],
        note: "需要 macOS Sonoma（Safari 17）以上版本。",
      };
    }
    // Chromium family: Chrome, Edge, Brave, Arc, Dia, Opera, Vivaldi…
    return {
      name: "Chromium 系瀏覽器",
      steps: [
        "點選網址列右側的「安裝」圖示（若有顯示）",
        "或開啟瀏覽器選單，選擇「安裝應用程式」／「加入 Dock／桌面」",
      ],
      note: "Chrome、Edge、Brave、Arc、Dia 等 Chromium 系瀏覽器多數支援；若選單沒有安裝選項，代表該瀏覽器暫不支援 PWA 安裝。",
    };
  }

  populateInstallDialog() {
    const guide = this.getInstallGuide();
    const hasNativePrompt = Boolean(this.installPrompt);
    if (this.elements.installStepsList) {
      this.elements.installStepsList.replaceChildren(
        ...guide.steps.map((step) => {
          const item = document.createElement("li");
          item.textContent = step;
          return item;
        })
      );
      this.elements.installStepsList.hidden = hasNativePrompt;
    }
    if (this.elements.installDialogNote) {
      this.elements.installDialogNote.textContent = hasNativePrompt
        ? "點選「立即安裝」後，依系統視窗完成安裝。"
        : guide.note;
    }
    if (this.elements.installNowButton) {
      this.elements.installNowButton.hidden = !hasNativePrompt;
    }
  }

  async initializeInstallExperience() {
    if (this.isStandaloneApp()) {
      this.installStateReady = true;
      this.detectedInstalledApp = true;
      this.updateInstallButton();
      return;
    }
    try {
      const relatedApps =
        (await navigator.getInstalledRelatedApps?.()) || [];
      this.detectedInstalledApp = relatedApps.some(
        (app) => app.platform === "webapp"
      );
    } catch (error) {
      console.warn("[PDF Editor] Installed app detection failed", error);
    } finally {
      this.installStateReady = true;
      this.updateInstallButton();
      this.scheduleInstallIntro();
    }
  }

  scheduleInstallIntro(delay = 2200) {
    clearTimeout(this.installIntroTimer);
    this.installIntroTimer = null;
    if (!this.shouldOfferInstall() || this.hasSeenInstallIntro()) return;
    // Only auto-show the intro where installation is most valuable
    // (Android share target) or a native prompt exists; other browsers
    // can open the guide from the header button.
    if (!/Android/i.test(navigator.userAgent) && !this.installPrompt) return;
    this.installIntroTimer = setTimeout(() => {
      this.installIntroTimer = null;
      this.showInstallIntro();
    }, delay);
  }

  showInstallIntro({ force = false } = {}) {
    if (!this.shouldOfferInstall()) return;
    if (!force && this.hasSeenInstallIntro()) return;
    clearTimeout(this.installIntroTimer);
    this.installIntroTimer = null;
    this.markInstallIntroSeen();
    this.populateInstallDialog();
    this.openDialog(this.elements.installDialog);
  }

  updateInstallButton() {
    const button = this.elements.installButton;
    if (!button) return;
    button.hidden = !this.shouldOfferInstall();
  }

  async installApp() {
    this.closeDialog(this.elements.installDialog, "install");
    if (!this.installPrompt) {
      const guide = this.getInstallGuide();
      this.toast(`安裝方式：${guide.steps.join("；")}。`, "default", 9000);
      return;
    }
    const promptEvent = this.installPrompt;
    this.installPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome !== "accepted") {
        this.toast(
          "已暫緩安裝，之後可使用最上方工具列的「安裝 APP」按鈕。",
          "default",
          6000
        );
      }
    } catch (error) {
      console.warn("[PDF Editor] Install prompt failed", error);
      this.toast(
        "無法開啟安裝視窗，請使用 Android Chrome 右上選單的「安裝應用程式」。",
        "error",
        7000
      );
    }
    this.updateInstallButton();
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
      this.refreshFeedbackServiceWorkerVersion(registration);
      // Ask the worker to warm the large OCR assets in the background so
      // install stays fast while offline OCR still becomes available.
      navigator.serviceWorker.ready.then((ready) => {
        this.refreshFeedbackServiceWorkerVersion(ready);
        setTimeout(
          () => ready.active?.postMessage({ type: "warm-ocr-cache" }),
          4000
        );
      });
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
      await this.handleOpenFiles(files);
    });
  }
}

const app = new PdfWorkshop();
const appReady = app.init();
if (new URLSearchParams(location.search).get("testHarness") === "1") {
  window.__PDF_WORKSHOP_TEST__ = { app, ready: appReady };
}
