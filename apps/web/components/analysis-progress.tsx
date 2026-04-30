'use client'

import type { AnalysisPhase } from '@reponboard/agent-core'

interface AnalysisProgressProps {
  currentPhase: AnalysisPhase
  progress?: { current: number; total: number } | undefined
  message: string
}

const PHASES: { phase: AnalysisPhase; label: string }[] = [
  { phase: 'discovery', label: 'Scanning repository' },
  { phase: 'analyzing', label: 'Analyzing with AI' },
  { phase: 'complete', label: 'Complete' },
]

function getStepState(
  stepPhase: AnalysisPhase,
  currentPhase: AnalysisPhase,
): 'done' | 'active' | 'pending' {
  const stepIndex = PHASES.findIndex((p) => p.phase === stepPhase)
  const currentIndex = PHASES.findIndex((p) => p.phase === currentPhase)

  if (stepIndex < currentIndex) return 'done'
  if (stepIndex === currentIndex) return 'active'
  return 'pending'
}

export function AnalysisProgress({
  currentPhase,
  message,
}: AnalysisProgressProps) {
  return (
    <div className="flex flex-col gap-0 py-2">
      {PHASES.map((step, index) => {
        const state = getStepState(step.phase, currentPhase)
        const isLast = index === PHASES.length - 1
        const isActive = state === 'active'
        const isDone = state === 'done'

        const connectorColor =
          isDone || isActive ? 'bg-emerald-500/40' : 'bg-zinc-800'

        const displayMessage = message

        return (
          <div key={step.phase} className="flex items-start gap-3 relative">
            {/* Vertical connector line */}
            {!isLast && (
              <div
                className={`absolute left-[7px] top-5 w-px h-full ${connectorColor} transition-all duration-150 ease-out`}
              />
            )}

            {/* Step circle */}
            <div
              className={`h-4 w-4 rounded-full shrink-0 mt-0.5 transition-all duration-150 flex items-center justify-center
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

            {/* Step content */}
            <div className="pb-4">
              <p
                className={`text-sm transition-all duration-150 ease-out
                  ${isDone ? 'text-zinc-500' : ''}
                  ${isActive ? 'text-zinc-100 font-medium' : ''}
                  ${state === 'pending' ? 'text-zinc-600' : ''}
                `}
              >
                {step.label}
              </p>
              {isActive && (
                <p className="text-xs text-zinc-500 mt-0.5">{displayMessage}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
