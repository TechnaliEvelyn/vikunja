import {useMutation, type QueryClient, type InfiniteData} from '@tanstack/vue-query'
import {tasksCreate, patchTasksRead, tasksDelete, tasksBulkCreate, tasksBulkUpdate, tasksDuplicate, tasksMarkRead, taskAssigneesCreate, taskAssigneesDelete, taskLabelsCreate, taskLabelsDelete, tasksRelationsCreate, tasksRelationsDelete, tasksPositionUpdate, taskBucketUpdate, type Task, type PaginatedTask, type TaskWritable, type User, type Label, type BulkTaskWritable, type TaskRelationWritable, type TasksRelationsDeleteData, type TaskPositionWritable, type JsonPatchOp} from '@/client/generated'
import {assertClientRequestContext, captureClientRequestContext} from '@/client/requestContext'
import {contextMutationOptions} from './contextMutation'
import {taskKeys} from './tasks'
import {kanbanKeys, type BoardData} from './kanban'
import {invalidateTaskMembership, mapTaskEverywhere, removeTaskEverywhere, replaceTaskEverywhere} from './taskCache'
import {projectKeys, type ProjectListResult, type ProjectResponse} from './projects'
import {getDefaultBucketId, moveTaskToBucket} from '@/helpers/task'
import {translatedError} from '@/message'

const writableFields = ['title', 'description', 'done', 'due_date', 'start_date', 'end_date', 'priority', 'hex_color', 'percent_done', 'repeat_after', 'repeat_mode', 'is_favorite', 'bucket_id', 'project_id', 'reminders', 'cover_image_attachment_id'] as const satisfies readonly (keyof TaskWritable)[]

