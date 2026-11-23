import { Bot, Check, Settings2, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { Provider } from '@/models/provider';

import { FlowStatusBadge } from '@/components/icons/flow-status-badge';
import { ProviderIcon } from '@/components/icons/provider-icon';
import { AppHeader, AppHeaderContent, AppHeaderTitle } from '@/components/layouts/app/app-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FlowForm, type FlowFormValues } from '@/features/flows/flow-form';
import { ProviderType } from '@/graphql/types';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useFlows } from '@/providers/flows-provider';
import { useProviders } from '@/providers/providers-provider';
import { useSidebarFlows } from '@/providers/sidebar-flows-provider';
import { useSystemSettings } from '@/providers/system-settings-provider';

type FlowType = 'assistant' | 'automation';

const RECENT_SESSIONS_LIMIT = 10;

const isOpenCodeProvider = (provider: Provider) => provider.name.toLowerCase().includes('opencode');

function AgentMode() {
    const navigate = useNavigate();

    const { providers, selectedProvider, setSelectedProvider } = useProviders();
    const { createFlow, createFlowWithAssistant } = useFlows();
    const { flows } = useSidebarFlows();
    const { settings } = useSystemSettings();

    const [isLoading, setIsLoading] = useState(false);
    const [flowType, setFlowType] = useState<FlowType>('automation');
    const [pickedProviderName, setPickedProviderName] = useState<null | string>(null);
    const [seenSelectedName, setSeenSelectedName] = useState(selectedProvider?.name ?? null);
    const [isFormProviderDirty, setIsFormProviderDirty] = useState(false);
    const [formKey, setFormKey] = useState(0);

    // The form's own provider dropdown writes to the shared selection; follow it so the
    // highlighted card always matches what the launcher will submit. The first null -> name
    // step is the providers query loading, not a user pick, and must not beat the OpenCode default.
    const currentSelectedName = selectedProvider?.name ?? null;

    if (currentSelectedName !== seenSelectedName) {
        setSeenSelectedName(currentSelectedName);

        if (seenSelectedName !== null && currentSelectedName && currentSelectedName !== pickedProviderName) {
            setPickedProviderName(currentSelectedName);
            setIsFormProviderDirty(true);
        }
    }

    const cliProviders = useMemo(() => {
        const custom = providers.filter((provider) => provider.type === ProviderType.Custom);

        return custom.length > 0 ? custom : providers;
    }, [providers]);

    const cliProviderNames = useMemo(() => new Set(cliProviders.map((provider) => provider.name)), [cliProviders]);

    const activeProvider = useMemo(() => {
        const picked = pickedProviderName ? providers.find((provider) => provider.name === pickedProviderName) : null;

        return (
            picked ??
            cliProviders.find(isOpenCodeProvider) ??
            cliProviders.find((provider) => provider.type === ProviderType.Custom) ??
            selectedProvider ??
            null
        );
    }, [cliProviders, pickedProviderName, providers, selectedProvider]);

    const activeProviderName = activeProvider?.name ?? '';
    const shouldUseAgents = settings?.assistantUseAgents ?? false;

    const formDefaultValues = useMemo(
        () => ({ providerName: activeProviderName, useAgents: shouldUseAgents }),
        [activeProviderName, shouldUseAgents],
    );

    const recentSessions = useMemo(
        () =>
            flows
                .filter(
                    (flow) => flow.provider.type === ProviderType.Custom || cliProviderNames.has(flow.provider.name),
                )
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .slice(0, RECENT_SESSIONS_LIMIT),
        [cliProviderNames, flows],
    );

    const handleSelectProvider = (provider: Provider) => {
        setPickedProviderName(provider.name);
        setSelectedProvider(provider);

        // A provider picked in the form's dropdown marks the field dirty, and FlowForm never
        // overwrites a dirty field from defaultValues — remount it so the card choice wins.
        if (isFormProviderDirty) {
            setIsFormProviderDirty(false);
            setFormKey((key) => key + 1);
        }
    };

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

            navigate(routes.flow(flowId, { tab: flowType }));

            return true;
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            <AppHeader>
                <AppHeaderContent>
                    <AppHeaderTitle>Agent Mode</AppHeaderTitle>
                </AppHeaderContent>
            </AppHeader>
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
                <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                        <div className="flex flex-col gap-1.5">
                            <CardTitle className="flex items-center gap-2">
                                <Bot className="size-5" />
                                Connected CLI agents
                            </CardTitle>
                            <CardDescription>Pick the CLI agent provider that drives the next flow</CardDescription>
                        </div>
                        <Button
                            asChild
                            size="sm"
                            variant="outline"
                        >
                            <Link to={routes.settings.providers}>
                                <Settings2 />
                                Manage providers
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {cliProviders.length === 0 ? (
                            <p className="text-muted-foreground text-sm">
                                No providers are configured yet. Add a custom provider that points at your CLI bridge.
                            </p>
                        ) : (
                            <div
                                aria-label="CLI agent providers"
                                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                                role="radiogroup"
                            >
                                {cliProviders.map((provider) => {
                                    const isActive = provider.name === activeProviderName;

                                    return (
                                        <button
                                            aria-checked={isActive}
                                            className={cn(
                                                'bg-card hover:bg-accent flex items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:pointer-events-none disabled:opacity-50',
                                                isActive && 'border-primary ring-primary ring-2',
                                            )}
                                            disabled={isLoading}
                                            key={provider.name}
                                            onClick={() => handleSelectProvider(provider)}
                                            role="radio"
                                            type="button"
                                        >
                                            <ProviderIcon
                                                className="size-5 shrink-0"
                                                provider={provider}
                                            />
                                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                                <span className="truncate font-medium">{provider.name}</span>
                                                <div className="flex flex-wrap gap-1">
                                                    <Badge variant="secondary">{provider.type}</Badge>
                                                    {isOpenCodeProvider(provider) && (
                                                        <Badge variant="blue">OpenCode</Badge>
                                                    )}
                                                </div>
                                            </div>
                                            {isActive && <Check className="text-primary size-4 shrink-0" />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>

                <div className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                    <span>
                        Agent Mode launches standard PentAGI Automation and Assistant flows: the same system prompts,
                        rules, persistence and isolated per-flow Docker sandbox as any other flow.
                    </span>
                </div>

                <Card>
                    <CardContent className="flex flex-col gap-4 pt-6">
                        <div className="flex flex-col gap-2 text-center">
                            <h2 className="text-2xl font-semibold">Launch an agent task</h2>
                            <p className="text-muted-foreground">
                                {activeProvider
                                    ? `Runs on ${activeProvider.name}`
                                    : 'Select a provider to start a flow'}
                            </p>
                        </div>
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
                                !isLoading
                                    ? flowType === 'automation'
                                        ? 'Describe what you would like the agent to test...'
                                        : 'What would you like the agent to help you with?'
                                    : 'Creating a new flow...'
                            }
                            type={flowType}
                        />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Recent Agent Mode sessions</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {recentSessions.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No Agent Mode flows yet</p>
                        ) : (
                            <ul
                                aria-label="Recent Agent Mode sessions"
                                className="flex flex-col divide-y"
                            >
                                {recentSessions.map((flow) => (
                                    <li key={flow.id}>
                                        <Link
                                            className="hover:bg-accent flex items-center gap-3 rounded-md px-2 py-2"
                                            to={routes.flow(flow.id)}
                                        >
                                            <span className="text-muted-foreground text-sm">#{flow.id}</span>
                                            <span className="min-w-0 flex-1 truncate">{flow.title}</span>
                                            <Badge variant="outline">{flow.provider.name}</Badge>
                                            <FlowStatusBadge status={flow.status} />
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </div>
        </>
    );
}

export default AgentMode;
