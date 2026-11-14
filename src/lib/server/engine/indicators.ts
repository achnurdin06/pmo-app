// Indikator project & proyeksi kolom `calc*` (PRD §8.4).
// Fungsi murni: menyusun hasil rollup + planned + RAG + health menjadi satu proyeksi siap simpan.
import type { ISODate } from './dates';
import {
	isOpenHighRaid,
	milestoneHealth,
	plannedProgressLinear,
	ragFromVariance,
	type MilestoneHealth,
	type Rag
} from './schedule';
import { rollupProject, type ProgressStatus } from './rollup';

export interface EngineSettings {
	rag: { green: number; amber: number };
	statusMap: Record<ProgressStatus, number>;
}

export interface ProjectSnapshot {
	id: string;
	baselineStart: ISODate;
	baselineFinish: ISODate;
}

export interface MilestoneSnapshot {
	id: string;
	weight: number;
	plannedStart: ISODate;
	plannedFinish: ISODate;
}

export interface TaskSnapshot {
	id: string;
	milestoneId: string;
	weight: number;
}

export interface WorkItemSnapshot {
	id: string;
	taskId: string;
	weight: number;
	status: ProgressStatus;
}

export interface RaidSnapshot {
	severity: string;
	status: string;
}

export interface CalcProjection {
	workItems: { id: string; progress: number; weighted: number }[];
	tasks: {
		id: string;
		progress: number;
		status: ProgressStatus;
		weighted: number;
		effWeight: number;
	}[];
	milestones: {
		id: string;
		progress: number;
		status: ProgressStatus;
		weighted: number;
		health: MilestoneHealth;
	}[];
	project: {
		overallProgress: number;
		plannedProgress: number;
		variance: number;
		rag: Rag;
		status: ProgressStatus;
		milestoneCount: number;
		overdueMilestones: number;
		openHighRaid: number;
	};
}

/** Hitung seluruh nilai turunan satu project (PRD §8.1–8.5). */
export function computeCalcProjection(
	p: ProjectSnapshot,
	ms: MilestoneSnapshot[],
	ts: TaskSnapshot[],
	wis: WorkItemSnapshot[],
	raids: RaidSnapshot[],
	today: ISODate,
	settings: EngineSettings
): CalcProjection {
	const roll = rollupProject(
		ms.map((m) => ({ id: m.id, weight: m.weight })),
		ts.map((t) => ({ id: t.id, milestoneId: t.milestoneId, weight: t.weight })),
		wis.map((w) => ({ id: w.id, taskId: w.taskId, weight: w.weight, status: w.status })),
		settings.statusMap
	);

	const planned = plannedProgressLinear(p.baselineStart, p.baselineFinish, today);
	const variance = roll.project.progress - planned;

	return {
		workItems: wis.map((w) => {
			const r = roll.workItems.get(w.id)!;
			return { id: w.id, progress: r.progress, weighted: r.weighted };
		}),
		tasks: ts.map((t) => {
			const r = roll.tasks.get(t.id)!;
			return {
				id: t.id,
				progress: r.progress,
				status: r.status,
				weighted: r.weighted,
				effWeight: r.effWeight
			};
		}),
		milestones: ms.map((m) => {
			const r = roll.milestones.get(m.id)!;
			return {
				id: m.id,
				progress: r.progress,
				status: r.status,
				weighted: r.weighted,
				health: milestoneHealth(
					{ plannedStart: m.plannedStart, plannedFinish: m.plannedFinish, progress: r.progress },
					today
				)
			};
		}),
		project: {
			overallProgress: roll.project.progress,
			plannedProgress: planned,
			variance,
			rag: ragFromVariance(variance, settings.rag),
			status: roll.project.status,
			milestoneCount: ms.length,
			overdueMilestones: ms.filter(
				(m) => m.plannedFinish < today && roll.milestones.get(m.id)!.progress < 1
			).length,
			openHighRaid: raids.filter(isOpenHighRaid).length
		}
	};
}
