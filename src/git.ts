import { execFile } from 'node:child_process';

export type BranchStatus = 'conflict' | 'clean' | 'integrated' | 'error';

export interface BranchReport {
	name: string;
	status: BranchStatus;
	ahead: number;
	behind: number;
	files: string[];
	author: string;
	date: number;
	upstream?: string;
	error?: string;
}

interface LocalBranch {
	name: string;
	upstream?: string;
	author: string;
	date: number;
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type RemoteOutcome = 'deleted' | 'kept' | 'protected' | 'gone' | 'none';

export function git(cwd: string, args: string[], timeout = 0): Promise<GitResult> {
	const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	return new Promise((resolve) => {
		execFile('git', args, { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = !error ? 0 : typeof error.code === 'number' ? error.code : -1;
			resolve({ code, stdout, stderr: stderr || error?.message || '' });
		});
	});
}

export async function gitOk(cwd: string, args: string[], timeout = 0): Promise<string> {
	const result = await git(cwd, args, timeout);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `git ${args[0]} exit ${result.code}`);
	}
	return result.stdout.trim();
}

export async function supportsMergeTree(cwd: string): Promise<boolean> {
	const result = await git(cwd, ['version']);
	const match = /(\d+)\.(\d+)/.exec(result.stdout);
	if (!match) {
		return false;
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 2 || (major === 2 && minor >= 38);
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ['rev-parse', '--show-toplevel']);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

export function gitCommonDir(root: string): Promise<string> {
	return gitOk(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
}

export async function refExists(root: string, ref: string): Promise<boolean> {
	const result = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
	return result.code === 0;
}

export async function defaultBase(root: string): Promise<string | undefined> {
	const originHead = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
	if (originHead.code === 0) {
		return originHead.stdout.trim();
	}
	for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
		if (await refExists(root, candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export async function listRefs(root: string): Promise<{ remotes: string[]; locals: string[] }> {
	const output = await gitOk(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/heads']);
	const refs = output.split('\n').filter((ref) => ref && !ref.endsWith('/HEAD'));
	const remoteRefs = refs.filter((ref) => ref.startsWith('refs/remotes/'));
	const localRefs = refs.filter((ref) => ref.startsWith('refs/heads/'));
	const remotes = remoteRefs.map((ref) => ref.slice('refs/remotes/'.length));
	const locals = localRefs.map((ref) => ref.slice('refs/heads/'.length));
	return { remotes, locals };
}

export async function currentBranch(root: string): Promise<string> {
	return gitOk(root, ['branch', '--show-current']);
}

export async function repoState(root: string): Promise<{ dirty: boolean; operation: boolean }> {
	const status = await gitOk(root, ['status', '--porcelain', '--untracked-files=no']);
	const markers = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
	const checks = await Promise.all(markers.map((marker) => git(root, ['rev-parse', '--verify', '--quiet', marker])));
	const operation = checks.some((check) => check.code === 0);
	return { dirty: status !== '', operation };
}

export async function fetchAll(root: string): Promise<string | undefined> {
	const result = await git(root, ['fetch', '--all', '--prune'], 120_000);
	return result.code === 0 ? undefined : result.stderr.trim() || 'fetch';
}

async function localCounterpart(root: string, base: string): Promise<string | undefined> {
	const fullName = await gitOk(root, ['rev-parse', '--symbolic-full-name', base]);
	if (fullName.startsWith('refs/heads/')) {
		return fullName.slice('refs/heads/'.length);
	}
	if (fullName.startsWith('refs/remotes/')) {
		const withoutPrefix = fullName.slice('refs/remotes/'.length);
		return withoutPrefix.slice(withoutPrefix.indexOf('/') + 1);
	}
	return undefined;
}

export function parseMergeTreeFiles(stdout: string): string[] {
	const entries = stdout.split('\0').filter((entry) => entry !== '');
	return entries.slice(1);
}

async function analyzeBranch(root: string, base: string, branch: LocalBranch): Promise<BranchReport> {
	const ref = `refs/heads/${branch.name}`;
	const report: BranchReport = { ...branch, status: 'clean', ahead: 0, behind: 0, files: [] };

	const ancestor = await git(root, ['merge-base', '--is-ancestor', ref, base]);
	if (ancestor.code === 0) {
		return { ...report, status: 'integrated' };
	}

	const counts = await git(root, ['rev-list', '--left-right', '--count', `${base}...${ref}`]);
	const mergeTree = await git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base, ref]);
	const failed = [ancestor, counts, mergeTree].find((result) => result.code > 1 || result.code < 0);
	if (failed || counts.code !== 0) {
		return { ...report, status: 'error', error: (failed ?? counts).stderr.trim() };
	}

	const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
	if (mergeTree.code === 1) {
		return { ...report, status: 'conflict', ahead, behind, files: parseMergeTreeFiles(mergeTree.stdout) };
	}
	return { ...report, ahead, behind };
}

export async function analyzeBranches(root: string, base: string): Promise<BranchReport[]> {
	const counterpart = await localCounterpart(root, base);
	const format = '--format=%(refname:short)%09%(upstream:short)%09%(authorname)%09%(committerdate:unix)';
	const output = await gitOk(root, ['for-each-ref', format, 'refs/heads']);
	const lines = output.split('\n').filter((line) => line !== '');
	const branches = lines.map((line): LocalBranch => {
		const [name, upstream, author, date] = line.split('\t');
		return { name, upstream: upstream || undefined, author, date: Number(date) * 1000 };
	});
	const analyzed = branches.filter((branch) => branch.name !== counterpart);

	const reports: BranchReport[] = [];
	for (const branch of analyzed) {
		reports.push(await analyzeBranch(root, base, branch));
	}
	return reports;
}

export function matchesGlob(name: string, pattern: string): boolean {
	const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
	return new RegExp(`^${parts.join('.*')}$`).test(name);
}

export async function resolveConflicts(root: string, branch: string, base: string): Promise<'merged' | 'conflict'> {
	await gitOk(root, ['switch', branch]);
	const merge = await git(root, ['merge', '--no-edit', base]);
	if (merge.code === 0) {
		return 'merged';
	}
	const mergeHead = await git(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
	if (mergeHead.code === 0) {
		return 'conflict';
	}
	throw new Error(merge.stderr.trim());
}

async function deleteUpstream(root: string, branch: string, base: string, isProtected: (name: string) => boolean): Promise<RemoteOutcome> {
	const remote = await git(root, ['config', `branch.${branch}.remote`]);
	const merge = await git(root, ['config', `branch.${branch}.merge`]);
	const remoteName = remote.stdout.trim();
	const mergeRef = merge.stdout.trim();
	if (remote.code !== 0 || merge.code !== 0 || remoteName === '.' || !mergeRef.startsWith('refs/heads/')) {
		return 'none';
	}

	const remoteBranch = mergeRef.slice('refs/heads/'.length);
	if (isProtected(remoteBranch) || `${remoteName}/${remoteBranch}` === base) {
		return 'protected';
	}

	const lsRemote = await git(root, ['ls-remote', '--exit-code', '--heads', remoteName, mergeRef], 60_000);
	if (lsRemote.code === 2) {
		return 'gone';
	}
	if (lsRemote.code !== 0) {
		throw new Error(lsRemote.stderr.trim());
	}

	await gitOk(root, ['fetch', remoteName, mergeRef], 120_000);
	const integrated = await git(root, ['merge-base', '--is-ancestor', 'FETCH_HEAD', base]);
	if (integrated.code !== 0) {
		return 'kept';
	}

	await gitOk(root, ['push', remoteName, '--delete', remoteBranch], 120_000);
	return 'deleted';
}

export async function deleteIntegrated(root: string, branch: string, base: string, isProtected: (name: string) => boolean): Promise<RemoteOutcome> {
	const ref = `refs/heads/${branch}`;
	const stillIntegrated = await git(root, ['merge-base', '--is-ancestor', ref, base]);
	if (stillIntegrated.code !== 0) {
		throw new Error(`${branch} not integrated`);
	}
	const remote = await deleteUpstream(root, branch, base, isProtected);
	await gitOk(root, ['branch', '-D', branch]);
	return remote;
}
