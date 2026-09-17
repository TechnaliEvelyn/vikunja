import {queryOptions} from '@tanstack/vue-query'
import {projectViewBucketsTasksList, type Bucket} from '@/client/generated'
import type {TaskFilterParams} from './tasks'

export const TASKS_PER_BUCKET = 25
export type BoardData = {buckets: Bucket[], pages: Record<number, number>, hasMore: Record<number, boolean>}
export const kanbanKeys = {
	all: ['kanban'] as const,
	board: (project: number, view: number, params: TaskFilterParams = {}) => ['kanban', project, view, params] as const,
}

export function kanbanQuery(project: number, view: number, params: TaskFilterParams = {}) {
	return queryOptions({
		queryKey: kanbanKeys.board(project, view, params),
		queryFn: async ({signal}): Promise<BoardData> => {
			const {data} = await projectViewBucketsTasksList({path: {project, view}, query: {...params, per_page: TASKS_PER_BUCKET, expand: ['comment_count', 'is_unread']}, signal})
			const buckets = data.items ?? []
			return {
				buckets,
				pages: Object.fromEntries(buckets.map(bucket => [bucket.id, 1])),
				hasMore: Object.fromEntries(buckets.map(bucket => [bucket.id, (bucket.tasks?.length ?? 0) < (bucket.count ?? 0)])),
			}
		},
	})
}
