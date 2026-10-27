import { RepoHeaderSkeleton } from './repo-header-skeleton'
import { ExecutiveSummarySkeleton } from './executive-summary-skeleton'
import { StackSkeleton } from './stack-skeleton'
import { OnboardingJourneySkeleton } from './onboarding-journey-skeleton'

// Suspense fallback while the results chunk loads. Same skeletons the
// results view shows before data streams in, so the swap is seamless.
export function ResultsSkeleton(): React.JSX.Element {
  return (
    <div className="w-full flex flex-col gap-6" aria-busy="true">
      <RepoHeaderSkeleton />
      <ExecutiveSummarySkeleton />
      <StackSkeleton />
      <OnboardingJourneySkeleton />
    </div>
  )
}
