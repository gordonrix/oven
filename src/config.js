/* Single place that reads oveCart.* settings, so defaults live in one file. */
'use strict';

const os = require('os');
const path = require('path');
const vscode = require('vscode');

const SECTION = 'oveCart';

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

/**
 * The fork renamed the settings section, so honour the pre-fork key once for
 * anyone upgrading from sanekun.openvectoreditor.
 */
function viewType() {
  const own = cfg().get('viewType');
  if (own) return own;
  const legacy = vscode.workspace.getConfiguration('openvectoreditor').get('viewType');
  return legacy || 'sequence';
}

/** Expand ~ and ${workspaceFolder} in a user-supplied path setting. */
function resolvePath(raw) {
  let p = String(raw || '').trim();
  if (!p) return '';

  if (p.includes('${workspaceFolder}')) {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
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
  maxItems: () => {
    const n = Number(cfg().get('maxItems', 500));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  },
  inventoryPath: () => resolvePath(cfg().get('inventoryPath', '')),
  inventorySheet: () => String(cfg().get('inventorySheet', '') || '').trim(),
  inventoryNameColumn: () => String(cfg().get('inventoryNameColumn', '') || '').trim(),
  inventorySequenceColumn: () => String(cfg().get('inventorySequenceColumn', '') || '').trim(),
  sequenceCopyIncludesName: () => cfg().get('sequenceCopyIncludesName', 'sequence') === 'name-tab-sequence',
  SECTION
};
