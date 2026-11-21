import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { Description, Dropdown, Header, Label } from '@heroui/react';
import { FileUp, Globe, Image, MessageSquare, PenLine, Plus } from 'lucide-react';
import { pickerPopoverClass } from './picker-shared';

export type AssistantIntent = 'qa' | 'writing';

const INTENTS = [
  { value: 'qa', label: '问答', icon: MessageSquare },
  { value: 'writing', label: '创作', icon: PenLine },
] as const satisfies readonly {
  value: AssistantIntent;
  label: string;
  icon: typeof PenLine;
}[];

/**
 * Per-round intent segment. Switching only changes the intent hint and the toolbar shape;
 * it never replaces the conversation, transport or input draft.
 */
export function IntentSegment({
  intent,
  onChange,
}: {
  intent: AssistantIntent;
  onChange: (next: AssistantIntent) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="本轮意图"
      className="assistant-intent"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        onChange(intent === 'qa' ? 'writing' : 'qa');
      }}
    >
      {INTENTS.map((item) => (
        <button
          key={item.value}
          type="button"
          role="radio"
          aria-checked={intent === item.value}
          className={cn('assistant-intent-btn', intent === item.value && 'active')}
          onClick={() => onChange(item.value)}
        >
          <item.icon className="size-3.5 shrink-0" />
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Icon + text toggle for web research; replaces the old checkbox. */
export function WebSearchToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={disabled ? '联网调研未在服务端配置，暂不可用' : '联网搜索'}
      className={cn('assistant-web-toggle', checked && 'active')}
      onClick={() => onChange(!checked)}
    >
      <Globe className="size-4 shrink-0" />
      联网搜索
    </button>
  );
}

/**
 * Attachment entry. The upload channel is a server-side dependency (design P3), so the
 * menu ships as an honest disabled skeleton instead of faking a working upload.
 */
export function AttachMenu() {
  return (
    <Dropdown>
      <Button
        variant="ghost"
        size="icon-sm"
        className="assistant-tool-icon shrink-0"
        aria-label="添加附件"
        title="上传图片或文件"
      >
        <Plus className="size-4" />
      </Button>
      <Dropdown.Popover placement="top start" className={cn(pickerPopoverClass, 'w-64')}>
        <Dropdown.Menu className="gap-0.5 text-[13px]">
          <Dropdown.Section>
            <Header className="px-2 text-xs font-medium text-muted-foreground">添加</Header>
            <Dropdown.Item id="attach-image" textValue="上传图片" isDisabled>
              <div className="flex flex-col">
                <Label className="flex items-center gap-2 font-normal">
                  <Image className="size-4 shrink-0 text-muted" />
                  上传图片
                </Label>
                <Description>PNG / JPG / GIF / WebP · 即将支持</Description>
              </div>
            </Dropdown.Item>
            <Dropdown.Item id="attach-file" textValue="上传文件" isDisabled>
              <div className="flex flex-col">
                <Label className="flex items-center gap-2 font-normal">
                  <FileUp className="size-4 shrink-0 text-muted" />
                  上传文件
                </Label>
                <Description>PDF / Word / Excel / Markdown · 即将支持</Description>
              </div>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Explicit create-draft command entry: inserts a confirm card into the message stream. */
export function DraftCreateButton({
  disabled,
  title,
  onClick,
}: {
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="secondary"
      size="xs"
      className="h-8 gap-1.5 px-2.5 text-[12.5px]"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <PenLine className="size-3.5" />
      创建草稿
    </Button>
  );
}
