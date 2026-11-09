import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchIdentityDirectory } from '@/api/generated/identity';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useKnowledgeWorkspace } from './workspace-context';

export type MemberChoice = { identityId: string; displayName: string; email?: string };
export function MemberPicker({
  value,
  onChange,
  documentId,
  disabled = false,
  label = '选择成员',
}: {
  value: MemberChoice | null;
  onChange: (value: MemberChoice | null) => void;
  documentId?: string;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const { identityKey } = useKnowledgeWorkspace();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const query = useQuery({
    queryKey: ['member-directory', identityKey, documentId, search],
    queryFn: ({ signal }) => searchIdentityDirectory({ q: search, documentId }, { signal }),
    enabled: open && !disabled,
    staleTime: 15_000,
  });
  const items = query.data ?? [];
  const choose = (member: MemberChoice) => {
    onChange(member);
    setOpen(false);
    setText('');
    setActive(0);
  };
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {value ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm">{value.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {value.email || value.identityId}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onChange(null);
              setOpen(true);
            }}
          >
            更换
          </Button>
        </div>
      ) : (
        <>
          <Input
            id={id}
            value={text}
            disabled={disabled}
            placeholder="搜索姓名或邮箱"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={open && items[active] ? `${id}-${active}` : undefined}
            autoComplete="off"
            onFocus={() => setOpen(true)}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setOpen(false);
            }}
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                setActive((index) =>
                  Math.max(
                    0,
                    Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                  ),
                );
              }
              if (event.key === 'Enter' && open) {
                event.preventDefault();
                if (items[active]) choose(items[active]);
              }
            }}
          />
          {open && (
            <div className="max-h-48 overflow-y-auto rounded-lg border bg-card p-1">
              {query.isPending ? (
                <p role="status" className="p-2 text-xs text-muted-foreground">
                  正在搜索…
                </p>
              ) : query.isError ? (
                <div role="alert" className="p-2 text-xs text-destructive">
                  {errorMessage(query.error)}{' '}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void query.refetch()}
                  >
                    重试
                  </Button>
                </div>
              ) : (
                <>
                  <ul role="listbox" id={`${id}-list`} aria-label={label}>
                    {items.map((member, index) => (
                      <li
                        key={member.identityId}
                        id={`${id}-${index}`}
                        role="option"
                        aria-selected={index === active}
                      >
                        <button
                          type="button"
                          className={`w-full rounded-md px-3 py-2 text-left hover:bg-secondary ${index === active ? 'bg-secondary' : ''}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => choose(member)}
                        >
                          <span className="block truncate text-sm">{member.displayName}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {member.email}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!items.length && (
                    <p className="p-2 text-xs text-muted-foreground">
                      没有匹配的成员，可先发送空间邀请链接。
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
