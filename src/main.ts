import {
  App,
  ItemView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  type SliderComponent,
  type TextComponent,
  WorkspaceLeaf,
  getAllTags,
  normalizePath,
  setIcon,
} from "obsidian";

const VIEW_TYPE_VAULT_COLUMNS = "vault-columns-view";
const FILE_MENU_SOURCE = "file-explorer";
const MIN_ROW_FONT_SIZE = 10;
const MAX_ROW_FONT_SIZE = 20;
const MIN_PRIMARY_PANE_WIDTH = 140;
const MAX_PRIMARY_PANE_WIDTH = 640;
const MIN_SECONDARY_PANE_WIDTH = 220;
const MIN_BRANCH_PANE_HEIGHT = 80;
const MIN_NOTES_PANE_HEIGHT = 120;
const MIN_NOTES_PANE_SHARE = 25;
const MAX_NOTES_PANE_SHARE = 85;
const LAYOUT_INPUT_WIDTH = "72px";

type NavigatorMode = "folders" | "tags";

interface VaultColumnsSettings {
  defaultMode: NavigatorMode;
  showTagResultPaths: boolean;
  showTagNoteCounts: boolean;
  rowFontSize: number;
  primaryPaneWidth: number;
  notesPaneShare: number;
}

const DEFAULT_SETTINGS: VaultColumnsSettings = {
  defaultMode: "folders",
  showTagResultPaths: true,
  showTagNoteCounts: true,
  rowFontSize: 13,
  primaryPaneWidth: 220,
  notesPaneShare: 62,
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export default class VaultColumnsPlugin extends Plugin {
  settings: VaultColumnsSettings = DEFAULT_SETTINGS;
  private refreshTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_VAULT_COLUMNS,
      (leaf) => new VaultColumnsView(leaf, this),
    );

    this.addRibbonIcon("columns-3", "Open Vault Columns", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-vault-columns",
      name: "Open Vault Columns",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new VaultColumnsSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("create", () => this.refreshViewsDebounced()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshViewsDebounced()));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshViewsDebounced()));
    this.registerEvent(this.app.vault.on("modify", () => this.refreshViewsDebounced()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshViewsDebounced()));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.syncActiveFile(file)));
  }

  onunload() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async loadSettings() {
    this.settings = VaultColumnsPlugin.normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    this.settings = VaultColumnsPlugin.normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  private static normalizeSettings(data: unknown): VaultColumnsSettings {
    const settings =
      data && typeof data === "object"
        ? (data as Partial<VaultColumnsSettings>)
        : {};

    const defaultMode =
      settings.defaultMode === "tags" || settings.defaultMode === "folders"
        ? settings.defaultMode
        : DEFAULT_SETTINGS.defaultMode;

    return {
      defaultMode,
      showTagResultPaths:
        typeof settings.showTagResultPaths === "boolean"
          ? settings.showTagResultPaths
          : DEFAULT_SETTINGS.showTagResultPaths,
      showTagNoteCounts:
        typeof settings.showTagNoteCounts === "boolean"
          ? settings.showTagNoteCounts
          : DEFAULT_SETTINGS.showTagNoteCounts,
      rowFontSize: VaultColumnsPlugin.normalizeNumber(
        settings.rowFontSize,
        DEFAULT_SETTINGS.rowFontSize,
        MIN_ROW_FONT_SIZE,
        MAX_ROW_FONT_SIZE,
      ),
      primaryPaneWidth: VaultColumnsPlugin.normalizeNumber(
        settings.primaryPaneWidth,
        DEFAULT_SETTINGS.primaryPaneWidth,
        MIN_PRIMARY_PANE_WIDTH,
        MAX_PRIMARY_PANE_WIDTH,
      ),
      notesPaneShare: VaultColumnsPlugin.normalizeNumber(
        settings.notesPaneShare,
        DEFAULT_SETTINGS.notesPaneShare,
        MIN_NOTES_PANE_SHARE,
        MAX_NOTES_PANE_SHARE,
      ),
    };
  }

  private static normalizeNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ) {
    const parsedValue =
      typeof value === "number" || (typeof value === "string" && value.trim() !== "")
        ? Number(value)
        : Number.NaN;
    const safeValue = Number.isFinite(parsedValue) ? parsedValue : fallback;
    return Math.round(clampNumber(safeValue, min, max));
  }

  async activateView() {
    const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COLUMNS);

    if (existingLeaves.length === 0) {
      await this.app.workspace.getLeftLeaf(false)?.setViewState({
        type: VIEW_TYPE_VAULT_COLUMNS,
        active: true,
      });
    }

    const [leaf] = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COLUMNS);
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
    } else {
      new Notice("Unable to open Vault Columns.");
    }
  }

  refreshViewsDebounced() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshViews();
    }, 150);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COLUMNS)) {
      if (leaf.view instanceof VaultColumnsView) {
        leaf.view.render();
      }
    }
  }

  syncActiveFile(file: TFile | null) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COLUMNS)) {
      if (leaf.view instanceof VaultColumnsView) {
        leaf.view.setActiveFile(file);
      }
    }
  }
}

