const vscode = require('vscode');
const path = require('path');
const { genbankToJson, fastaToJson, snapgeneToJson, jsonToSnapgene, jsonToGenbank, jsonToFasta } = require('./media/bioparser2.umd.js');

function activate(context) {
  console.log('openvectoreditor: now activated!');

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'openvectoreditor.editor',
      new DNAViewerProvider(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openvectoreditor.show', () => {
      const panel = vscode.window.createWebviewPanel(
        'openvectoreditor',
        'Open Vector Editor',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.file(path.join(context.extensionPath, 'media'))
          ]
        }
      );
      panel.webview.html = getTestHtml(context, panel.webview);
    })
  )
  console.log("openvectoreditor: comamnd registered");
}

function viewType(viewTypeConfig) {
  if (viewTypeConfig === 'split') {
    return `
          panelsShown: [
            [
              {
                id: "circular",
                name: "Circular Map",
                active: true,
              }
            ],
            [
              {
                id: "sequence",
                name: "Sequence Map",
                active: true,
              },
              {
                id: "properties",
                name: "Properties",
                active: false,
              },
            ]
          ]`;
  }

  return `
        panelsShown: [
          [
            {
              id: "sequence",
              name: "Sequence Map",
              active: ${viewTypeConfig === 'sequence'},
            },
            {
              id: "circular",
              name: "Circular Map",
              active: ${viewTypeConfig === 'circular'},
            },
            {
              id: "properties",
              name: "Properties",
              active: false,
            },
          ],
        ]`;
}

function getTestHtml(context, webview) {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'media', 'ove.css'))
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'media', 'index.umd.js'))
  );
  const defaultViewType = viewType(vscode.workspace.getConfiguration('openvectoreditor').get('viewType'));

  // const htmlcontent = vscode.fs.readFile(context.extensionPath, 'media', 'testWebview.html', 'utf8')
  // htmlcontent.replace('{{styleUri}}', styleUri.toString())
  // htmlcontent.replace('{{scriptUri}}', scriptUri.toString())
  // return htmlcontent;

  return `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="stylesheet" href="${styleUri}" />
          <style>
          html, body {
            height: 100%;
          }
          .ove-created-div {
            width: 100%;
            height: 100%;
            background-color: white;
          }
          </style>
        </head>
        <body>
        <script src="${scriptUri}"></script>
        <script>
			const editor = window.createVectorEditor("createDomNodeForMe", {
				withPreviewMode: false,
				editorName: "editor",
				showMenuBar: true,
			});
      editor.updateEditor({
        sequenceData: {
          circular: true,
          sequence:
            "AAGG",
        },
        ${defaultViewType},
      });
        </script>
        </body>
      </html>
    `;
}

class DNAViewerProvider {
  constructor(context) {
    this.context = context;
  }

  async openCustomDocument(uri, openContext, token) {
    return {
      uri,
      dispose: () => { } // 파일을 닫을 때 호출됨
    };
  }

  async resolveCustomEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media'))
      ]
    };
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'ove.css'))
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'index.umd.js'))
    );
    const ext = path.extname(document.uri.fsPath.toLowerCase().trim());
    const defaultViewType = viewType(vscode.workspace.getConfiguration('openvectoreditor').get('viewType'));

    let jsonOutput;
    let snapgeneRawBlocks = null; // preserved for .dna roundtrip

    if (ext === '.gb' || ext === '.gbk') {
      const doc = await vscode.workspace.openTextDocument(document.uri);
      const fileContent = doc.getText();
      jsonOutput = JSON.stringify(genbankToJson(fileContent)[0].parsedSequence);
    } else if (ext === '.fa' || ext === '.fasta') {
      const doc = await vscode.workspace.openTextDocument(document.uri);
      const fileContent = doc.getText();
      jsonOutput = JSON.stringify(fastaToJson(fileContent)[0].parsedSequence);
    } else if (ext === '.dna') {
      let fileName = path.basename(document.uri.fsPath);
      const basename = path.parse(fileName).name.trim();
      const buffer = await vscode.workspace.fs.readFile(document.uri); // Uint8Array
      const snapgeneOutput = await snapgeneToJson(buffer, { 'fileName': basename });
      const parsed = snapgeneOutput[0].parsedSequence;
      snapgeneRawBlocks = parsed._snapgeneRawBlocks || null; // keep primers/history/etc.
      delete parsed._snapgeneRawBlocks;                      // don't send large binary blobs to webview
      jsonOutput = JSON.stringify(parsed);
    }

    function toFileBytes(newJsonData) {
      if (ext === '.dna') {
        return jsonToSnapgene(Object.assign({}, newJsonData, { _snapgeneRawBlocks: snapgeneRawBlocks }));
      } else if (ext === '.gb' || ext === '.gbk') {
        return Buffer.from(jsonToGenbank(newJsonData));
      } else if (ext === '.fa' || ext === '.fasta') {
        return Buffer.from(jsonToFasta(newJsonData));
      }
    }

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "save") {
        try {
          const fileBytes = toFileBytes(message.data);
          await vscode.workspace.fs.writeFile(document.uri, fileBytes);
          vscode.window.showInformationMessage(`Saved: ${path.basename(document.uri.fsPath)}`);
        } catch (e) {
          vscode.window.showErrorMessage(`Save failed: ${e.message}`);
        }
      }
    })

    webview.html = `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="stylesheet" href="${styleUri}" />
          <style>
            html, body {
              width: 100%;
              height: 100%;
            }
            .ove-created-div {
              height: 100%;
              background-color: white;
            }
            .save-button {
              display: inline-block;
              padding: 10px;
              background-color: #0078d4;
              color: white;
              text-decoration: none;
              border-radius: 4px;
              font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
              font-size: 16px;
              font-weight: 600;
              box-shadow: none;
              border: none;
              cursor: pointer;
              position: fixed;
              top: 10px;
              right: 35px;
              z-index: 20000;
            }
            .save-button:hover {
              background-color: #005a9e;
              box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
            }
            .save-button:disabled {
              background-color: gray;
              cursor: not-allowed;
              opacity: 0.6;
            }
          </style>
        </head>
        <body>
		<script>
		const vscode = acquireVsCodeApi();
    const fileExt = ${JSON.stringify(ext)};

    function isSavable() {
      // All supported formats are now savable
    }

    function postSave() {
			const newJsonData = editor.getState()["sequenceData"];
			console.log('save data');
		vscode.postMessage({
			type: "save",
			data: newJsonData
		});
			}
		</script>
      <button id="save-button" class="save-button" onclick=postSave()>
        Save
      </button>
        <script src="${scriptUri}"></script>
      <script>
			const editor = window.createVectorEditor("createDomNodeForMe", {
				withPreviewMode: false,
				editorName: "VectorEditor",
				showMenuBar: true,
			});
			editor.updateEditor({
				sequenceData: ${JSON.parse(JSON.stringify(jsonOutput))},
        ${defaultViewType},
        });
      
      // Initialize the editor
      isSavable();
      </script>
    </body>
    </html>
    `;
  }
}

exports.activate = activate;
