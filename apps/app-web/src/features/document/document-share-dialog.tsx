import { MemberPicker, type MemberChoice } from '@/features/knowledge/member-picker';
import { DocumentAccessMode } from './document-access-mode';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Trash2 } from 'lucide-react';
import { Calendar, DateField, DatePicker } from '@heroui/react';
import { CalendarDateTime, getLocalTimeZone, type DateValue } from '@internationalized/date';
import {
  createDocumentShare,
  listDocumentAcl,
  listDocumentShares,
  removeDocumentAcl,
  revokeDocumentShare,
  setDocumentAcl,
} from '@/api/generated/documents';
import { explainDocumentAuthorization } from '@/api/generated/authorization';
import type {
  CreateDocumentShare201,
  ListDocumentShares200Item,
} from '@/api/generated/app-api.schemas';
import { SetDocumentAcl200ActionsItem } from '@/api/generated/app-api.schemas';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { PanelDialog } from '@/components/ui/panel-dialog';

const DAY_MS = 86_400_000;
const permissionNames: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '编辑者',
  viewer: '阅读者',
  read: '阅读',
  write: '编辑',
  comment: '评论',
  share: '分享',
  export: '导出',
  manage: '管理',
  ai: 'AI',
};

const expiryPresets = [
  { days: 1, label: '1 天' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
] as const;

const shareDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatShareDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : shareDateTimeFormatter.format(date);
}

function shareUrl(shareId: string): string {
  return new URL(`/share/${encodeURIComponent(shareId)}`, window.location.origin).toString();
}

function isExpired(share: { expiresAt: string; revokedAt: string | null }): boolean {
  return !share.revokedAt && new Date(share.expiresAt).getTime() <= Date.now();
}

function calendarDateTimeFromTimestamp(timestamp: number): CalendarDateTime {
  const date = new Date(timestamp);
  return new CalendarDateTime(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  );
}

