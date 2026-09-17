import {ref, shallowRef, watch, computed, type ComputedGetter} from 'vue'
import {useRouter, isNavigationFailure} from 'vue-router'
import type {LocationQueryRaw} from 'vue-router'
import {useRouteQuery} from '@vueuse/router'

import {useInfiniteQuery} from '@tanstack/vue-query'
import {tasksQuery, getDefaultTaskFilterParams, type TaskExpansion, type TaskFilterParams, type TaskScope} from '@/client/queries/tasks'
import {useAuthStore} from '@/stores/auth'
import {useViewFiltersStore} from '@/stores/viewFilters'

export type Order = 'asc' | 'desc' | 'none'

export interface SortBy {
	id?: Order
	index?: Order
	done?: Order
	title?: Order
	priority?: Order
	due_date?: Order
	start_date?: Order
	end_date?: Order
	percent_done?: Order
	created?: Order
	updated?: Order
	done_at?: Order,
	position?: Order,
}

const VALID_SORT_FIELDS = new Set<string>(
	['id', 'index', 'done', 'title', 'priority', 'due_date', 'start_date',
		'end_date', 'percent_done', 'created', 'updated', 'done_at', 'position'],
)

function parseSortQuery(raw: string, fallback: SortBy): SortBy {
	const result: Record<string, Order> = {}
	for (const part of raw.split(',')) {
		const [field, order] = part.split(':')
		if (!VALID_SORT_FIELDS.has(field)) continue
		if (order !== 'asc' && order !== 'desc') continue
		result[field] = order
	}
	return Object.keys(result).length > 0 ? result as SortBy : {...fallback}
}

function serializeSortBy(sortBy: SortBy, defaultSort: SortBy): string | undefined {
	const keys = Object.keys(sortBy) as (keyof SortBy)[]
	const defaultKeys = Object.keys(defaultSort) as (keyof SortBy)[]
	const isDefault = keys.length === defaultKeys.length &&
		keys.every(k => sortBy[k] === defaultSort[k])
	if (isDefault) return undefined
	return keys.map(k => `${k}:${sortBy[k]}`).join(',')
}

const SORT_BY_DEFAULT: SortBy = {
	id: 'desc',
}

interface TaskListQueryState {
	sort: string | undefined
	filter: string | undefined
	s: string | undefined
	page: number
}

export function buildStoredQuery(state: TaskListQueryState): LocationQueryRaw {
	const query: LocationQueryRaw = {}
	if (state.sort) query.sort = state.sort
	if (state.filter) query.filter = state.filter
	if (state.s) query.s = state.s
	if (state.page > 1) query.page = String(state.page)
	return query
}

// This makes sure an id sort order is always sorted last.
// When tasks would be sorted first by id and then by whatever else was specified, the id sort takes
// precedence over everything else, making any other sort columns pretty useless.
function formatSortOrder(sortBy, params) {
	let hasIdFilter = false
	const sortKeys = Object.keys(sortBy)
	for (const s of sortKeys) {
		if (s === 'id') {
			sortKeys.splice(s, 1)
			hasIdFilter = true
			break
		}
	}
	if (hasIdFilter) {
		sortKeys.push('id')
	}
	params.sort_by = sortKeys
	params.order_by = sortKeys.map(s => sortBy[s])

	return params
}

/**
 * This mixin provides a base set of methods and properties to get tasks.
 */
