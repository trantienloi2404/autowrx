// Copyright (c) 2025 Eclipse Foundation.
//
// This program and the accompanying materials are made available under the
// terms of the MIT License which is available at
// https://opensource.org/licenses/MIT.
//
// SPDX-License-Identifier: MIT

/**
 * Sidebar runtime panel: Coder workspace only (no hardware kit / DaRuntimeConnector).
 * Polls `.autowrx_out`, merges NDJSON lines into runtimeStore for dashboard widgets.
 */

import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/atoms/button'
import { TbPlayerPlayFilled } from 'react-icons/tb'
import { FaAnglesLeft, FaAnglesRight } from 'react-icons/fa6'
import { cn } from '@/lib/utils'
import useModelStore from '@/stores/modelStore'
import useRuntimeStore from '@/stores/runtimeStore'
import { Prototype } from '@/types/model.type'
import { shallow } from 'zustand/shallow'
import { addLog } from '@/services/log.service'
import useSelfProfileQuery from '@/hooks/useSelfProfile'
import useCurrentModel from '@/hooks/useCurrentModel'
import usePermissionHook from '@/hooks/usePermissionHook'
import { PERMISSIONS } from '@/data/permission'
import DaApisWatch from './DaApisWatch'
import PrototypeVarsWatch from './PrototypeVarsWatch'
import { countCodeExecution } from '@/services/prototype.service'
import { useSystemUI } from '@/hooks/useSystemUI'
import { useParams } from 'react-router-dom'
import { triggerWorkspaceRun, getWorkspaceRunOutput } from '@/services/coder.service'

const AlwaysScrollToBottom = () => {
  const elementRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (elementRef?.current) {
      elementRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  })

  return <div ref={elementRef} />
}

/** Merge NDJSON lines (one JSON object per line) from workspace `.autowrx_out` into apisValue for dashboard widgets. */
function patchApisFromNdjsonContent(
  content: string,
  setActiveApis: (v: Record<string, unknown>) => void,
) {
  if (!content?.trim()) return
  const lines = content.split(/\r?\n/)
  let patch: Record<string, unknown> = {}
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        patch = { ...patch, ...(o as Record<string, unknown>) }
      }
    } catch {
      /* skip non-JSON lines */
    }
  }
  if (Object.keys(patch).length === 0) return
  const prev =
    (useRuntimeStore.getState().apisValue as Record<string, unknown> | undefined) ||
    {}
  setActiveApis({ ...prev, ...patch })
}

