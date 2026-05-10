# Vault Columns

Vault Columns is a desktop-only Obsidian plugin that turns folder and tag navigation into a column-based workspace.

It is designed for large vaults where the default file explorer becomes hard to scan after opening a few top-level folders.

## Layout

Folder mode:

- Left pane: top-level folders.
- Right upper pane: subfolders for the selected top-level folder.
- Right lower pane: direct Markdown notes and PDFs in the selected folder.

Tag mode:

- Left pane: tags.
- Right pane: notes matching the selected tag.

## Features

- Keep top-level folders visible while browsing subfolders.
- Show only direct Markdown notes and PDFs for the selected folder.
- Do not recursively include files from subfolders.
- Keep empty folders visible.
- Browse notes by a single tag without jumping to Obsidian search.
- Open notes and PDFs in the main editor.
- Right-click files for common file actions.
- Right-click folders to create notes/folders, rename, delete, or copy paths.
- Let other plugins extend the context menu through Obsidian's `file-menu` hook.
- Follow Obsidian theme variables for colors, typography, and selection states.

## Current Scope

- Desktop only.
- Folder mode shows direct Markdown notes and PDFs only.
- Tag mode shows Markdown notes only, based on Obsidian's metadata cache.
- Tags are single-select.

## Usage

After enabling the plugin, open `Vault Columns` from the ribbon icon or command palette.

The collapse button in the toolbar returns folder mode to the selected top-level folder. In tag mode, it clears the selected tag.

## Development

```bash
npm install
npm run build
```

For local testing, copy or symlink this folder into:

```text
<your-vault>/.obsidian/plugins/vault-columns
```

Then enable `Vault Columns` from Obsidian's community plugin settings.

## Release Files

Obsidian needs these files from the project root:

- `manifest.json`
- `main.js`
- `styles.css`