export function taskWriteBody(task: Task): TaskWritable {
	const body: TaskWritable = Object.fromEntries(writableFields.filter(field => task[field] !== undefined).map(field => [field, task[field]]))
	if (body.title !== undefined) body.title = body.title.trim()
	if (body.hex_color !== undefined) body.hex_color = body.hex_color.replace(/^#/, '')
	for (const field of ['due_date', 'start_date', 'end_date'] as const) {
		if (body[field] === '') body[field] = '0001-01-01T00:00:00Z'
	}
	if (body.reminders) body.reminders = body.reminders.map(reminder => ({...reminder, reminder: reminder.reminder === '' ? '0001-01-01T00:00:00Z' : reminder.reminder}))
	return body
}

function taskPatchBody(task: Task): JsonPatchOp[] {
	return Object.entries(taskWriteBody(task)).map(([field, value]) => ({op: 'add', path: `/${field}`, value}))
}

function reconcileDoneBuckets(client: QueryClient, task: Task) {
	for (const [key, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
		if (!board) continue
		const navigation = client.getQueryData<ProjectListResult>(projectKeys.list())
		const project = client.getQueryData<ProjectResponse>(projectKeys.detail(Number(key[1])))
			?? [...(navigation?.projects ?? []), ...(navigation?.savedFilterProjects ?? []), navigation?.favoriteProject].find(project => project?.id === key[1])
		const view = project?.views?.find(view => view.id === key[2])
		if (!view?.done_bucket_id) continue
		const source = board.buckets.find(bucket => bucket.tasks?.some(item => item.id === task.id))
		const target = task.done ? view.done_bucket_id : source?.id === view.done_bucket_id ? getDefaultBucketId(view, board.buckets) : source?.id
		if (target !== undefined) client.setQueryData(key, {...board, buckets: moveTaskToBucket(board.buckets, task, target)})
	}
}

export function createTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (task: Task & Required<Pick<Task, 'project_id'>>) => (await tasksCreate({path: {project: task.project_id}, body: taskWriteBody(task)})).data,
		onSettled: (_task, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function updateTaskMutationOptions(optimistic = false) {
	return contextMutationOptions({
		mutationFn: async (task: Task & Required<Pick<Task, 'id'>>) => (await patchTasksRead({path: {task: task.id}, body: taskPatchBody(task)})).data,
		optimistic: optimistic ? {
			queryKeys: () => [taskKeys.all, kanbanKeys.all],
			update: (task, client) => replaceTaskEverywhere(client, task),
		} : undefined,
		onSuccess: (task, _input, client) => { replaceTaskEverywhere(client, task); reconcileDoneBuckets(client, task) },
		onSettled: ({id}, client) => invalidateTaskMembership(client, id),
	})
}

export function deleteTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (id: number) => { await tasksDelete({path: {task: id}}) },
		onSuccess: (_data, id, client) => removeTaskEverywhere(client, id),
		onSettled: (_id, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function bulkCreateTasksMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: Task[]) => {
			const context = captureClientRequestContext()
			const tasks: (Task | null)[] = Array(input.length).fill(null)
			let error: unknown = null
			const groups = new Map<number, {task: Task, index: number}[]>()
			input.forEach((task, index) => {
				const project = task.project_id ?? 0
				groups.set(project, [...(groups.get(project) ?? []), {task, index}])
			})
			for (const [project, entries] of groups) {
				const batches = []
				for (let index = 0; index < entries.length; index += 100) batches.push(entries.slice(index, index + 100))
				// The API inserts batches at the top, so submit the last batch first.
				for (const batch of batches.reverse()) {
					assertClientRequestContext(context)
					try {
						const {data} = await tasksBulkCreate({path: {project}, body: {tasks: batch.map(({task}) => taskWriteBody(task))}})
						if (data.tasks?.length !== batch.length) throw translatedError('task.bulkCreateUnexpectedResponse')
						data.tasks!.forEach((task, index) => { tasks[batch[index].index] = task })
					} catch (cause) { error ??= cause; break }
				}
			}
			return {tasks, error}
		},
		onSettled: (_input, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function bulkUpdateTasksMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (body: BulkTaskWritable) => (await tasksBulkUpdate({body})).data,
		onSuccess: (data, _input, client) => data.tasks?.forEach(task => replaceTaskEverywhere(client, task)),
		onSettled: (_input, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function duplicateTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (id: number) => (await tasksDuplicate({path: {task: id}})).data.duplicated_task!,
		onSettled: (_id, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function favoriteTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (task: Task & Required<Pick<Task, 'id'>>) => (await patchTasksRead({path: {task: task.id}, body: taskPatchBody({is_favorite: !task.is_favorite})})).data,
		optimistic: {queryKeys: () => [taskKeys.all, kanbanKeys.all], update: (task, client) => mapTaskEverywhere(client, task.id, current => ({...current, is_favorite: !task.is_favorite}))},
		onSuccess: (task, _input, client) => replaceTaskEverywhere(client, task),
		onSettled: async ({id}, client) => { await invalidateTaskMembership(client, id); await client.invalidateQueries({queryKey: projectKeys.list()}) },
	})
}

export function markTaskReadMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (id: number) => { await tasksMarkRead({path: {task: id}}) },
		onSuccess: (_data, id, client) => mapTaskEverywhere(client, id, task => ({...task, is_unread: false})),
		onSettled: (id, client) => invalidateTaskMembership(client, id),
	})
}

type AssigneeInput = {taskId: number, user: User & Required<Pick<User, 'id'>>}
export function addTaskAssigneeMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, user}: AssigneeInput) => (await taskAssigneesCreate({path: {task: taskId}, body: {user_id: user.id}})).data,
		onSuccess: (_data, {taskId, user}, client) => mapTaskEverywhere(client, taskId, task => ({...task, assignees: [...(task.assignees ?? []).filter(item => item.id !== user.id), user]})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}
export function removeTaskAssigneeMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, user}: AssigneeInput) => { await taskAssigneesDelete({path: {task: taskId, user: user.id}}) },
		onSuccess: (_data, {taskId, user}, client) => mapTaskEverywhere(client, taskId, task => ({...task, assignees: task.assignees?.filter(item => item.id !== user.id)})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}

type LabelInput = {taskId: number, label: Label & Required<Pick<Label, 'id'>>}
export function addTaskLabelMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, label}: LabelInput) => (await taskLabelsCreate({path: {task: taskId}, body: {label_id: label.id}})).data,
		onSuccess: (_data, {taskId, label}, client) => mapTaskEverywhere(client, taskId, task => ({...task, labels: [...(task.labels ?? []).filter(item => item.id !== label.id), label]})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}
export function removeTaskLabelMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, label}: LabelInput) => { await taskLabelsDelete({path: {task: taskId, label: label.id}}) },
		onSuccess: (_data, {taskId, label}, client) => mapTaskEverywhere(client, taskId, task => ({...task, labels: task.labels?.filter(item => item.id !== label.id)})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}

