import * as vscode from 'vscode';
import {
	BranchReport,
	BranchStatus,
	RemoteOutcome,
	analyzeBranches,
	currentBranch,
	defaultBase,
	deleteIntegrated,
	fetchAll,
	git,
	gitCommonDir,
	listRefs,
	matchesGlob,
	refExists,
	repoRoot,
	repoState,
	resolveConflicts,
	supportsMergeTree,
} from './git';
import { BranchFilter, DateRange, applyFilter, formatDay, isFiltered, parseDay } from './filter';
import { BranchTree, Node } from './tree';

const viewId = 'branchWatcher.branches';
const diffScheme = 'branch-watcher';

type ViewState = 'loading' | 'noRepo' | 'oldGit' | 'noBase' | 'ready';

export function activate(context: vscode.ExtensionContext) {
	let root: string | undefined;
	let base: string | undefined;
	let repos: string[] = [];
	let previous = new Map<string, BranchStatus>();
	let allReports: BranchReport[] = [];
	let filter: BranchFilter = {};
	let running = false;
	let pending = false;
	let fetchTimer: NodeJS.Timeout | undefined;
	let refsWatcher: vscode.FileSystemWatcher | undefined;
	let debounce: NodeJS.Timeout | undefined;

	const config = () => vscode.workspace.getConfiguration('branchWatcher');
	const isProtected = (name: string) => {
		const patterns = config().get<string[]>('protectedBranches', []);
		return patterns.some((pattern) => matchesGlob(name, pattern));
	};

	const tree = new BranchTree(() => ({ root, base }), isProtected);
	const view = vscode.window.createTreeView(viewId, { treeDataProvider: tree, showCollapseAll: true });
	context.subscriptions.push(view);

	const setState = (state: ViewState) => vscode.commands.executeCommand('setContext', 'branchWatcher.state', state);

	const rangeLabel = (range: DateRange) => {
		if (range.kind === 'days') {
			return vscode.l10n.t('últimos {0} dias', range.days);
		}
		return `${range.from} → ${range.to}`;
	};

	const render = async () => {
		const visible = applyFilter(allReports, filter);
		tree.setReports(visible);

		const conflicts = visible.filter((report) => report.status === 'conflict').length;
		const tooltip = vscode.l10n.t('{0} branch(es) vão conflitar com {1}', conflicts, base ?? '');
		view.badge = conflicts > 0 ? { value: conflicts, tooltip } : undefined;

		const parts = [vscode.l10n.t('base: {0}', base ?? '')];
		if (filter.author) {
			parts.push(vscode.l10n.t('autor: {0}', filter.author));
		}
		if (filter.range) {
			parts.push(rangeLabel(filter.range));
		}
		view.description = parts.join(' · ');
		await vscode.commands.executeCommand('setContext', 'branchWatcher.filtered', isFiltered(filter));
	};

	const clearView = () => {
		previous = new Map();
		allReports = [];
		tree.setReports([]);
		view.badge = undefined;
		view.description = undefined;
		view.message = undefined;
	};

	const notifyNewConflicts = (reports: BranchReport[]) => {
		const newConflicts = reports.filter((report) => report.status === 'conflict' && previous.get(report.name) === 'clean');
		if (newConflicts.length === 0 || !config().get<boolean>('notifyNewConflicts', true)) {
			return;
		}
		const show = vscode.l10n.t('Ver');
		const resolve = vscode.l10n.t('Resolver');
		const single = newConflicts.length === 1;
		const message = single
			? vscode.l10n.t('{0} passou a conflitar com {1}.', newConflicts[0].name, base ?? '')
			: vscode.l10n.t('{0} branches passaram a conflitar com {1}.', newConflicts.length, base ?? '');
		const actions = single ? [show, resolve] : [show];
		void vscode.window.showWarningMessage(message, ...actions).then((choice) => {
			if (choice === show) {
				void vscode.commands.executeCommand(`${viewId}.focus`);
			}
			if (choice === resolve) {
				void vscode.commands.executeCommand('branchWatcher.resolve', { kind: 'branch', report: newConflicts[0] });
			}
		});
	};

	const analyzeNow = async () => {
		if (!root) {
			clearView();
			await setState('noRepo');
			return;
		}
		if (!base || !(await refExists(root, base))) {
			clearView();
			await setState('noBase');
			return;
		}
		const reports = await analyzeBranches(root, base);
		notifyNewConflicts(applyFilter(reports, filter));
		previous = new Map(reports.map((report) => [report.name, report.status]));
		allReports = reports;
		await render();
		await setState('ready');
	};

	const refresh = async (): Promise<void> => {
		if (running) {
			pending = true;
			return;
		}
		running = true;
		try {
			await vscode.window.withProgress({ location: { viewId } }, analyzeNow);
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Branch Watcher: falha ao analisar branches. {0}', String(error)));
		} finally {
			running = false;
			if (pending) {
				pending = false;
				void refresh();
			}
		}
	};

	const fetchAndRefresh = async () => {
		if (!root) {
			return refresh();
		}
		const repo = root;
		const error = await vscode.window.withProgress({ location: { viewId } }, () => fetchAll(repo));
		const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		view.message = error ? vscode.l10n.t('Fetch falhou às {0}; usando refs locais. {1}', time, error) : undefined;
		await refresh();
	};

	const scheduleFetch = () => {
		clearInterval(fetchTimer);
		const minutes = config().get<number>('fetchIntervalMinutes', 10);
		if (minutes > 0) {
			fetchTimer = setInterval(() => void fetchAndRefresh(), minutes * 60_000);
		}
	};

	const watchRefs = async () => {
		refsWatcher?.dispose();
		refsWatcher = undefined;
		if (!root) {
			return;
		}
		const gitDir = await gitCommonDir(root);
		const pattern = new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,packed-refs,refs/**}');
		refsWatcher = vscode.workspace.createFileSystemWatcher(pattern);
		const onChange = () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void refresh(), 1000);
		};
		refsWatcher.onDidChange(onChange);
		refsWatcher.onDidCreate(onChange);
		refsWatcher.onDidDelete(onChange);
	};

	const selectRepo = async (repo: string | undefined) => {
		root = repo;
		await context.workspaceState.update('repo', repo);
		const stored = repo ? context.workspaceState.get<string>(`base:${repo}`) : undefined;
		base = stored ?? (repo ? await defaultBase(repo) : undefined);
		filter = (repo ? context.workspaceState.get<BranchFilter>(`filter:${repo}`) : undefined) ?? {};
		clearView();
		await watchRefs();
		await refresh();
		await fetchAndRefresh();
	};

	const init = async () => {
		await setState('loading');
		const folders = vscode.workspace.workspaceFolders ?? [];
		const roots = await Promise.all(folders.map((folder) => repoRoot(folder.uri.fsPath)));
		const found = roots.filter((repo): repo is string => repo !== undefined);
		repos = [...new Set(found)];
		await vscode.commands.executeCommand('setContext', 'branchWatcher.multiRepo', repos.length > 1);

		if (repos.length > 0 && !(await supportsMergeTree(repos[0]))) {
			await setState('oldGit');
			return;
		}
		const stored = context.workspaceState.get<string>('repo');
		const selected = stored && repos.includes(stored) ? stored : repos[0];
		await selectRepo(selected);
	};

	const requireRepo = () => {
		if (!root || !base) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Nenhum repositório ou Branch base selecionado.'));
			return undefined;
		}
		return { repo: root, baseRef: base };
	};

	const blockedByOperation = async (repo: string) => {
		const state = await repoState(repo);
		if (state.operation) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Há um merge, rebase ou cherry-pick em andamento. Conclua-o antes.'));
		}
		return state;
	};

	const saveFilter = async (next: BranchFilter) => {
		filter = next;
		if (root) {
			await context.workspaceState.update(`filter:${root}`, filter);
		}
		await render();
	};

	const pickAuthor = async () => {
		const counts = new Map<string, number>();
		for (const report of allReports) {
			counts.set(report.author, (counts.get(report.author) ?? 0) + 1);
		}
		const authors = [...counts.keys()].sort((a, b) => a.localeCompare(b));
		const current = vscode.l10n.t('atual');
		const anyAuthor = { label: vscode.l10n.t('Todos os autores'), author: undefined, description: filter.author ? undefined : current };
		const authorItems = authors.map((author) => ({
			label: author,
			author,
			description: vscode.l10n.t('{0} branch(es)', counts.get(author) ?? 0) + (author === filter.author ? ` · ${current}` : ''),
		}));
		const picked = await vscode.window.showQuickPick([anyAuthor, ...authorItems], {
			placeHolder: vscode.l10n.t('Autor do último commit'),
			matchOnDescription: false,
		});
		if (picked) {
			await saveFilter({ ...filter, author: picked.author });
		}
	};

	const askDay = (prompt: string, value: string, min?: Date) =>
		vscode.window.showInputBox({
			prompt,
			value,
			placeHolder: 'AAAA-MM-DD',
			validateInput: (input) => {
				const day = parseDay(input);
				if (!day) {
					return vscode.l10n.t('Use o formato AAAA-MM-DD.');
				}
				if (min && day < min) {
					return vscode.l10n.t('A data final não pode ser anterior à inicial.');
				}
				return undefined;
			},
		});

	const pickRange = async () => {
		const current = filter.range;
		const currentLabel = vscode.l10n.t('atual');
		const preset = (label: string, range: DateRange | undefined) => ({
			label,
			range,
			custom: false,
			description: JSON.stringify(range) === JSON.stringify(current) ? currentLabel : undefined,
		});
		const customItem = {
			label: vscode.l10n.t('Personalizado...'),
			range: undefined,
			custom: true,
			description: current?.kind === 'custom' ? `${rangeLabel(current)} · ${currentLabel}` : undefined,
		};
		const items = [
			preset(vscode.l10n.t('Qualquer data'), undefined),
			preset(vscode.l10n.t('Últimos 7 dias'), { kind: 'days', days: 7 }),
			preset(vscode.l10n.t('Últimos 30 dias'), { kind: 'days', days: 30 }),
			preset(vscode.l10n.t('Últimos 90 dias'), { kind: 'days', days: 90 }),
			customItem,
		];
		const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Data do último commit') });
		if (!picked) {
			return;
		}
		if (!picked.custom) {
			await saveFilter({ ...filter, range: picked.range });
			return;
		}
		const today = new Date();
		const monthAgo = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
		const previousCustom = current?.kind === 'custom' ? current : undefined;
		const from = await askDay(vscode.l10n.t('Data inicial'), previousCustom?.from ?? formatDay(monthAgo));
		if (!from) {
			return;
		}
		const to = await askDay(vscode.l10n.t('Data final'), previousCustom?.to ?? formatDay(today), parseDay(from));
		if (!to) {
			return;
		}
		await saveFilter({ ...filter, range: { kind: 'custom', from: from.trim(), to: to.trim() } });
	};

	const chooseFilter = async () => {
		const items = [
			{ label: `$(person) ${vscode.l10n.t('Autor')}`, description: filter.author ?? vscode.l10n.t('todos'), action: pickAuthor },
			{ label: `$(calendar) ${vscode.l10n.t('Data do último commit')}`, description: filter.range ? rangeLabel(filter.range) : vscode.l10n.t('qualquer data'), action: pickRange },
		];
		if (isFiltered(filter)) {
			items.push({ label: `$(clear-all) ${vscode.l10n.t('Limpar filtros')}`, description: '', action: () => saveFilter({}) });
		}
		const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Filtrar branches') });
		await picked?.action();
	};

	const chooseBase = async () => {
		if (!root) {
			return;
		}
		const repo = root;
		const { remotes, locals } = await listRefs(repo);
		const separator = (label: string) => ({ label, kind: vscode.QuickPickItemKind.Separator });
		const toItem = (ref: string) => ({ label: ref, description: ref === base ? vscode.l10n.t('atual') : undefined });
		const items = [
			separator(vscode.l10n.t('Remotas')),
			...remotes.map(toItem),
			separator(vscode.l10n.t('Locais')),
			...locals.map(toItem),
		];
		const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Escolha a Branch base') });
		if (!picked) {
			return;
		}
		base = picked.label;
		await context.workspaceState.update(`base:${repo}`, base);
		clearView();
		await refresh();
	};

	const chooseRepo = async () => {
		const items = repos.map((repo) => ({ label: vscode.workspace.asRelativePath(repo, false) || repo, description: repo, repo }));
		const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Escolha o repositório observado') });
		if (picked) {
			await selectRepo(picked.repo);
		}
	};

	const openDiff = async (node: Node) => {
		if (node.kind !== 'file' || !base) {
			return;
		}
		const side = (ref: string) => vscode.Uri.from({ scheme: diffScheme, path: `/${node.file}`, query: ref });
		const title = `${node.file} (${base} ↔ ${node.report.name})`;
		await vscode.commands.executeCommand('vscode.diff', side(base), side(`refs/heads/${node.report.name}`), title);
	};

	const resolve = async (node: Node) => {
		const selected = requireRepo();
		if (node.kind !== 'branch' || !selected) {
			return;
		}
		const { repo, baseRef } = selected;
		const state = await blockedByOperation(repo);
		if (state.operation) {
			return;
		}
		if (state.dirty) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Há alterações não commitadas. Faça commit ou stash antes de resolver.'));
			return;
		}
		try {
			const outcome = await resolveConflicts(repo, node.report.name, baseRef);
			if (outcome === 'merged') {
				void vscode.window.showInformationMessage(vscode.l10n.t('{0} recebeu {1} sem conflitos.', node.report.name, baseRef));
				return;
			}
			void vscode.window.showInformationMessage(vscode.l10n.t('Resolva os conflitos de {0} e faça commit do merge.', node.report.name));
			await vscode.commands.executeCommand('workbench.view.scm');
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Não foi possível resolver {0}. {1}', node.report.name, String(error)));
		}
	};

	const remoteLabel = (outcome: RemoteOutcome) => {
		switch (outcome) {
			case 'deleted':
				return vscode.l10n.t('local e upstream excluídos');
			case 'kept':
				return vscode.l10n.t('upstream mantido: tem commits não integrados');
			case 'protected':
				return vscode.l10n.t('upstream mantido: protegido');
			case 'gone':
				return vscode.l10n.t('upstream já não existia');
			case 'none':
				return vscode.l10n.t('sem upstream');
		}
	};

	const cleanup = async (candidates: BranchReport[], pick: boolean) => {
		const selected = requireRepo();
		if (!selected) {
			return;
		}
		const { repo, baseRef } = selected;
		const state = await blockedByOperation(repo);
		if (state.operation) {
			return;
		}
		const current = await currentBranch(repo);
		const unprotected = candidates.filter((report) => !isProtected(report.name));
		const eligible = unprotected.filter((report) => report.name !== current);
		const skippedCurrent = unprotected.length !== eligible.length;
		const currentNote = skippedCurrent ? vscode.l10n.t('{0} está em checkout e não será excluída.', current) : '';

		if (eligible.length === 0) {
			void vscode.window.showInformationMessage(currentNote || vscode.l10n.t('Nenhuma branch integrada para excluir.'));
			return;
		}

		const describe = (report: BranchReport) => report.upstream ? vscode.l10n.t('local + {0}', report.upstream) : vscode.l10n.t('só local');
		let chosen = eligible;
		if (pick) {
			const items = eligible.map((report) => ({ label: report.name, description: describe(report), picked: true, report }));
			const picked = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				placeHolder: vscode.l10n.t('Branches integradas em {0} a excluir', baseRef),
			});
			if (!picked || picked.length === 0) {
				return;
			}
			chosen = picked.map((item) => item.report);
		}

		const lines = chosen.map((report) => `• ${report.name} (${describe(report)})`);
		const detail = [
			...lines,
			'',
			vscode.l10n.t('Cada upstream passa por fetch antes e só é excluído se não tiver commits fora de {0}.', baseRef),
			currentNote,
		].join('\n');
		const confirm = vscode.l10n.t('Excluir');
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t('Excluir {0} branch(es) integrada(s)?', chosen.length),
			{ modal: true, detail },
			confirm,
		);
		if (answer !== confirm) {
			return;
		}

		const results = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Excluindo branches') },
			async (progress) => {
				const outcomes: string[] = [];
				for (const report of chosen) {
					progress.report({ message: report.name });
					try {
						const outcome = await deleteIntegrated(repo, report.name, baseRef, isProtected);
						outcomes.push(`${report.name}: ${remoteLabel(outcome)}`);
					} catch (error) {
						outcomes.push(`${report.name}: ${vscode.l10n.t('erro')} — ${String(error)}`);
					}
				}
				return outcomes;
			},
		);
		void vscode.window.showInformationMessage(vscode.l10n.t('Limpeza concluída.'), { modal: true, detail: results.join('\n') });
		await refresh();
	};

	const integratedReports = () => tree.getReports().filter((report) => report.status === 'integrated');

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(diffScheme, {
			provideTextDocumentContent: async (uri) => {
				if (!root) {
					return '';
				}
				const result = await git(root, ['show', `${uri.query}:${uri.path.slice(1)}`]);
				return result.code === 0 ? result.stdout : '';
			},
		}),
		vscode.commands.registerCommand('branchWatcher.refresh', fetchAndRefresh),
		vscode.commands.registerCommand('branchWatcher.chooseBase', chooseBase),
		vscode.commands.registerCommand('branchWatcher.filter', chooseFilter),
		vscode.commands.registerCommand('branchWatcher.filterActive', chooseFilter),
		vscode.commands.registerCommand('branchWatcher.clearFilters', () => saveFilter({})),
		vscode.commands.registerCommand('branchWatcher.chooseRepo', chooseRepo),
		vscode.commands.registerCommand('branchWatcher.openDiff', openDiff),
		vscode.commands.registerCommand('branchWatcher.resolve', resolve),
		vscode.commands.registerCommand('branchWatcher.cleanup', () => cleanup(integratedReports(), true)),
		vscode.commands.registerCommand('branchWatcher.deleteBranch', (node: Node) => {
			if (node.kind === 'branch') {
				return cleanup([node.report], false);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('branchWatcher.fetchIntervalMinutes')) {
				scheduleFetch();
			}
			if (event.affectsConfiguration('branchWatcher.protectedBranches')) {
				tree.setReports(tree.getReports());
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => void init()),
		{
			dispose: () => {
				clearInterval(fetchTimer);
				clearTimeout(debounce);
				refsWatcher?.dispose();
			},
		},
	);

	scheduleFetch();
	void init();
}

export function deactivate() {}
