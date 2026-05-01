import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export function OnboardingJourneySkeleton(): React.JSX.Element {
  return (
    <Card className="animate-fade-slide-up hover:border-zinc-700 transition-colors duration-150">
      <div className="w-full flex items-center justify-between px-5 py-4 rounded-t-xl">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-4 w-4" />
      </div>
      <div className="border-t border-zinc-800 pt-4 pb-4 px-4 flex flex-col gap-4">
        <div className="flex flex-col gap-2 px-1">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-8" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
        <div className="flex flex-col gap-0">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-stretch gap-3">
              <div className="w-10 shrink-0 border-l-2 border-zinc-800 relative">
                <Skeleton className="absolute top-3 left-0 -translate-x-1/2 h-7 w-7 rounded-full" />
              </div>
              <div className="flex-1 min-w-0 py-3 px-4">
                <div className="flex items-start justify-between gap-3">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-5 w-16 rounded-full shrink-0" />
                </div>
                <Skeleton className="h-3 w-full mt-2" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    </Card>
  )
}
