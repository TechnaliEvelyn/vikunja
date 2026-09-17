import {beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, type InfiniteData} from '@tanstack/vue-query'
import {taskKeys} from './tasks'
import {kanbanKeys, type BoardData} from './kanban'
import {updateTaskMutationOptions, deleteTaskMutationOptions, addTaskAssigneeMutationOptions, bulkCreateTasksMutationOptions, moveTaskMutationOptions, updateTaskPositionMutationOptions, taskWriteBody} from './taskMutations'
import type {Task, PaginatedTask} from '@/client/generated'
const sdk = vi.hoisted(() => ({patchTasksRead: vi.fn(), tasksDelete: vi.fn(), taskAssigneesCreate: vi.fn(), tasksBulkCreate: vi.fn(), taskBucketUpdate: vi.fn(), tasksPositionUpdate: vi.fn()}))
vi.mock('@/client/generated', async importOriginal => ({...await importOriginal<object>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn(), translatedError: (message: string) => new Error(message)}))
vi.mock('@/client/requestContext', () => ({captureClientRequestContext: () => 1, assertClientRequestContext: vi.fn(), isClientRequestContextCurrent: vi.fn(() => true)}))

describe('task mutations', () => {
	beforeEach(() => vi.resetAllMocks())
	it('sends only writable fields and reconciles loaded detail', async () => {
		const client = new QueryClient()
		client.setQueryData(taskKeys.detail(1), {id: 1, title: 'old'})
		sdk.patchTasksRead.mockResolvedValue({data: {id: 1, title: 'new'}})
		await client.getMutationCache().build(client, updateTaskMutationOptions()).execute({id: 1, title: 'new', labels: [{id: 2}], created: '2026-01-01'})
		expect(sdk.patchTasksRead).toHaveBeenCalledWith({path: {task: 1}, body: [{op: 'add', path: '/title', value: 'new'}]})
		expect(client.getQueryData<Task>(taskKeys.detail(1))?.title).toBe('new')
	})
	it('removes a deleted task from loaded detail', async () => {
		const client = new QueryClient()
		client.setQueryData(taskKeys.detail(1), {id: 1})
		sdk.tasksDelete.mockResolvedValue({})
		await client.getMutationCache().build(client, deleteTaskMutationOptions()).execute(1)
		expect(client.getQueryData(taskKeys.detail(1))).toBeUndefined()
	})
	it('patches embedded assignees without creating an assignee cache', async () => {
		const client = new QueryClient()
		client.setQueryData(taskKeys.detail(1), {id: 1, assignees: []})
		sdk.taskAssigneesCreate.mockResolvedValue({data: {user_id: 2}})
		await client.getMutationCache().build(client, addTaskAssigneeMutationOptions()).execute({taskId: 1, user: {id: 2, username: 'alice'}})
		expect(client.getQueryData<Task>(taskKeys.detail(1))?.assignees).toEqual([{id: 2, username: 'alice'}])
		expect(client.getQueryCache().getAll()).toHaveLength(1)
	})
	it('rolls back an optimistic bucket move when the request fails', async () => {
		const client = new QueryClient()
		const key = kanbanKeys.board(1, 2)
		const original: BoardData = {buckets: [{id: 3, count: 1, tasks: [{id: 1, bucket_id: 3}]}, {id: 4, count: 0, tasks: []}], pages: {3: 1, 4: 1}, hasMore: {3: false, 4: false}}
		client.setQueryData(key, original)
		sdk.taskBucketUpdate.mockImplementation(() => {
			expect(client.getQueryData<BoardData>(key)?.buckets[1].tasks).toMatchObject([{id: 1, bucket_id: 4}])
			throw new Error('denied')
		})
		await expect(client.getMutationCache().build(client, moveTaskMutationOptions()).execute({project: 1, view: 2, bucket: 4, task: {id: 1}})).rejects.toThrow('denied')
		expect(client.getQueryData(key)).toEqual(original)
	})
	it('retains successful bulk batches and input alignment after partial failure', async () => {
		const client = new QueryClient()
		sdk.tasksBulkCreate.mockImplementation(({body}) => {
			if (body.tasks[0].title === '0') throw new Error('failed batch')
			return {data: {tasks: body.tasks.map((task: Task) => ({...task, id: 7}))}}
		})
		const input = Array.from({length: 101}, (_, index) => ({title: String(index), project_id: 1}))
		const result = await client.getMutationCache().build(client, bulkCreateTasksMutationOptions()).execute(input)
		expect(result.tasks[100]).toMatchObject({id: 7, title: '100'})
		expect(result.tasks.slice(0, 100)).toEqual(Array(100).fill(null))
		expect(result.error).toBeInstanceOf(Error)
	})
})

