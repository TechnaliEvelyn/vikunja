import type {Bucket, ProjectView, Task, TaskReminder, User} from '@/client/generated'
import type {IRepeatAfter} from '@/types/IRepeatAfter'
import {secondsToPeriod, periodToSeconds} from '@/helpers/time/period'
import {cleanupItemText, parseTaskText, PREFIXES, type PrefixMode} from '@/modules/quickAddMagic'

export function createTaskDraft(data: Partial<Task> = {}): Task {
	return {
		id: 0, description: '', done: false, priority: 0,
		labels: [], assignees: [], reminders: [], attachments: [], buckets: [],
		related_tasks: {}, reactions: {}, comments: [], project_id: 0, bucket_id: 0,
		repeat_after: 0, repeat_mode: 0, percent_done: 0, hex_color: '',
		is_favorite: false, cover_image_attachment_id: 0,
		...data,
		title: (data.title ?? '').trim(),
	}
}

export function getTaskIdentifier(task: Pick<Task, 'identifier' | 'index'> | null | undefined): string {
	if (!task) return ''
	return task.identifier && task.identifier !== `-${task.index}` ? task.identifier : `#${task.index ?? 0}`
}

export function getHexColor(color?: string): string | undefined {
	if (!color || color === '#') return undefined
	return color.startsWith('#') ? color : `#${color}`
}

export function parseRepeatAfter(seconds = 0): IRepeatAfter {
	const {unit, amount} = secondsToPeriod(seconds)
	return {type: unit, amount}
}

export function repeatAfterToSeconds(repeat?: number | IRepeatAfter | null): number {
	return typeof repeat === 'number' ? repeat : repeat ? periodToSeconds(repeat.amount, repeat.type) : 0
}

export function replaceTask(tasks: readonly Task[], updated: Task): Task[] {
	return tasks.map(task => {
		const next = task.id === updated.id ? {...task, ...updated, position: task.position ?? updated.position, bucket_id: task.bucket_id ?? updated.bucket_id} : task
		if (!next.related_tasks) return next
		return {...next, related_tasks: Object.fromEntries(Object.entries(next.related_tasks).map(([kind, children]) => [kind, replaceTask(children ?? [], updated)]))}
	})
}

export function removeTask(tasks: readonly Task[], id: number): Task[] {
	return tasks.filter(task => task.id !== id).map(task => task.related_tasks ? {
		...task,
		related_tasks: Object.fromEntries(Object.entries(task.related_tasks).map(([kind, children]) => [kind, removeTask(children ?? [], id)])),
	} : task)
}

export function getDefaultBucketId(view: Pick<ProjectView, 'default_bucket_id'>, buckets: readonly Bucket[]): number | undefined {
	return view.default_bucket_id || buckets[0]?.id
}

export function moveTaskToBucket(buckets: Bucket[], task: Task, bucketId: number): Bucket[] {
	const source = buckets.find(bucket => bucket.tasks?.some(item => item.id === task.id))
	if (!source || source.id === bucketId || !buckets.some(bucket => bucket.id === bucketId)) return buckets
	const original = source.tasks?.find(item => item.id === task.id)
	return buckets.map(bucket => {
		if (bucket.id === source.id) return {...bucket, count: Math.max(0, (bucket.count ?? 0) - 1), tasks: removeTask(bucket.tasks ?? [], task.id!)}
		if (bucket.id === bucketId) return {...bucket, count: (bucket.count ?? 0) + 1, tasks: [{...original, ...task, bucket_id: bucketId}, ...(bucket.tasks ?? [])]}
		return bucket
	})
}

export function buildDefaultRemindersForQuickAdd(defaults: readonly TaskReminder[] | undefined, dueDate?: string | null): TaskReminder[] {
	return dueDate ? (defaults ?? []).map(reminder => ({relative_period: reminder.relative_period, relative_to: 'due_date'})) : []
}

export function buildQuickAddTask(input: Partial<Task>, mode: PrefixMode, assignees: (User & {match: string})[], defaults?: readonly TaskReminder[]) {
	const parsed = parseTaskText(input.title ?? '', mode)
	if (!parsed.text) return {task: createTaskDraft(input), parsedLabels: [] as string[]}
	const prefix = PREFIXES[mode]?.assignee
	const title = prefix ? cleanupItemText(parsed.text, assignees.map(user => user.match), prefix) : parsed.text
	const dueDate = parsed.date?.toISOString()
	return {
		task: createTaskDraft({
			...input, title, due_date: dueDate, priority: parsed.priority ?? 0,
			assignees: assignees.map(({match: _match, ...user}) => user),
			repeat_after: repeatAfterToSeconds(parsed.repeats),
			repeat_mode: parsed.repeats?.type === 'months' && parsed.repeats.amount === 1 ? 1 : 0,
			reminders: buildDefaultRemindersForQuickAdd(defaults, dueDate),
		}),
		parsedLabels: parsed.labels,
	}
}
