import * as assert from 'assert';
import { applyFilter, parseDay } from '../filter';
import { BranchReport } from '../git';

function report(name: string, author: string, day: string): BranchReport {
	const date = parseDay(day)?.getTime() ?? 0;
	return { name, author, date: date + 12 * 60 * 60 * 1000, status: 'clean', ahead: 0, behind: 0, files: [] };
}

const reports = [
	report('a', 'Ana', '2026-11-01'),
	report('b', 'Bruno', '2026-11-20'),
	report('c', 'Ana', '2026-11-25'),
];
const now = new Date(2026, 10, 26, 12);

function names(list: BranchReport[]): string[] {
	return list.map((item) => item.name);
}

suite('applyFilter', () => {
	test('devolve todas as branches sem filtro', () => {
		assert.deepStrictEqual(names(applyFilter(reports, {}, now)), ['a', 'b', 'c']);
	});

	test('filtra pelo autor do último commit', () => {
		assert.deepStrictEqual(names(applyFilter(reports, { author: 'Ana' }, now)), ['a', 'c']);
	});

	test('filtra pelos últimos N dias', () => {
		const filtered = applyFilter(reports, { range: { kind: 'days', days: 7 } }, now);
		assert.deepStrictEqual(names(filtered), ['b', 'c']);
	});

	test('range personalizado inclui o dia final inteiro', () => {
		const filtered = applyFilter(reports, { range: { kind: 'custom', from: '2026-11-01', to: '2026-11-20' } }, now);
		assert.deepStrictEqual(names(filtered), ['a', 'b']);
	});

	test('combina autor e data', () => {
		const filtered = applyFilter(reports, { author: 'Ana', range: { kind: 'days', days: 7 } }, now);
		assert.deepStrictEqual(names(filtered), ['c']);
	});
});

suite('parseDay', () => {
	test('rejeita formato inválido e dia inexistente', () => {
		assert.strictEqual(parseDay('26/11/2026'), undefined);
		assert.strictEqual(parseDay('2026-02-30'), undefined);
		assert.ok(parseDay('2026-02-28'));
	});
});
