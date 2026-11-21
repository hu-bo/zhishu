import { Description, Dropdown, Header, Label } from '@heroui/react';
import { FolderDown } from 'lucide-react';
import type { ListKnowledgeWorkspaces200Item } from '../../api/generated/app-api.schemas';
import { PickerNote, PickerTrigger, RadioTick, pickerPopoverClass } from './picker-shared';
import { workspaceVisibility } from './workspace-labels';

/**
 * Draft save-target picker (creation intent). The value never comes from the retrieval
 * scope or the first list entry: it is the user's explicit choice, and the server
 * re-validates write permission when the draft is created.
 */
export function SaveToPicker({
  workspaces,
  value,
  onChange,
  isOpen,
  onOpenChange,
}: {
  workspaces: readonly ListKnowledgeWorkspaces200Item[];
  /** Effective target id (explicit choice or the default personal space). */
  value: string | null;
  onChange: (workspaceId: string) => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = workspaces.find((space) => space.id === value);
  const label = selected ? `保存到：${selected.name}` : '选择保存位置…';
  return (
    <Dropdown isOpen={isOpen} onOpenChange={onOpenChange}>
      <PickerTrigger
        icon={FolderDown}
        label={label}
        ariaLabel={label}
        open={isOpen}
        tone={selected ? 'default' : 'warn'}
      />
      <Dropdown.Popover placement="top start" className={pickerPopoverClass}>
        <Dropdown.Menu className="gap-0.5 text-[13px]">
          <Dropdown.Section>
            <Header className="px-2 text-xs font-medium text-muted-foreground">保存位置</Header>
            {workspaces.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">正在载入空间…</p>
            ) : (
              workspaces.map((workspace) => (
                <Dropdown.Item
                  key={workspace.id}
                  id={workspace.id}
                  textValue={workspace.name}
                  onAction={() => {
                    onChange(workspace.id);
                    onOpenChange(false);
                  }}
                >
                  <RadioTick active={workspace.id === value} />
                  <div className="flex flex-col">
                    <Label className="font-normal">{workspace.name}</Label>
                    <Description>{workspaceVisibility(workspace.kind)}</Description>
                  </div>
                </Dropdown.Item>
              ))
            )}
          </Dropdown.Section>
        </Dropdown.Menu>
        <PickerNote>
          草稿将创建为所选空间中的一篇真实文档；创建时服务端将再次校验你的写入权限。
        </PickerNote>
      </Dropdown.Popover>
    </Dropdown>
  );
}
