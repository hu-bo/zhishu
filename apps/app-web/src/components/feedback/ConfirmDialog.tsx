import type { ReactNode } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  isBusy?: boolean;
  onConfirm: () => void;
}

/**
 * 通用确认对话框。
 *
 * 取代浏览器 `window.confirm`，用于删除、放弃修改、版本恢复等破坏性操作。
 * 失败时由调用方维持 isOpen 并显示错误，本组件不持有错误状态。
 */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  variant = 'primary',
  isBusy = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {typeof description === 'string' ? null : <DialogBody>{description}</DialogBody>}
        <DialogFooter>
          <Button variant="ghost" onPress={() => onOpenChange(false)} isDisabled={isBusy}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onPress={onConfirm}
            isDisabled={isBusy}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
