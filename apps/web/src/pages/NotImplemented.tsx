import { useLocation } from 'react-router-dom';
import { Badge, EmptyState } from '../ui';

const PLAN: Record<string, [string, number]> = {
  '/services': ['Services', 4], '/traces': ['Traces', 4], '/metrics': ['Metrics', 4],
  '/dependencies': ['Dependency map', 7], '/incidents': ['Incidents', 6], '/alerts': ['Alerts', 6],
  '/deployments': ['Deployments', 6], '/dashboards': ['Dashboards', 7], '/settings': ['Settings', 2],
};

/** Honest placeholder: this module does not exist yet, so it shows no controls and no data. */
export default function NotImplemented() {
  const { pathname } = useLocation();
  const [name, phase] = PLAN[pathname] ?? ['This page', 0];
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{name}</h1>
      <EmptyState title="Not implemented yet">
        This module is on the roadmap (phase {phase}). See docs/STATUS.md for what is complete and tested.
        <span className="mt-2 block"><Badge tone="warn">Planned</Badge></span>
      </EmptyState>
    </div>
  );
}
