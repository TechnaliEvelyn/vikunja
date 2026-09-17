import {computed, toValue, type MaybeRefOrGetter} from 'vue'
import {useInfiniteQuery} from '@tanstack/vue-query'
import {tasksQuery, type TaskScope} from '@/client/queries/tasks'

export function useTasks(scope: MaybeRefOrGetter<TaskScope>, enabled: MaybeRefOrGetter<boolean> = true) {
	const query = useInfiniteQuery(computed(() => ({...tasksQuery(toValue(scope)), enabled: toValue(enabled)})))
	const tasks = computed(() => query.data.value?.pages.flatMap(page => page.items ?? []) ?? [])
	return {...query, tasks}
}
