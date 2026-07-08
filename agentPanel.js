"use strict";
/**
 * agentPanel.ts
 * The right-hand "Agent" webview panel: chat UI, multi-turn memory,
 * file/selection context attachment, guided clarifying-question mode,
 * and insert-into-editor / save-as-file actions.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const llmRegistry_1 = require("./llmRegistry");
class AgentPanel {
    static createOrShow(extensionUri, getEnabledModels, context, refreshSessionsTree) {
        const column = vscode.ViewColumn.Two;
        if (AgentPanel.currentPanel) {
            AgentPanel.currentPanel.panel.reveal(column);
            if (context) AgentPanel.currentPanel.setExtensionContext(context, refreshSessionsTree);
            return AgentPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel("techmindAgent", "TechMind Agent", column, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        AgentPanel.currentPanel = new AgentPanel(panel, extensionUri, getEnabledModels);
        if (context) AgentPanel.currentPanel.setExtensionContext(context, refreshSessionsTree);
        return AgentPanel.currentPanel;
    }
    constructor(panel, extensionUri, getEnabledModels) {
        this.disposables = [];
        this.history = [];
        this.attachedFiles = [];
        this.attachedImages = []; // { name, base64, mimeType }
        // ── Session state ──
        this.currentSessionId = null;
        this.currentSessionName = 'New Session';
        this.extContext = null;
        this.refreshSessionsTree = () => {};
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.getEnabledModels = getEnabledModels;
        this.panel.webview.html = this.getHtml();
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "userMessage":
                    await this.handleUserMessage(msg.text);
                    break;
                case "insertIntoEditor":
                    await this.insertIntoActiveEditor(msg.code);
                    break;
                case "saveAsFile":
                    await this.saveAsFile(msg.code, msg.suggestedName);
                    break;
                case "clearContext":
                    this.attachedFiles = [];
                    this.attachedImages = [];
                    this.postToWebview({ type: "contextCleared" });
                    break;
                case "clearHistory":
                    this.history = [];
                    break;
                case "openFilePicker":
                    await this.attachFileFromPicker();
                    break;
                case "newSession":
                    this.newSession();
                    break;
                case "renameSession":
                    await this.promptRenameCurrentSession();
                    break;
            }
        }, null, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }
    // Called by extension.js after construction to inject context
    setExtensionContext(context, refreshSessionsTree) {
        this.extContext = context;
        this.refreshSessionsTree = refreshSessionsTree || (() => {});
    }
    attachFile(name, content) {
        // Replace if already attached
        this.attachedFiles = this.attachedFiles.filter((f) => f.name !== name);
        this.attachedFiles.push({ name, content: content.slice(0, 12000) });
        this.postToWebview({
            type: "filesUpdated",
            files: this.attachedFiles.map((f) => f.name),
        });
    }
    // ── Session helpers ───────────────────────────────────────────────────────
    generateSessionId() {
        return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    autoNameFromHistory() {
        // Use first user message (truncated) as session name
        const firstUser = this.history.find(m => m.role === 'user');
        if (!firstUser) return 'New Session';
        const text = typeof firstUser.content === 'string'
            ? firstUser.content
            : (firstUser.content[0]?.text || 'New Session');
        return text.slice(0, 48).replace(/\n/g, ' ').trim() || 'New Session';
    }
    getAllSessions() {
        if (!this.extContext) return [];
        return this.extContext.globalState.get('techmind.sessions', []);
    }
    async saveCurrentSession() {
        if (!this.extContext || this.history.length === 0) return;
        const sessions = this.getAllSessions();
        const now = Date.now();
        // Auto-name on first save if still default
        if (this.currentSessionName === 'New Session' && this.history.length >= 2) {
            this.currentSessionName = this.autoNameFromHistory();
        }
        if (this.currentSessionId) {
            // Update existing
            const idx = sessions.findIndex(s => s.id === this.currentSessionId);
            if (idx >= 0) {
                sessions[idx].history = this.history;
                sessions[idx].updatedAt = now;
                sessions[idx].name = this.currentSessionName;
            } else {
                // Session was deleted externally — create fresh
                sessions.push({ id: this.currentSessionId, name: this.currentSessionName, history: this.history, createdAt: now, updatedAt: now });
            }
        } else {
            // First save — create new session
            this.currentSessionId = this.generateSessionId();
            sessions.push({ id: this.currentSessionId, name: this.currentSessionName, history: this.history, createdAt: now, updatedAt: now });
        }
        await this.extContext.globalState.update('techmind.sessions', sessions);
        this.refreshSessionsTree();
        // Update panel header
        this.postToWebview({ type: 'sessionInfo', name: this.currentSessionName, id: this.currentSessionId });
    }
    newSession() {
        this.history = [];
        this.attachedFiles = [];
        this.attachedImages = [];
        this.currentSessionId = null;
        this.currentSessionName = 'New Session';
        this.panel.title = 'TechMind Agent';
        this.postToWebview({ type: 'sessionNew' });
    }
    loadSession(sessionId) {
        if (!this.extContext) return;
        const sessions = this.getAllSessions();
        const session = sessions.find(s => s.id === sessionId);
        if (!session) { vscode.window.showWarningMessage('Session not found.'); return; }
        this.history = session.history || [];
        this.currentSessionId = session.id;
        this.currentSessionName = session.name;
        this.attachedFiles = [];
        this.attachedImages = [];
        this.panel.title = `TechMind — ${session.name.slice(0, 30)}`;
        this.postToWebview({ type: 'sessionLoaded', history: this.history, name: session.name, id: session.id });
    }
    clearContext() {
        this.attachedFiles = [];
        this.attachedImages = [];
        this.postToWebview({ type: 'contextCleared' });
    }
    notifySessionRenamed(sessionId, newName) {
        if (this.currentSessionId === sessionId) {
            this.currentSessionName = newName;
            this.panel.title = `TechMind — ${newName.slice(0, 30)}`;
            this.postToWebview({ type: 'sessionInfo', name: newName, id: sessionId });
        }
    }
    notifySessionDeleted(sessionId) {
        if (this.currentSessionId === sessionId) {
            this.newSession();
            vscode.window.showInformationMessage('Current session was deleted. Started a new session.');
        }
    }
    async promptRenameCurrentSession() {
        const newName = await vscode.window.showInputBox({
            prompt: 'Rename current session',
            value: this.currentSessionName,
            placeHolder: 'Session name',
        });
        if (!newName || !newName.trim()) return;
        this.currentSessionName = newName.trim();
        this.panel.title = `TechMind — ${this.currentSessionName.slice(0, 30)}`;
        this.postToWebview({ type: 'sessionInfo', name: this.currentSessionName, id: this.currentSessionId });
        await this.saveCurrentSession();
    }
    async attachFileFromPicker() {
        // Show file picker — supports text, images, PDF, common data files
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach to TechMind",
            filters: {
                "All Supported": ["txt","py","sql","md","json","yaml","yml","log","sh","csv","js","ts","java","xml","html","css","png","jpg","jpeg","gif","webp","bmp","pdf"],
                "Text Files": ["txt","py","sql","md","json","yaml","yml","log","sh","csv","js","ts","java","xml","html","css"],
                "Images": ["png","jpg","jpeg","gif","webp","bmp"],
                "PDF": ["pdf"],
            },
        });
        if (!uris || uris.length === 0) return;

        const TEXT_EXTS = new Set(["txt","py","sql","md","json","yaml","yml","log","sh","csv","js","ts","java","xml","html","css","env","cfg","ini","toml"]);
        const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","bmp"]);
        const MIME_MAP = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", webp:"image/webp", bmp:"image/bmp" };

        for (const uri of uris) {
            const fileName = path.basename(uri.fsPath);
            const ext = fileName.split(".").pop()?.toLowerCase() || "";

            try {
                const rawBytes = await vscode.workspace.fs.readFile(uri);

                if (TEXT_EXTS.has(ext)) {
                    // Plain text — inject as context string (existing behaviour)
                    const content = Buffer.from(rawBytes).toString("utf8").slice(0, 15000);
                    this.attachedFiles = this.attachedFiles.filter(f => f.name !== fileName);
                    this.attachedFiles.push({ name: fileName, content });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as text context`);

                } else if (IMAGE_EXTS.has(ext)) {
                    // Image — store as base64 for multimodal message to Llama
                    const b64 = Buffer.from(rawBytes).toString("base64");
                    this.attachedImages = this.attachedImages.filter(f => f.name !== fileName);
                    this.attachedImages.push({ name: fileName, base64: b64, mimeType: MIME_MAP[ext] || "image/png" });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as image (multimodal)`);

                } else if (ext === "pdf") {
                    // PDF — extract raw bytes as base64; Llama-3.3-70B can read PDFs as documents
                    const b64 = Buffer.from(rawBytes).toString("base64");
                    this.attachedImages = this.attachedImages.filter(f => f.name !== fileName);
                    this.attachedImages.push({ name: fileName, base64: b64, mimeType: "application/pdf" });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as PDF`);

                } else {
                    // Unknown — try reading as text anyway
                    const content = Buffer.from(rawBytes).toString("utf8").slice(0, 15000);
                    this.attachedFiles = this.attachedFiles.filter(f => f.name !== fileName);
                    this.attachedFiles.push({ name: fileName, content });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as text`);
                }
            } catch (e) {
                vscode.window.showWarningMessage(`TechMind: could not read ${fileName}: ${e}`);
            }
        }

        // Notify webview to update the attached bar
        const allNames = [
            ...this.attachedFiles.map(f => f.name),
            ...this.attachedImages.map(f => `${f.name} (${f.mimeType.split("/")[0]})`),
        ];
        this.postToWebview({ type: "filesUpdated", files: allNames });
    }
    sendSelectionAsPrompt(text, fileName) {
        this.attachFile(`${fileName} (selection)`, text);
        this.postToWebview({
            type: "prefill",
            text: `Regarding this selection from ${fileName}:\n\n`,
        });
    }
    prefillStarter(starter, preferredLlm) {
        this.postToWebview({ type: "prefill", text: starter });
        this.postToWebview({ type: "suggestModel", model: preferredLlm });
    }
    postToWebview(message) {
        this.panel.webview.postMessage(message);
    }
    buildFileContext() {
        if (this.attachedFiles.length === 0)
            return "";
        const parts = ["## ATTACHED CONTEXT (from VS Code editor)\n"];
        for (const f of this.attachedFiles) {
            parts.push(`### ${f.name}\n\`\`\`\n${f.content}\n\`\`\`\n`);
        }
        return parts.join("\n");
    }
    async handleUserMessage(userText) {
        const guidedMode = vscode.workspace.getConfiguration("techmind").get("guidedMode");
        const route = (0, llmRegistry_1.autoRoute)(userText);
        this.postToWebview({ type: "routing", llm: route.llmName, taskType: route.taskType, icon: route.icon });
        let systemMsg = llmRegistry_1.SYSTEM_CONTEXT;
        const fileCtx = this.buildFileContext();
        if (fileCtx)
            systemMsg += `\n\n${fileCtx}`;
        let userContent = userText;
        if (guidedMode && userText.split(/\s+/).length > 20) {
            userContent =
                "Before providing the full solution, identify if there is ONE critical clarifying question " +
                    "needed to produce the best answer. If yes, ask it briefly and stop there. If the request is " +
                    "clear enough to proceed, say 'Proceeding:' and then give the full answer.\n\n" +
                    `User request:\n${userText}`;
        }
        // Build user content — plain string if no images, multimodal array if images/PDFs attached
        let userPayload;
        if (this.attachedImages.length > 0) {
            // Multimodal: content is an array of parts
            const parts = [];
            // Add text part first
            parts.push({ type: "text", text: userContent });
            // Add each image/PDF as base64
            for (const img of this.attachedImages) {
                if (img.mimeType === "application/pdf") {
                    // Llama handles PDFs as a document block (vLLM OpenAI-compat)
                    parts.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${img.mimeType};base64,${img.base64}`,
                            detail: "high",
                        },
                    });
                } else {
                    // Standard image_url block for images
                    parts.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${img.mimeType};base64,${img.base64}`,
                            detail: "high",
                        },
                    });
                }
            }
            userPayload = parts;
        } else {
            userPayload = userContent;
        }
        const messages = [
            { role: "system", content: systemMsg },
            ...this.history,
            { role: "user", content: userPayload },
        ];
        const result = await (0, llmRegistry_1.callWithFallback)(route.llmName, messages, this.getEnabledModels());
        if (!result.text) {
            this.postToWebview({ type: "error", text: `All models failed. ${result.error}` });
            return;
        }
        // Store clean turn (without guided-mode wrapper) for memory
        this.history.push({ role: "user", content: userText });
        this.history.push({ role: "assistant", content: result.text });
        // Auto-save session after every exchange
        await this.saveCurrentSession();
        this.postToWebview({
            type: "assistantMessage",
            text: result.text,
            llmUsed: result.llmUsed,
            taskType: `${route.icon} ${route.taskType}`,
            elapsedMs: result.elapsedMs,
            note: result.error || "",
        });
    }
    async insertIntoActiveEditor(code) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("No active editor to insert into.");
            return;
        }
        await editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, code);
        });
        vscode.window.showInformationMessage("Inserted into editor.");
    }
    async saveAsFile(code, suggestedName) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const defaultUri = workspaceFolders
            ? vscode.Uri.joinPath(workspaceFolders[0].uri, suggestedName)
            : vscode.Uri.file(suggestedName);
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { "Python": ["py"], "All Files": ["*"] },
        });
        if (!uri)
            return;
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(code));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`Saved: ${path.basename(uri.fsPath)}`);
    }
    dispose() {
        AgentPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d)
                d.dispose();
        }
    }
    getHtml() {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --tm-radius: 6px;
    --tm-user-bg: var(--vscode-inputOption-activeBackground);
    --tm-agent-bg: var(--vscode-editor-background);
    --tm-code-bg: var(--vscode-textCodeBlock-background);
    --tm-border: var(--vscode-panel-border);
    --tm-accent: var(--vscode-textLink-foreground);
    --tm-heading: var(--vscode-textLink-activeForeground);
    --tm-strong: var(--vscode-editor-foreground);
    --tm-muted: var(--vscode-descriptionForeground);
    --tm-quote-border: var(--vscode-activityBarBadge-background);
    --tm-quote-bg: var(--vscode-textBlockQuote-background);
    --tm-table-border: var(--vscode-panel-border);
    --tm-table-head-bg: var(--vscode-textCodeBlock-background);
    --tm-error: var(--vscode-errorForeground);
    --tm-success: var(--vscode-terminal-ansiGreen);
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    margin: 0; padding: 0;
    display: flex; flex-direction: column; height: 100vh;
    font-size: 13px; line-height: 1.55;
  }

  /* ── Header ── */
  #header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--tm-border);
    font-weight: 700;
    font-size: 13px;
    display: flex; justify-content: space-between; align-items: center;
    letter-spacing: 0.3px;
  }
  #header .sub { font-weight: 400; opacity: 0.6; font-size: 11px; }

  /* ── Session bar ── */
  #sessionBar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 5px 14px;
    background: var(--tm-code-bg);
    border-bottom: 1px solid var(--tm-border);
    font-size: 11px;
  }
  #sessionName {
    font-weight: 600; opacity: 0.85;
    max-width: 60%; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    color: var(--tm-accent);
  }
  #sessionBtns { display: flex; gap: 5px; }
  #sessionBtns button {
    font-size: 10px; padding: 2px 7px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 3px; cursor: pointer;
  }
  #sessionBtns button:hover { background: var(--vscode-button-secondaryHoverBackground); }

  /* ── Attached bar ── */
  #attachedBar {
    padding: 5px 14px;
    font-size: 11px;
    background: var(--tm-quote-bg);
    border-bottom: 1px solid var(--tm-border);
    color: var(--tm-accent);
    display: none;
  }

  /* ── Routing banner ── */
  #routingBanner {
    font-size: 11px; opacity: 0.65;
    padding: 4px 14px; display: none;
    font-style: italic;
  }

  /* ── Chat area ── */
  #chat { flex: 1; overflow-y: auto; padding: 12px 14px; }

  /* ── Message bubbles ── */
  .msg { margin-bottom: 18px; }

  .role {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.8px; text-transform: uppercase;
    opacity: 0.5; margin-bottom: 5px;
  }
  .role.role-user  { color: var(--tm-accent); }
  .role.role-agent { color: var(--tm-success, #4ec994); }

  .bubble-user {
    background: var(--tm-user-bg);
    border-radius: var(--tm-radius);
    padding: 9px 12px;
    font-size: 13px;
    white-space: pre-wrap;
    border-left: 3px solid var(--tm-accent);
  }
  .bubble-agent {
    font-size: 13.5px;
    line-height: 1.6;
  }

  /* ── Markdown elements inside agent bubble ── */
  .bubble-agent h1 {
    font-size: 17px; font-weight: 700;
    color: var(--tm-heading);
    margin: 16px 0 6px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--tm-border);
  }
  .bubble-agent h2 {
    font-size: 15px; font-weight: 700;
    color: var(--tm-heading);
    margin: 14px 0 5px 0;
  }
  .bubble-agent h3 {
    font-size: 13.5px; font-weight: 700;
    color: var(--tm-accent);
    margin: 12px 0 4px 0;
  }
  .bubble-agent h4 {
    font-size: 13px; font-weight: 600;
    opacity: 0.85; margin: 10px 0 3px 0;
  }
  .bubble-agent p {
    margin: 0 0 10px 0;
  }
  .bubble-agent strong, .bubble-agent b {
    font-weight: 700;
    color: var(--tm-strong);
  }
  .bubble-agent em, .bubble-agent i {
    font-style: italic; opacity: 0.9;
  }
  .bubble-agent code {
    font-family: var(--vscode-editor-font-family), 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
    background: var(--tm-code-bg);
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--vscode-textPreformat-foreground);
  }
  .bubble-agent pre {
    background: var(--tm-code-bg);
    border: 1px solid var(--tm-border);
    border-radius: var(--tm-radius);
    padding: 10px 12px;
    overflow-x: auto;
    margin: 8px 0;
    position: relative;
  }
  .bubble-agent pre code {
    font-family: var(--vscode-editor-font-family), 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
    background: none;
    padding: 0;
    border-radius: 0;
    color: var(--vscode-editor-foreground);
    white-space: pre;
  }
  .code-lang {
    font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--tm-muted);
    margin-bottom: 6px;
    display: block;
  }
  .bubble-agent ul, .bubble-agent ol {
    margin: 6px 0 10px 0;
    padding-left: 22px;
  }
  .bubble-agent li { margin-bottom: 4px; }
  .bubble-agent ul li::marker { color: var(--tm-accent); }
  .bubble-agent ol li::marker { color: var(--tm-accent); font-weight: 600; }
  .bubble-agent blockquote {
    border-left: 3px solid var(--tm-quote-border);
    background: var(--tm-quote-bg);
    margin: 8px 0;
    padding: 6px 12px;
    border-radius: 0 var(--tm-radius) var(--tm-radius) 0;
    font-style: italic;
    opacity: 0.9;
  }
  .bubble-agent hr {
    border: none;
    border-top: 1px solid var(--tm-border);
    margin: 12px 0;
  }
  .bubble-agent table {
    border-collapse: collapse;
    width: 100%;
    margin: 10px 0;
    font-size: 12.5px;
  }
  .bubble-agent th {
    background: var(--tm-table-head-bg);
    font-weight: 700;
    padding: 6px 10px;
    border: 1px solid var(--tm-table-border);
    text-align: left;
    color: var(--tm-heading);
  }
  .bubble-agent td {
    padding: 5px 10px;
    border: 1px solid var(--tm-table-border);
    vertical-align: top;
  }
  .bubble-agent tr:nth-child(even) td {
    background: var(--tm-code-bg);
  }
  .bubble-agent a {
    color: var(--tm-accent);
    text-decoration: none;
  }
  .bubble-agent a:hover { text-decoration: underline; }

  /* ── Meta / timing ── */
  .meta {
    font-size: 10px; opacity: 0.45;
    margin-top: 6px; font-style: italic;
  }

  /* ── Action buttons ── */
  .actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button {
    font-size: 11px; padding: 3px 9px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 3px; cursor: pointer;
  }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }

  /* ── Input bar ── */
  #inputBar {
    border-top: 1px solid var(--tm-border);
    padding: 10px; display: flex; gap: 6px; align-items: flex-end;
  }
  #userInput {
    flex: 1; resize: none;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: var(--tm-radius);
    padding: 8px 10px;
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 13px;
    min-height: 38px; max-height: 140px;
    line-height: 1.4;
  }
  #userInput:focus {
    outline: none;
    border-color: var(--tm-accent);
  }
  #sendBtn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: var(--tm-radius);
    padding: 0 16px; height: 38px;
    cursor: pointer; font-size: 13px; font-weight: 600;
  }
  #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
  #attachBtn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: var(--tm-radius);
    padding: 0 10px; height: 38px;
    cursor: pointer; font-size: 16px;
  }
  #attachBtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .error { color: var(--tm-error); }
