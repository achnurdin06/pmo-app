/**
 * Rekalkulasi kolom `calc*` satu project (FR-ENG-01..03).
 *
 * ATURAN (AGENTS.md #4/#5): semua rumus ada di `engine/`. File ini hanya memuat data,
 * memanggil engine, lalu menyimpan hasilnya — tidak ada rumus yang ditulis ulang di sini.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import {
	milestones,
	progressEvents,
	projects,
	raidItems,
	tasks,
	workItems,
	type progressStatus,
	type ragStatus
} from '#lib/server/db/schema.ts';
import {
	DEFAULT_RAG,
	DEFAULT_STATUS_MAP,
	computeCalcProjection,
	todayJakarta,
	type CalcProjection,
	type EngineSettings,
	type ISODate,
	type ProgressStatus
} from '#lib/server/engine/index.ts';
import { getSetting } from './master.service';

type Executor = Pick<typeof db, 'select' | 'update' | 'insert'>;

/** Threshold RAG & mapping status→progress dari Pengaturan Sistem (PRD §8.3), fallback ke default engine. */
export async function loadEngineSettings(): Promise<EngineSettings> {
	const [ragRaw, mapRaw] = await Promise.all([
		getSetting('rag_thresholds'),
		getSetting('status_progress_map')
	]);
	const r = (ragRaw ?? {}) as Partial<typeof DEFAULT_RAG>;
	const m = (mapRaw ?? {}) as Partial<Record<ProgressStatus, number>>;
	return {
		rag: {
			green: typeof r.green === 'number' ? r.green : DEFAULT_RAG.green,
			amber: typeof r.amber === 'number' ? r.amber : DEFAULT_RAG.amber
		},
		statusMap: { ...DEFAULT_STATUS_MAP, ...m } as Record<ProgressStatus, number>
	};
}

/**
 * Idempoten: memuat ulang seluruh level project, menghitung, lalu menyimpan kolom `calc*`.
 * Panggil di dalam transaksi perubahan data agar hasil baca & tulis konsisten (FR-ENG-01).
 */
export async function recalculateProject(
	projectId: string,
	tx?: Executor,
	today: ISODate = todayJakarta()
): Promise<CalcProjection | null> {
	const ex = tx ?? db;
	const [project] = await ex.select().from(projects).where(eq(projects.id, projectId));
	if (!project) return null;

	const [msRows, taskRows, raidRows] = await Promise.all([
		ex
			.select({
				id: milestones.id,
				weight: milestones.weight,
				plannedStart: milestones.plannedStart,
				plannedFinish: milestones.plannedFinish,
				actualFinish: milestones.actualFinish
			})
			.from(milestones)
			.where(eq(milestones.projectId, projectId))
			.orderBy(asc(milestones.seq)),
		ex
			.select({
				id: tasks.id,
				milestoneId: tasks.milestoneId,
				weight: tasks.weight,
				actualStart: tasks.actualStart,
				actualFinish: tasks.actualFinish
			})
			.from(tasks)
			.where(eq(tasks.projectId, projectId))
			.orderBy(asc(tasks.seq)),
		ex
			.select({ severity: raidItems.severity, status: raidItems.status })
			.from(raidItems)
			.where(eq(raidItems.projectId, projectId))
	]);

	const wiRows = taskRows.length
		? await ex
				.select({
					id: workItems.id,
					taskId: workItems.taskId,
					weight: workItems.weight,
					status: workItems.status
				})
				.from(workItems)
				.where(
					inArray(
						workItems.taskId,
						taskRows.map((t) => t.id)
					)
				)
		: [];

	const projection = computeCalcProjection(
		{
			id: project.id,
			baselineStart: project.baselineStart,
			baselineFinish: project.baselineFinish
		},
		msRows,
		taskRows,
		wiRows,
		raidRows,
		today,
		await loadEngineSettings()
	);

	for (const w of projection.workItems) {
		await ex
			.update(workItems)
			.set({ calcProgress: w.progress, calcWeightedContribution: w.weighted })
			.where(eq(workItems.id, w.id));
	}

	// Actual Start/Finish terisi otomatis saat progress mulai / mencapai 100% (FR-MS-01, FR-TSK-01).
	const taskById = new Map(taskRows.map((t) => [t.id, t]));
	for (const t of projection.tasks) {
		const row = taskById.get(t.id)!;
		const patch: Partial<typeof tasks.$inferInsert> = {
			calcProgress: t.progress,
			calcStatus: t.status,
			calcWeightedContribution: t.weighted,
			calcEffWeight: t.effWeight
		};
		if (t.progress > 0 && !row.actualStart) patch.actualStart = today;
		if (t.progress >= 1 && !row.actualFinish) patch.actualFinish = today;
		await ex.update(tasks).set(patch).where(eq(tasks.id, t.id));
	}

	const msById = new Map(msRows.map((m) => [m.id, m]));
	for (const m of projection.milestones) {
		const row = msById.get(m.id)!;
		const patch: Partial<typeof milestones.$inferInsert> = {
			calcProgress: m.progress,
			calcStatus: m.status,
			calcWeightedContribution: m.weighted,
			calcHealth: m.health
		};
		if (m.progress >= 1 && !row.actualFinish) patch.actualFinish = today;
		await ex.update(milestones).set(patch).where(eq(milestones.id, m.id));
	}

	const pr = projection.project;
	await ex
		.update(projects)
		.set({
			calcOverallProgress: pr.overallProgress,
			calcPlannedProgress: pr.plannedProgress,
			calcVariance: pr.variance,
			calcRag: pr.rag as (typeof ragStatus.enumValues)[number],
			calcStatus: pr.status as (typeof progressStatus.enumValues)[number],
			calcMilestoneCount: pr.milestoneCount,
			calcOverdueMilestones: pr.overdueMilestones,
			calcOpenHighRaid: pr.openHighRaid,
			lastCalculatedAt: new Date()
		})
		.where(eq(projects.id, projectId));

	return projection;
}

