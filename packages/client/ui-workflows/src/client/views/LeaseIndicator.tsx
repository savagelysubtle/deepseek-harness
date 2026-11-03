/** The visible "live approvals attached / lapsed" indicator: a lapsed or refused lease always says why. */
import type { LeaseView } from '../controller.ts'
import css from '../Workflows.module.css'
import { FailureNotice } from './shared.tsx'
import type { T } from './shared.tsx'

/**
 * Render the lease state and, when it is not healthy, the reason and remedy.
 * @param props.lease - the lease view from the controller.
 */
export function LeaseIndicator({ lease, t }: { lease: LeaseView; t: T }) {
  const failure = lease.failure
  return (
    <div className={css.lease} data-lease-indicator data-lease-state={lease.state}>
      <span className={css.leaseDot} data-lease-dot />
      <span data-lease-label>{t(`lease.${lease.state}`)}</span>
      {lease.state === 'attached' && <span className={css.muted} data-lease-hint>{t('lease.hint.attached')}</span>}
      {failure !== undefined && (
        failure.error === 'LEASE_LAPSED'
          ? <span className={css.remedy} data-lease-reason>{t('lease.lapsedExpired')}</span>
          : <FailureNotice failure={failure} scope="lease" t={t} />
      )}
    </div>
  )
}
