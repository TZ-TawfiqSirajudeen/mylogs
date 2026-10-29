import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-400',
    ghost: 'border border-slate-300 bg-white hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800',
    danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-400',
  }[variant];
  return <button {...p} className={cx('inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed', styles, className)} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined }>(
  function Input({ label, error, id, className, ...p }, ref) {
    const fid = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
    return (
      <div className="space-y-1">
        <label htmlFor={fid} className="block text-sm font-medium">{label}</label>
        <input ref={ref} id={fid} aria-invalid={!!error} {...p}
          className={cx('w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900', error && 'border-red-500', className)} />
        {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  });

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
          <h2 className="text-sm font-semibold">{title}</h2>{actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'danger' | 'info' | 'warn'; children: ReactNode }) {
  const t = {
    neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    danger: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    info: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
    warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  }[tone];
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', t)}>{children}</span>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
      <h3 className="font-medium">{title}</h3>
      {children && <p className="mx-auto mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-400">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  const rid = (error as { requestId?: string })?.requestId;
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950/40">
      <p className="font-medium text-red-800 dark:text-red-300">{msg}</p>
      {rid && <p className="mt-1 font-mono text-xs text-red-700/80 dark:text-red-300/70">request id: {rid}</p>}
      {onRetry && <Button variant="ghost" className="mt-3" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p role="status" className="p-4 text-sm text-slate-500">{label}</p>;
}
