import { describe, it, expect } from 'vitest';
import {
	computeCalcProjection,
	type EngineSettings,
	type MilestoneSnapshot,
	type TaskSnapshot,
	type WorkItemSnapshot
} from './indicators';

const settings: EngineSettings = {
	rag: { green: -0.1, amber: -0.2 },
	statusMap: { 'Not Started': 0, 'In Progress': 0.5, Completed: 1 }
};

const project = {
	id: 'p1',
	baselineStart: '2026-01-01',
	baselineFinish: '2026-01-11' // 10 hari
};

const ms = (over: Partial<MilestoneSnapshot> = {}): MilestoneSnapshot => ({
	id: 'm1',
	weight: 1,
	plannedStart: '2026-01-01',
	plannedFinish: '2026-01-11',
	...over
});

const task = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	id: 't1',
	milestoneId: 'm1',
	weight: 1,
	...over
});

const wi = (over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot => ({
	id: 'w1',
	taskId: 't1',
	weight: 1,
	status: 'Not Started',
	...over
});

describe('computeCalcProjection (PRD §8.1–8.5)', () => {
	it('roll-up berbobot: 2 work item 50/50, satu completed → task 50%', () => {
		const r = computeCalcProjection(
			project,
			[ms()],
			[task()],
			[
				wi({ id: 'w1', weight: 0.5, status: 'Completed' }),
				wi({ id: 'w2', weight: 0.5, status: 'Not Started' })
			],
			[],
			'2026-01-01',
			settings
		);
		expect(r.workItems.find((w) => w.id === 'w1')!.progress).toBe(1);
		expect(r.tasks[0].progress).toBeCloseTo(0.5, 9);
		expect(r.tasks[0].status).toBe('In Progress');
		expect(r.project.overallProgress).toBeCloseTo(0.5, 9);
	});

	it('bobot efektif task = (w_task/Σw_task_ms) × (w_ms/Σw_ms)', () => {
		const r = computeCalcProjection(
			project,
			[ms({ id: 'm1', weight: 0.6 }), ms({ id: 'm2', weight: 0.4 })],
			[
				task({ id: 't1', milestoneId: 'm1', weight: 0.25 }),
				task({ id: 't2', milestoneId: 'm1', weight: 0.75 }),
				task({ id: 't3', milestoneId: 'm2', weight: 1 })
			],
			[],
			[],
			'2026-01-01',
			settings
		);
		expect(r.tasks.find((t) => t.id === 't1')!.effWeight).toBeCloseTo(0.6 * 0.25, 9);
		expect(r.tasks.find((t) => t.id === 't2')!.effWeight).toBeCloseTo(0.6 * 0.75, 9);
		expect(r.tasks.find((t) => t.id === 't3')!.effWeight).toBeCloseTo(0.4, 9);
	});

	it('planned progress linear & variance & RAG', () => {
		// hari ke-5 dari 10 → planned 0.5
		const r = computeCalcProjection(project, [ms()], [task()], [], [], '2026-01-06', settings);
		expect(r.project.plannedProgress).toBeCloseTo(0.5, 9);
		expect(r.project.variance).toBeCloseTo(-0.5, 9);
		expect(r.project.rag).toBe('Red');
	});

	it('RAG memakai threshold dari settings', () => {
		const loose: EngineSettings = { ...settings, rag: { green: -0.9, amber: -0.95 } };
		const r = computeCalcProjection(project, [ms()], [task()], [], [], '2026-01-06', loose);
		expect(r.project.variance).toBeCloseTo(-0.5, 9);
		expect(r.project.rag).toBe('Green');
	});

	it('overdue milestone dihitung bila planned finish lewat & progress < 100%', () => {
		const r = computeCalcProjection(
			project,
			[ms({ id: 'm1' }), ms({ id: 'm2', weight: 0, plannedFinish: '2026-01-02' })],
			[task({ id: 't1', milestoneId: 'm1' }), task({ id: 't2', milestoneId: 'm2', weight: 0 })],
			[],
			[],
			'2026-03-01',
			settings
		);
		expect(r.project.overdueMilestones).toBe(2);
		expect(r.project.milestoneCount).toBe(2);
	});

	it('open high/critical RAID menghitung severity High/Critical yang belum Closed', () => {
		const r = computeCalcProjection(
			project,
			[ms()],
			[task()],
			[],
			[
				{ severity: 'High', status: 'Open' },
				{ severity: 'Critical', status: 'In Progress' },
				{ severity: 'High', status: 'Closed' },
				{ severity: 'Low', status: 'Open' }
			],
			'2026-01-01',
			settings
		);
		expect(r.project.openHighRaid).toBe(2);
	});

	it('project kosong (tanpa milestone) → progress 0, tidak error', () => {
		const r = computeCalcProjection(project, [], [], [], [], '2026-01-01', settings);
		expect(r.project.overallProgress).toBe(0);
		expect(r.project.status).toBe('Not Started');
		expect(r.project.milestoneCount).toBe(0);
	});

	it('health milestone mengikuti urutan evaluasi §8.5', () => {
		const done = computeCalcProjection(
			project,
			[ms()],
			[task()],
			[wi({ status: 'Completed' })],
			[],
			'2026-01-05',
			settings
		);
		expect(done.milestones[0].health).toBe('Completed');

		const overdue = computeCalcProjection(
			project,
			[ms()],
			[task()],
			[],
			[],
			'2026-02-01',
			settings
		);
		expect(overdue.milestones[0].health).toBe('Overdue');

		const notStarted = computeCalcProjection(
			project,
			[ms({ plannedStart: '2026-06-01', plannedFinish: '2026-06-10' })],
			[],
			[],
			[],
			'2026-01-01',
			settings
		);
		expect(notStarted.milestones[0].health).toBe('Not Started');
	});
});