const DaWorkspaceRuntimeControl: FC = () => {
  const { prototype_id: routePrototypeId } = useParams<{
    prototype_id?: string
  }>()
  const { data: currentUser } = useSelfProfileQuery()
  const [prototype] = useModelStore(
    (state) => [state.prototype as Prototype],
    shallow,
  )
  const { data: model } = useCurrentModel()
  const [isAuthorized] = usePermissionHook([PERMISSIONS.READ_MODEL, model?.id])
  const { showPrototypeDashboardFullScreen } = useSystemUI()

  const [setActiveApis, setTraceVars, setAppLog] = useRuntimeStore((state) => [
    state.setActiveApis,
    state.setTraceVars,
    state.setAppLog,
  ])

  const [isExpand, setIsExpand] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('output')
  /** Last `.autowrx_out` mtime from server (for clear-until-new-run). */
  const vscodeRunOutputMtimeRef = useRef(0)
  /** When set, hide run output until server file `mtimeMs` is greater than this. */
  const vscodeRunOutputClearBaselineRef = useRef<number | null>(null)
  const [vscodeRunOutput, setVscodeRunOutput] = useState('')

  const prototypeIdForCoder = prototype?.id ?? routePrototypeId ?? ''

  const handleClearLog = () => {
    setVscodeRunOutput('')
    vscodeRunOutputClearBaselineRef.current = vscodeRunOutputMtimeRef.current
  }

  /** Run inside Coder workspace (`.autowrx_run` → VS Code extension). */
  const handleCoderWorkspaceRun = () => {
    const id = prototype?.id ?? routePrototypeId
    if (!id) return
    setActiveTab('output')
    void triggerWorkspaceRun(id).catch((error) => {
      console.error('[DaWorkspaceRuntimeControl] Coder trigger-run failed:', error)
    })

    notifyWidgetIframes({ action: 'run-app' })

    const userId = currentUser?.id || 'Anonymous'
    if (prototype) {
      addLog({
        name: `User ${userId} run prototype`,
        description: `User ${userId} run prototype ${prototype?.name || 'Unknown'} with id ${prototype?.id || 'Unknown'}`,
        type: 'run-prototype',
        create_by: userId,
      })
      countCodeExecution(prototype.id)
    }
  }

  const notifyWidgetIframes = (data: unknown) => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach((iframe) => {
      iframe.contentWindow?.postMessage(JSON.stringify(data), '*')
    })
  }

  /** Poll workspace terminal output; merge NDJSON lines into runtime store for dashboard charts. */
  useEffect(() => {
    if (!prototypeIdForCoder || !isAuthorized) return

    let cancelled = false
    const poll = async () => {
      try {
        const data = await getWorkspaceRunOutput(prototypeIdForCoder)
        if (cancelled) return
        vscodeRunOutputMtimeRef.current = data.mtimeMs
        const baseline = vscodeRunOutputClearBaselineRef.current
        if (baseline !== null && data.mtimeMs <= baseline) {
          return
        }
        vscodeRunOutputClearBaselineRef.current = null
        setVscodeRunOutput((prev) =>
          prev === data.content ? prev : data.content,
        )
        setAppLog(data.content ?? '')
        patchApisFromNdjsonContent(data.content ?? '', setActiveApis)
      } catch {
        /* keep last good output */
      }
    }

    void poll()
    const id = window.setInterval(() => void poll(), 100)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [prototypeIdForCoder, isAuthorized, setActiveApis, setAppLog])

  const writeSignalValue = useCallback(
    (obj: Record<string, unknown> | null | undefined) => {
      if (!obj || typeof obj !== 'object') return
      const prev =
        (useRuntimeStore.getState().apisValue as Record<string, unknown>) || {}
      setActiveApis({ ...prev, ...obj })
    },
    [setActiveApis],
  )

  const writeVarsValue = useCallback(
    (obj: Record<string, unknown> | null | undefined) => {
      if (!obj || typeof obj !== 'object') return
      const prev =
        (useRuntimeStore.getState().traceVars as Record<string, unknown>) || {}
      setTraceVars({ ...prev, ...obj })
    },
    [setTraceVars],
  )

  const handleMessageListener = (e: MessageEvent) => {
    if (!e.data) return
    try {
      const payload =
        typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      if (payload?.cmd === 'set-api-value' && payload.api !== undefined) {
        writeSignalValue({ [String(payload.api)]: payload.value })
        writeVarsValue({ [String(payload.api)]: payload.value })
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    window.addEventListener('message', handleMessageListener)
    return () => {
      window.removeEventListener('message', handleMessageListener)
    }
  }, [writeSignalValue, writeVarsValue])

  const outputPanelText = useMemo(() => {
    const placeholder =
      'No output yet. Click Run to start the prototype in the workspace.'
    if (!String(vscodeRunOutput ?? '').trim()) return placeholder
    return vscodeRunOutput
  }, [vscodeRunOutput])

  return (
    <div
      data-id="workspace-runtime-control-panel"
      className={cn(
        'bottom-0 right-0 z-10 flex flex-col px-1 py-1',
        showPrototypeDashboardFullScreen
          ? 'fixed top-[58px]'
          : 'absolute top-0',
        isExpand ? 'w-[500px]' : 'w-14',
      )}
      style={{
        backgroundColor: 'hsl(217, 33%, 17%)',
        color: 'hsl(214, 32%, 91%)',
      }}
    >
      <div className={cn('mt-1 grow overflow-y-auto', !isExpand && 'hidden')}>
        {isExpand && (
          <>
            {activeTab === 'output' && (
              <div className="h-full flex flex-col">
                <div
                  data-id="current-log"
                  className="flex-1 overflow-y-auto whitespace-pre-wrap rounded bg-black px-2 py-1 text-xs"
                  style={{
                    backgroundColor: 'hsl(0, 0%, 0%)',
                    color: 'hsl(0, 0%, 100%)',
                  }}
                >
                  {outputPanelText}
                  <AlwaysScrollToBottom />
                </div>
              </div>
            )}

            {activeTab === 'apis' && (
              <DaApisWatch
                requestWriteSignalValue={(obj: Record<string, unknown>) => {
                  writeSignalValue(obj)
                }}
              />
            )}

            {activeTab === 'vars' && (
              <PrototypeVarsWatch
                requestWriteVarValue={(obj: Record<string, unknown>) => {
                  writeVarsValue(obj)
                }}
              />
            )}
          </>
        )}
      </div>

      <div className="mt-auto flex w-full flex-col">
        <div
          className={cn(
            'flex flex-col items-stretch gap-1 px-1 pb-2',
            isExpand && 'flex-row items-center justify-start gap-2',
          )}
        >
          <button
            type="button"
            data-id="btn-run-prototype-sidebar-lower"
            disabled={!prototypeIdForCoder}
            onClick={handleCoderWorkspaceRun}
            className="flex items-center justify-center rounded border p-2 font-semibold text-sm"
            style={{
              color: prototypeIdForCoder
                ? 'hsl(0, 0%, 100%)'
                : 'hsl(215, 16%, 47%)',
              borderColor: 'hsl(215, 16%, 47%)',
            }}
            onMouseEnter={(e) => {
              if (prototypeIdForCoder) {
                e.currentTarget.style.backgroundColor = 'hsl(215, 16%, 47%)'
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent'
            }}
          >
            <TbPlayerPlayFilled className="h-4 w-4" />
          </button>
        </div>

        <div className="flex">
          <Button
            variant="ghost"
            data-id="btn-expand-runtime-control"
            onClick={() => {
              setIsExpand((v) => !v)
            }}
            className="group hover:bg-slate-700"
            size="sm"
          >
            {isExpand ? (
              <FaAnglesRight
                className="w-4 h-4"
                style={{ color: 'hsl(0, 0%, 100%)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'hsl(215, 25%, 27%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'hsl(0, 0%, 100%)'
                }}
              />
            ) : (
              <FaAnglesLeft
                className="w-4 h-4"
                style={{ color: 'hsl(0, 0%, 100%)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'hsl(215, 25%, 27%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'hsl(0, 0%, 100%)'
                }}
              />
            )}
          </Button>

          {isExpand && (
            <>
              <div className="grow" />
              <div
                data-id="btn-runtime-control-tab-output"
                className={cn(
                  'text-xs flex cursor-pointer items-center px-4 py-0.5',
                  activeTab === 'output' && 'border-b-2',
                )}
                style={{
                  color: 'hsl(0, 0%, 100%)',
                  borderBottomColor:
                    activeTab === 'output'
                      ? 'hsl(0, 0%, 100%)'
                      : 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'hsl(215, 16%, 47%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent'
                }}
                onClick={() => {
                  setActiveTab('output')
                }}
              >
                Terminal
              </div>
              {prototype?.language === 'cpp' && (
                <div
                  data-id="btn-runtime-control-tab-vars"
                  className={cn(
                    'text-xs flex cursor-pointer items-center px-4 py-0.5',
                    activeTab === 'vars' && 'border-b-2',
                  )}
                  style={{
                    color: 'hsl(0, 0%, 100%)',
                    borderBottomColor:
                      activeTab === 'vars'
                        ? 'hsl(0, 0%, 100%)'
                        : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor =
                      'hsl(215, 16%, 47%)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent'
                  }}
                  onClick={() => {
                    setActiveTab('vars')
                  }}
                >
                  Vars Watch
                </div>
              )}
              <div
                data-id="btn-runtime-control-tab-apis"
                className={cn(
                  'text-xs flex cursor-pointer items-center px-4 py-0.5',
                  activeTab === 'apis' && 'border-b-2',
                )}
                style={{
                  color: 'hsl(0, 0%, 100%)',
                  borderBottomColor:
                    activeTab === 'apis'
                      ? 'hsl(0, 0%, 100%)'
                      : 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'hsl(215, 16%, 47%)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent'
                }}
                onClick={() => {
                  setActiveTab('apis')
                }}
              >
                Signals Watch
              </div>
              <Button
                size="sm"
                variant="ghost"
                data-id="btn-clear-log"
                className="text-xs px-2"
                style={{ color: 'hsl(0, 0%, 100%)' }}
                onClick={handleClearLog}
              >
                Clear
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default DaWorkspaceRuntimeControl
