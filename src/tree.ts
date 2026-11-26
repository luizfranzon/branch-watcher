import * as path from 'node:path';
import * as vscode from 'vscode';
import { BranchReport, BranchStatus } from './git';

export type Node =
	| { kind: 'group'; status: BranchStatus; reports: BranchReport[] }
	| { kind: 'branch'; report: BranchReport }
	| { kind: 'file'; report: BranchReport; file: string };

const groupOrder: BranchStatus[] = ['conflict', 'clean', 'integrated', 'error'];

function groupLabel(status: BranchStatus, count: number): string {
	switch (status) {
		case 'conflict':
			return vscode.l10n.t('Conflitantes ({0})', count);
		case 'clean':
			return vscode.l10n.t('Limpas ({0})', count);
		case 'integrated':
			return vscode.l10n.t('Integradas ({0})', count);
		case 'error':
			return vscode.l10n.t('Com erro ({0})', count);
	}
}

function branchIcon(status: BranchStatus): vscode.ThemeIcon {
	switch (status) {
		case 'conflict':
			return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
		case 'clean':
			return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
		case 'integrated':
			return new vscode.ThemeIcon('git-merge');
		case 'error':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
	}
}

function branchTooltip(report: BranchReport, base: string): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(`**${report.name}**\n\n`);
	switch (report.status) {
		case 'conflict':
			tooltip.appendMarkdown(vscode.l10n.t('Vai conflitar com {0} em {1} arquivo(s).', base, report.files.length));
			break;
		case 'clean':
			tooltip.appendMarkdown(vscode.l10n.t('Mescla em {0} sem conflitos.', base));
			break;
		case 'integrated':
			tooltip.appendMarkdown(vscode.l10n.t('Já contida em {0}.', base));
			break;
		case 'error':
			tooltip.appendText(report.error ?? '');
			break;
	}
	if (report.status === 'conflict' || report.status === 'clean') {
		tooltip.appendMarkdown('\n\n' + vscode.l10n.t('{0} commit(s) à frente, {1} atrás.', report.ahead, report.behind));
	}
	const lastCommit = new Date(report.date).toLocaleString();
	tooltip.appendMarkdown('\n\n');
	tooltip.appendText(vscode.l10n.t('Último commit: {0}, {1}', report.author, lastCommit));
	return tooltip;
}

export class BranchTree implements vscode.TreeDataProvider<Node> {
	private reports: BranchReport[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(
		private readonly context: () => { root?: string; base?: string },
		private readonly isProtected: (name: string) => boolean,
	) {}

	setReports(reports: BranchReport[]): void {
		this.reports = reports;
		this.changed.fire();
	}

	getReports(): BranchReport[] {
		return this.reports;
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			const groups = groupOrder.map((status) => ({
				kind: 'group' as const,
				status,
				reports: this.reports.filter((report) => report.status === status),
			}));
			return groups.filter((group) => group.reports.length > 0);
		}
		if (node.kind === 'group') {
			return node.reports.map((report) => ({ kind: 'branch', report }));
		}
		if (node.kind === 'branch') {
			return node.report.files.map((file) => ({ kind: 'file', report: node.report, file }));
		}
		return [];
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const { root = '', base = '' } = this.context();

		if (node.kind === 'group') {
			const collapsed = node.status === 'integrated';
			const state = collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
			const item = new vscode.TreeItem(groupLabel(node.status, node.reports.length), state);
			item.id = `group:${node.status}`;
			item.contextValue = `group-${node.status}`;
			return item;
		}

		if (node.kind === 'branch') {
			const { report } = node;
			const hasFiles = report.files.length > 0;
			const state = hasFiles ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
			const item = new vscode.TreeItem(report.name, state);
			item.id = `branch:${report.name}`;
			item.iconPath = branchIcon(report.status);
			item.tooltip = branchTooltip(report, base);
			if (report.status === 'conflict' || report.status === 'clean') {
				item.description = `↑${report.ahead} ↓${report.behind}`;
			}
			if (report.status === 'error') {
				item.description = report.error;
			}
			const protectedSuffix = report.status === 'integrated' && this.isProtected(report.name) ? '-protected' : '';
			item.contextValue = `branch-${report.status}${protectedSuffix}`;
			return item;
		}

		const item = new vscode.TreeItem(vscode.Uri.file(path.join(root, node.file)));
		item.id = `file:${node.report.name}:${node.file}`;
		const directory = path.dirname(node.file);
		item.description = directory === '.' ? '' : directory;
		item.tooltip = vscode.l10n.t('Abrir diff {0} ↔ {1}', base, node.report.name);
		item.command = { command: 'branchWatcher.openDiff', title: vscode.l10n.t('Abrir diff'), arguments: [node] };
		return item;
	}
}
