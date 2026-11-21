import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { searchIdentityDirectory } from '@/api/generated/identity';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import type { MemberChoice } from './member-picker';
import { useKnowledgeWorkspace } from './workspace-context';

/** 成员多选框：搜索通讯录点选多人，已选成员以标签展示；用于批量添加空间成员。 */
export function MemberMultiSelect({
  value,
  onChange,
  excludeIds,
  disabled = false,
}: {
  value: MemberChoice[];
  onChange: (value: MemberChoice[]) => void;
  /** 已在空间中的成员不会出现在候选里。 */
  excludeIds: string[];
  disabled?: boolean;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
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
    queryKey: ['member-directory', identityKey, undefined, search],
    queryFn: ({ signal }) => searchIdentityDirectory({ q: search }, { signal }),
    enabled: open && !disabled,
    staleTime: 15_000,
  });
  const selectedIds = new Set(value.map((member) => member.identityId));
  const excludedIds = new Set(excludeIds);
  const items = (query.data ?? []).filter(
    (member) => !selectedIds.has(member.identityId) && !excludedIds.has(member.identityId),
  );
  const toggle = (member: MemberChoice) => {
    onChange(
      selectedIds.has(member.identityId)
        ? value.filter((item) => item.identityId !== member.identityId)
        : [...value, member],
    );
  };
  return (
    <div ref={rootRef} className="space-y-2">
      <div
        className={`flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border bg-card px-2 py-1 ${
          disabled ? 'opacity-60' : ''
        }`}
      >
        {value.map((member) => (
          <span
            key={member.identityId}
            className="flex items-center gap-1 rounded-full bg-secondary py-0.5 pr-1 pl-2.5 text-xs"
          >
            <span className="max-w-36 truncate" title={member.email || member.identityId}>
              {member.displayName}
            </span>
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除已选 ${member.displayName}`}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
              onClick={() => toggle(member)}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          disabled={disabled}
          aria-label="搜索并选择要添加的成员"
          placeholder={value.length ? '' : '搜索成员姓名或邮箱，可多选'}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && items[active] ? `${id}-${active}` : undefined}
          autoComplete="off"
          className="min-w-32 flex-1 bg-transparent text-sm py-1 outline-none placeholder:text-muted-foreground"
          onFocus={() => setOpen(true)}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && rootRef.current?.contains(next)) return;
            setOpen(false);
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
              if (items[active]) {
                toggle(items[active]);
                setText('');
                setActive(0);
              }
            }
            if (event.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
        />
      </div>
      {open && (
        <div className="max-h-48 overflow-y-auto rounded-lg border bg-card p-1">
          {query.isPending ? (
            <p role="status" className="p-2 text-xs text-muted-foreground">
              正在搜索…
            </p>
          ) : query.isError ? (
            <div role="alert" className="p-2 text-xs text-destructive">
              {errorMessage(query.error)}{' '}
              <Button type="button" size="sm" variant="ghost" onClick={() => void query.refetch()}>
                重试
              </Button>
            </div>
          ) : (
            <>
              <ul
                role="listbox"
                id={`${id}-list`}
                aria-label="选择要添加的成员"
                className="space-y-0.5"
              >
                {items.map((member, index) => (
                  <li
                    key={member.identityId}
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={index === active}
                  >
                    <button
                      type="button"
                      className={`w-full rounded-md px-3 py-2 text-left hover:bg-secondary ${
                        index === active ? 'bg-secondary' : ''
                      }`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        toggle(member);
                        setText('');
                        setActive(0);
                      }}
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
                  没有可添加的成员；若对方尚未加入，可先发送空间邀请链接。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
