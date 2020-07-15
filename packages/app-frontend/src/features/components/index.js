import { ref, computed, watch } from '@vue/composition-api'
import Vue from 'vue'
import groupBy from 'lodash/groupBy'
import { BridgeEvents, parse, sortByKey, searchDeepInObject, BridgeSubscriptions } from '@vue-devtools/shared-utils'
import { useBridge } from '../bridge'
import { useRoute, useRouter } from '@front/util/router'
import { putError } from '../error'

const rootInstances = ref([])
let componentsMap = {}
let componentsParent = {}
const treeFilter = ref('')
const selectedComponentId = ref(null)
const selectedComponentData = ref(null)
const selectedComponentStateFilter = ref('')
let selectedComponentPendingId = null
let lastSelectedApp = null
let lastSelectedComponentId = null
// @TODO auto expand to selected component after target page refresh
let lastSelectedComponentPath = []
const expandedMap = ref({})
let resetComponentsQueued = false

function useComponentRequests () {
  const { bridge } = useBridge()
  const router = useRouter()

  function requestComponentTree (instanceId = null) {
    if (!instanceId) {
      instanceId = '_root'
    }
    if (instanceId === '_root') {
      resetComponentsQueued = true
    }
    bridge.send(BridgeEvents.TO_BACK_COMPONENT_TREE, {
      instanceId,
      filter: treeFilter.value
    })
  }

  function selectComponent (id, replace = false) {
    if (selectedComponentId.value !== id) {
      router[replace ? 'replace' : 'push']({
        params: {
          componentId: id
        }
      })
      lastSelectedComponentPath = getPath(id)
    } else {
      loadComponent(id)
    }
  }

  function loadComponent (id) {
    if (!id || selectedComponentPendingId === id) return
    lastSelectedComponentId = id
    selectedComponentPendingId = id
    bridge.send(BridgeEvents.TO_BACK_COMPONENT_SELECTED_DATA, id)
  }

  return {
    requestComponentTree,
    selectComponent,
    loadComponent
  }
}

export function useComponents () {
  const { onBridge, subscribe } = useBridge()
  const route = useRoute()
  const {
    requestComponentTree,
    selectComponent,
    loadComponent
  } = useComponentRequests()

  watch(treeFilter, () => {
    requestComponentTree()
  })

  watch(() => route.value.params.componentId, value => {
    selectedComponentId.value = value
    loadComponent(value)
  }, {
    immediate: true
  })

  function subscribeToSelectedData () {
    let unsub
    watch(selectedComponentId, value => {
      if (unsub) {
        unsub()
        unsub = null
      }

      if (value != null) {
        unsub = subscribe(BridgeSubscriptions.SELECTED_COMPONENT_DATA, {
          instanceId: value
        })
      }
    }, {
      immediate: true
    })
  }

  // We watch for the tree data so that we can auto load the current selected component
  watch(() => componentsMap, () => {
    if (selectedComponentId.value && selectedComponentPendingId !== selectedComponentId.value && !selectedComponentData.value) {
      selectComponent(selectedComponentId.value)
    }
  }, {
    immediate: true,
    deep: true
  })

  onBridge(BridgeEvents.TO_FRONT_APP_SELECTED, ({ id, lastInspectedComponentId }) => {
    requestComponentTree()
    selectedComponentData.value = null
    if (lastSelectedApp !== null) {
      selectComponent(lastInspectedComponentId, true)
    }
    lastSelectedApp = id
  })

  // Re-select last selected component when switching back to inspector component tab
  function selectLastComponent () {
    if (lastSelectedComponentId) {
      selectComponent(lastSelectedComponentId, true)
    }
  }

  return {
    rootInstances: computed(() => rootInstances.value),
    treeFilter,
    selectedComponentId: computed(() => selectedComponentId.value),
    requestComponentTree,
    selectComponent,
    selectLastComponent,
    subscribeToSelectedData
  }
}

export function useComponent (instance) {
  const { selectComponent, requestComponentTree } = useComponentRequests()
  const { subscribe } = useBridge()

  const isExpanded = computed(() => !!expandedMap.value[instance.value.id])
  const isExpandedUndefined = computed(() => expandedMap.value[instance.value.id] == null)

  function toggleExpand (load = true) {
    if (!instance.value.hasChildren) return
    Vue.set(expandedMap.value, instance.value.id, !isExpanded.value)
    if (load) {
      requestComponentTree(instance.value.id)
    }
  }

  const isSelected = computed(() => selectedComponentId.value === instance.value.id)

  function select () {
    selectComponent(instance.value.id)
  }

  function subscribeToComponentTree () {
    let unsub
    watch(() => instance.value.id, value => {
      if (unsub) {
        unsub()
        unsub = null
      }

      if (value != null) {
        unsub = subscribe(BridgeSubscriptions.COMPONENT_TREE, {
          instanceId: value
        })
      }
    }, {
      immediate: true
    })
  }

  if (isExpanded.value) {
    requestComponentTree(instance.value.id)
  }

  return {
    isExpanded,
    isExpandedUndefined,
    toggleExpand,
    isSelected,
    select,
    subscribeToComponentTree
  }
}

export function useSelectedComponent () {
  const data = computed(() => selectedComponentData.value)
  const state = computed(() => selectedComponentData.value ? groupBy(sortByKey(selectedComponentData.value.state.filter(el => {
    return searchDeepInObject({
      [el.key]: el.value
    }, selectedComponentStateFilter.value)
  })), 'type') : ({}))

  return {
    data,
    state,
    stateFilter: selectedComponentStateFilter
  }
}

export function resetComponents () {
  resetComponentsQueued = false
  rootInstances.value = []
  componentsMap = {}
  componentsParent = {}
}

export function setupComponentsBridgeEvents (bridge) {
  bridge.on(BridgeEvents.TO_FRONT_COMPONENT_TREE, ({ instanceId, treeData }) => {
    // Reset
    if (resetComponentsQueued) {
      resetComponents()
    }

    // Not supported
    if (!treeData) {
      if (instanceId.endsWith('root')) {
        putError('Component tree not supported')
      }
      return
    }

    // Handle tree data
    const data = parse(treeData)
    const instance = componentsMap[instanceId]
    if (instance) {
      for (const key in data) {
        Vue.set(instance, key, data[key])
      }
      addToComponentsMap(instance)
    } else if (Array.isArray(data)) {
      rootInstances.value = data
      data.forEach(i => addToComponentsMap(i))
    } else {
      rootInstances.value = [data]
      addToComponentsMap(data)
    }
  })

  bridge.on(BridgeEvents.TO_FRONT_COMPONENT_SELECTED_DATA, ({ instanceId, data }) => {
    if (instanceId === selectedComponentId.value) {
      selectedComponentData.value = parse(data)
      selectedComponentPendingId = null
    }
  })
}

function addToComponentsMap (instance) {
  componentsMap[instance.id] = instance
  if (instance.children) {
    instance.children.forEach(c => {
      componentsParent[c.id] = instance.id
      addToComponentsMap(c)
    })
  }
}

function getPath (instanceId) {
  const path = [instanceId]
  const parentId = componentsParent[instanceId]
  if (parentId) {
    path.unshift(...getPath(parentId))
  }
  return path
}
