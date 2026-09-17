import {computed, toValue, type MaybeRefOrGetter} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {taskQuery, type TaskExpansion} from '@/client/queries/tasks'

export function useTask(id: MaybeRefOrGetter<number>, expand: TaskExpansion = []) {
	const query = useQuery(computed(() => ({...taskQuery(toValue(id), expand), enabled: toValue(id) > 0})))
	return {...query, task: query.data}
}
