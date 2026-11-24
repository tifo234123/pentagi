import { Bot, Check, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ProviderIcon } from '@/components/icons/provider-icon';
import { AppHeaderTitle } from '@/components/layouts/app/app-header';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FlowForm, type FlowFormValues } from '@/features/flows/flow-form';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useFlows } from '@/providers/flows-provider';
import { useSystemSettings } from '@/providers/system-settings-provider';

import AgentModeLayout from './agent-mode-layout';
import { isOpenCodeProvider, useAgentModeProviderSelection } from './use-agent-mode-providers';

type FlowType = 'assistant' | 'automation';

function AgentModeComposer() {
    const navigate = useNavigate();
    const { createFlow, createFlowWithAssistant } = useFlows();
    const { settings } = useSystemSettings();
    const { activeProvider, cliProviders, formKey, selectProvider } = useAgentModeProviderSelection();

    const [isLoading, setIsLoading] = useState(false);
    const [flowType, setFlowType] = useState<FlowType>('automation');

    const activeProviderName = activeProvider?.name ?? '';
    const shouldUseAgents = settings?.assistantUseAgents ?? false;

    const formDefaultValues = useMemo(
        () => ({ providerName: activeProviderName, useAgents: shouldUseAgents }),
        [activeProviderName, shouldUseAgents],
    );

    const handleSubmit = async (values: FlowFormValues) => {
        if (isLoading) {
            return false;
        }

        setIsLoading(true);

        try {
            const flowId = flowType === 'automation' ? await createFlow(values) : await createFlowWithAssistant(values);

            if (!flowId) {
                return false;
            }

            navigate(routes.agentModeSession(flowId, { tab: flowType }));

            return true;
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <AgentModeLayout
            activeProviderName={activeProviderName}
            headerTitle={<AppHeaderTitle>Agent Mode</AppHeaderTitle>}
            onSelectProvider={selectProvider}
        >
            <div className="flex-1 overflow-auto">
                <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10">
                    <div className="flex flex-col items-center gap-3 text-center">
                        <div className="bg-primary/10 text-primary flex size-11 items-center justify-center rounded-xl border">
                            <Bot className="size-5" />
                        </div>
                        <h1 className="text-2xl font-semibold tracking-tight">New agent thread</h1>
                        <p className="text-muted-foreground text-sm">
                            {activeProvider ? `Runs on ${activeProvider.name}` : 'Select a CLI agent to start a thread'}
                        </p>
                    </div>

                    {cliProviders.length === 0 ? (
                        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
                            No providers are configured yet.{' '}
                            <Link
                                className="text-foreground underline underline-offset-4"
                                to={routes.settings.providers}
                            >
                                Add a custom provider
                            </Link>{' '}
                            that points at your CLI bridge.
                        </p>
                    ) : (
                        <div
                            aria-label="CLI agent providers"
                            className="grid gap-2 sm:grid-cols-2"
                            role="radiogroup"
                        >
                            {cliProviders.map((provider) => {
                                const isActive = provider.name === activeProviderName;

                                return (
                                    <button
                                        aria-checked={isActive}
                                        className={cn(
                                            'bg-card hover:bg-accent flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:pointer-events-none disabled:opacity-50',
                                            isActive && 'border-primary ring-primary ring-1',
                                        )}
                                        disabled={isLoading}
                                        key={provider.name}
                                        onClick={() => selectProvider(provider)}
                                        role="radio"
                                        type="button"
                                    >
                                        <ProviderIcon
                                            className="size-5 shrink-0"
                                            provider={provider}
                                        />
                                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                            <span className="truncate text-sm font-medium">{provider.name}</span>
                                            {isOpenCodeProvider(provider) && <Badge variant="blue">OpenCode</Badge>}
                                            <Badge variant="secondary">{provider.type}</Badge>
                                        </div>
                                        {isActive && <Check className="text-primary size-4 shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <div className="flex justify-center">
                        <Badge
                            className="gap-1.5 py-1 font-normal"
                            variant="outline"
                        >
                            <ShieldCheck className="size-3.5" />
                            Same PentAGI system prompts, rules &amp; isolated Docker sandbox
                        </Badge>
                    </div>

                    <div className="bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-sm">
                        <Tabs
                            onValueChange={(value) => setFlowType(value as FlowType)}
                            value={flowType}
                        >
                            <TabsList className="grid w-full grid-cols-2">
                                <TabsTrigger
                                    disabled={isLoading}
                                    value="automation"
                                >
                                    Automation
                                </TabsTrigger>
                                <TabsTrigger
                                    disabled={isLoading}
                                    value="assistant"
                                >
                                    Assistant
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>
                        <FlowForm
                            defaultValues={formDefaultValues}
                            isSubmitting={isLoading}
                            key={formKey}
                            onSubmit={handleSubmit}
                            placeholder={
                                isLoading
                                    ? 'Starting a new agent thread...'
                                    : flowType === 'automation'
                                      ? 'Describe what you would like the agent to test...'
                                      : 'What would you like the agent to help you with?'
                            }
                            type={flowType}
                        />
                    </div>
                </div>
            </div>
        </AgentModeLayout>
    );
}

export default AgentModeComposer;
