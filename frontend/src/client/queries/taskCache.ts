import type {InfiniteData, QueryClient} from '@tanstack/vue-query'
import type {PaginatedTask, Task} from '@/client/generated'
import {replaceTask, removeTask} from '@/helpers/task'
import {taskKeys} from './tasks'
import {kanbanKeys, type BoardData} from './kanban'

export function mapTaskEverywhere(client: QueryClient, id: number, update: (task: Task) => Task) {
	const map = (tasks: Task[]): Task[] => tasks.map(task => {
		const updated = task.id === id ? update(task) : task
		return updated.related_tasks ? {...updated, related_tasks: Object.fromEntries(Object.entries(updated.related_tasks).map(([kind, children]) => [kind, map(children ?? [])]))} : updated
	})
	client.setQueriesData<Task[]>({queryKey: taskKeys.allLists}, current => current ? map(current) : current)
	client.setQueriesData<Task>({queryKey: taskKeys.details}, current => current ? map([current])[0] : current)
	client.setQueriesData<InfiniteData<PaginatedTask>>({queryKey: taskKeys.lists}, current => current ? {...current, pages: current.pages.map(page => ({...page, items: map(page.items ?? [])}))} : current)
	client.setQueriesData<BoardData>({queryKey: kanbanKeys.all}, current => current ? {...current, buckets: current.buckets.map(bucket => ({...bucket, tasks: map(bucket.tasks ?? [])}))} : current)
}

export function replaceTaskEverywhere(client: QueryClient, updated: Task) {
	if (updated.id === undefined) return
	if (updated.project_id) {
		for (const [key, tasks] of client.getQueriesData<Task[]>({queryKey: taskKeys.allLists})) {
			if (tasks && typeof key[2] === 'number' && key[2] > 0 && key[2] !== updated.project_id) client.setQueryData(key, removeTask(tasks, updated.id))
		}
		for (const [key, list] of client.getQueriesData<InfiniteData<PaginatedTask>>({queryKey: taskKeys.lists})) {
			if (list && typeof key[2] === 'number' && key[2] > 0 && key[2] !== updated.project_id) {
				client.setQueryData(key, {...list, pages: list.pages.map(page => ({...page, items: removeTask(page.items ?? [], updated.id!), total: page.total === undefined ? undefined : Math.max(0, page.total - (page.items?.some(task => task.id === updated.id) ? 1 : 0))}))})
			}
		}
		for (const [key, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
			if (board && typeof key[1] === 'number' && key[1] > 0 && key[1] !== updated.project_id) {
				client.setQueryData(key, {...board, buckets: board.buckets.map(bucket => ({...bucket, tasks: removeTask(bucket.tasks ?? [], updated.id!), count: Math.max(0, (bucket.count ?? 0) - (bucket.tasks?.some(task => task.id === updated.id) ? 1 : 0))}))})
			}
		}
	}
	mapTaskEverywhere(client, updated.id, current => replaceTask([current], updated)[0])
}

export function removeTaskEverywhere(client: QueryClient, id: number) {
	client.setQueriesData<Task[]>({queryKey: taskKeys.allLists}, current => current ? removeTask(current, id) : current)
	client.removeQueries({queryKey: [...taskKeys.details, id]})
	client.setQueriesData<Task>({queryKey: taskKeys.details}, current => current ? removeTask([current], id)[0] : current)
	client.setQueriesData<InfiniteData<PaginatedTask>>({queryKey: taskKeys.lists}, current => current ? {
		...current,
		pages: current.pages.map(page => ({...page, items: removeTask(page.items ?? [], id), total: page.total === undefined ? undefined : Math.max(0, page.total - (page.items?.some(task => task.id === id) ? 1 : 0))})),
	} : current)
	client.setQueriesData<BoardData>({queryKey: kanbanKeys.all}, current => current ? {
		...current,
		buckets: current.buckets.map(bucket => ({...bucket, tasks: removeTask(bucket.tasks ?? [], id), count: Math.max(0, (bucket.count ?? 0) - (bucket.tasks?.some(task => task.id === id) ? 1 : 0))})),
	} : current)
}

export async function invalidateTaskMembership(client: QueryClient, id?: number, refetchType: 'none' | 'active' = 'none') {
	await Promise.all([
		client.invalidateQueries({queryKey: taskKeys.lists, refetchType}),
		client.invalidateQueries({queryKey: taskKeys.allLists, refetchType}),
		client.invalidateQueries({queryKey: kanbanKeys.all, refetchType}),
		...(id === undefined ? [] : [client.invalidateQueries({queryKey: [...taskKeys.details, id]})]),
	])
}