export function useTaskList(
	projectIdGetter: ComputedGetter<number>,
	projectViewIdGetter: ComputedGetter<number>,
	sortByDefault: SortBy = SORT_BY_DEFAULT,
	expandGetter: ComputedGetter<TaskExpansion> = () => ['subtasks'],
) {
	
	const projectId = computed(() => projectIdGetter())
	const projectViewId = computed(() => projectViewIdGetter())

	const router = useRouter()
	const viewFiltersStore = useViewFiltersStore()

	const params = ref<TaskFilterParams>({...getDefaultTaskFilterParams()})

	const page = useRouteQuery('page', '1', { transform: Number })
	const filter = useRouteQuery('filter')
	const s = useRouteQuery('s')

	watch(filter, v => { params.value.filter = String(v ?? '') }, { immediate: true })
	watch(s, v => { params.value.q = String(v ?? '') }, { immediate: true })

	watch(() => params.value.filter, v => { filter.value = v || undefined })
	watch(() => params.value.q, v => { s.value = v || undefined })

	const sortQuery = useRouteQuery('sort')

	const sortBy = computed<SortBy>({
		get() {
			const raw = sortQuery.value as string | undefined
			if (!raw) return {...sortByDefault}
			return parseSortQuery(raw, sortByDefault)
		},
		set(val: SortBy) {
			sortQuery.value = serializeSortBy(val, sortByDefault) || undefined
		},
	})

	const pendingQueryRestore = shallowRef<Promise<unknown>>()
	// Sidebar links omit the query, and project views are reused across navigation.
	let lastSyncedViewId: number | undefined
	watch(
		[projectViewId, sortQuery, filter, s, page],
		([viewId, sortValue, filterValue, sValue, pageValue]) => {
			const viewIdChanged = viewId !== lastSyncedViewId
			lastSyncedViewId = viewId

			// An invalid `?page=` becomes NaN via `transform: Number`; treat it as
			// the default so it neither blocks restoration nor wipes stored state.
			const currentPage = Number.isInteger(pageValue) ? pageValue : 1
			const urlIsEmpty = !sortValue && !filterValue && !sValue && currentPage === 1
			if (viewIdChanged && urlIsEmpty) {
				const storedQuery = viewFiltersStore.getViewQuery(viewId)
				if (Object.keys(storedQuery).length > 0) {
					const restore = router.replace({query: {...router.currentRoute.value.query, ...storedQuery}})
					pendingQueryRestore.value = restore
					restore
						.catch(failure => {
							if (!isNavigationFailure(failure)) throw failure
						})
						.finally(() => {
							if (pendingQueryRestore.value === restore) {
								pendingQueryRestore.value = undefined
							}
						})
					return
				}
			}

			const query = buildStoredQuery({
				sort: sortValue as string | undefined,
				filter: filterValue as string | undefined,
				s: sValue as string | undefined,
				page: currentPage,
			})
			if (Object.keys(query).length > 0) {
				viewFiltersStore.setViewQuery(viewId, query)
			} else {
				viewFiltersStore.clearViewQuery(viewId)
			}
		},
		{immediate: true},
	)

	const allParams = computed(() => {
		const loadParams = {...params.value}

		// Relevance ranking only engages when no sort is sent, so omit the default
		// sort while searching and let an explicit user sort still take precedence.
		if (loadParams.q && !sortQuery.value) {
			loadParams.sort_by = []
			loadParams.order_by = []
			return loadParams
		}

		return formatSortOrder(sortBy.value, loadParams)
	})

	watch(
		[params, sortBy, page],
		([, , newPage], [, , oldPage]) => {
			// A redundant page write can cancel the navigation restoring a saved sort.
			if (newPage === oldPage && newPage !== 1) {
				page.value = 1
			}
		},
		{deep: true},
	)
	
	const authStore = useAuthStore()
	
	const scope = computed(() => ({project: projectId.value, view: projectViewId.value, params: {...allParams.value, filter_timezone: authStore.settings.timezone, expand: expandGetter()}}))
	const request = shallowRef<{scope: TaskScope, page: number}>()
	watch([scope, page, pendingQueryRestore], () => {
		if (!pendingQueryRestore.value) request.value = {scope: scope.value, page: page.value}
	}, {immediate: true, flush: 'post'})
	const query = useInfiniteQuery(computed(() => ({...tasksQuery(request.value?.scope ?? {}, request.value?.page ?? 1), enabled: !!request.value && !pendingQueryRestore.value && request.value.page === page.value && JSON.stringify(request.value.scope) === JSON.stringify(scope.value)})))
	const loading = query.isFetching
	const totalPages = computed(() => query.data.value?.pages[0]?.total_pages ?? 0)
	const tasks = computed(() => query.data.value?.pages.flatMap(result => result.items ?? []) ?? [])

	async function loadTasks() {
		await query.refetch()
		return tasks.value
	}

	return {
		tasks,
		loading,
		totalPages,
		currentPage: page,
		loadTasks,
		params,
		sortByParam: sortBy,
	}
}
