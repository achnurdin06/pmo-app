import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/schema.ts';
import { milestones, projects, raidItems, tasks, workItems } from '#lib/server/db/schema.ts';
import { recalculateProject, changeWorkItemStatus } from './recalc.service';

const CODE = 'PRJ-ITEST';
let projectId = '';
let actorId = '';
let m1 = '',
	m2 = '',
	t1 = '',
	t3 = '',
	w1 = '';

// Butuh PostgreSQL hidup + hasil `npm run db:seed`.
// Jalankan: RUN_DB_TESTS=1 npx vitest --run src/lib/server/services/recalc.integration.spec.ts
describe.skipIf(!process.env.RUN_DB_TESTS)(
	'recalculateProject (integrasi DB)',
	{ timeout: 60_000 },
	() => {
		beforeAll(async () => {
			await db.delete(projects).where(eq(projects.code, CODE));
			const [admin] = await db.select().from(user).where(eq(user.email, 'admin@pmo.local'));
			actorId = admin.id;
			const [p] = await db
				.insert(projects)
				.values({
					code: CODE,
					name: 'Project Uji Recalc',
					baselineStart: '2026-01-01',
					baselineFinish: '2026-01-11'
				})
				.returning();
			projectId = p.id;
			const [a] = await db
				.insert(milestones)
				.values({
					projectId,
					code: `${CODE}-M1`,
					name: 'M1',
					weight: 0.6,
					plannedStart: '2026-01-01',
					plannedFinish: '2026-01-05'
				})
				.returning();
			const [b] = await db
				.insert(milestones)
				.values({
					projectId,
					code: `${CODE}-M2`,
					name: 'M2',
					weight: 0.4,
					plannedStart: '2026-01-06',
					plannedFinish: '2026-01-11'
				})
				.returning();
			m1 = a.id;
			m2 = b.id;
			const [x] = await db
				.insert(tasks)
				.values({
					projectId,
					milestoneId: m1,
					code: `${CODE}-M1-T1`,
					name: 'T1',
					weight: 0.5,
					plannedStart: '2026-01-01',
					plannedFinish: '2026-01-05'
				})
				.returning();
			const [y] = await db
				.insert(tasks)
				.values({
					projectId,
					milestoneId: m1,
					code: `${CODE}-M1-T2`,
					name: 'T2',
					weight: 0.5,
					plannedStart: '2026-01-01',
					plannedFinish: '2026-01-05'
				})
				.returning();
			const [z] = await db
				.insert(tasks)
				.values({
					projectId,
					milestoneId: m2,
					code: `${CODE}-M2-T1`,
					name: 'T3',
					weight: 1,
					plannedStart: '2026-01-06',
					plannedFinish: '2026-01-11'
				})
				.returning();
			t1 = x.id;
			t3 = z.id;
			const wis = await db
				.insert(workItems)
				.values([
					{
						projectId,
						milestoneId: m1,
						taskId: t1,
						code: `${CODE}-M1-T1-W1`,
						detail: 'W1',
						weight: 0.5,
						status: 'Completed'
					},
					{
						projectId,
						milestoneId: m1,
						taskId: t1,
						code: `${CODE}-M1-T1-W2`,
						detail: 'W2',
						weight: 0.5,
						status: 'Not Started'
					},
					{
						projectId,
						milestoneId: m1,
						taskId: y.id,
						code: `${CODE}-M1-T2-W1`,
						detail: 'W3',
						weight: 1,
						status: 'Completed'
					},
					{
						projectId,
						milestoneId: m2,
						taskId: t3,
						code: `${CODE}-M2-T1-W1`,
						detail: 'W4',
						weight: 1,
						status: 'Not Started'
					}
				])
				.returning();
			w1 = wis[0].id;
			await db.insert(raidItems).values([
				{
					projectId,
					code: `${CODE}-RAID-1`,
					type: 'Risk',
					description: 'R1',
					severity: 'High',
					status: 'Open'
				},
				{
					projectId,
					code: `${CODE}-RAID-2`,
					type: 'Issue',
					description: 'R2',
					severity: 'Low',
					status: 'Open'
				}
			]);
		});

		afterAll(async () => {
			await db.delete(projects).where(eq(projects.code, CODE));
		});

		it('roll-up tersimpan ke kolom calc* sesuai PRD §8', async () => {
			const r = (await recalculateProject(projectId, undefined, '2026-01-06'))!;
			expect(r.milestones.find((m) => m.id === m1)!.progress).toBeCloseTo(0.75, 6);
			expect(r.project.overallProgress).toBeCloseTo(0.45, 6);
			expect(r.project.plannedProgress).toBeCloseTo(0.5, 6);
			expect(r.project.variance).toBeCloseTo(-0.05, 6);
			expect(r.project.rag).toBe('Green');
			expect(r.project.milestoneCount).toBe(2);
			expect(r.project.overdueMilestones).toBe(1); // M1 planned finish 2026-01-05, dihitung hari 2026-01-06
			expect(r.project.openHighRaid).toBe(1);
			expect(r.tasks.find((t) => t.id === t1)!.effWeight).toBeCloseTo(0.3, 6);
			expect(r.tasks.find((t) => t.id === t3)!.effWeight).toBeCloseTo(0.4, 6);

			const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
			expect(row.calcOverallProgress).toBeCloseTo(0.45, 6);
			expect(row.calcRag).toBe('Green');
			expect(row.calcStatus).toBe('In Progress');
			expect(row.lastCalculatedAt).not.toBeNull();

			const msRows = await db.select().from(milestones).where(eq(milestones.projectId, projectId));
			expect(msRows.find((m) => m.id === m1)!.calcHealth).toBe('Overdue');
			expect(msRows.find((m) => m.id === m2)!.calcHealth).toBe('Due ≤14 hari');
		});

		it('idempoten: dua kali jalan menghasilkan nilai sama', async () => {
			const a = (await recalculateProject(projectId, undefined, '2026-01-06'))!;
			const b = (await recalculateProject(projectId, undefined, '2026-01-06'))!;
			expect(b.project.overallProgress).toBeCloseTo(a.project.overallProgress, 9);
			expect(b.project.rag).toBe(a.project.rag);
		});

		it('overdue milestone bertambah saat tanggal lewat', async () => {
			const r = (await recalculateProject(projectId, undefined, '2026-03-01'))!;
			expect(r.project.overdueMilestones).toBe(2);
		});

		it('changeWorkItemStatus menulis progress_events & recalc', async () => {
			const res = await changeWorkItemStatus({
				workItemId: w1,
				toStatus: 'Not Started',
				changedBy: actorId,
				today: '2026-01-06'
			});
			expect(res!.unchanged).toBe(false);
			const [wi] = await db.select().from(workItems).where(eq(workItems.id, w1));
			expect(wi.status).toBe('Not Started');
			expect(wi.completedAt).toBeNull();
			const ev = await db.select().from((await import('#lib/server/db/schema.ts')).progressEvents);
			expect(ev.length).toBeGreaterThan(0);
			const last = ev[ev.length - 1];
			expect(last.fromStatus).toBe('Completed');
			expect(last.toStatus).toBe('Not Started');
		});
	}
);
