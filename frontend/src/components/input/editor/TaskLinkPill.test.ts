import {createPinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mount, flushPromises, enableAutoUnmount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {taskKeys} from '@/client/queries/tasks'
import TaskLinkPill from './TaskLinkPill.vue'
const sdk = vi.hoisted(() => ({tasksRead: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/stores/base', () => ({useBaseStore: () => ({currentProjectId: 1})}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projects: {}})}))
enableAutoUnmount(afterEach)
let client: QueryClient
beforeEach(() => { client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 60000}}}); sdk.tasksRead.mockReset() })
function pill(id = 5) {
 return mount(TaskLinkPill, {
  props: {href: `http://localhost:3000/tasks/${id}`},
  global: {plugins: [createPinia(), [VueQueryPlugin, {queryClient: client}]], mocks: {$t: (key: string) => key}, stubs: {TaskGlanceTooltip: {template: '<span><slot /></span>'}, Icon: true}},
 })
}
it('updates an already mounted link from the task cache', async () => {
 client.setQueryData(taskKeys.detail(5), {id: 5, title: 'Original', index: 12})
 const wrapper = pill()
 expect(wrapper.text()).toContain('Original')
 client.setQueryData(taskKeys.detail(5), {id: 5, title: 'Renamed', index: 12, done: true})
 await flushPromises()
 expect(wrapper.text()).toContain('Renamed')
 expect(wrapper.find('.task-link-pill--done').exists()).toBe(true)
})
it('discards the old task when the href changes during a request', async () => {
 let resolveFirst!: (value: unknown) => void
 sdk.tasksRead.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve })).mockResolvedValueOnce({data: {id: 6, title: 'Second'}})
 const wrapper = pill()
 await flushPromises()
 await wrapper.setProps({href: 'http://localhost:3000/tasks/6'})
 await flushPromises()
 resolveFirst({data: {id: 5, title: 'Stale'}})
 await flushPromises()
 expect(wrapper.text()).toContain('Second')
 expect(wrapper.text()).not.toContain('Stale')
})
it('keeps loaded data when a refresh fails', async () => {
 client.setQueryData(taskKeys.detail(5), {id: 5, title: 'Original'})
 const wrapper = pill()
 sdk.tasksRead.mockRejectedValue(new Error('offline'))
 await client.invalidateQueries({queryKey: taskKeys.detail(5)})
 await flushPromises()
 expect(wrapper.text()).toContain('Original')
})
