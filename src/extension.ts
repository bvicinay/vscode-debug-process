/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { PrologDebugSession } from './mockDebug';
import * as Net from 'net';

/*
 * Set the following compile time flag to true if the
 * debug adapter should run inside the extension host.
 * Please note: the test suite does no longer work in this mode.
 */
const EMBED_DEBUG_ADAPTER = false;
var htmlLoaded = false;
var switchEditorCount = 0;

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand('extension.mock-debug.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of a markdown file in the workspace folder",
			value: "readme.md"
		});
    }));



    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((customEvent) => {
        console.log("received somethign");
        let type = customEvent.event;
        let msg = "";
        if (type == "runtimeOutput") {
            msg = customEvent.body.data.msg;
        } else if (type == "loadedSource") {
            msg = "***Imported file " + customEvent.body.source.origin;
        }
        if (PrologDebugPanel.currentPanel) {
            PrologDebugPanel.currentPanel._panel.webview.postMessage({ command: 'writeToConsole', text: msg });
        }
    }));

	// register a configuration provider for 'mock' debug type
	const provider = new MockConfigurationProvider()
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('mock', provider));
	context.subscriptions.push(provider);

    context.subscriptions.push(vscode.commands.registerCommand('catCoding.start', () => {
        PrologDebugPanel.createOrShow(context.extensionPath);
    }));

 	context.subscriptions.push(vscode.commands.registerCommand('catCoding.doRefactor', () => {
        if (PrologDebugPanel.currentPanel) {
            PrologDebugPanel.currentPanel.doRefactor();
        }
	}));

    vscode.commands.executeCommand("catCoding.start");

    vscode.window.onDidChangeActiveTextEditor( () => {
        if (switchEditorCount++ < 1) {
            let column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
            if (PrologDebugPanel.currentPanel) {
                PrologDebugPanel.currentPanel._panel.reveal(column);
            }
        }


    })

}

export function deactivate() {
	// nothing to do
}

class MockConfigurationProvider implements vscode.DebugConfigurationProvider {

	private _server?: Net.Server;

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'markdown' ) {
				config.type = 'mock';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.stopOnEntry = true;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		if (EMBED_DEBUG_ADAPTER) {
			// start port listener on launch of first debug session
			if (!this._server) {

                //this._server = new PrologDebugSession();


				// start listening on a random port
				this._server = Net.createServer(socket => {
					const session = new PrologDebugSession();
					session.setRunAsServer(true);
                    session.start(<NodeJS.ReadableStream>socket, socket);

				}).listen(4711);
            }


			// make VS Code connect to debug server instead of launching debug adapter
			config.debugServer = this._server.address().port;
		}

		return config;
	}

	dispose() {
		if (this._server) {
			this._server.close();
		}
	}
}

/**
 * Manages Prolog Debugger webview panels
 */
class PrologDebugPanel {
    /**
     * Track the currently panel. Only allow a single panel to exist at a time.
     */
    public static currentPanel: PrologDebugPanel | undefined;

    private static readonly viewType = 'prologDebugging';

    public readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionPath: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        // If we already have a panel, show it.
        // Otherwise, create a new panel.
        if (PrologDebugPanel.currentPanel) {
            PrologDebugPanel.currentPanel._panel.reveal(column);
        } else {
            PrologDebugPanel.currentPanel = new PrologDebugPanel(extensionPath, column || vscode.ViewColumn.One);
		}


	}

    // TODO: clean up code and remove extra stuff
    private constructor(extensionPath: string, column: vscode.ViewColumn) {
        this._extensionPath = extensionPath;

        // Create and show a new webview panel
        this._panel = vscode.window.createWebviewPanel(PrologDebugPanel.viewType, "Prolog Debugger", column, {
            // Enable javascript in the webview
			enableScripts: true,
			retainContextWhenHidden: true,

            // And restric the webview to only loading content from our extension's `media` directory.
            localResourceRoots: [
                vscode.Uri.file(path.join(this._extensionPath, 'media'))
            ]
        });

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Update the content based on view changes
        this._panel.onDidChangeViewState(e => {
            if (this._panel.visible) {
                this._update()
            }
        }, null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(message => {
            let debugSession = vscode.debug.activeDebugSession;
            switch (message.command) {
                case 'user_input':
                    vscode.window.showInformationMessage(message.text);
                    if (debugSession) {
                        debugSession.customRequest("user_input", {msg: message.text});
                        //console.log("sent from extension: " + message.text);
                    }
                    break;
                case 'raw_input':
                    if (debugSession) {
                        debugSession.customRequest("raw_input", {msg: message.text});
                        //console.log("sent from extension: " + message.text);
                    }
                    break;
                case 'exportLog':
                    //let text = message.text;
                    //let channel = vscode.window.showSaveDialog({ saveLabel: "Export Log"});
                    //vscode.window.showInformationMessage(channel.then)
                    break;
                case 'importFile':
                    var fileDialog = vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        openLabel: 'Import File'
                    }).then( file => {
                        if (file) {
                            console.log(file);
                            console.log(file[0]);
                            if (debugSession) {
                                debugSession.customRequest("importFile", file[0]);
                            }
                            vscode.window.showTextDocument(file[0], {
                                preview: true,
                                preserveFocus: false
                            }).then( editor => {
                                // editor is opened
                            })
                        }
                    });

            }
        }, null, this._disposables);


        // Message receiving goes here





    }

    public doRefactor() {
        // Send a message to the webview webview.
        // You can send any JSON serializable data.
        this._panel.webview.postMessage({ command: 'setConsoleText', text: 'the message worked' });
    }

    public dispose() {
        PrologDebugPanel.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        // Vary the webview's content based on where it is located in the editor.
        switch (this._panel.viewColumn) {
            case vscode.ViewColumn.Two:
                this._updateUI('Prolog Debugger');
                return;

            case vscode.ViewColumn.Three:
                this._updateUI('Prolog Debugger');
                return;

            case vscode.ViewColumn.One:
            default:
                this._updateUI('Prolog Debugger');
                return;
        }
    }

    private _updateUI(panelTitle: string) {
        this._panel.title = panelTitle;
        if (!htmlLoaded) {
            this._panel.webview.html = this._getHtmlForWebview(panelTitle);
            htmlLoaded = true;
        }

    }

    private _getHtmlForWebview(title: string) {

        // Local path to main script run in the webview
		const scriptPathOnDisk = vscode.Uri.file(path.join(this._extensionPath, 'media', 'main.js'));
		const stylePathOnDisk =  vscode.Uri.file(path.join(this._extensionPath, 'media', 'main.css'));

        // And the uri we use to load this script in the webview
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
		const styleUri = stylePathOnDisk.with({ scheme: 'vscode-resource' });

        // Use a nonce to whitelist which scripts can be run
        const nonce = getNonce();
        // TODO: resize console to fix formattting
        // TODO: make console accept input directly
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src vscode-resource:; style-src vscode-resource:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link nonce="${nonce}" rel="stylesheet" type="text/css" href="${styleUri}" >
                <title>Prolog Debugger</title>
            </head>
            <body>
                <textarea id="debug-text" rows="4" cols="50"></textarea><br>
                <input id="debug-input" type="text" placeholder="Enter command..">
                <input id="raw-input" type="text" placeholder="Enter RAW command..">
                <div id="button-menu">
                    <button id="import-btn">Import File</button><button onclick="exportLog()">Export log</button>
                </div>


				<script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