/** Rekalkulasi banyak project sekaligus (job malam FR-ENG-03, setelah import). */
export async function recalculateProjects(projectIds: string[], today: ISODate = todayJakarta()) {
	let done = 0;
	for (const id of projectIds) {
		if (await recalculateProject(id, undefined, today)) done++;
	}
	return done;
}

/** Rekalkulasi seluruh project — dipakai scheduled job & setelah import massal. */
export async function recalculateAllProjects(today: ISODate = todayJakarta()) {
	const rows = await db.select({ id: projects.id }).from(projects);
	return recalculateProjects(
		rows.map((r) => r.id),
		today
	);
}

/**
 * Ubah status work item: catat `progress_events` (FR-WI-06), set started/completed_at,
 * lalu rekalkulasi project — semuanya dalam satu transaksi.
 */
export async function changeWorkItemStatus(input: {
	workItemId: string;
	toStatus: ProgressStatus;
	changedBy: string;
	evidenceUrl?: string | null;
	today?: ISODate;
}) {
	const today = input.today ?? todayJakarta();
	return db.transaction(async (tx) => {
		const [wi] = await tx.select().from(workItems).where(eq(workItems.id, input.workItemId));
		if (!wi) return null;
		if (wi.status === input.toStatus && input.evidenceUrl === undefined) {
			return { workItemId: wi.id, projectId: wi.projectId, projection: null, unchanged: true };
		}

		const now = new Date();
		const patch: Partial<typeof workItems.$inferInsert> = {
			status: input.toStatus,
			updatedBy: input.changedBy
		};
		if (input.toStatus === 'In Progress' && !wi.startedAt) patch.startedAt = now;
		if (input.toStatus === 'Completed') {
			patch.startedAt = wi.startedAt ?? now;
			patch.completedAt = wi.completedAt ?? now;
		}
		if (input.toStatus === 'Not Started') {
			patch.startedAt = null;
			patch.completedAt = null;
		}
		if (input.evidenceUrl !== undefined) patch.evidenceUrl = input.evidenceUrl;

		await tx.update(workItems).set(patch).where(eq(workItems.id, wi.id));

		const projection = await recalculateProject(wi.projectId, tx, today);
		const wiCalc = projection?.workItems.find((w) => w.id === wi.id);

		await tx.insert(progressEvents).values({
			workItemId: wi.id,
			projectId: wi.projectId,
			fromStatus: wi.status,
			toStatus: input.toStatus,
			progressAfter: wiCalc?.progress ?? 0,
			projectProgressAfter: projection?.project.overallProgress ?? 0,
			changedBy: input.changedBy
		});

		return { workItemId: wi.id, projectId: wi.projectId, projection, unchanged: false };
	});
}
