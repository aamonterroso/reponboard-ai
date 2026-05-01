import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export function KeyFilesSkeleton(): React.JSX.Element {
  return (
    <Card className="animate-fade-slide-up hover:border-zinc-700 transition-colors duration-150">
      <div className="w-full flex items-center justify-between px-5 py-4 rounded-t-xl">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-4" />
      </div>
      <div className="flex flex-col divide-y divide-zinc-800 border-t border-zinc-800">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="px-5 py-3 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-16 rounded" />
            </div>
            <Skeleton className="h-3 w-full mt-1" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </Card>
  )
}