class VaultColumnsView extends ItemView {
  private mode: NavigatorMode;
  private selectedFolderPath = "";
  private selectedTag: string | null = null;
  private activeFilePath: string | null = null;
  private expandedFolders = new Set<string>();
  private paneResizeCleanup: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: VaultColumnsPlugin,
  ) {
    super(leaf);
    this.mode = plugin.settings.defaultMode;
    this.activeFilePath = plugin.app.workspace.getActiveFile()?.path ?? null;
  }

  getViewType() {
    return VIEW_TYPE_VAULT_COLUMNS;
  }

  getDisplayText() {
    return "Vault Columns";
  }

  getIcon() {
    return "columns-3";
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.stopPaneResize();
  }

  setActiveFile(file: TFile | null) {
    this.activeFilePath = file?.path ?? null;
    this.render();
  }

  render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("vault-columns-view");
    this.applyLayoutSettings(containerEl);

    const shellEl = containerEl.createDiv({ cls: "vault-columns-shell" });

    this.renderToolbar(shellEl);

    if (this.mode === "folders") {
      this.renderFolderMode(shellEl);
    } else {
      this.renderTagMode(shellEl);
    }
  }

  private applyLayoutSettings(el: HTMLElement) {
    const { rowFontSize, primaryPaneWidth, notesPaneShare } = this.plugin.settings;
    el.style.setProperty("--vault-columns-font-size", `${rowFontSize}px`);
    el.style.setProperty("--vault-columns-primary-width", `${primaryPaneWidth}px`);
    el.style.setProperty("--vault-columns-branch-fr", `${100 - notesPaneShare}fr`);
    el.style.setProperty("--vault-columns-notes-fr", `${notesPaneShare}fr`);
  }

  private renderToolbar(parentEl: HTMLElement) {
    const toolbarEl = parentEl.createDiv({ cls: "vault-columns-toolbar" });

    const switchEl = toolbarEl.createDiv({ cls: "vault-columns-mode-switch" });
    this.createModeButton(switchEl, "folders", "文件夹");
    this.createModeButton(switchEl, "tags", "标签");

    const collapseButtonEl = toolbarEl.createDiv({
      cls: "clickable-icon vault-columns-icon-button",
    });
    collapseButtonEl.setAttr("aria-label", "折叠到顶层");
    collapseButtonEl.setAttr("title", "折叠到顶层");
    setIcon(collapseButtonEl, "list-collapse");
    collapseButtonEl.addEventListener("click", () => {
      this.collapseToTop();
    });
  }

  private createModeButton(parentEl: HTMLElement, mode: NavigatorMode, label: string) {
    const buttonEl = parentEl.createEl("button", {
      cls: `clickable-icon vault-columns-mode-button ${
        this.mode === mode ? "is-active" : ""
      }`,
      text: label,
    });
    buttonEl.setAttr("aria-label", label);

    buttonEl.addEventListener("click", () => {
      this.mode = mode;
      this.render();
    });
  }

  private renderFolderMode(parentEl: HTMLElement) {
    const boardEl = parentEl.createDiv({ cls: "vault-columns-folder-board" });
    const primaryPaneEl = boardEl.createDiv({
      cls: "vault-columns-pane vault-columns-primary-pane",
    });
    this.renderColumnResizer(boardEl, "调整左侧栏宽度");
    const rightStackEl = boardEl.createDiv({ cls: "vault-columns-right-stack" });
    const branchPaneEl = rightStackEl.createDiv({
      cls: "vault-columns-pane vault-columns-branch-pane",
    });
    this.renderRowResizer(rightStackEl, "调整子文件夹和笔记区域高度");
    const notesPaneEl = rightStackEl.createDiv({
      cls: "vault-columns-pane vault-columns-notes-pane",
    });

    this.renderPaneHeader(primaryPaneEl, "顶层文件夹", "folder");
    this.renderTopLevelFolders(primaryPaneEl);

    this.renderPaneHeader(branchPaneEl, "子文件夹", "folder-open");
    this.renderBranchFolders(branchPaneEl);

    this.renderPaneHeader(notesPaneEl, this.getNotesPaneTitle(), "file-text");
    this.renderFolderNotes(notesPaneEl);
  }

  private renderTagMode(parentEl: HTMLElement) {
    const boardEl = parentEl.createDiv({ cls: "vault-columns-tag-board" });
    const tagPaneEl = boardEl.createDiv({
      cls: "vault-columns-pane vault-columns-tag-pane",
    });
    this.renderColumnResizer(boardEl, "调整标签栏宽度");
    const notesPaneEl = boardEl.createDiv({
      cls: "vault-columns-pane vault-columns-notes-pane",
    });

    this.renderPaneHeader(tagPaneEl, "标签", "tags");
    this.renderTagList(tagPaneEl);

    this.renderPaneHeader(notesPaneEl, this.selectedTag ?? "标签笔记", "file-text");
    this.renderTagNotes(notesPaneEl);
  }

  private renderPaneHeader(parentEl: HTMLElement, title: string, icon: string) {
    const headerEl = parentEl.createDiv({ cls: "vault-columns-pane-header" });
    const iconEl = headerEl.createSpan({ cls: "vault-columns-pane-icon" });
    setIcon(iconEl, icon);
    headerEl.createSpan({
      cls: "vault-columns-pane-title",
      text: title,
    });
  }

  private renderColumnResizer(parentEl: HTMLElement, label: string) {
    const resizerEl = parentEl.createDiv({
      cls: "vault-columns-resizer vault-columns-column-resizer",
    });
    resizerEl.setAttr("role", "separator");
    resizerEl.setAttr("aria-orientation", "vertical");
    resizerEl.setAttr("aria-label", label);
    resizerEl.setAttr("title", label);
    resizerEl.addEventListener("pointerdown", (event) => {
      this.beginColumnResize(event, parentEl, resizerEl);
    });
    resizerEl.addEventListener("dblclick", async () => {
      this.plugin.settings.primaryPaneWidth = DEFAULT_SETTINGS.primaryPaneWidth;
      this.applyLayoutSettings(this.containerEl);
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    });
  }

  private renderRowResizer(parentEl: HTMLElement, label: string) {
    const resizerEl = parentEl.createDiv({
      cls: "vault-columns-resizer vault-columns-row-resizer",
    });
    resizerEl.setAttr("role", "separator");
    resizerEl.setAttr("aria-orientation", "horizontal");
    resizerEl.setAttr("aria-label", label);
    resizerEl.setAttr("title", label);
    resizerEl.addEventListener("pointerdown", (event) => {
      this.beginRowResize(event, parentEl, resizerEl);
    });
    resizerEl.addEventListener("dblclick", async () => {
      this.plugin.settings.notesPaneShare = DEFAULT_SETTINGS.notesPaneShare;
      this.applyLayoutSettings(this.containerEl);
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    });
  }

  private beginColumnResize(event: PointerEvent, boardEl: HTMLElement, resizerEl: HTMLElement) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    this.stopPaneResize();
    this.containerEl.addClass("is-resizing");
    resizerEl.addClass("is-active");
    document.body.style.cursor = "col-resize";

    const updateWidth = (clientX: number) => {
      const rect = boardEl.getBoundingClientRect();
      const handleSize = this.getResizeHandleSize();
      const maxByContainer = rect.width - MIN_SECONDARY_PANE_WIDTH - handleSize;
      const maxWidth = Math.min(MAX_PRIMARY_PANE_WIDTH, Math.max(MIN_PRIMARY_PANE_WIDTH, maxByContainer));
      const nextWidth = clampNumber(clientX - rect.left, MIN_PRIMARY_PANE_WIDTH, maxWidth);
      this.plugin.settings.primaryPaneWidth = Math.round(nextWidth);
      this.applyLayoutSettings(this.containerEl);
    };

    const cleanup = async (save: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      this.containerEl.removeClass("is-resizing");
      resizerEl.removeClass("is-active");
      document.body.style.cursor = "";
      this.paneResizeCleanup = null;

      if (save) {
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      }
    };

    const onMove = (e: PointerEvent) => {
      updateWidth(e.clientX);
    };
    const onUp = () => {
      void cleanup(true);
    };
    const onCancel = () => {
      void cleanup(false);
    };

    this.paneResizeCleanup = () => {
      void cleanup(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  private beginRowResize(event: PointerEvent, stackEl: HTMLElement, resizerEl: HTMLElement) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    this.stopPaneResize();
    this.containerEl.addClass("is-resizing");
    resizerEl.addClass("is-active");
    document.body.style.cursor = "row-resize";

    const updateShare = (clientY: number) => {
      const rect = stackEl.getBoundingClientRect();
      const handleSize = this.getResizeHandleSize();
      const availableHeight = Math.max(1, rect.height - handleSize);
      const notesPixels = rect.bottom - clientY - handleSize / 2;
      const minShare = Math.max(MIN_NOTES_PANE_SHARE, (MIN_NOTES_PANE_HEIGHT / availableHeight) * 100);
      const maxShare = Math.min(MAX_NOTES_PANE_SHARE, 100 - (MIN_BRANCH_PANE_HEIGHT / availableHeight) * 100);
      const nextShare = clampNumber((notesPixels / availableHeight) * 100, minShare, maxShare);
      this.plugin.settings.notesPaneShare = Math.round(nextShare);
      this.applyLayoutSettings(this.containerEl);
    };

    const cleanup = async (save: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      this.containerEl.removeClass("is-resizing");
      resizerEl.removeClass("is-active");
      document.body.style.cursor = "";
      this.paneResizeCleanup = null;

      if (save) {
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      }
    };

    const onMove = (e: PointerEvent) => {
      updateShare(e.clientY);
    };
    const onUp = () => {
      void cleanup(true);
    };
    const onCancel = () => {
      void cleanup(false);
    };

    this.paneResizeCleanup = () => {
      void cleanup(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  private stopPaneResize() {
    this.paneResizeCleanup?.();
    this.paneResizeCleanup = null;
  }

  private getResizeHandleSize() {
    const rawValue = getComputedStyle(this.containerEl).getPropertyValue("--vault-columns-resizer-size");
    const parsedValue = Number.parseFloat(rawValue);
    return Number.isFinite(parsedValue) ? parsedValue : 8;
  }

  private renderTopLevelFolders(parentEl: HTMLElement) {
    const scrollerEl = parentEl.createDiv({ cls: "vault-columns-scroller" });
    const treeEl = scrollerEl.createDiv({ cls: "nav-files-container" });
    const rootFolder = this.app.vault.getRoot();

    this.renderFolderNode(treeEl, rootFolder, 0, "primary");
    for (const folder of this.getChildFolders(rootFolder)) {
      this.renderFolderNode(treeEl, folder, 0, "primary");
    }
  }

  private renderBranchFolders(parentEl: HTMLElement) {
    const scrollerEl = parentEl.createDiv({ cls: "vault-columns-scroller" });
    const topFolderPath = this.getTopLevelPath(this.selectedFolderPath);

    if (!topFolderPath) {
      this.renderEmptyState(scrollerEl, "选择一个顶层文件夹后，这里显示它下面的子文件夹");
      return;
    }

    const topFolder = this.findFolderByPath(topFolderPath);
    if (!topFolder) {
      this.renderEmptyState(scrollerEl, "未找到文件夹");
      return;
    }

    const childFolders = this.getChildFolders(topFolder);
    if (childFolders.length === 0) {
      this.renderEmptyState(scrollerEl, "无子文件夹");
      return;
    }

    const treeEl = scrollerEl.createDiv({ cls: "nav-files-container" });
    for (const childFolder of childFolders) {
      this.renderFolderNode(treeEl, childFolder, 0, "branch");
    }
  }

  private renderFolderNode(
    parentEl: HTMLElement,
    folder: TFolder,
    depth: number,
    area: "primary" | "branch",
  ) {
    const folderPath = this.getFolderPath(folder);
    const isRoot = folder === this.app.vault.getRoot();
    const childFolders = this.getChildFolders(folder);
    const hasChildren = childFolders.length > 0;
    const isExpanded = this.expandedFolders.has(folderPath);
    const isCollapsible = area === "branch" && hasChildren;
    const isSelected =
      area === "primary"
        ? this.getTopLevelPath(this.selectedFolderPath) === folderPath ||
          (folderPath === "" && this.selectedFolderPath === "")
        : this.selectedFolderPath === folderPath;

    const folderEl = parentEl.createDiv({
      cls: `tree-item nav-folder${isCollapsible && !isExpanded ? " is-collapsed" : ""}`,
    });

    const titleEl = folderEl.createDiv({
      cls: `tree-item-self nav-folder-title is-clickable mod-collapsible${
        isSelected ? " is-active is-selected" : ""
      }`,
    });
    titleEl.setAttr("data-path", isRoot ? "/" : folder.path);
    titleEl.style.setProperty("--nav-item-parent-padding", `${depth * 17}px`);
    titleEl.style.paddingInlineStart = `${depth * 17 + 24}px`;

    const collapseEl = titleEl.createDiv({
      cls: `tree-item-icon collapse-icon nav-folder-collapse-indicator${
        isCollapsible ? "" : " is-hidden"
      }${isCollapsible && !isExpanded ? " is-collapsed" : ""}`,
    });
    if (isCollapsible) {
      setIcon(collapseEl, "right-triangle");
    }

    titleEl.createDiv({
      cls: "tree-item-inner nav-folder-title-content",
      text: this.getFolderLabel(folder),
    });

    const auxEl = titleEl.createDiv({
      cls: "tree-item-flair-outer nav-folder-flair",
    });
    auxEl.createSpan({
      cls: "tree-item-flair vault-columns-count",
      text: String(this.getDirectViewableFiles(folder).length),
    });

    titleEl.addEventListener("click", () => {
      this.selectFolder(folderPath, hasChildren, isExpanded, area);
    });

    titleEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.selectedFolderPath = folderPath;
      this.showFolderMenu(event, folder);
      this.render();
    });

    if (!isRoot) {
      this.attachDragSource(titleEl, folder);
    }

    if (isCollapsible && isExpanded) {
      const childrenEl = folderEl.createDiv({
        cls: "tree-item-children nav-folder-children",
      });
      for (const childFolder of childFolders) {
        this.renderFolderNode(childrenEl, childFolder, depth + 1, area);
      }
    }
  }

  private selectFolder(
    folderPath: string,
    hasChildren: boolean,
    isExpanded: boolean,
    area: "primary" | "branch",
  ) {
    this.selectedFolderPath = folderPath;

    if (area === "primary") {
      this.expandedFolders.clear();
    } else if (hasChildren) {
      if (isExpanded) {
        this.expandedFolders.delete(folderPath);
      } else {
        this.expandedFolders.add(folderPath);
      }
    }

    this.render();
  }

  private renderFolderNotes(parentEl: HTMLElement) {
    const scrollerEl = parentEl.createDiv({ cls: "vault-columns-note-scroller" });
    const folder = this.findFolderByPath(this.selectedFolderPath);

    if (!folder) {
      this.renderEmptyState(scrollerEl, "请选择文件夹");
      return;
    }

    const notes = this.getDirectViewableFiles(folder);
    if (notes.length === 0) {
      this.renderEmptyState(scrollerEl, "无直属笔记");
      return;
    }

    const treeEl = scrollerEl.createDiv({ cls: "nav-files-container" });
    this.renderNoteRows(treeEl, notes, false);
  }

  private renderTagList(parentEl: HTMLElement) {
    const scrollerEl = parentEl.createDiv({ cls: "vault-columns-scroller" });
    const tagCounts = this.getTagCounts();
    const tags = Array.from(tagCounts.keys()).sort((a, b) => a.localeCompare(b));

    if (tags.length === 0) {
      this.renderEmptyState(scrollerEl, "没有可用标签");
      return;
    }

    const treeEl = scrollerEl.createDiv({ cls: "nav-files-container" });
    for (const tag of tags) {
      const isSelected = this.selectedTag === tag;
      const itemEl = treeEl.createDiv({ cls: "tree-item" });
      const titleEl = itemEl.createDiv({
        cls: `tree-item-self is-clickable vault-columns-tag-item${
          isSelected ? " is-active is-selected" : ""
        }`,
      });
      titleEl.setAttr("data-tag", tag);

      const iconEl = titleEl.createDiv({ cls: "tree-item-icon" });
      setIcon(iconEl, "tag");

      titleEl.createDiv({
        cls: "tree-item-inner",
        text: tag,
      });

      if (this.plugin.settings.showTagNoteCounts) {
        const auxEl = titleEl.createDiv({ cls: "tree-item-flair-outer" });
        auxEl.createSpan({
          cls: "tree-item-flair vault-columns-count",
          text: String(tagCounts.get(tag) ?? 0),
        });
      }

      titleEl.addEventListener("click", () => {
        this.selectedTag = tag;
        this.render();
      });
    }
  }

  private renderTagNotes(parentEl: HTMLElement) {
    const scrollerEl = parentEl.createDiv({ cls: "vault-columns-note-scroller" });

    if (!this.selectedTag) {
      this.renderEmptyState(scrollerEl, "请选择标签");
      return;
    }

    const notes = this.getFilesForTag(this.selectedTag);
    if (notes.length === 0) {
      this.renderEmptyState(scrollerEl, "无匹配笔记");
      return;
    }

    const treeEl = scrollerEl.createDiv({ cls: "nav-files-container" });
    this.renderNoteRows(treeEl, notes, this.plugin.settings.showTagResultPaths);
  }

  private renderNoteRows(parentEl: HTMLElement, files: TFile[], showPath: boolean) {
    const activePath = this.activeFilePath ?? this.app.workspace.getActiveFile()?.path ?? null;

    for (const file of files) {
      const itemEl = parentEl.createDiv({ cls: "tree-item nav-file" });
      const titleEl = itemEl.createDiv({
        cls: `tree-item-self nav-file-title is-clickable${
          activePath === file.path ? " is-active is-selected" : ""
        }`,
      });
      titleEl.setAttr("data-path", file.path);

      titleEl.createDiv({
        cls: "tree-item-inner nav-file-title-content",
        text: file.basename,
      });

      if (file.extension && file.extension.toLowerCase() !== "md") {
        titleEl.createDiv({
          cls: "nav-file-tag",
          text: file.extension,
        });
      }

      if (showPath) {
        const pathEl = itemEl.createDiv({ cls: "vault-columns-note-path" });
        pathEl.setText(this.getParentPath(file));
      }

      titleEl.addEventListener("click", () => {
        this.activeFilePath = file.path;
        this.render();
        this.openFile(file);
      });

      titleEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.activeFilePath = file.path;
        this.showFileMenu(event, file);
        this.render();
      });

      this.attachDragSource(titleEl, file);
    }
  }

  private renderEmptyState(parentEl: HTMLElement, text: string) {
    const emptyEl = parentEl.createDiv({ cls: "vault-columns-empty-state" });
    emptyEl.createDiv({ cls: "vault-columns-empty-message", text });
  }

  // Pointer-based drag. HTML5 drag (and even app.dragManager) is intercepted
  // by Obsidian in side panels and never produces a ghost, so we roll our own.
  // Drop targets are discovered live via document.elementFromPoint, so we do
  // not need to attach any per-row drop listeners.
  private attachDragSource(el: HTMLElement, source: TAbstractFile) {
    if (source === this.app.vault.getRoot()) return;
    el.addEventListener("pointerdown", (event) => {
      this.beginPointerDrag(event, source);
    });
  }

  private beginPointerDrag(event: PointerEvent, source: TAbstractFile) {
    if (event.button !== 0) return;
    const targetEl = event.target as HTMLElement | null;
    // Don't start a drag from the collapse chevron — let it toggle.
    if (targetEl?.closest(".collapse-icon")) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let ghostEl: HTMLElement | null = null;
    let dropEl: HTMLElement | null = null;
    let dropFolder: TFolder | null = null;

    const setDrop = (el: HTMLElement | null, folder: TFolder | null) => {
      if (el === dropEl) {
        dropFolder = folder;
        return;
      }
      dropEl?.removeClass("vault-columns-drop-target");
      el?.addClass("vault-columns-drop-target");
      dropEl = el;
      dropFolder = folder;
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.style.cursor = "";
      ghostEl?.remove();
      ghostEl = null;
      dropEl?.removeClass("vault-columns-drop-target");
      dropEl = null;
    };

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < 5) return;
        started = true;
        ghostEl = this.createDragGhost(source);
        document.body.appendChild(ghostEl);
        document.body.style.cursor = "grabbing";
      }

      if (ghostEl) {
        ghostEl.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      }

      const overEl = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!overEl || !overEl.closest(".vault-columns-view")) {
        setDrop(null, null);
        return;
      }

      const folderTitleEl = overEl.closest<HTMLElement>(".nav-folder-title");
      if (folderTitleEl) {
        const path = folderTitleEl.getAttribute("data-path") ?? "";
        const folder = this.resolveFolder(path);
        if (folder && this.isValidDropTarget(source, folder)) {
          setDrop(folderTitleEl, folder);
          return;
        }
        setDrop(null, null);
        return;
      }

      const notesScrollerEl = overEl.closest<HTMLElement>(".vault-columns-note-scroller");
      if (notesScrollerEl) {
        const folder = this.findFolderByPath(this.selectedFolderPath);
        if (folder && this.isValidDropTarget(source, folder)) {
          setDrop(notesScrollerEl, folder);
          return;
        }
      }

      setDrop(null, null);
    };

    const onUp = () => {
      const wasStarted = started;
      const folder = dropFolder;
      cleanup();
      if (wasStarted && folder) {
        void this.moveInto(source.path, folder);
      }
    };

    const onCancel = () => cleanup();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  private createDragGhost(source: TAbstractFile): HTMLElement {
    const ghostEl = document.createElement("div");
    ghostEl.addClass("vault-columns-drag-ghost");
    const iconEl = ghostEl.createSpan({ cls: "vault-columns-drag-ghost-icon" });
    setIcon(iconEl, source instanceof TFolder ? "folder" : "file-text");
    ghostEl.createSpan({
      cls: "vault-columns-drag-ghost-label",
      text: source.name,
    });
    return ghostEl;
  }

  private resolveFolder(dataPath: string): TFolder | null {
    if (!dataPath || dataPath === "/") return this.app.vault.getRoot();
    const f = this.app.vault.getAbstractFileByPath(dataPath);
    return f instanceof TFolder ? f : null;
  }

  private isValidDropTarget(source: TAbstractFile, target: TFolder): boolean {
    if (source === target) return false;
    if (source.parent === target) return false;
    if (source instanceof TFolder) {
      const sp = source.path;
      const tp = this.getFolderPath(target);
      if (tp === sp || tp.startsWith(`${sp}/`)) return false;
    }
    return true;
  }

  private async moveInto(sourcePath: string, target: TFolder) {
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!source) return;
    if (source === target) return;
    if (source.parent === target) return;

    if (source instanceof TFolder) {
      const targetPath = this.getFolderPath(target);
      const sourceFolderPath = source.path;
      if (targetPath === sourceFolderPath || targetPath.startsWith(`${sourceFolderPath}/`)) {
        new Notice("Cannot move a folder into itself.");
        return;
      }
    }

    const targetBase = this.getFolderPath(target);
    const newPath = normalizePath(targetBase ? `${targetBase}/${source.name}` : source.name);

    if (await this.app.vault.adapter.exists(newPath)) {
      new Notice(`"${source.name}" already exists in the target folder.`);
      return;
    }

    try {
      await this.app.fileManager.renameFile(source, newPath);
      this.plugin.refreshViewsDebounced();
    } catch (err) {
      console.error("Vault Columns: move failed", err);
      new Notice(`Move failed: ${(err as Error).message ?? err}`);
    }
  }

  private showFileMenu(event: MouseEvent, file: TFile) {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("Open")
        .setIcon("file-text")
        .onClick(() => this.openFile(file)),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open in new tab")
        .setIcon("panel-top-open")
        .onClick(() => this.openFileInNewTab(file)),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open to the right")
        .setIcon("separator-vertical")
        .onClick(() => this.openFileToRight(file)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(() => this.renameAbstractFile(file)),
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy path")
        .setIcon("copy")
        .onClick(() => this.copyPath(file.path)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .setWarning(true)
        .onClick(() => this.trashAbstractFile(file)),
    );

    this.app.workspace.trigger("file-menu", menu, file, FILE_MENU_SOURCE, this.leaf);
    menu.showAtMouseEvent(event);
  }

  private showFolderMenu(event: MouseEvent, folder: TFolder) {
    const isRoot = folder === this.app.vault.getRoot();
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("New note")
        .setIcon("file-plus")
        .onClick(() => this.createNoteInFolder(folder)),
    );
    menu.addItem((item) =>
      item
        .setTitle("New folder")
        .setIcon("folder-plus")
        .onClick(() => this.createFolderInFolder(folder)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Rename")
        .setIcon("pencil")
        .setDisabled(isRoot)
        .onClick(() => this.renameAbstractFile(folder)),
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy path")
        .setIcon("copy")
        .onClick(() => this.copyPath(this.getFolderPath(folder) || "/")),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .setWarning(true)
        .setDisabled(isRoot)
        .onClick(() => this.trashAbstractFile(folder)),
    );

    this.app.workspace.trigger("file-menu", menu, folder, FILE_MENU_SOURCE, this.leaf);
    menu.showAtMouseEvent(event);
  }

  private collapseToTop() {
    if (this.mode === "tags") {
      this.selectedTag = null;
      this.render();
      return;
    }

    const topLevelPath = this.getTopLevelPath(this.selectedFolderPath);
    this.selectedFolderPath = topLevelPath;
    this.expandedFolders.clear();
    this.render();
  }

  private getNotesPaneTitle() {
    const folder = this.findFolderByPath(this.selectedFolderPath);
    if (!folder) {
      return "笔记";
    }

    return this.getFolderLabel(folder);
  }

  private async openFile(file: TFile) {
    this.activeFilePath = file.path;
    const activeLeaf = this.app.workspace.activeLeaf;
    const markdownLeaf =
      activeLeaf?.view.getViewType() === "markdown"
        ? activeLeaf
        : this.app.workspace.getLeavesOfType("markdown")[0];
    const leaf = markdownLeaf ?? this.app.workspace.getLeaf("tab");

    await leaf.openFile(file);
  }

  private async openFileInNewTab(file: TFile) {
    this.activeFilePath = file.path;
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private async openFileToRight(file: TFile) {
    this.activeFilePath = file.path;
    await this.app.workspace.getLeaf("split", "vertical").openFile(file);
  }

  private async createNoteInFolder(folder: TFolder) {
    const rawName = window.prompt("New note name", "Untitled");
    const name = rawName?.trim();
    if (!name) {
      return;
    }

    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    const path = await this.getAvailablePath(folder, fileName);
    const file = await this.app.vault.create(path, "");
    await this.openFile(file);
    this.plugin.refreshViewsDebounced();
  }

  private async createFolderInFolder(folder: TFolder) {
    const rawName = window.prompt("New folder name", "Untitled");
    const name = rawName?.trim();
    if (!name) {
      return;
    }

    const path = await this.getAvailablePath(folder, name);
    const createdFolder = await this.app.vault.createFolder(path);
    this.selectedFolderPath = this.getFolderPath(createdFolder);
    this.plugin.refreshViewsDebounced();
  }

  private async renameAbstractFile(file: TAbstractFile) {
    const rawName = window.prompt("Rename", file.name);
    const name = rawName?.trim();
    if (!name || name === file.name) {
      return;
    }

    const parentPath = file.parent ? this.getFolderPath(file.parent) : "";
    const newPath = normalizePath(parentPath ? `${parentPath}/${name}` : name);
    await this.app.fileManager.renameFile(file, newPath);
    this.plugin.refreshViewsDebounced();
  }

  private async trashAbstractFile(file: TAbstractFile) {
    if (!window.confirm(`Move "${file.name}" to trash?`)) {
      return;
    }

    await this.app.vault.trash(file, true);
    this.plugin.refreshViewsDebounced();
  }

  private async copyPath(path: string) {
    await navigator.clipboard.writeText(path);
    new Notice("Path copied.");
  }

  private async getAvailablePath(folder: TFolder, name: string) {
    const basePath = this.getFolderPath(folder);
    const normalizedBase = normalizePath(basePath ? `${basePath}/${name}` : name);

    if (!(await this.app.vault.adapter.exists(normalizedBase))) {
      return normalizedBase;
    }

    const dotIndex = name.lastIndexOf(".");
    const hasExtension = dotIndex > 0;
    const stem = hasExtension ? name.slice(0, dotIndex) : name;
    const extension = hasExtension ? name.slice(dotIndex) : "";

    let index = 1;
    while (true) {
      const candidateName = `${stem} ${index}${extension}`;
      const candidatePath = normalizePath(basePath ? `${basePath}/${candidateName}` : candidateName);
      if (!(await this.app.vault.adapter.exists(candidatePath))) {
        return candidatePath;
      }
      index += 1;
    }
  }

  private getChildFolders(folder: TFolder) {
    return folder.children
      .filter((child): child is TFolder => child instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private static readonly VIEWABLE_EXTENSIONS = new Set(["md", "pdf"]);

  private getDirectViewableFiles(folder: TFolder) {
    return folder.children
      .filter(
        (child): child is TFile =>
          child instanceof TFile && VaultColumnsView.VIEWABLE_EXTENSIONS.has(child.extension),
      )
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  private getTagCounts() {
    const counts = new Map<string, number>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      for (const tag of this.getFileTags(file)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return counts;
  }

  private getFilesForTag(tag: string) {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.getFileTags(file).has(tag))
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  private getFileTags(file: TFile) {
    const cache = this.app.metadataCache.getFileCache(file);
    return new Set(cache ? getAllTags(cache) ?? [] : []);
  }

  private findFolderByPath(folderPath: string): TFolder | null {
    if (!folderPath) return this.app.vault.getRoot();
    const f = this.app.vault.getAbstractFileByPath(folderPath);
    return f instanceof TFolder ? f : null;
  }

  private getTopLevelPath(folderPath: string) {
    if (!folderPath) {
      return "";
    }

    return folderPath.split("/")[0];
  }

  private getFolderPath(folder: TFolder) {
    if (folder === this.app.vault.getRoot() || folder.path === "/") {
      return "";
    }

    return folder.path;
  }

  private getFolderLabel(folder: TFolder) {
    if (folder === this.app.vault.getRoot()) {
      return this.app.vault.getName() || "Vault";
    }

    return folder.name;
  }

  private getParentPath(file: TFile) {
    const parent = file.parent;
    if (!parent || parent === this.app.vault.getRoot() || parent.path === "/") {
      return "/";
    }

    return parent.path;
  }
}

class VaultColumnsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: VaultColumnsPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Columns" });

    new Setting(containerEl)
      .setName("Default mode")
      .setDesc("Choose which mode opens by default.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("folders", "Folders")
          .addOption("tags", "Tags")
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (value: NavigatorMode) => {
            this.plugin.settings.defaultMode = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Show paths in tag results")
      .setDesc("Display each note's parent folder under the note name in tag mode.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showTagResultPaths)
          .onChange(async (value) => {
            this.plugin.settings.showTagResultPaths = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Show tag note counts")
      .setDesc("Display the number of notes for each tag.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showTagNoteCounts)
          .onChange(async (value) => {
            this.plugin.settings.showTagNoteCounts = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    containerEl.createEl("h3", { text: "Layout" });

    this.addNumberSetting(
      containerEl,
      "View font size",
      "Font size for the whole Vault Columns page, in pixels. Type a number or use the slider.",
      "rowFontSize",
      MIN_ROW_FONT_SIZE,
      MAX_ROW_FONT_SIZE,
      1,
      "px",
    );

    this.addNumberSetting(
      containerEl,
      "Primary pane width",
      "Width of the left folder/tag pane, in pixels. Type a number or use the slider.",
      "primaryPaneWidth",
      MIN_PRIMARY_PANE_WIDTH,
      MAX_PRIMARY_PANE_WIDTH,
      10,
      "px",
    );

    this.addNumberSetting(
      containerEl,
      "Notes pane height",
      "Height share used by the notes pane in folder mode. Type a percentage or use the slider.",
      "notesPaneShare",
      MIN_NOTES_PANE_SHARE,
      MAX_NOTES_PANE_SHARE,
      1,
      "%",
    );
  }

  private addNumberSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: "rowFontSize" | "primaryPaneWidth" | "notesPaneShare",
    min: number,
    max: number,
    step: number,
    unit: string,
  ) {
    let sliderComponent: SliderComponent | null = null;
    let textComponent: TextComponent | null = null;

    const getValue = () => this.plugin.settings[key];
    const setValue = async (rawValue: number) => {
      const nextValue = Math.round(clampNumber(rawValue, min, max));
      this.plugin.settings[key] = nextValue;
      sliderComponent?.setValue(nextValue);
      textComponent?.setValue(String(nextValue));
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    };
    const commitTextValue = async () => {
      if (!textComponent) return;
      const parsedValue = Number.parseFloat(textComponent.getValue());
      if (Number.isFinite(parsedValue)) {
        await setValue(parsedValue);
      } else {
        textComponent.setValue(String(getValue()));
      }
    };

    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addSlider((slider) => {
        sliderComponent = slider;
        slider
          .setLimits(min, max, step)
          .setValue(getValue())
          .setDynamicTooltip()
          .onChange(async (value) => {
            await setValue(value);
          });
      })
      .addText((text) => {
        textComponent = text;
        text
          .setValue(String(getValue()))
          .setPlaceholder(`${DEFAULT_SETTINGS[key]}${unit}`)
          .onChange((value) => {
            const trimmedValue = value.trim();
            if (trimmedValue === "") return;
            const parsedValue = Number.parseFloat(trimmedValue);
            if (Number.isFinite(parsedValue)) {
              sliderComponent?.setValue(Math.round(clampNumber(parsedValue, min, max)));
            }
          });
        text.inputEl.type = "number";
        text.inputEl.min = String(min);
        text.inputEl.max = String(max);
        text.inputEl.step = String(step);
        text.inputEl.addClass("vault-columns-layout-input");
        text.inputEl.style.width = LAYOUT_INPUT_WIDTH;
        text.inputEl.addEventListener("blur", () => {
          void commitTextValue();
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commitTextValue();
          }
        });
        text.inputEl.setAttr("aria-label", `${name} (${unit})`);
      })
      .addExtraButton((button) => {
        button
          .setIcon("rotate-ccw")
          .setTooltip(`Reset to ${DEFAULT_SETTINGS[key]}${unit}`)
          .onClick(() => {
            void setValue(DEFAULT_SETTINGS[key]);
          });
      });
  }
}
