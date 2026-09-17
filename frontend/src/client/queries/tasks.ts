import {infiniteQueryOptions, queryOptions} from '@tanstack/vue-query'
import {projectTasksList, projectViewTasksList, tasksList, tasksRead} from '@/client/generated'
import type {TasksListData, TasksReadData} from '@/client/generated'
import {queryClient} from '@/client/queryClient'

export type TaskFilterParams = Omit<NonNullable<TasksListData['query']>, 'format' | 'page'>
export type TaskExpansion = NonNullable<NonNullable<TasksReadData['query']>['expand']>
export type TaskScope = {project?: number | null, view?: number, params?: TaskFilterParams}

export function getDefaultTaskFilterParams(): TaskFilterParams {
	return {sort_by: ['position', 'id'], order_by: ['asc', 'desc'], filter: '', filter_include_nulls: false, filter_timezone: '', q: '', expand: ['subtasks']}
}

export const taskKeys = {
	all: ['tasks'] as const,
	details: ['tasks', 'detail'] as const,
	detail: (id: number, expand: TaskExpansion = []) => [...taskKeys.details, id, expand] as const,
	lists: ['tasks', 'list'] as const,
	list: ({project = null, view = 0, params = {}}: TaskScope) => [...taskKeys.lists, project, view, params] as const,
}

export function taskQuery(id: number, expand: TaskExpansion = []) {
	return queryOptions({
		queryKey: taskKeys.detail(id, expand),
		queryFn: async ({signal}) => (await tasksRead({path: {task: id}, query: {expand}, signal})).data,
	})
}

export function tasksQuery(scope: TaskScope = {}, initialPage = 1) {
	const {project = null, view = 0, params = {}} = scope
	return infiniteQueryOptions({
		queryKey: taskKeys.list(scope),
		initialPageParam: initialPage,
		queryFn: async ({pageParam, signal}) => {
			const query = {...params, page: pageParam}
			if (project === null) return (await tasksList({query, signal})).data
			if (view) return (await projectViewTasksList({path: {project, view}, query, signal})).data
			return (await projectTasksList({path: {project}, query, signal})).data
		},
		getNextPageParam: (last, _pages, page) => page < (last.total_pages ?? 1) ? page + 1 : undefined,
		getPreviousPageParam: (_first, _pages, page) => page > 1 ? page - 1 : undefined,
	})
}

export function ensureTask(id: number, expand: TaskExpansion = []) {
	return queryClient.ensureQueryData(taskQuery(id, expand))
}