function PermissionBadge({ permission }: { permission: 'read' | 'edit' }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
        permission === 'edit'
          ? 'bg-primary/10 text-primary'
          : 'bg-secondary text-secondary-foreground'
      }`}
    >
      {permission === 'edit' ? '可编辑' : '可阅读'}
    </span>
  );
}

function LinkShareSection({
  documentId,
  canGrantEdit,
}: {
  documentId: string;
  canGrantEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [permission, setPermission] = useState<'read' | 'edit'>('read');
  const [kind, setKind] = useState<'invite' | 'access'>('access');
  const selectedPermission = canGrantEdit ? permission : 'read';
  const [presetDays, setPresetDays] = useState<number | null>(7);
  const [customExpiry, setCustomExpiry] = useState<DateValue | null>(null);
  const [datePickerResetKey, setDatePickerResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateDocumentShare201 | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ListDocumentShares200Item | null>(null);
  const copyTimer = useRef<number | null>(null);
  // Mount-time clock reading: render-phase purity rules forbid calling
  // Date.now() during render, and this section remounts each time the
  // share dialog opens.
  const [renderNow] = useState(() => Date.now());
  const minCustomExpiry = calendarDateTimeFromTimestamp(renderNow + 5 * 60_000);
  const maxCustomExpiry = calendarDateTimeFromTimestamp(renderNow + 365 * DAY_MS);

  const shares = useQuery({
    queryKey: ['document-shares', documentId],
    queryFn: ({ signal }) => listDocumentShares(documentId, { signal }),
  });

  const resolveExpiresAt = (): string | null => {
    if (customExpiry) {
      const time = customExpiry.toDate(getLocalTimeZone()).getTime();
      if (Number.isNaN(time) || time <= Date.now() || time > renderNow + 365 * DAY_MS) {
        return null;
      }
      return new Date(time).toISOString();
    }
    if (presetDays) return new Date(Date.now() + presetDays * DAY_MS).toISOString();
    return null;
  };

  const copyLink = async (shareId: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(shareId));
      setCopiedId(shareId);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 2_000);
    } catch {
      setError('无法复制链接，请检查浏览器剪贴板权限。');
    }
  };

  const create = async () => {
    const expiresAt = resolveExpiresAt();
    if (!expiresAt || busy) return;
    setBusy(true);
    setError(null);
    try {
      const share = await createDocumentShare(documentId, {
        permission: selectedPermission,
        kind,
        expiresAt,
      });
      setCreated(share);
      await queryClient.invalidateQueries({ queryKey: ['document-shares', documentId] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return false;
    try {
      await revokeDocumentShare(documentId, revokeTarget.id);
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
    if (created?.id === revokeTarget.id) setCreated(null);
    await queryClient.invalidateQueries({ queryKey: ['document-shares', documentId] });
    setRevokeTarget(null);
    return true;
  };

  const customExpiryTime = customExpiry?.toDate(getLocalTimeZone()).getTime() ?? Number.NaN;
  const expiryValid = customExpiry
    ? !Number.isNaN(customExpiryTime) &&
      customExpiryTime > renderNow + 5 * 60_000 &&
      customExpiryTime <= renderNow + 365 * DAY_MS
    : presetDays !== null;

  return (
    <section aria-label="链接分享" className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Link2 size={15} className="text-primary" aria-hidden="true" />
          链接分享
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          创建一条公开链接；任何人打开都可以阅读，站内用户接受后按档位获得权限。链接必须设置有效期，最长一年。
          仅可分享你当前拥有的权限；失去对应权限后，链接将停止公开访问和新成员加入。
        </p>
      </div>

      <label className="block space-y-2 text-xs font-medium">
        授权期限
        <select
          className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
          value={kind}
          disabled={busy}
          onChange={(e) => setKind(e.target.value as 'invite' | 'access')}
        >
          <option value="access">限时访问：撤销或过期后收回此来源权限</option>
          <option value="invite">长期邀请：接受后保留，需单独撤销成员权限</option>
        </select>
      </label>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">访问档位</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { value: 'read', title: '可阅读', hint: '仅查看正文' },
              { value: 'edit', title: '可编辑', hint: '站内用户加入后可编辑与评论' },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors duration-150 ${
                selectedPermission === option.value
                  ? 'border-primary/50 bg-primary/5'
                  : 'hover:border-primary/30'
              }`}
            >
              <input
                type="radio"
                name="share-permission"
                className="mt-0.5 accent-primary"
                checked={selectedPermission === option.value}
                disabled={option.value === 'edit' && !canGrantEdit}
                onChange={() => setPermission(option.value)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.title}</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">有效期（必填）</legend>
        <div className="flex flex-wrap items-center gap-2">
          {expiryPresets.map((preset) => {
            const active = !customExpiry && presetDays === preset.days;
            return (
              <button
                key={preset.days}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setPresetDays(preset.days);
                  setCustomExpiry(null);
                  setDatePickerResetKey((key) => key + 1);
                }}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:border-primary/40 hover:text-primary'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>自定义</span>
            <DatePicker
              key={datePickerResetKey}
              aria-label="自定义有效期"
              className="w-64 max-w-full"
              value={customExpiry}
              minValue={minCustomExpiry}
              maxValue={maxCustomExpiry}
              granularity="minute"
              hourCycle={24}
              hideTimeZone
              onChange={(value) => {
                setCustomExpiry(value);
                setPresetDays(null);
              }}
            >
              <DateField.Group fullWidth className="h-8">
                <DateField.Input>
                  {(segment) => <DateField.Segment segment={segment} />}
                </DateField.Input>
                <DateField.Suffix>
                  <DatePicker.Trigger aria-label="打开日期选择器">
                    <DatePicker.TriggerIndicator />
                  </DatePicker.Trigger>
                </DateField.Suffix>
              </DateField.Group>
              <DatePicker.Popover>
                <Calendar aria-label="选择分享链接有效期">
                  <Calendar.Header>
                    <Calendar.YearPickerTrigger>
                      <Calendar.YearPickerTriggerHeading />
                      <Calendar.YearPickerTriggerIndicator />
                    </Calendar.YearPickerTrigger>
                    <Calendar.NavButton slot="previous" />
                    <Calendar.NavButton slot="next" />
                  </Calendar.Header>
                  <Calendar.Grid>
                    <Calendar.GridHeader>
                      {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
                    </Calendar.GridHeader>
                    <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
                  </Calendar.Grid>
                  <Calendar.YearPickerGrid>
                    <Calendar.YearPickerGridBody>
                      {({ year }) => <Calendar.YearPickerCell year={year} />}
                    </Calendar.YearPickerGridBody>
                  </Calendar.YearPickerGrid>
                </Calendar>
              </DatePicker.Popover>
            </DatePicker>
          </div>
        </div>
        {customExpiry && !expiryValid && (
          <p className="text-xs text-destructive">有效期需在 5 分钟后至一年内。</p>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!expiryValid || busy}
          onClick={() => void create()}
        >
          {busy ? '正在创建…' : '创建分享链接'}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      {created && (
        <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <p className="text-xs font-medium text-primary">
            链接已创建，有效期至 {formatShareDate(created.expiresAt)}
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={shareUrl(created.id)}
              className="h-8 flex-1 text-xs"
              aria-label="分享链接"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => void copyLink(created.id)}
            >
              {copiedId === created.id ? (
                <>
                  <Check size={13} aria-hidden="true" />
                  已复制
                </>
              ) : (
                <>
                  <Copy size={13} aria-hidden="true" />
                  复制
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">已创建的链接</h4>
        {shares.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            正在读取分享链接…
          </p>
        ) : shares.isError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-xs text-destructive">
              {errorMessage(shares.error)}
            </p>
            <Button variant="outline" size="sm" onClick={() => void shares.refetch()}>
              重新加载
            </Button>
          </div>
        ) : shares.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有分享链接。</p>
        ) : (
          <ul aria-label="分享链接列表" className="divide-y rounded-xl border">
            {shares.data.map((share) => {
              const expired = isExpired(share);
              return (
                <li
                  key={share.id}
                  className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <PermissionBadge permission={share.permission} />
                      <span className="text-xs text-muted-foreground">
                        {share.kind === 'access' ? '限时访问' : '长期邀请'}
                      </span>
                      <span
                        className={`text-xs font-normal ${
                          share.revokedAt
                            ? 'text-destructive'
                            : expired
                              ? 'text-amber-600'
                              : 'text-muted-foreground'
                        }`}
                      >
                        {share.revokedAt
                          ? '已撤销'
                          : expired
                            ? '已过期'
                            : `有效期至 ${formatShareDate(share.expiresAt)}`}
                      </span>
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {share.joinCount} 人通过链接加入 · 创建于 {formatShareDate(share.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="复制链接"
                      title={copiedId === share.id ? '已复制' : '复制链接'}
                      onClick={() => void copyLink(share.id)}
                    >
                      {copiedId === share.id ? (
                        <Check size={14} className="text-primary" aria-hidden="true" />
                      ) : (
                        <Copy size={14} aria-hidden="true" />
                      )}
                    </Button>
                    {!share.revokedAt && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="撤销链接"
                        title="撤销链接"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          setError(null);
                          setRevokeTarget(share);
                        }}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="撤销这条分享链接？"
        description={
          revokeTarget?.kind === 'access'
            ? '链接及此来源的权限将失效；其他链接、成员或直接授权继续生效。'
            : '链接会立即失效，已经接受邀请的用户保留权限，可在成员设置中单独撤销。'
        }
        confirmLabel="撤销链接"
        destructive
        onConfirm={confirmRevoke}
      />
    </section>
  );
}

const editableActions = Object.values(SetDocumentAcl200ActionsItem);

const actionLabels: Record<SetDocumentAcl200ActionsItem, string> = {
  read: '查看正文',
  write: '编辑正文',
  comment: '评论',
  share: '创建与撤销分享链接',
  export: '导出文档',
  ai: 'AI 使用',
  manage: '管理权限与删除',
  move: '移动文档',
};

function MemberAclSection({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const [selectedMember, setSelectedMember] = useState<MemberChoice | null>(null);
  const identityId = selectedMember?.identityId ?? '';
  const [actions, setActions] = useState<SetDocumentAcl200ActionsItem[]>(['read']);
  const [role, setRole] = useState<'viewer' | 'editor' | 'admin' | 'custom'>('viewer');
  const [busyIdentity, setBusyIdentity] = useState<string | null>(null);
  const [revokeSubject, setRevokeSubject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const acl = useQuery({
    queryKey: ['document-acl', documentId],
    queryFn: ({ signal }) => listDocumentAcl(documentId, { signal }),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['document-acl', documentId] });
  };

  const toggleAction = (action: SetDocumentAcl200ActionsItem, checked: boolean) => {
    setActions((current) =>
      checked
        ? current.includes(action)
          ? current
          : [...current, action]
        : current.filter((item) => item !== action),
    );
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subject = identityId.trim();
    if (!subject || (role === 'custom' && actions.length === 0)) return;
    setBusyIdentity(subject);
    setError(null);
    setNotice(null);
    try {
      await setDocumentAcl(documentId, subject, role === 'custom' ? { actions } : { role });
      await refresh();
      setSelectedMember(null);
      setActions(['read']);
      setRole('viewer');
      setNotice('权限已保存。');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyIdentity(null);
    }
  };

  const confirmRevoke = async () => {
    const subject = revokeSubject;
    if (!subject) return false;
    setBusyIdentity(subject);
    setError(null);
    setNotice(null);
    try {
      await removeDocumentAcl(documentId, subject);
      await refresh();
      if (identityId === subject) {
        setSelectedMember(null);
        setActions(['read']);
      }
      setNotice('已撤销该主体的文档权限。');
      setRevokeSubject(null);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusyIdentity(null);
    }
  };

  return (
    <section aria-label="成员权限" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">成员权限</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          搜索成员姓名或邮箱，单独授予访问权限。单独授权与空间继承权限共同生效。
        </p>
      </div>

      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <MemberPicker
          value={selectedMember}
          disabled={busyIdentity !== null}
          onChange={setSelectedMember}
        />

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">授权内容</legend>
          <label className="flex items-center gap-2 text-sm">
            角色
            <select
              aria-label="文档成员角色"
              value={role}
              onChange={(e) => {
                const value = e.target.value;
                if (
                  value === 'viewer' ||
                  value === 'editor' ||
                  value === 'admin' ||
                  value === 'custom'
                )
                  setRole(value);
              }}
              className="rounded border bg-background px-2 py-1"
            >
              <option value="viewer">只读</option>
              <option value="editor">编辑</option>
              <option value="admin">管理</option>
              <option value="custom">单独操作权限</option>
            </select>
          </label>
          {role === 'custom' &&
            editableActions.map((action) => (
              <label key={action} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={actions.includes(action)}
                  onChange={(event) => toggleAction(action, event.target.checked)}
                />
                {actionLabels[action]}
              </label>
            ))}
          <p className="text-xs leading-5 text-muted-foreground">
            角色能力按本空间配置生效，单独操作权限与继承来源共同生效。实际能力见下方授权列表。
          </p>
        </fieldset>

        <Button
          type="submit"
          variant="outline"
          disabled={
            !identityId.trim() ||
            (role === 'custom' && actions.length === 0) ||
            busyIdentity !== null
          }
        >
          {busyIdentity ? '正在保存…' : '保存授权'}
        </Button>
      </form>

      {acl.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取现有授权…
        </p>
      ) : acl.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(acl.error)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void acl.refetch()}>
            重新加载
          </Button>
        </div>
      ) : acl.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">目前没有其他主体的单独授权。</p>
      ) : (
        <ul aria-label="已授权主体" className="divide-y rounded-xl border">
          {acl.data.map((entry) => (
            <li
              key={entry.identityId}
              className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="break-all text-sm font-medium">
                  {entry.displayName || entry.identityId}
                </p>
                {entry.email && <p className="text-xs text-muted-foreground">{entry.email}</p>}
                {entry.grantedAt && (
                  <p className="text-xs text-muted-foreground">
                    授权于 {formatShareDate(entry.grantedAt)}
                  </p>
                )}
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  直接授予：{entry.actions.map((action) => actionLabels[action]).join('、')}
                  <br />
                  有效能力：{entry.actions.map((action) => actionLabels[action]).join('、')}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyIdentity !== null}
                  onClick={() => {
                    setSelectedMember({
                      identityId: entry.identityId,
                      displayName: entry.displayName ?? entry.identityId,
                      email: entry.email,
                    });
                    setRole(entry.role ?? 'custom');
                    setActions(entry.actions.filter((action) => editableActions.includes(action)));
                    setError(null);
                    setNotice(null);
                  }}
                >
                  编辑权限
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyIdentity !== null}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setRevokeSubject(entry.identityId);
                  }}
                >
                  撤销
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(error || notice) && (
        <p
          className={`text-sm ${error ? 'text-destructive' : 'text-muted-foreground'}`}
          role={error ? 'alert' : 'status'}
        >
          {error ?? notice}
        </p>
      )}
      <ConfirmDialog
        open={revokeSubject !== null}
        onOpenChange={(open) => {
          if (!open && busyIdentity === null) setRevokeSubject(null);
        }}
        title="撤销文档权限"
        description={
          revokeSubject
            ? `将撤销 ${revokeSubject} 对这篇文档的全部单独授权。对方可能会立即失去查看或编辑权限。`
            : ''
        }
        confirmLabel="撤销全部权限"
        destructive
        error={error}
        onConfirm={confirmRevoke}
      />
    </section>
  );
}

export function DocumentShareDialog({
  open,
  onOpenChange,
  documentId,
  canManage,
  canShare,
  canWrite,
  canComment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
  canManage: boolean;
  canShare: boolean;
  canWrite: boolean;
  canComment: boolean;
}) {
  const authorization = useQuery({
    queryKey: ['document-authorization', documentId],
    queryFn: ({ signal }) => explainDocumentAuthorization(documentId, { signal }),
    enabled: open,
  });
  return (
    <PanelDialog
      open={open}
      onOpenChange={onOpenChange}
      title="分享与权限"
      description="把知识分享给需要的人，自由控制查看与编辑权限。"
    >
      {canManage || canShare ? (
        <div className="space-y-8 text-foreground">
          {canManage && <DocumentAccessMode documentId={documentId} />}
          <details className="rounded-xl border p-3 text-xs">
            <summary className="cursor-pointer">我的权限来源</summary>
            {authorization.isError ? (
              <p role="alert">权限来源加载失败，请重新打开重试。</p>
            ) : (
              <div className="mt-3 space-y-2">
                <p>
                  当前有效角色：
                  {authorization.data?.roles
                    .map((role) => permissionNames[role] ?? role)
                    .join('、') || '正在加载'}
                </p>
                <p>
                  直接授权来源：
                  {authorization.data?.directGrants
                    .map(
                      (g) =>
                        `${g.sourceShareId ? (g.kind === 'access' ? '限时访问链接' : '长期邀请') : '成员直接授权'} · ${permissionNames[g.role] ?? g.role}${g.active ? '' : '（已失效）'}`,
                    )
                    .join('；') || '通过空间或目录继承'}
                </p>
              </div>
            )}
          </details>
          {canShare && (
            <LinkShareSection documentId={documentId} canGrantEdit={canWrite && canComment} />
          )}
          {canManage && (
            <details className="rounded-xl border border-border/70 bg-background/50 p-4">
              <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground">
                成员权限设置
              </summary>
              <div className="mt-5">
                <MemberAclSection documentId={documentId} />
              </div>
            </details>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">你没有这篇文档的分享管理权限。</p>
      )}
    </PanelDialog>
  );
}
