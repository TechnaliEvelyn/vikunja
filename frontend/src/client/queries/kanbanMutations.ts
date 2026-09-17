import {useMutation} from '@tanstack/vue-query'
import {bucketsCreate, bucketsUpdate, bucketsDelete, projectViewTasksList, type Bucket, type BucketWritable} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {kanbanKeys, TASKS_PER_BUCKET, type BoardData} from './kanban'
import {type TaskFilterParams} from './tasks'
import {invalidateTaskMembership} from './taskCache'
import {projectKeys} from './projects'

type BucketInput = {project: number, view: number, bucket: Bucket}
function bucketBody(bucket: Bucket): BucketWritable {
	return {title: bucket.title, limit: bucket.limit, position: bucket.position}
}

export function createBucketMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({project, view, bucket}: BucketInput) => (await bucketsCreate({path: {project, view}, body: bucketBody(bucket)})).data,
		onSuccess: (bucket, {project, view}, client) => client.setQueriesData<BoardData>({queryKey: [...kanbanKeys.all, project, view]}, current => current ? {...current, buckets: [...current.buckets, {...bucket, tasks: []}], pages: {...current.pages, [bucket.id!]: 1}, hasMore: {...current.hasMore, [bucket.id!]: false}} : current),
		onSettled: (_input, client) => invalidateTaskMembership(client),
	})
}

export function updateBucketMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({project, view, bucket}: BucketInput) => (await bucketsUpdate({path: {project, view, bucket: bucket.id!}, body: bucketBody(bucket)})).data,
		optimistic: {
			queryKeys: ({project, view}) => [[...kanbanKeys.all, project, view]],
			update: ({project, view, bucket}, client) => client.setQueriesData<BoardData>({queryKey: [...kanbanKeys.all, project, view]}, current => current ? {...current, buckets: current.buckets.map(item => item.id === bucket.id ? {...item, ...bucket} : item)} : current),
		},
		onSuccess: (bucket, {project, view}, client) => client.setQueriesData<BoardData>({queryKey: [...kanbanKeys.all, project, view]}, current => current ? {...current, buckets: current.buckets.map(item => item.id === bucket.id ? {...item, ...bucket, tasks: item.tasks, count: item.count} : item).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))} : current),
		onSettled: (_input, client) => invalidateTaskMembership(client),
	})
}

export function deleteBucketMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({project, view, bucket}: BucketInput) => { await bucketsDelete({path: {project, view, bucket: bucket.id!}}) },
		onSettled: async ({project, view}, client) => {
			await Promise.all([
				client.invalidateQueries({queryKey: [...kanbanKeys.all, project, view]}),
				client.invalidateQueries({queryKey: projectKeys.all, refetchType: 'none'}),
				invalidateTaskMembership(client),
			])
		},
	})
}

export function loadBucketPageMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({project, view, params, bucket, page}: {project: number, view: number, params: TaskFilterParams, bucket: number, page: number}) => (await projectViewTasksList({
			path: {project, view},
			query: {...params, page, per_page: TASKS_PER_BUCKET, sort_by: ['position'], order_by: ['asc'], expand: ['comment_count', 'is_unread'], filter: `${params.filter ? `(${params.filter}) && ` : ''}bucket_id = ${bucket}`},
		})).data,
		onSuccess: (data, {project, view, params, bucket, page}, client) => client.setQueryData<BoardData>(kanbanKeys.board(project, view, params), current => {
			if (!current || (current.pages[bucket] ?? 1) !== page - 1) return current
			return {
				...current,
				buckets: current.buckets.map(item => item.id === bucket ? {...item, tasks: [...(item.tasks ?? []), ...(data.items ?? []).filter(task => !item.tasks?.some(old => old.id === task.id))]} : item),
				pages: {...current.pages, [bucket]: page},
				hasMore: {...current.hasMore, [bucket]: page < (data.total_pages ?? 1)},
			}
		}),
	})
}

export function useCreateBucketMutation() { return useMutation(createBucketMutationOptions()) }
export function useUpdateBucketMutation() { return useMutation(updateBucketMutationOptions()) }
export function useDeleteBucketMutation() { return useMutation(deleteBucketMutationOptions()) }
export function useLoadBucketPageMutation() { return useMutation(loadBucketPageMutationOptions()) }
