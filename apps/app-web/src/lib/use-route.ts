import { useEffect, useSyncExternalStore } from 'react';
import { createRouteController, type RouteController, type RouteState } from '@/lib/route';

let singletonController: RouteController | null = null;

function getController(): RouteController {
  if (!singletonController) {
    singletonController = createRouteController();
  }
  return singletonController;
}

export function useRoute(): {
  route: RouteState;
  goToWorkbench: () => void;
  goToDocument: (documentId: string) => void;
} {
  const controller = getController();
  const route = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.state,
    () => ({ name: 'workbench' as const }),
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === '/' || window.location.pathname === '') {
      window.history.replaceState({}, '', '/documents');
    }
  }, []);
  return {
    route,
    goToWorkbench: controller.goToWorkbench,
    goToDocument: controller.goToDocument,
  };
}

/**
 * 测试 / 重置用入口；正常运行时只持有一个控制器。
 */
export function _resetRouteController(): void {
  singletonController = null;
}
