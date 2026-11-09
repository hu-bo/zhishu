import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_LATEX_LENGTH, type RequestMathSource } from '@zhishu/editor-core';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

type FormulaRequest = Parameters<RequestMathSource>[0];

export function useDocumentFormulaDialog(sessionKey: string) {
  const pending = useRef<((source: string | null) => void) | null>(null);
  const [form, setForm] = useState<{ key: string; request: FormulaRequest; source: string }>();
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () => () => {
      pending.current?.(null);
      pending.current = null;
    },
    [sessionKey],
  );

  const requestMathSource = useCallback<RequestMathSource>(
    (request) => {
      if (pending.current) return null;
      return new Promise((resolve) => {
        pending.current = resolve;
        setForm({ key: sessionKey, request, source: request.initialSource ?? '' });
      });
    },
    [sessionKey],
  );

  function close(source: string | null) {
    const resolve = pending.current;
    pending.current = null;
    setForm(undefined);
    resolve?.(source);
  }

  const current = form?.key === sessionKey ? form : undefined;
  const editing = current?.request.initialSource !== undefined;
  const title = editing
    ? '编辑公式'
    : current?.request.kind === 'block'
      ? '插入公式块'
      : '插入行内公式';

  return {
    requestMathSource,
    formulaDialog: current && (
      <Dialog open onOpenChange={(open) => !open && close(null)} initialFocus={input}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>输入 LaTeX 公式内容，例如 {'\\frac{a}{b}'}。</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (current.source.trim()) close(current.source);
            }}
          >
            <label className="block space-y-2 text-sm font-medium">
              <span>LaTeX 源码</span>
              <Textarea
                ref={input}
                autoFocus
                spellCheck={false}
                maxLength={MAX_LATEX_LENGTH}
                value={current.source}
                className="bg-transparent font-sans text-foreground"
                onChange={(event) => setForm({ ...current, source: event.target.value })}
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => close(null)}>
                取消
              </Button>
              <Button type="submit" disabled={!current.source.trim()}>
                {editing ? '更新公式' : '插入公式'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    ),
  };
}