</style>
</head>
<body>
  <div id="header">
    <span>TechMind Agent</span>
    <span class="sub" id="modelSuggestion"></span>
  </div>
  <div id="sessionBar">
    <span id="sessionName">New Session</span>
    <div id="sessionBtns">
      <button id="newSessionBtn" title="Start new session">＋ New</button>
      <button id="renameSessionBtn" title="Rename this session">✎ Rename</button>
    </div>
  </div>
  <div id="attachedBar"></div>
  <div id="routingBanner"></div>
  <div id="chat"></div>
  <div id="inputBar">
    <button id="attachBtn" title="Attach file (text, image, PDF)">📎</button>
    <textarea id="userInput" placeholder="Ask a technical question, paste an error, or describe what you need..."></textarea>
    <button id="sendBtn">Send</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById('chat');
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const attachedBar = document.getElementById('attachedBar');
  const routingBanner = document.getElementById('routingBanner');
  const modelSuggestion = document.getElementById('modelSuggestion');

  let msgCounter = 0;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Full markdown renderer — handles the common subset Llama produces
  function renderMarkdown(text) {
    // 1. Extract code blocks first (protect them from inline processing)
    const codeBlocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || '', code });
      return `\x00CODE${idx}\x00`;
    });

    // 2. Process line-by-line for block elements
    const lines = text.split('\n');
    let html = '';
    let inUl = false, inOl = false, inTable = false, tableHeader = false;

    const closeList = () => {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
    };
    const closeTable = () => {
      if (inTable) { html += '</tbody></table>'; inTable = false; tableHeader = false; }
    };

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Restore code block placeholders
      if (/^\x00CODE\d+\x00$/.test(line.trim())) {
        closeList(); closeTable();
        const idx = parseInt(line.trim().replace(/\x00CODE(\d+)\x00/, '$1'));
        const { lang, code } = codeBlocks[idx];
        const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
        html += `<pre>${langLabel}<code>${escapeHtml(code)}</code></pre>`;
        continue;
      }

      // Horizontal rule
      if (/^[-*_]{3,}\s*$/.test(line)) {
        closeList(); closeTable();
        html += '<hr>';
        continue;
      }

      // Headings
      const h4 = line.match(/^####\s+(.*)/);
      const h3 = line.match(/^###\s+(.*)/);
      const h2 = line.match(/^##\s+(.*)/);
      const h1 = line.match(/^#\s+(.*)/);
      if (h1 || h2 || h3 || h4) {
        closeList(); closeTable();
        const level = h4 ? 4 : h3 ? 3 : h2 ? 2 : 1;
        const content = inlineFormat((h4||h3||h2||h1)[1]);
        html += `<h${level}>${content}</h${level}>`;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        closeList(); closeTable();
        html += `<blockquote>${inlineFormat(line.replace(/^>\s?/, ''))}</blockquote>`;
        continue;
      }

      // Table row
      if (/^\|.*\|/.test(line)) {
        const cells = line.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => c.trim());
        const isSep = cells.every(c => /^[-:]+$/.test(c));
        if (!inTable) {
          closeList();
          html += '<table><thead><tr>';
          cells.forEach(c => { html += `<th>${inlineFormat(c)}</th>`; });
          html += '</tr></thead><tbody>';
          inTable = true; tableHeader = true;
        } else if (isSep) {
          // separator row — skip
        } else {
          html += '<tr>';
          cells.forEach(c => { html += `<td>${inlineFormat(c)}</td>`; });
          html += '</tr>';
        }
        continue;
      } else if (inTable) {
        closeTable();
      }

      // Unordered list
      const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)/);
      if (ulMatch) {
        closeTable();
        if (!inUl) { if (inOl) { html += '</ol>'; inOl = false; } html += '<ul>'; inUl = true; }
        html += `<li>${inlineFormat(ulMatch[2])}</li>`;
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^(\s*)\d+[.)]\s+(.*)/);
      if (olMatch) {
        closeTable();
        if (!inOl) { if (inUl) { html += '</ul>'; inUl = false; } html += '<ol>'; inOl = true; }
        html += `<li>${inlineFormat(olMatch[2])}</li>`;
        continue;
      }

      // Blank line
      if (line.trim() === '') {
        closeList(); closeTable();
        html += '';
        continue;
      }

      // Regular paragraph line
      closeList(); closeTable();
      html += `<p>${inlineFormat(line)}</p>`;
    }

    closeList(); closeTable();
    return html;
  }

  // Inline formatting: bold, italic, inline code, links
  function inlineFormat(text) {
    // Protect inline code first
    const inlineCodes = [];
    text = text.replace(/`([^`]+)`/g, (_, c) => {
      inlineCodes.push(c);
      return `\x01IC${inlineCodes.length - 1}\x01`;
    });
    // Bold+italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/_(.+?)_/g, '<em>$1</em>');
    // Links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Restore inline code
    text = text.replace(/\x01IC(\d+)\x01/g, (_, i) => `<code>${escapeHtml(inlineCodes[i])}</code>`);
    return text;
  }

  function extractCodeBlocks(text) {
    const re = /```(?:python|py|sql|js|ts|bash|sh)?\n([\s\S]*?)```/g;
    const blocks = [];
    let m;
    while ((m = re.exec(text)) !== null) blocks.push(m[1]);
    return blocks;
  }

  function addMessage(role, text, meta) {
    const div = document.createElement('div');
    div.className = 'msg';
    const roleLabel = role === 'user' ? 'You' : 'TechMind';
    const roleClass = role === 'user' ? 'role-user' : 'role-agent';
    let html = `<div class="role ${roleClass}">${roleLabel}</div>`;
    if (role === 'user') {
      html += `<div class="bubble-user">${escapeHtml(text)}</div>`;
    } else {
      html += `<div class="bubble-agent">${renderMarkdown(text)}</div>`;
    }
    if (meta) html += `<div class="meta">${escapeHtml(meta)}</div>`;
    div.innerHTML = html;

    if (role === 'assistant') {
      const blocks = extractCodeBlocks(text);
      if (blocks.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        const insertBtn = document.createElement('button');
        insertBtn.textContent = '↪ Insert into editor';
        insertBtn.onclick = () => vscode.postMessage({ type: 'insertIntoEditor', code: blocks.join('\n\n') });
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '💾 Save as .py';
        saveBtn.onclick = () => vscode.postMessage({ type: 'saveAsFile', code: blocks.join('\n\n'), suggestedName: 'techmind_output.py' });
        actions.appendChild(insertBtn);
        actions.appendChild(saveBtn);
        div.appendChild(actions);
      }
    }

    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    addMessage('user', text);
    input.value = '';
    routingBanner.style.display = 'block';
    routingBanner.textContent = 'Routing...';
    vscode.postMessage({ type: 'userMessage', text });
  }

  const attachBtn = document.getElementById('attachBtn');
  attachBtn.onclick = () => vscode.postMessage({ type: 'openFilePicker' });

  const newSessionBtn = document.getElementById('newSessionBtn');
  const renameSessionBtn = document.getElementById('renameSessionBtn');
  const sessionNameEl = document.getElementById('sessionName');

  newSessionBtn.onclick = () => vscode.postMessage({ type: 'newSession' });
  renameSessionBtn.onclick = () => vscode.postMessage({ type: 'renameSession' });

  function setSessionName(name) {
    sessionNameEl.textContent = name || 'New Session';
  }

  function replayHistory(history) {
    chat.innerHTML = '';
    msgCounter = 0;
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      const role = m.role === 'user' ? 'user' : 'assistant';
      const content = typeof m.content === 'string' ? m.content : (m.content[0]?.text || '');
      if (role === 'user' || role === 'assistant') {
        addMessage(role, content, null);
      }
    }
    chat.scrollTop = chat.scrollHeight;
  }

  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'routing':
        routingBanner.style.display = 'block';
        routingBanner.textContent = msg.icon + ' Routing to ' + msg.llm + ' (' + msg.taskType + ')...';
        break;
      case 'assistantMessage': {
        routingBanner.style.display = 'none';
        let meta = 'Model: ' + msg.llmUsed + ' · ' + msg.taskType + ' · ' + (msg.elapsedMs/1000).toFixed(1) + 's';
        if (msg.note) meta += ' · ' + msg.note;
        addMessage('assistant', msg.text, meta);
        break;
      }
      case 'error':
        routingBanner.style.display = 'none';
        addMessage('assistant', '❌ ' + msg.text, null);
        break;
      case 'prefill':
        input.value = msg.text;
        input.focus();
        break;
      case 'suggestModel':
        modelSuggestion.textContent = 'suggested: ' + msg.model;
        break;
      case 'filesUpdated':
        attachedBar.style.display = 'block';
        attachedBar.textContent = '📎 Attached: ' + msg.files.join(', ');
        break;
      case 'contextCleared':
        attachedBar.style.display = 'none';
        attachedBar.textContent = '';
        break;
      case 'sessionNew':
        chat.innerHTML = '';
        msgCounter = 0;
        setSessionName('New Session');
        attachedBar.style.display = 'none';
        break;
      case 'sessionLoaded':
        setSessionName(msg.name);
        replayHistory(msg.history);
        attachedBar.style.display = 'none';
        break;
      case 'sessionInfo':
        setSessionName(msg.name);
        break;
    }
  });
</script>
</body>
</html>`;
    }
}
exports.AgentPanel = AgentPanel;
//# sourceMappingURL=agentPanel.js.map