export function createTaskRelationMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, ...body}: TaskRelationWritable & {taskId: number}) => (await tasksRelationsCreate({path: {task: taskId}, body})).data,
		onSettled: async ({taskId, other_task_id}, client) => { await invalidateTaskMembership(client, taskId, 'active'); if (other_task_id) await invalidateTaskMembership(client, other_task_id) },
	})
}
export function deleteTaskRelationMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (path: TasksRelationsDeleteData['path']) => { await tasksRelationsDelete({path}) },
		onSettled: async ({task, otherTask}, client) => { await invalidateTaskMembership(client, task, 'active'); await invalidateTaskMembership(client, otherTask) },
	})
}

export function updateTaskPositionMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, ...body}: TaskPositionWritable & {taskId: number}) => (await tasksPositionUpdate({path: {task: taskId}, body})).data,
		onSuccess: (data, {taskId, project_view_id}, client) => {
			for (const [key, list] of client.getQueriesData<InfiniteData<PaginatedTask>>({queryKey: taskKeys.lists})) {
				if (!list || key[3] !== project_view_id) continue
				const params = key[4] as {sort_by?: string[]}
				const sortByPosition = !params.sort_by?.length || params.sort_by[0] === 'position'
				client.setQueryData(key, {...list, pages: list.pages.map(page => {
					const items = page.items?.map(task => task.id === taskId ? {...task, position: data.position} : task)
					return {...page, items: sortByPosition ? items?.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) : items}
				})})
			}
			for (const [key, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
				if (board && key[2] === project_view_id) client.setQueryData(key, {...board, buckets: board.buckets.map(bucket => ({...bucket, tasks: bucket.tasks?.map(task => task.id === taskId ? {...task, position: data.position} : task).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))}))})
			}
		},
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}

export function moveTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({project, view, bucket, task}: {project: number, view: number, bucket: number, task: Task}) => (await taskBucketUpdate({path: {project, view, bucket}, body: {task_id: task.id}})).data,
		optimistic: {
			queryKeys: ({project, view}) => [[...kanbanKeys.all, project, view]],
			update: ({project, view, bucket, task}, client) => client.setQueriesData<BoardData>({queryKey: [...kanbanKeys.all, project, view]}, current => current ? {...current, buckets: moveTaskToBucket(current.buckets, task, bucket)} : current),
		},
		onSuccess: (data, {project, view, bucket, task}, client) => {
			if (data.task) replaceTaskEverywhere(client, data.task)
			client.setQueriesData<BoardData>({queryKey: [...kanbanKeys.all, project, view]}, current => current ? {...current, buckets: moveTaskToBucket(current.buckets, data.task ?? task, data.bucket_id ?? bucket)} : current)
		},
		onSettled: ({task}, client) => invalidateTaskMembership(client, task.id),
	})
}

export function useCreateTaskMutation() { return useMutation(createTaskMutationOptions()) }

export function useUpdateTaskMutation(optimistic = false) { return useMutation(updateTaskMutationOptions(optimistic)) }

export function useDeleteTaskMutation() { return useMutation(deleteTaskMutationOptions()) }

export function useBulkCreateTasksMutation() { return useMutation(bulkCreateTasksMutationOptions()) }

export function useBulkUpdateTasksMutation() { return useMutation(bulkUpdateTasksMutationOptions()) }

export function useDuplicateTaskMutation() { return useMutation(duplicateTaskMutationOptions()) }

export function useFavoriteTaskMutation() { return useMutation(favoriteTaskMutationOptions()) }

export function useMarkTaskReadMutation() { return useMutation(markTaskReadMutationOptions()) }

export function useAddTaskAssigneeMutation() { return useMutation(addTaskAssigneeMutationOptions()) }

export function useRemoveTaskAssigneeMutation() { return useMutation(removeTaskAssigneeMutationOptions()) }

export function useAddTaskLabelMutation() { return useMutation(addTaskLabelMutationOptions()) }

export function useRemoveTaskLabelMutation() { return useMutation(removeTaskLabelMutationOptions()) }

export function useCreateTaskRelationMutation() { return useMutation(createTaskRelationMutationOptions()) }

export function useDeleteTaskRelationMutation() { return useMutation(deleteTaskRelationMutationOptions()) }

export function useUpdateTaskPositionMutation() { return useMutation(updateTaskPositionMutationOptions()) }

export function useMoveTaskMutation() { return useMutation(moveTaskMutationOptions()) }
