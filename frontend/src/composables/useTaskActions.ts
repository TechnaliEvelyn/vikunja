import {computed, reactive} from 'vue'
import {useRouter} from 'vue-router'
import type {Task, Label} from '@/client/generated'
import {useCreateTaskMutation, useUpdateTaskMutation, useDeleteTaskMutation, useBulkCreateTasksMutation, useDuplicateTaskMutation, useFavoriteTaskMutation, useMarkTaskReadMutation, useAddTaskAssigneeMutation, useRemoveTaskAssigneeMutation, useAddTaskLabelMutation, useRemoveTaskLabelMutation} from '@/client/queries/taskMutations'
import {ensureLabels, refreshLabels, getLabelByExactTitle, useCreateLabelMutation} from '@/client/queries/labels'
import {ensureProjects, findProjectByExactTitle} from '@/client/queries/projects'
import {searchProjectUsers} from '@/client/queries/userSearch'
import {useAuthStore} from '@/stores/auth'
import {useConfigStore} from '@/stores/config'
import {parseTaskText} from '@/modules/quickAddMagic'
import {buildQuickAddTask} from '@/helpers/task'
import {getRandomColorHex} from '@/helpers/color/randomColor'
import {runWrites} from '@/helpers/runWrites'
import {assertClientRequestContext, captureClientRequestContext, type ClientRequestContext} from '@/client/requestContext'
import {useTaskDragState} from './useTaskDragState'

