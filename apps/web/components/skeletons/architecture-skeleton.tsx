import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export function ArchitectureSkeleton(): React.JSX.Element {
  return (
    <Card className="animate-fade-slide-up hover:border-zinc-700 transition-colors duration-150">
      <div className="w-full flex items-center justify-between px-4 py-3 rounded-t-xl">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-7 rounded" />
          <div className="flex flex-col items-start gap-1 min-w-0">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
        <Skeleton className="h-4 w-4" />
      </div>
    </Card>
  )
}
