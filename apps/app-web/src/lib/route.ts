/**
 * 简易视图层路由：
 * 当前阶段不接入 TanStack Router，使用 history API + 自定义 store 维护路由状态，
 * 复用 URL 作为恢复入口（刷新保留当前位置）。
 *
 * - `workbench`：文档工作台根路径 `/documents`
 * - `document`：单文档详情页 `/documents/:documentId`
 */

export type RouteState = { name: 'workbench' } | { name: 'document'; documentId: string };

const WORKBENCH_STATE: RouteState = { name: 'workbench' };
const DOCUMENT_CACHE = new Map<string, RouteState>();

function getDocumentState(documentId: string): RouteState {
  // 缓存每条路径对应的 RouteState 引用，避免每次调用返回新对象触发无限渲染。
  let cached = DOCUMENT_CACHE.get(documentId);
  if (!cached) {
    cached = { name: 'document', documentId };
    DOCUMENT_CACHE.set(documentId, cached);
  }
  return cached;
}

function readRouteFromUrl(): RouteState {
  if (typeof window === 'undefined') return WORKBENCH_STATE;
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  // 期望前缀 /documents
  if (segments[0] !== 'documents') return WORKBENCH_STATE;
  if (segments.length >= 2 && segments[1]) {
    return getDocumentState(decodeURIComponent(segments[1]));
  }
  return WORKBENCH_STATE;
}

function writeRouteToUrl(state: RouteState): void {
  if (typeof window === 'undefined') return;
  const path =
    state.name === 'document' ? `/documents/${encodeURIComponent(state.documentId)}` : '/documents';
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path);
  }
}

/**
 * 在 React 组件外读取当前路由状态（用于事件回调中判断）。
 * 注意：组件内应使用 hook 订阅以触发重渲染。
 */
export function getRouteSnapshot(): RouteState {
  return readRouteFromUrl();
}

export interface RouteController {
  state: RouteState;
  goToWorkbench: () => void;
  goToDocument: (documentId: string) => void;
  /** 监听浏览器前进 / 后退按钮。 */
  subscribe: (listener: () => void) => () => void;
}

/**
 * 创建一个简单的路由控制器，可在多个组件间共享。
 */
export function createRouteController(): RouteController {
  const listeners = new Set<() => void>();
  let current = readRouteFromUrl();
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
      current = readRouteFromUrl();
      listeners.forEach((listener) => listener());
    });
  }
  return {
    get state() {
      return current;
    },
    goToWorkbench: () => {
      writeRouteToUrl({ name: 'workbench' });
      current = WORKBENCH_STATE;
      listeners.forEach((listener) => listener());
    },
    goToDocument: (documentId: string) => {
      writeRouteToUrl({ name: 'document', documentId });
      current = getDocumentState(documentId);
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * 解析路由：从当前 RouteState 派生出 URL 路径，便于分享 / 复制。
 */
export function routeToPath(state: RouteState): string {
  return state.name === 'document'
    ? `/documents/${encodeURIComponent(state.documentId)}`
    : '/documents';
}
