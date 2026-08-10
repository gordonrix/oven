/* Single place that reads oveCart.* settings, so defaults live in one file. */
'use strict';

const os = require('os');
const path = require('path');

const SECTION = 'oveCart';

/*
 * `vscode` is required lazily rather than at module load. Everything in this
 * tree ends up transitively importing this file, and a top-level require would
 * make all of it unloadable under `node --test`, where the vscode module does
 * not exist. Nothing here touches the API until a getter is actually called.
 */
function vs() {
  return require('vscode');
}

function cfg() {
  return vs().workspace.getConfiguration(SECTION);
}

/**
 * The fork renamed the settings section, so honour the pre-fork key once for
 * anyone upgrading from sanekun.openvectoreditor.
 */
function viewType() {
  const own = cfg().get('viewType');
  if (own) return own;
  const legacy = vs().workspace.getConfiguration('openvectoreditor').get('viewType');
  return legacy || 'sequence';
}

/** Expand ~ and ${workspaceFolder} in a user-supplied path setting. */
function resolvePath(raw) {
  let p = String(raw || '').trim();
  if (!p) return '';

  if (p.includes('${workspaceFolder}')) {
    const folders = vs().workspace.workspaceFolders;
    const folder = folders && folders[0];
    p = p.replace(/\$\{workspaceFolder\}/g, folder ? folder.uri.fsPath : '');
  }
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));

  return p;
}

module.exports = {
  viewType,
  readOnly: () => cfg().get('readOnly', false),
  allowSequenceEditing: () => cfg().get('allowSequenceEditing', false),
  autoAddCreatedPrimers: () => cfg().get('autoAddCreatedPrimers', true),
  showSelectionStatsByDefault: () => cfg().get('showSelectionStatsByDefault', true),
  useDesignTmCalculation: () => cfg().get('useDesignTmCalculation', true),
  maxItems: () => {
    const n = Number(cfg().get('maxItems', 500));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  },
  inventoryPath: () => resolvePath(cfg().get('inventoryPath', '')),
  inventorySheet: () => String(cfg().get('inventorySheet', '') || '').trim(),
  inventoryNameColumn: () => String(cfg().get('inventoryNameColumn', '') || '').trim(),
  inventorySequenceColumn: () => String(cfg().get('inventorySequenceColumn', '') || '').trim(),
  inventoryAliasColumn: () => String(cfg().get('inventoryAliasColumn', '') || '').trim(),
  inventoryDescriptionColumn: () => String(cfg().get('inventoryDescriptionColumn', '') || '').trim(),
  searchMinAnneal: () => {
    const n = Number(cfg().get('searchMinAnneal', 15));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
  },
  searchFullLengthOnly: () => cfg().get('searchFullLengthOnly', false),
  searchMaxHits: () => {
    const n = Number(cfg().get('searchMaxHits', 500));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  },
  sequenceCopyIncludesName: () => cfg().get('sequenceCopyIncludesName', 'sequence') === 'name-tab-sequence',
  SECTION
};
