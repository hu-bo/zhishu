const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Compact zh-CN relative time; falls back to a medium date beyond ~30 days. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = then - Date.now();
  const magnitude = Math.abs(diff);
  if (magnitude < MINUTE) return '刚刚';
  if (magnitude < HOUR) return relativeFormatter.format(Math.round(diff / MINUTE), 'minute');
  if (magnitude < DAY) return relativeFormatter.format(Math.round(diff / HOUR), 'hour');
  if (magnitude < 30 * DAY) return relativeFormatter.format(Math.round(diff / DAY), 'day');
  return dateFormatter.format(then);
}
