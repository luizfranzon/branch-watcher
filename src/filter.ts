import { BranchReport } from './git';

export type DateRange = { kind: 'days'; days: number } | { kind: 'custom'; from: string; to: string };

export interface BranchFilter {
	author?: string;
	range?: DateRange;
}

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDay(value: string): Date | undefined {
	const match = dayPattern.exec(value.trim());
	if (!match) {
		return undefined;
	}
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	const sameDay = date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]);
	return sameDay ? date : undefined;
}

export function formatDay(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

function rangeBounds(range: DateRange, now: Date): { since: number; until: number } {
	if (range.kind === 'days') {
		const since = now.getTime() - range.days * 24 * 60 * 60 * 1000;
		return { since, until: Number.POSITIVE_INFINITY };
	}
	const from = parseDay(range.from)?.getTime() ?? Number.NEGATIVE_INFINITY;
	const to = parseDay(range.to);
	const endOfDay = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() - 1 : Number.POSITIVE_INFINITY;
	return { since: from, until: endOfDay };
}

export function applyFilter(reports: BranchReport[], filter: BranchFilter, now = new Date()): BranchReport[] {
	const byAuthor = filter.author ? reports.filter((report) => report.author === filter.author) : reports;
	if (!filter.range) {
		return byAuthor;
	}
	const { since, until } = rangeBounds(filter.range, now);
	return byAuthor.filter((report) => report.date >= since && report.date <= until);
}

export function isFiltered(filter: BranchFilter): boolean {
	return filter.author !== undefined || filter.range !== undefined;
}
