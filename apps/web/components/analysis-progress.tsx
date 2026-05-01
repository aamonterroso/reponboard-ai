'use client'

import { Fragment } from 'react'
import type { AnalysisPhase } from '@reponboard/agent-core'

interface AnalysisProgressProps {
  seenPhases: Set<AnalysisPhase>
  currentPhase: AnalysisPhase
  progress?: { current: number; total: number } | undefined
  message: string
}

const PHASES: { phase: AnalysisPhase; label: string }[] = [
  { phase: 'discovery', label: 'Scan' },
  { phase: 'analyzing', label: 'Analyze' },
  { phase: 'partial_core', label: 'Stack' },
  { phase: 'partial_guide', label: 'Guide' },
  { phase: 'complete', label: 'Done' },
]

function getStepState(
  stepPhase: AnalysisPhase,
  currentPhase: AnalysisPhase,
  seenPhases: Set<AnalysisPhase>,
): 'done' | 'active' | 'pending' {
  if (currentPhase === 'complete' && stepPhase === 'complete') {
    return 'done'
  }
  if (stepPhase === currentPhase) return 'active'
  if (seenPhases.has(stepPhase)) return 'done'
  return 'pending'
}

export function AnalysisProgress({
  seenPhases,
  currentPhase,
  message,
}: AnalysisProgressProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex items-start w-full">
        {PHASES.map((step, index) => {
          const state = getStepState(step.phase, currentPhase, seenPhases)
          const isLast = index === PHASES.length - 1
          const isActive = state === 'active'
          const isDone = state === 'done'
          const connectorColor =
            isDone || isActive ? 'bg-emerald-500/40' : 'bg-zinc-800'

          return (
            <Fragment key={step.phase}>
              <div className="flex flex-col items-center gap-1 shrink-0">
                <div
                  className={`h-4 w-4 rounded-full transition-all duration-150 flex items-center justify-center
                    ${isDone ? 'bg-emerald-500' : ''}
                    ${isActive ? 'bg-emerald-500 animate-pulse-subtle' : ''}
                    ${state === 'pending' ? 'bg-zinc-800 border border-zinc-700' : ''}
                  `}
                >
                  {isDone && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M2 5L4 7L8 3"
                        stroke="white"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                  {isActive && (
                    <div className="h-1.5 w-1.5 rounded-full bg-white" />
                  )}
                </div>
                <span
                  className={`text-[10px] whitespace-nowrap transition-colors duration-150
                    ${isDone ? 'text-zinc-500' : ''}
                    ${isActive ? 'text-zinc-100 font-medium' : ''}
                    ${state === 'pending' ? 'text-zinc-600' : ''}
                  `}
                >
                  {step.label}
                </span>
              </div>
              {!isLast && (
                <div
                  className={`h-px flex-1 mt-2 mx-1.5 ${connectorColor} transition-colors duration-150`}
                />
              )}
            </Fragment>
          )
        })}
      </div>
      {message !== '' && (
        <p className="text-xs text-zinc-500 text-center truncate">{message}</p>
      )}
    </div>
  )
}
