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
  WorkspaceLeaf,
  getAllTags,
  normalizePath,
  setIcon,
} from "obsidian";

const VIEW_TYPE_VAULT_COLUMNS = "vault-columns-view";
const FILE_MENU_SOURCE = "file-explorer";

type NavigatorMode = "folders" | "tags";

interface VaultColumnsSettings {
  defaultMode: NavigatorMode;
  showTagResultPaths: boolean;
  showTagNoteCounts: boolean;
}

const DEFAULT_SETTINGS: VaultColumnsSettings = {
  defaultMode: "folders",
  showTagResultPaths: true,
  showTagNoteCounts: true,
};

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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

  setActiveFile(file: TFile | null) {
    this.activeFilePath = file?.path ?? null;
    this.render();
  }

  render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("vault-columns-view");

    const shellEl = containerEl.createDiv({ cls: "vault-columns-shell" });

    this.renderToolbar(shellEl);

    if (this.mode === "folders") {
      this.renderFolderMode(shellEl);
    } else {
      this.renderTagMode(shellEl);
    }
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
    const rightStackEl = boardEl.createDiv({ cls: "vault-columns-right-stack" });
    const branchPaneEl = rightStackEl.createDiv({
      cls: "vault-columns-pane vault-columns-branch-pane",
    });
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

  private renderTopLevelFolders(parentEl: HTMLElement) {
    const listEl = parentEl.createDiv({ cls: "vault-columns-scroller" });
    const rootFolder = this.app.vault.getRoot();
    this.renderFolderRow(listEl, rootFolder, 0, true, "primary");

    for (const folder of this.getChildFolders(rootFolder)) {
      this.renderFolderRow(listEl, folder, 0, true, "primary");
    }
  }

  private renderBranchFolders(parentEl: HTMLElement) {
    const listEl = parentEl.createDiv({ cls: "vault-columns-scroller" });
    const topFolderPath = this.getTopLevelPath(this.selectedFolderPath);

    if (!topFolderPath) {
      this.renderEmptyState(listEl, "选择一个顶层文件夹后，这里显示它下面的子文件夹");
      return;
    }

    const topFolder = this.findFolderByPath(topFolderPath);
    if (!topFolder) {
      this.renderEmptyState(listEl, "未找到文件夹");
      return;
    }

    const childFolders = this.getChildFolders(topFolder);
    if (childFolders.length === 0) {
      this.renderEmptyState(listEl, "无子文件夹");
      return;
    }

    for (const childFolder of childFolders) {
      this.renderFolderRow(listEl, childFolder, 0, true, "branch");
      if (this.expandedFolders.has(childFolder.path)) {
        this.renderBranchChildren(listEl, childFolder, 1);
      }
    }
  }

  private renderBranchChildren(parentEl: HTMLElement, folder: TFolder, depth: number) {
    for (const childFolder of this.getChildFolders(folder)) {
      this.renderFolderRow(parentEl, childFolder, depth, true, "branch");
      if (this.expandedFolders.has(childFolder.path)) {
        this.renderBranchChildren(parentEl, childFolder, depth + 1);
      }
    }
  }

  private renderFolderRow(
    parentEl: HTMLElement,
    folder: TFolder,
    depth: number,
    showCount: boolean,
    area: "primary" | "branch",
  ) {
    const folderPath = this.getFolderPath(folder);
    const childFolders = this.getChildFolders(folder);
    const hasChildren = childFolders.length > 0;
    const isSelected =
      area === "primary"
        ? this.getTopLevelPath(this.selectedFolderPath) === folderPath ||
          (folderPath === "" && this.selectedFolderPath === "")
        : this.selectedFolderPath === folderPath;
    const isExpanded = this.expandedFolders.has(folderPath);

    const rowEl = parentEl.createDiv({
      cls: `vault-columns-row vault-columns-folder-row ${isSelected ? "is-selected" : ""}`,
    });
    rowEl.style.setProperty("--level", String(depth));
    rowEl.setAttr("data-path", folderPath || "/");

    const contentEl = rowEl.createDiv({ cls: "vault-columns-row-content" });
    const chevronEl = contentEl.createSpan({
      cls: `vault-columns-chevron ${hasChildren && area === "branch" ? "" : "is-hidden"}`,
    });
    if (hasChildren && area === "branch") {
      setIcon(chevronEl, isExpanded ? "chevron-down" : "chevron-right");
    }

    const iconEl = contentEl.createSpan({ cls: "vault-columns-row-icon" });
    setIcon(iconEl, isSelected ? "folder-open" : "folder");

    const nameEl = contentEl.createSpan({
      cls: "vault-columns-row-name",
      text: this.getFolderLabel(folder),
    });
    nameEl.setAttr("title", folderPath || this.getFolderLabel(folder));

    contentEl.createSpan({ cls: "vault-columns-row-spacer" });

    if (showCount) {
      contentEl.createSpan({
        cls: "vault-columns-row-count",
        text: String(this.getDirectMarkdownFiles(folder).length),
      });
    }

    rowEl.addEventListener("click", () => {
      this.selectFolder(folderPath, hasChildren, isExpanded, area);
    });

    rowEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.selectedFolderPath = folderPath;
      this.showFolderMenu(event, folder);
      this.render();
    });
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
    const listEl = parentEl.createDiv({ cls: "vault-columns-note-scroller" });
    const folder = this.findFolderByPath(this.selectedFolderPath);

    if (!folder) {
      this.renderEmptyState(listEl, "请选择文件夹");
      return;
    }

    const notes = this.getDirectMarkdownFiles(folder);
    if (notes.length === 0) {
      this.renderEmptyState(listEl, "无直属笔记");
      return;
    }

    this.renderNoteRows(listEl, notes, false);
  }

  private renderTagList(parentEl: HTMLElement) {
    const listEl = parentEl.createDiv({ cls: "vault-columns-scroller" });
    const tagCounts = this.getTagCounts();
    const tags = Array.from(tagCounts.keys()).sort((a, b) => a.localeCompare(b));

    if (tags.length === 0) {
      this.renderEmptyState(listEl, "没有可用标签");
      return;
    }

    for (const tag of tags) {
      const isSelected = this.selectedTag === tag;
      const rowEl = listEl.createDiv({
        cls: `vault-columns-row vault-columns-tag-row ${isSelected ? "is-selected" : ""}`,
      });
      rowEl.style.setProperty("--level", "0");
      rowEl.setAttr("data-path", tag);

      const contentEl = rowEl.createDiv({ cls: "vault-columns-row-content" });
      contentEl.createSpan({ cls: "vault-columns-chevron is-hidden" });
      const iconEl = contentEl.createSpan({ cls: "vault-columns-row-icon" });
      setIcon(iconEl, "tag");

      const nameEl = contentEl.createSpan({
        cls: "vault-columns-row-name",
        text: tag,
      });
      nameEl.setAttr("title", tag);

      contentEl.createSpan({ cls: "vault-columns-row-spacer" });

      if (this.plugin.settings.showTagNoteCounts) {
        contentEl.createSpan({
          cls: "vault-columns-row-count",
          text: String(tagCounts.get(tag) ?? 0),
        });
      }

      rowEl.addEventListener("click", () => {
        this.selectedTag = tag;
        this.render();
      });
    }
  }

  private renderTagNotes(parentEl: HTMLElement) {
    const listEl = parentEl.createDiv({ cls: "vault-columns-note-scroller" });

    if (!this.selectedTag) {
      this.renderEmptyState(listEl, "请选择标签");
      return;
    }

    const notes = this.getFilesForTag(this.selectedTag);
    if (notes.length === 0) {
      this.renderEmptyState(listEl, "无匹配笔记");
      return;
    }

    this.renderNoteRows(listEl, notes, this.plugin.settings.showTagResultPaths);
  }

  private renderNoteRows(parentEl: HTMLElement, files: TFile[], showPath: boolean) {
    const activePath = this.activeFilePath ?? this.app.workspace.getActiveFile()?.path ?? null;

    for (const file of files) {
      const rowEl = parentEl.createDiv({
        cls: `vault-columns-note-row ${activePath === file.path ? "is-selected" : ""}`,
      });
      rowEl.setAttr("data-path", file.path);

      const iconEl = rowEl.createSpan({ cls: "vault-columns-note-icon" });
      setIcon(iconEl, "file-text");

      const textEl = rowEl.createDiv({ cls: "vault-columns-note-text" });
      const titleEl = textEl.createDiv({
        cls: "vault-columns-note-title",
        text: file.basename,
      });
      titleEl.setAttr("title", file.path);

      if (showPath) {
        textEl.createDiv({
          cls: "vault-columns-note-path",
          text: this.getParentPath(file),
        });
      }

      rowEl.addEventListener("click", () => {
        this.activeFilePath = file.path;
        this.render();
        this.openFile(file);
      });

      rowEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.activeFilePath = file.path;
        this.showFileMenu(event, file);
        this.render();
      });
    }
  }

  private renderEmptyState(parentEl: HTMLElement, text: string) {
    const emptyEl = parentEl.createDiv({ cls: "vault-columns-empty-state" });
    emptyEl.createDiv({ cls: "vault-columns-empty-message", text });
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

  private getDirectMarkdownFiles(folder: TFolder) {
    return folder.children
      .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
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

  private findFolderByPath(folderPath: string) {
    let match: TFolder | null = null;

    const visit = (folder: TFolder) => {
      if (this.getFolderPath(folder) === folderPath) {
        match = folder;
        return;
      }

      for (const child of folder.children) {
        if (child instanceof TFolder) {
          visit(child);
        }
      }
    };

    visit(this.app.vault.getRoot());
    return match;
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
  }
}
