import { MessageSquarePlus, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { Provider } from '@/models/provider';

import { FlowStatusIcon } from '@/components/icons/flow-status-icon';
import { ProviderIcon } from '@/components/icons/provider-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusType } from '@/graphql/types';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';

import { useAgentThreads, useCliProviders } from './use-agent-mode-providers';

interface AgentModeRailProps {
    activeFlowId?: null | string;
    activeProviderName?: null | string;
    onNavigate?: () => void;
    onSelectProvider: (provider: Provider) => void;
}

const isRunning = (status: StatusType) => ![StatusType.Failed, StatusType.Finished].includes(status);

function AgentModeRail({ activeFlowId, activeProviderName, onNavigate, onSelectProvider }: AgentModeRailProps) {
    const cliProviders = useCliProviders();
    const threads = useAgentThreads();

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="p-3">
                <Button
                    asChild
                    className="w-full justify-start"
                    variant="outline"
                >
                    <Link
                        onClick={onNavigate}
                        to={routes.agentMode}
                    >
                        <MessageSquarePlus />
                        New thread
                    </Link>
                </Button>
            </div>

            <section className="px-3 pb-3">
                <div className="text-muted-foreground mb-2 flex items-center justify-between px-1 text-xs font-medium tracking-wide uppercase">
                    <span>CLI agents</span>
                    <Button
                        asChild
                        className="size-6"
                        size="icon"
                        variant="ghost"
                    >
                        <Link
                            aria-label="Manage providers"
                            onClick={onNavigate}
                            to={routes.settings.providers}
                        >
                            <Settings2 className="size-3.5" />
                        </Link>
                    </Button>
                </div>
                {cliProviders.length === 0 ? (
                    <p className="text-muted-foreground px-1 text-xs">No CLI agents configured</p>
                ) : (
                    <div
                        aria-label="Connected CLI agents"
                        className="flex flex-wrap gap-1.5"
                        role="group"
                    >
                        {cliProviders.map((provider) => {
                            const isActive = provider.name === activeProviderName;
                            const runningCount = threads.filter(
                                (flow) => flow.provider.name === provider.name && isRunning(flow.status),
                            ).length;

                            return (
                                <button
                                    aria-pressed={isActive}
                                    className={cn(
                                        'hover:bg-accent flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                                        isActive && 'border-primary bg-primary/10 text-foreground',
                                    )}
                                    key={provider.name}
                                    onClick={() => onSelectProvider(provider)}
                                    title={runningCount ? `${runningCount} running` : 'Idle'}
                                    type="button"
                                >
                                    <span
                                        aria-hidden
                                        className={cn(
                                            'size-1.5 shrink-0 rounded-full',
                                            runningCount ? 'animate-pulse bg-emerald-500' : 'bg-emerald-500/40',
                                        )}
                                    />
                                    <span className="truncate">{provider.name}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </section>

            <div className="text-muted-foreground flex items-center justify-between border-t px-4 pt-3 pb-1 text-xs font-medium tracking-wide uppercase">
                <span>Threads</span>
                <span className="font-mono">{threads.length}</span>
            </div>
            <ScrollArea className="min-h-0 flex-1">
                {threads.length === 0 ? (
                    <p className="text-muted-foreground px-4 py-2 text-xs">No agent threads yet</p>
                ) : (
                    <ul
                        aria-label="Agent threads"
                        className="flex flex-col gap-0.5 p-2"
                    >
                        {threads.map((flow) => {
                            const isCurrent = String(flow.id) === activeFlowId;

                            return (
                                <li key={flow.id}>
                                    <Link
                                        aria-current={isCurrent ? 'page' : undefined}
                                        className={cn(
                                            'hover:bg-accent group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                                            isCurrent && 'bg-accent font-medium',
                                        )}
                                        onClick={onNavigate}
                                        to={routes.agentModeSession(flow.id)}
                                    >
                                        <FlowStatusIcon
                                            className="size-3.5 shrink-0"
                                            status={flow.status}
                                        />
                                        <span className="min-w-0 flex-1 truncate">
                                            {flow.title || `Session #${flow.id}`}
                                        </span>
                                        <Badge
                                            className="shrink-0 gap-1 px-1.5 py-0 text-[10px] font-normal"
                                            variant="outline"
                                        >
                                            <ProviderIcon
                                                className="size-3"
                                                provider={flow.provider}
                                            />
                                            {flow.provider.name}
                                        </Badge>
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </ScrollArea>
        </div>
    );
}

export default AgentModeRail;
