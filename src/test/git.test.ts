import * as assert from 'assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { analyzeBranches, deleteIntegrated, gitOk, matchesGlob } from '../git';

async function commit(root: string, file: string, content: string, message: string) {
	writeFileSync(path.join(root, file), content);
	await gitOk(root, ['add', file]);
	await gitOk(root, ['commit', '-m', message]);
}

async function createRepo(): Promise<string> {
	const root = mkdtempSync(path.join(tmpdir(), 'branch-watcher-'));
	await gitOk(root, ['init', '-b', 'main']);
	await gitOk(root, ['config', 'user.email', 'test@example.com']);
	await gitOk(root, ['config', 'user.name', 'Test']);
	await commit(root, 'shared.txt', 'original\n', 'inicial');

	await gitOk(root, ['switch', '-c', 'feature/conflito']);
	await commit(root, 'shared.txt', 'da branch\n', 'altera shared');

	await gitOk(root, ['switch', '-c', 'feature/limpa', 'main']);
	await commit(root, 'novo.txt', 'novo\n', 'adiciona novo');

	await gitOk(root, ['switch', '-c', 'feature/integrada', 'main']);
	await commit(root, 'integrada.txt', 'x\n', 'integrada');

	await gitOk(root, ['switch', 'main']);
	await gitOk(root, ['merge', '--no-ff', '--no-edit', 'feature/integrada']);
	await commit(root, 'shared.txt', 'da main\n', 'altera shared na main');
	return root;
}

suite('analyzeBranches', () => {
	test('classifica branches em conflitante, limpa e integrada, ignorando a própria base', async () => {
		const root = await createRepo();

		const reports = await analyzeBranches(root, 'main');
		const byName = new Map(reports.map((report) => [report.name, report]));

		assert.deepStrictEqual([...byName.keys()].sort(), ['feature/conflito', 'feature/integrada', 'feature/limpa']);
		assert.strictEqual(byName.get('feature/conflito')?.status, 'conflict');
		assert.deepStrictEqual(byName.get('feature/conflito')?.files, ['shared.txt']);
		assert.strictEqual(byName.get('feature/limpa')?.status, 'clean');
		assert.strictEqual(byName.get('feature/limpa')?.ahead, 1);
		assert.strictEqual(byName.get('feature/limpa')?.behind, 3);
		assert.strictEqual(byName.get('feature/integrada')?.status, 'integrated');
		assert.strictEqual(byName.get('feature/limpa')?.author, 'Test');
		assert.ok(Math.abs((byName.get('feature/limpa')?.date ?? 0) - Date.now()) < 60_000);
	});

	test('exclui branch integrada sem upstream apenas localmente', async () => {
		const root = await createRepo();

		const outcome = await deleteIntegrated(root, 'feature/integrada', 'main', () => false);

		assert.strictEqual(outcome, 'none');
		const branches = await gitOk(root, ['branch', '--list', 'feature/integrada']);
		assert.strictEqual(branches, '');
	});

	test('recusa excluir branch que não está integrada', async () => {
		const root = await createRepo();

		await assert.rejects(deleteIntegrated(root, 'feature/limpa', 'main', () => false));
	});

	test('mantém upstream com commits não integrados e exclui upstream integrado', async () => {
		const remote = mkdtempSync(path.join(tmpdir(), 'branch-watcher-remote-'));
		await gitOk(remote, ['init', '--bare', '-b', 'main']);
		const root = await createRepo();
		await gitOk(root, ['remote', 'add', 'origin', remote]);
		await gitOk(root, ['push', '-u', 'origin', 'main', 'feature/integrada']);
		await gitOk(root, ['branch', 'feature/outra', 'feature/integrada']);
		await gitOk(root, ['push', '-u', 'origin', 'feature/outra']);

		const clone = mkdtempSync(path.join(tmpdir(), 'branch-watcher-clone-'));
		await gitOk(clone, ['clone', '-b', 'feature/outra', remote, '.']);
		await gitOk(clone, ['config', 'user.email', 'colega@example.com']);
		await gitOk(clone, ['config', 'user.name', 'Colega']);
		await commit(clone, 'colega.txt', 'trabalho\n', 'trabalho do colega');
		await gitOk(clone, ['push']);

		const kept = await deleteIntegrated(root, 'feature/outra', 'origin/main', () => false);
		const deleted = await deleteIntegrated(root, 'feature/integrada', 'origin/main', () => false);

		assert.strictEqual(kept, 'kept');
		assert.strictEqual(deleted, 'deleted');
		const remoteBranches = await gitOk(remote, ['branch', '--list']);
		assert.match(remoteBranches, /feature\/outra/);
		assert.doesNotMatch(remoteBranches, /feature\/integrada/);
	});
});

suite('matchesGlob', () => {
	test('casa nome exato e curinga', () => {
		assert.ok(matchesGlob('main', 'main'));
		assert.ok(matchesGlob('release/1.0', 'release/*'));
		assert.ok(!matchesGlob('mainline', 'main'));
	});
});
