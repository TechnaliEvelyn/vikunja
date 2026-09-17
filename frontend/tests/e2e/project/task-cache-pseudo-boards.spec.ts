import type {Task, Bucket} from '../../../src/client/generated'
import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {TaskFactory} from '../../factories/task'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'

for (const scope of ['favorites', 'saved filter']) {
	test(`persists ${scope} task edits in its board response`, async ({authenticatedPage: page, apiContext, userToken}) => {
		const headers = {Authorization: `Bearer ${userToken}`}
		const [project] = await ProjectFactory.create(1)
		const [task] = await TaskFactory.create(1, {project_id: project.id, title: 'Before edit', done: false})
		let projectId = -1
		if (scope === 'favorites') {
			const favorite = await apiContext.put(`/api/v2/tasks/${task.id}`, {headers, data: {title: task.title, is_favorite: true}})
			expect(favorite.ok()).toBeTruthy()
		} else {
			const response = await apiContext.post('/api/v2/filters', {headers, data: {title: 'Open tasks', filters: {filter: 'done = false'}}})
			expect(response.ok()).toBeTruthy()
			projectId = -(await response.json()).id - 1
		}
		// Favorites normally has only list/table/Gantt; seed a stored Kanban view to exercise the pseudo-project board endpoint.
		const [view] = await ProjectViewFactory.create(1, {id: 80, project_id: projectId, view_kind: 3, bucket_configuration_mode: 1})
		const [bucket] = await BucketFactory.create(1, {project_view_id: view.id})
		await TaskBucketFactory.create(1, {task_id: task.id, bucket_id: bucket.id, project_view_id: view.id})
		const route = `/projects/${projectId}/${scope === 'favorites' ? -1 : view.id}`
		const taskSelector = scope === 'favorites' ? '.tasks .task' : '.kanban .task'
		await page.goto(route)
		await expect(page.locator(taskSelector).filter({hasText: task.title})).toBeVisible()
		await page.locator(taskSelector).filter({hasText: task.title}).getByText(task.title, {exact: true}).click()
		const heading = page.locator('.task-view h1[contenteditable]')
		await heading.fill('After edit')
		await heading.press('Enter')
		await expect.poll(async () => {
			const response = await apiContext.get(`/api/v2/tasks/${task.id}`, {headers})
			return (await response.json()).title
		}).toBe('After edit')
		const board = await apiContext.get(`/api/v2/projects/${projectId}/views/${view.id}/buckets/tasks`, {headers})
		expect(board.ok()).toBeTruthy()
		expect((await board.json()).items.flatMap((bucket: Bucket) => bucket.tasks ?? []).find((item: Task) => item.id === task.id)?.title).toBe('After edit')
		await page.goto(route)
		await page.reload()
		await expect(page.locator(taskSelector).filter({hasText: 'After edit'})).toBeVisible()
		await expect(page.locator(taskSelector).filter({hasText: 'Before edit'})).toHaveCount(0)
	})
}