export function useTaskActions(optimisticUpdates = false) {
	const create = useCreateTaskMutation()
	const update = useUpdateTaskMutation(optimisticUpdates)
	const remove = useDeleteTaskMutation()
	const bulk = useBulkCreateTasksMutation()
	const duplicate = useDuplicateTaskMutation()
	const favorite = useFavoriteTaskMutation()
	const read = useMarkTaskReadMutation()
	const addAssignee = useAddTaskAssigneeMutation()
	const removeAssignee = useRemoveTaskAssigneeMutation()
	const addLabel = useAddTaskLabelMutation()
	const removeLabel = useRemoveTaskLabelMutation()
	const createLabel = useCreateLabelMutation()
	const auth = useAuthStore()
	const config = useConfigStore()
	const router = useRouter()

	async function findProjectId({project, projectId}: {project?: string | null, projectId: number}) {
		if (project) {
			const {projects} = await ensureProjects()
			const found = findProjectByExactTitle(projects, project) ?? projects.find(item => item.identifier?.toLowerCase() === project.toLowerCase())
			if (found?.id) return found.id
		}
		const routeProjectId = Number(router.currentRoute.value.params.projectId)
		const id = routeProjectId > 0 ? routeProjectId : projectId
		if (id <= 0) throw new Error('NO_PROJECT')
		return id
	}

	async function ensureLabelsExist(titles: string[], context = captureClientRequestContext()): Promise<Label[]> {
		if (!titles.length) return []
		assertClientRequestContext(context)
		let labels: Label[] = []
		try {
			labels = await ensureLabels()
			if (titles.some(title => !getLabelByExactTitle(labels, title))) labels = await refreshLabels()
		} catch (cause) {
			assertClientRequestContext(context)
			if (![401, 403].includes((cause as {status?: number}).status ?? 0)) throw cause
		}
		const found = await Promise.all([...new Set(titles)].map(async title => {
			assertClientRequestContext(context)
			const existing = getLabelByExactTitle(labels, title)
			if (existing) return existing
			try { return await createLabel.mutateAsync({title, hex_color: getRandomColorHex()}) } catch (cause) {
				assertClientRequestContext(context)
				if (![401, 403].includes((cause as {status?: number}).status ?? 0)) throw cause
				return undefined
			}
		}))
		return found.filter((label): label is Label => label !== undefined)
	}

	async function build(input: Partial<Task>, context: ClientRequestContext) {
		const mode = auth.settings.frontendSettings.quickAddMagicMode
		const parsed = parseTaskText(input.title ?? '', mode)
		const project_id = await findProjectId({project: parsed.project, projectId: input.project_id ?? 0})
		assertClientRequestContext(context)
		const matches = await Promise.all(parsed.assignees.map(async match => {
			const users = await searchProjectUsers(project_id, match)
			const query = match.toLowerCase()
			const user = users.find(user => [user.username, user.name, user.email].some(value => users.length === 1 ? value?.toLowerCase().includes(query) : value?.toLowerCase() === query))
			return user ? {...user, match} : undefined
		}))
		assertClientRequestContext(context)
		const defaults = auth.settings.frontendSettings.quickAddDefaultReminders?.map(reminder => ({relative_period: reminder.relativePeriod}))
		return buildQuickAddTask({...input, project_id}, mode, matches.filter(user => user !== undefined), defaults)
	}

	async function addLabelsToTask({task, parsedLabels}: {task: Task, parsedLabels: string[]}, context = captureClientRequestContext()) {
		const labels = await ensureLabelsExist(parsedLabels, context)
		await runWrites(labels, label => {
			assertClientRequestContext(context)
			return addLabel.mutateAsync({taskId: task.id!, label: {...label, id: label.id!}})
		}, config.concurrentWrites)
		return {...task, labels: [...(task.labels ?? []), ...labels]}
	}

	async function finishTask(task: Task, built: Awaited<ReturnType<typeof build>>, context: ClientRequestContext) {
		assertClientRequestContext(context)
		await runWrites(built.task.assignees ?? [], user => {
			assertClientRequestContext(context)
			return addAssignee.mutateAsync({taskId: task.id!, user: {...user, id: user.id!}})
		}, config.concurrentWrites)
		return addLabelsToTask({task: {...task, assignees: built.task.assignees}, parsedLabels: built.parsedLabels}, context)
	}

	async function createNewTask(input: Partial<Task>) {
		const context = captureClientRequestContext()
		const built = await build(input, context)
		assertClientRequestContext(context)
		const task = await create.mutateAsync({...built.task, project_id: built.task.project_id!})
		return finishTask(task, built, context)
	}

	async function createNewTasksBulk(entries: {title: string, project_id: number}[]) {
		const context = captureClientRequestContext()
		const built = await Promise.all(entries.map(entry => build(entry, context)))
		assertClientRequestContext(context)
		const result = await bulk.mutateAsync(built.map(item => item.task))
		await runWrites(built.map((item, index) => ({item, index})), async ({item, index}) => {
			const task = result.tasks[index]
			if (!task) return
			try { result.tasks[index] = await finishTask(task, item, context) } catch (cause) {
				assertClientRequestContext(context)
				result.error ??= cause
			}
		}, config.concurrentWrites)
		return result
	}

	return reactive({
		isLoading: computed(() => [create, update, remove, bulk, duplicate, favorite, read, addAssignee, removeAssignee, addLabel, removeLabel].some(mutation => mutation.isPending.value)),
		update: (task: Task) => update.mutateAsync({...task, id: task.id!}),
		delete: (task: Task) => remove.mutateAsync(task.id!),
		addAssignee: addAssignee.mutateAsync, removeAssignee: removeAssignee.mutateAsync,
		addLabel: addLabel.mutateAsync, removeLabel: removeLabel.mutateAsync,
		toggleFavorite: (task: Task) => favorite.mutateAsync({...task, id: task.id!}),
		duplicateTask: duplicate.mutateAsync, markTaskAsRead: read.mutateAsync,
		setCoverImage: (task: Task, attachment: {id?: number} | null) => update.mutateAsync({...task, id: task.id!, cover_image_attachment_id: attachment?.id ?? 0}),
		createNewTask, createNewTasksBulk, findProjectId, ensureLabelsExist, addLabelsToTask,
		...useTaskDragState(),
	})
}
