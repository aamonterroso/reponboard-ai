import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export function ExecutiveSummarySkeleton(): React.JSX.Element {
  return (
    <Card className="animate-fade-slide-up hover:border-zinc-700 transition-colors duration-150">
      <CardHeader>
        <CardTitle>Overview - TL;DR</CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-5 w-3/4" />
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
        <div className="flex items-start gap-2 pt-3 mt-3 border-t border-zinc-800">
          <Skeleton className="h-3 w-14 shrink-0 mt-0.5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </CardContent>
    </Card>
  )
}
