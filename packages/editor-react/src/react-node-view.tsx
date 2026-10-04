import { Component, type ComponentType, type ReactNode } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type {
  NodeViewRenderer,
  ReactNodeViewProps,
  ReactNodeViewRendererOptions,
} from "@tiptap/react";

export interface ReactNodeViewErrorContext {
  node: ReactNodeViewProps["node"];
}

export interface SafeReactNodeViewRendererOptions extends Partial<ReactNodeViewRendererOptions> {
  errorLabel?: string;
  retryLabel?: string;
  errorClassName?: string;
  onError?: (error: Error, context: ReactNodeViewErrorContext) => void;
}

interface NodeViewErrorBoundaryProps {
  children: ReactNode;
  node: ReactNodeViewProps["node"];
  errorLabel: string;
  retryLabel: string;
  errorClassName: string;
  onError?: SafeReactNodeViewRendererOptions["onError"];
}

interface NodeViewErrorBoundaryState {
  error: Error | null;
}

class NodeViewErrorBoundary extends Component<
  NodeViewErrorBoundaryProps,
  NodeViewErrorBoundaryState
> {
  state: NodeViewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): NodeViewErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    try {
      this.props.onError?.(error, { node: this.props.node });
    } catch {
      // Consumer error reporting must not escape the node boundary.
    }
  }

  private retry = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <NodeViewWrapper
        as={this.props.node.isInline ? "span" : "div"}
        role="alert"
        className={this.props.errorClassName}
        data-node-view-error=""
      >
        <span>{this.props.errorLabel}</span>
        <button type="button" onClick={this.retry}>
          {this.props.retryLabel}
        </button>
      </NodeViewWrapper>
    );
  }
}

/**
 * Creates a React NodeView renderer whose component failures stay inside that node.
 * The document node remains intact; a changed identity or explicit retry remounts its view.
 */
export function createSafeReactNodeViewRenderer(
  component: ComponentType<ReactNodeViewProps>,
  options: SafeReactNodeViewRendererOptions = {},
): NodeViewRenderer {
  const {
    errorLabel = "此内容块暂时无法显示。",
    retryLabel = "重试此块",
    errorClassName = "zhishu-react-node-view-error",
    onError,
    ...rendererOptions
  } = options;

  function IsolatedNodeView(props: ReactNodeViewProps) {
    const NodeViewComponent = component;
    const blockId = props.node.attrs.blockId;
    let position: number | undefined;
    try {
      const currentPosition = props.getPos();
      if (typeof currentPosition === "number") position = currentPosition;
    } catch {
      // A stale NodeView should still render with a type-local fallback identity.
    }
    const identity =
      typeof blockId === "string" && blockId.length > 0
        ? `${props.node.type.name}:block:${blockId}`
        : `${props.node.type.name}:position:${position ?? "unknown"}`;
    return (
      <NodeViewErrorBoundary
        key={identity}
        node={props.node}
        errorLabel={errorLabel}
        retryLabel={retryLabel}
        errorClassName={errorClassName}
        onError={onError}
      >
        <NodeViewComponent {...props} />
      </NodeViewErrorBoundary>
    );
  }

  return ReactNodeViewRenderer(IsolatedNodeView, rendererOptions);
}

export { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
export type { ReactNodeViewProps, ReactNodeViewRendererOptions } from "@tiptap/react";