it('reconciles the server task after a bucket move', async () => {
	const client = new QueryClient()
	client.setQueryData(taskKeys.detail(1), {id: 1, done: false})
	sdk.taskBucketUpdate.mockResolvedValue({data: {task: {id: 1, done: true}}})
	await client.getMutationCache().build(client, moveTaskMutationOptions()).execute({project: 1, view: 2, bucket: 4, task: {id: 1}})
	expect(client.getQueryData<Task>(taskKeys.detail(1))?.done).toBe(true)
})
it('reorders only cached lists for the affected view', async () => {
	const client = new QueryClient()
	const key = taskKeys.list({project: 1, view: 2})
	const other = taskKeys.list({project: 1, view: 3})
	const data = {pages: [{items: [{id: 1, position: 1}, {id: 2, position: 2}]}], pageParams: [1]}
	client.setQueryData(key, data)
	client.setQueryData(other, data)
	sdk.tasksPositionUpdate.mockResolvedValue({data: {position: 3}})
	await client.getMutationCache().build(client, updateTaskPositionMutationOptions()).execute({taskId: 1, project_view_id: 2, position: 3})
	expect(client.getQueryData<InfiniteData<PaginatedTask>>(key)?.pages[0].items?.map(task => task.id)).toEqual([2, 1])
	expect(client.getQueryData(other)).toEqual(data)
})

it('serializes clearing a date and relative reminders as valid API dates', () => {
	expect(taskWriteBody({due_date: '', reminders: [{relative_to: 'due_date', relative_period: -60, reminder: ''}]})).toEqual({due_date: '0001-01-01T00:00:00Z', reminders: [{relative_to: 'due_date', relative_period: -60, reminder: '0001-01-01T00:00:00Z'}]})
})

it('uses the mutation client to move completed tasks to its configured done bucket', async () => {
	const {projectKeys} = await import('./projects')
	const client = new QueryClient()
	const key = kanbanKeys.board(1, 2)
	client.setQueryData(projectKeys.detail(1), {id: 1, views: [{id: 2, done_bucket_id: 4}]})
	client.setQueryData(key, {buckets: [{id: 3, count: 1, tasks: [{id: 1, done: false}]}, {id: 4, count: 0, tasks: []}], pages: {3: 1, 4: 1}, hasMore: {3: false, 4: false}})
	sdk.patchTasksRead.mockResolvedValue({data: {id: 1, project_id: 1, done: true}})
	await client.getMutationCache().build(client, updateTaskMutationOptions()).execute({id: 1, done: true})
	expect(client.getQueryData<BoardData>(key)?.buckets).toMatchObject([{tasks: [], count: 0}, {tasks: [{id: 1, done: true}], count: 1}])
})

it('honors the resolved bucket when a recurring task returns to backlog', async () => {
	const client = new QueryClient()
	const key = kanbanKeys.board(1, 2)
	client.setQueryData(key, {buckets: [{id: 3, count: 1, tasks: [{id: 1, done: false, bucket_id: 3}]}, {id: 4, count: 0, tasks: []}], pages: {3: 1, 4: 1}, hasMore: {3: false, 4: false}})
	sdk.taskBucketUpdate.mockResolvedValue({data: {bucket_id: 3, task: {id: 1, done: false}}})
	await client.getMutationCache().build(client, moveTaskMutationOptions()).execute({project: 1, view: 2, bucket: 4, task: {id: 1}})
	expect(client.getQueryData<BoardData>(key)?.buckets).toMatchObject([{count: 1, tasks: [{id: 1, bucket_id: 3}]}, {count: 0, tasks: []}])
})

it('stops a bulk write before the next batch when the identity changes', async () => {
	const {assertClientRequestContext, isClientRequestContextCurrent} = await import('@/client/requestContext')
	const client = new QueryClient()
	sdk.tasksBulkCreate.mockClear()
	sdk.tasksBulkCreate.mockImplementation(({body}) => {
		vi.mocked(isClientRequestContextCurrent).mockReturnValue(false)
		vi.mocked(assertClientRequestContext).mockImplementation(() => { throw new DOMException('Changed identity', 'AbortError') })
		return {data: {tasks: body.tasks.map((task: Task) => ({...task, id: 1}))}}
	})
	await expect(client.getMutationCache().build(client, bulkCreateTasksMutationOptions()).execute(Array.from({length: 101}, (_, index) => ({title: String(index), project_id: 1})))).rejects.toThrow('Changed identity')
	expect(sdk.tasksBulkCreate).toHaveBeenCalledTimes(1)
})
