import {shallowRef} from 'vue'
import {createSharedComposable} from '@vueuse/core'
import type {Task} from '@/client/generated'

export const useTaskDragState = createSharedComposable(() => {
	const draggedTask = shallowRef<Task | null>(null)
	return {draggedTask, setDraggedTask: (task: Task | null) => { draggedTask.value = task }}
})
