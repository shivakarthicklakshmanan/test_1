"use strict";
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
exports.SessionsProvider = exports.SessionItem = exports.ModelsProvider = exports.ModelItem = exports.ToolsProvider = exports.ToolItem = exports.WorkflowsProvider = exports.WorkflowItem = void 0;
const vscode = __importStar(require("vscode"));
const workflows_1 = require("./workflows");
const llmRegistry_1 = require("./llmRegistry");
// ── Workflows ──────────────────────────────────────────────────────────────
class WorkflowItem extends vscode.TreeItem {
    constructor(workflow) {
        super(`${workflow.icon}  ${workflow.label}`, vscode.TreeItemCollapsibleState.None);
        this.workflow = workflow;
        this.tooltip = workflow.description;
        this.description = workflow.preferredLlm;
        this.command = { command: "techmind.runWorkflow", title: "Run Workflow", arguments: [workflow] };
        this.contextValue = "workflowItem";
    }
}
exports.WorkflowItem = WorkflowItem;
class WorkflowsProvider {
    getTreeItem(element) { return element; }
    getChildren() { return workflows_1.WORKFLOWS.map(w => new WorkflowItem(w)); }
}
exports.WorkflowsProvider = WorkflowsProvider;
// ── Tools ──────────────────────────────────────────────────────────────────
const TOOLS = [
    { label: "Attach Active File",      icon: "file-add",           command: "techmind.attachActiveFile", tooltip: "Attach the currently open file as context" },
    { label: "Send Selection to Agent", icon: "arrow-right",        command: "techmind.attachSelection",  tooltip: "Send highlighted text to the agent" },
    { label: "Open Agent Panel",        icon: "comment-discussion", command: "techmind.openAgent",        tooltip: "Open TechMind Agent panel" },
    { label: "Clear Attached Context",  icon: "clear-all",          command: "techmind.clearContext",     tooltip: "Remove all attached files" },
    { label: "Check Endpoint Health",   icon: "pulse",              command: "techmind.checkEndpoints",   tooltip: "Ping all vLLM endpoints" },
];
class ToolItem extends vscode.TreeItem {
    constructor(tool) {
        super(tool.label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(tool.icon);
        this.tooltip = tool.tooltip;
        this.command = { command: tool.command, title: tool.label };
    }
}
exports.ToolItem = ToolItem;
class ToolsProvider {
    getTreeItem(element) { return element; }
    getChildren() { return TOOLS.map(t => new ToolItem(t)); }
}
exports.ToolsProvider = ToolsProvider;
// ── Models ─────────────────────────────────────────────────────────────────
class ModelItem extends vscode.TreeItem {
    constructor(modelName, enabled, strengths) {
        super(modelName, vscode.TreeItemCollapsibleState.None);
        this.modelName = modelName;
        this.enabled = enabled;
        this.description = enabled ? "enabled" : "disabled";
        this.tooltip = strengths;
        this.iconPath = new vscode.ThemeIcon(enabled ? "check" : "circle-slash");
        this.command = { command: "techmind.toggleModel", title: "Toggle Model", arguments: [modelName] };
    }
}
exports.ModelItem = ModelItem;
class ModelsProvider {
    constructor(initialEnabled) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.enabledSet = initialEnabled;
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    isEnabled(name) { return this.enabledSet.has(name); }
    toggle(name) {
        if (this.enabledSet.has(name)) { this.enabledSet.delete(name); }
        else { this.enabledSet.add(name); }
        this.refresh();
    }
    getEnabledSet() { return this.enabledSet; }
    getTreeItem(element) { return element; }
    getChildren() {
        return llmRegistry_1.LLM_REGISTRY.map(m => new ModelItem(m.name, this.enabledSet.has(m.name), m.strengths));
    }
}
exports.ModelsProvider = ModelsProvider;
// ── Sessions ───────────────────────────────────────────────────────────────
class SessionItem extends vscode.TreeItem {
    constructor(session) {
        super(session.name, vscode.TreeItemCollapsibleState.None);
        this.session = session;
        this.contextValue = "sessionItem";
        this.tooltip = `${session.name}\nMessages: ${Math.floor((session.history || []).length / 2)}\n${new Date(session.updatedAt).toLocaleString()}`;
        this.description = new Date(session.updatedAt).toLocaleDateString();
        this.iconPath = new vscode.ThemeIcon("comment-discussion");
        this.command = { command: "techmind.loadSession", title: "Load Session", arguments: [session.id] };
    }
}
exports.SessionItem = SessionItem;
class SessionsProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.sessions = [];
    }
    setSessions(sessions) {
        this.sessions = [...(sessions || [])].sort((a, b) => b.updatedAt - a.updatedAt);
        this._onDidChangeTreeData.fire();
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) { return element; }
    getChildren() {
        if (this.sessions.length === 0) {
            const empty = new vscode.TreeItem("No sessions yet", vscode.TreeItemCollapsibleState.None);
            empty.iconPath = new vscode.ThemeIcon("info");
            return [empty];
        }
        return this.sessions.map(s => new SessionItem(s));
    }
}
exports.SessionsProvider = SessionsProvider;
